import { createHash } from "node:crypto";
import type { Logger } from "@srectl/core";
import type pg from "pg";
import { chunkFile, embeddingText, type Chunk } from "./chunker.js";
import { toVectorLiteral } from "./db.js";
import type { Embedder } from "./embed.js";
import { buildImportGraph } from "./import-graph.js";
import { loadRepo, localSource, type RepoSource } from "./source.js";

export interface IndexStats {
  repo: string;
  filesScanned: number;
  filesChanged: number;
  filesUnchanged: number;
  filesRemoved: number;
  chunksWritten: number;
  importEdges: number;
  embedRequests: number;
  embedInputs: number;
  durationMs: number;
}

export interface IndexOptions {
  repo: string;
  /** Used by the default local source, and as the project root for it. */
  repoRoot: string;
  /**
   * Where to read the repository from. Defaults to the checkout at repoRoot.
   * The orchestrator passes a GitHub-backed source, because it runs in a
   * container with no checkout.
   */
  source?: RepoSource;
  pool: pg.Pool;
  embedder: Embedder;
  logger?: Logger;
  /** Re-embed everything, ignoring stored hashes. */
  force?: boolean;
}

/**
 * Thrown instead of pruning when the source yields nothing but the index is
 * populated.
 *
 * "Zero files" almost never means "the repository is empty"; it means the
 * source could not be read - a missing checkout, a failed API call, a bad
 * token. Treating those files as deleted wipes the index, and the run still
 * reports success. That happened: the orchestrator moved into the cluster,
 * scanned zero files, and every push emptied the index until retrieval had
 * only the diff left.
 */
export class EmptySourceError extends Error {
  constructor(
    readonly repo: string,
    readonly indexedFiles: number,
    readonly sourceKind: string,
  ) {
    super(
      `refusing to index ${repo}: the ${sourceKind} source listed 0 files while ${indexedFiles} are indexed. ` +
        "This is treated as an unreadable source, not an empty repository, so nothing was deleted.",
    );
    this.name = "EmptySourceError";
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Incremental by file content hash. On a push that touches one file, exactly
 * one file is re-embedded — the rest cost a hash comparison and nothing else.
 */
export async function indexRepo(opts: IndexOptions): Promise<IndexStats> {
  const { repo, repoRoot, pool, embedder, logger, force = false } = opts;
  const source = opts.source ?? localSource(repoRoot);
  const started = performance.now();

  const loaded = await loadRepo(source, repoRoot);
  const { edges, files } = buildImportGraph(loaded.root, loaded.project);

  const { rows: existingRows } = await pool.query<{ path: string; content_hash: string }>(
    "SELECT path, content_hash FROM repo_files WHERE repo = $1",
    [repo],
  );
  const existing = new Map(existingRows.map((r) => [r.path, r.content_hash]));

  // Before any write. The guard has to run against the DB state, because
  // "0 files scanned" is only alarming when something is already indexed.
  if (files.length === 0 && existing.size > 0) {
    throw new EmptySourceError(repo, existing.size, source.kind);
  }

  interface Pending {
    path: string;
    hash: string;
    size: number;
    chunks: Chunk[];
  }

  const pending: Pending[] = [];
  let unchanged = 0;

  for (const path of files) {
    const content = loaded.contents.get(path);
    if (content === undefined) continue;
    const hash = sha256(content);

    if (!force && existing.get(path) === hash) {
      unchanged += 1;
      continue;
    }

    const sourceFile = loaded.sourceFiles.get(path);
    if (!sourceFile) continue;

    pending.push({ path, hash, size: content.length, chunks: chunkFile(sourceFile) });
  }

  const removed = [...existing.keys()].filter((p) => !files.includes(p));

  // One flat list, so batching is decided by the embedder rather than by how
  // chunks happen to be distributed across files.
  const flat = pending.flatMap((f) => f.chunks.map((c) => ({ path: f.path, chunk: c })));
  const vectors = flat.length
    ? await embedder.embed(
        flat.map((f) => embeddingText(f.path, f.chunk)),
        "RETRIEVAL_DOCUMENT",
      )
    : [];

  logger?.info("embedded chunks", { chunks: flat.length, requests: embedder.stats.requests });

  const client = await pool.connect();
  let chunksWritten = 0;

  try {
    await client.query("BEGIN");

    for (const path of removed) {
      await client.query("DELETE FROM file_chunks WHERE repo = $1 AND path = $2", [repo, path]);
      await client.query("DELETE FROM repo_files WHERE repo = $1 AND path = $2", [repo, path]);
    }

    let cursor = 0;
    for (const file of pending) {
      await client.query("DELETE FROM file_chunks WHERE repo = $1 AND path = $2", [repo, file.path]);

      for (const chunk of file.chunks) {
        const vector = vectors[cursor];
        cursor += 1;
        if (!vector) throw new Error(`missing embedding for ${file.path}#${chunk.index}`);

        await client.query(
          `INSERT INTO file_chunks
             (repo, path, chunk_index, kind, symbol, start_line, end_line, content, embedding)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::vector)`,
          [
            repo,
            file.path,
            chunk.index,
            chunk.kind,
            chunk.symbol,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            toVectorLiteral(vector),
          ],
        );
        chunksWritten += 1;
      }

      await client.query(
        `INSERT INTO repo_files (repo, path, content_hash, size_bytes, indexed_at)
         VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (repo, path)
         DO UPDATE SET content_hash = EXCLUDED.content_hash,
                       size_bytes   = EXCLUDED.size_bytes,
                       indexed_at   = now()`,
        [repo, file.path, file.hash, file.size],
      );
    }

    // Edges are deterministic and free to recompute, so they are replaced
    // wholesale rather than diffed.
    await client.query("DELETE FROM import_edges WHERE repo = $1", [repo]);
    for (const edge of edges) {
      await client.query(
        "INSERT INTO import_edges (repo, from_path, to_path) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [repo, edge.from, edge.to],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    repo,
    filesScanned: files.length,
    filesChanged: pending.length,
    filesUnchanged: unchanged,
    filesRemoved: removed.length,
    chunksWritten,
    importEdges: edges.length,
    embedRequests: embedder.stats.requests,
    embedInputs: embedder.stats.inputs,
    durationMs: Math.round(performance.now() - started),
  };
}
