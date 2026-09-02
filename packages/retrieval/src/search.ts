import type pg from "pg";
import { renderConventions, type Conventions } from "./conventions.js";
import { toVectorLiteral } from "./db.js";
import type { Embedder } from "./embed.js";
import { estimateTokens } from "./tokens.js";

export type Tier = "diff" | "structural" | "semantic" | "conventions";

export interface BundleItem {
  tier: Tier;
  path: string;
  /** Why this item is in the bundle. Rendered as the retrieval trace. */
  reason: string;
  content: string;
  estimatedTokens: number;
  symbol?: string | null;
  lines?: [number, number];
  /** Cosine similarity, semantic tier only. */
  score?: number;
}

export interface ContextBundle {
  repo: string;
  prNumber: number;
  headSha: string;
  items: BundleItem[];
  dropped: Array<Pick<BundleItem, "tier" | "path" | "reason" | "estimatedTokens">>;
  estimatedTokens: number;
  budgetTokens: number;
  /** Tokens a naive "send every indexed file whole" strategy would have used. */
  baselineTokens: number;
  timings: { structuralMs: number; semanticMs: number; totalMs: number };
}

export interface AssembleOptions {
  repo: string;
  prNumber: number;
  headSha: string;
  changedFiles: Array<{ path: string; patch: string | null; status: string }>;
  pool: pg.Pool;
  embedder: Embedder;
  conventions: Conventions;
  budgetTokens?: number;
  semanticLimit?: number;
}

const DEFAULT_BUDGET = 16_000;

/** Diversity guard for the semantic tier. */
const MAX_CHUNKS_PER_FILE = 2;

/**
 * Hybrid retrieval in strict priority order:
 *
 *   1. the diff              - always included, never retrieved
 *   2. structural neighbours - from the real import graph
 *   3. semantic neighbours   - pgvector cosine search
 *   4. convention digest
 *
 * Structural comes before semantic deliberately. The function that breaks is
 * usually the caller three directories away, and it shares no vocabulary with
 * the change, so embedding similarity will not surface it but an import edge
 * will.
 */
export async function assembleContext(opts: AssembleOptions): Promise<ContextBundle> {
  const started = performance.now();
  const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET;
  const changedPaths = opts.changedFiles.map((f) => f.path);

  const candidates: BundleItem[] = [];

  // --- tier 1: the diff ------------------------------------------------------
  for (const file of opts.changedFiles) {
    const content = file.patch ?? `(no textual diff available; status: ${file.status})`;
    candidates.push({
      tier: "diff",
      path: file.path,
      reason: `changed in this pull request (${file.status})`,
      content,
      estimatedTokens: estimateTokens(content),
    });
  }

  // --- tier 2: structural neighbours -----------------------------------------
  const structuralStart = performance.now();
  const included = new Set(changedPaths);

  const { rows: importerRows } = await opts.pool.query<{ from_path: string; to_path: string }>(
    `SELECT from_path, to_path FROM import_edges
      WHERE repo = $1 AND to_path = ANY($2::text[])
      ORDER BY from_path`,
    [opts.repo, changedPaths],
  );
  const { rows: importRows } = await opts.pool.query<{ from_path: string; to_path: string }>(
    `SELECT from_path, to_path FROM import_edges
      WHERE repo = $1 AND from_path = ANY($2::text[])
      ORDER BY to_path`,
    [opts.repo, changedPaths],
  );

  // Callers first: they are the ones that break.
  const structural: Array<{ path: string; reason: string }> = [];
  for (const row of importerRows) {
    if (included.has(row.from_path)) continue;
    included.add(row.from_path);
    structural.push({
      path: row.from_path,
      reason: `imports ${row.to_path}, which this PR changes`,
    });
  }
  for (const row of importRows) {
    if (included.has(row.to_path)) continue;
    included.add(row.to_path);
    structural.push({
      path: row.to_path,
      reason: `imported by ${row.from_path}, which this PR changes`,
    });
  }

  for (const neighbour of structural) {
    const content = await readFileFromChunks(opts.pool, opts.repo, neighbour.path);
    if (!content) continue;
    candidates.push({
      tier: "structural",
      path: neighbour.path,
      reason: neighbour.reason,
      content,
      estimatedTokens: estimateTokens(content),
    });
  }
  const structuralMs = Math.round(performance.now() - structuralStart);

  // --- tier 3: semantic neighbours -------------------------------------------
  const semanticStart = performance.now();
  const queryText = buildQueryText(opts.changedFiles);

  if (queryText.trim().length > 0) {
    const [queryVector] = await opts.embedder.embed([queryText], "RETRIEVAL_QUERY");
    if (queryVector) {
      const { rows } = await opts.pool.query<{
        path: string;
        symbol: string | null;
        kind: string;
        start_line: number;
        end_line: number;
        content: string;
        similarity: string;
      }>(
        `SELECT path, symbol, kind, start_line, end_line, content,
                1 - (embedding <=> $2::vector) AS similarity
           FROM file_chunks
          WHERE repo = $1
            AND embedding IS NOT NULL
            AND NOT (path = ANY($3::text[]))
            AND kind <> 'Barrel'
          ORDER BY embedding <=> $2::vector
          LIMIT $4`,
        // Over-fetch, because the per-file cap below discards some rows.
        [opts.repo, toVectorLiteral(queryVector), [...included], (opts.semanticLimit ?? 6) * 3],
      );

      // Four chunks of one file crowd out four different files. Cap the hits
      // per file so the semantic tier adds breadth the structural tier cannot.
      const perFile = new Map<string, number>();
      let taken = 0;

      for (const row of rows) {
        if (taken >= (opts.semanticLimit ?? 6)) break;
        const seen = perFile.get(row.path) ?? 0;
        if (seen >= MAX_CHUNKS_PER_FILE) continue;
        perFile.set(row.path, seen + 1);
        taken += 1;

        const similarity = Number(row.similarity);
        const label = row.symbol ? `${row.kind} ${row.symbol}` : row.kind;
        candidates.push({
          tier: "semantic",
          path: row.path,
          reason: `similar to the change (cosine ${similarity.toFixed(3)}, ${label})`,
          content: row.content,
          estimatedTokens: estimateTokens(row.content),
          symbol: row.symbol,
          lines: [row.start_line, row.end_line],
          score: Number(similarity.toFixed(4)),
        });
      }
    }
  }
  const semanticMs = Math.round(performance.now() - semanticStart);

  // --- tier 4: conventions ---------------------------------------------------
  const conventionText = renderConventions(opts.conventions);
  candidates.push({
    tier: "conventions",
    path: "(repository conventions)",
    reason: "cached digest of package.json and tsconfig.json",
    content: conventionText,
    estimatedTokens: estimateTokens(conventionText),
  });

  // --- budget ----------------------------------------------------------------
  const items: BundleItem[] = [];
  const dropped: ContextBundle["dropped"] = [];
  let used = 0;

  for (const candidate of candidates) {
    // The diff and the conventions digest are never dropped: without them the
    // review has no subject and no house style.
    const mandatory = candidate.tier === "diff" || candidate.tier === "conventions";
    if (!mandatory && used + candidate.estimatedTokens > budgetTokens) {
      dropped.push({
        tier: candidate.tier,
        path: candidate.path,
        reason: `dropped: would exceed the ${budgetTokens} token budget`,
        estimatedTokens: candidate.estimatedTokens,
      });
      continue;
    }
    items.push(candidate);
    used += candidate.estimatedTokens;
  }

  const { rows: sizeRows } = await opts.pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM repo_files WHERE repo = $1`,
    [opts.repo],
  );
  const baselineTokens = Math.ceil(Number(sizeRows[0]?.total ?? 0) / 4);

  return {
    repo: opts.repo,
    prNumber: opts.prNumber,
    headSha: opts.headSha,
    items,
    dropped,
    estimatedTokens: used,
    budgetTokens,
    baselineTokens,
    timings: { structuralMs, semanticMs, totalMs: Math.round(performance.now() - started) },
  };
}

async function readFileFromChunks(
  pool: pg.Pool,
  repo: string,
  path: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ content: string }>(
    `SELECT content FROM file_chunks WHERE repo = $1 AND path = $2 ORDER BY chunk_index`,
    [repo, path],
  );
  if (rows.length === 0) return null;
  return rows.map((r) => r.content).join("\n\n");
}

/** The query is the change itself: added lines carry the intent. */
function buildQueryText(files: AssembleOptions["changedFiles"]): string {
  const parts: string[] = [];
  for (const file of files) {
    parts.push(file.path);
    if (!file.patch) continue;
    const added = file.patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    parts.push(added.join("\n"));
  }
  return parts.join("\n").slice(0, 6_000);
}
