import { describe, expect, it } from "vitest";
import { buildImportGraph } from "./import-graph.js";
import { functionSource, isIndexableSourcePath, loadRepo } from "./source.js";
import { EmptySourceError, indexRepo } from "./indexer.js";
import type { Embedder } from "./embed.js";
import type pg from "pg";

/**
 * These cover the bug that emptied the index in production.
 *
 * The orchestrator moved into the cluster, where there is no checkout. The
 * indexer read from disk regardless, scanned zero files, and treated every
 * indexed file as deleted - so each push wiped the index and reported success.
 * Retrieval then ran with the diff alone: structural and semantic tiers empty,
 * baselineTokens 0, and nothing in the logs saying so.
 */

const FILES: Record<string, string> = {
  "src/money.ts": `export function toCents(n: number): number { return Math.round(n * 100); }
export function allocate(total: number, ratios: number[]): number[] { return ratios.map(() => total); }`,
  "src/invoice.ts": `import { allocate, toCents } from "./money.js";
export function invoiceTotal(lines: number[]): number { return toCents(lines.length) + allocate(1, [1])[0]!; }`,
  "src/index.ts": `export * from "./money.js";
export * from "./invoice.js";`,
  "test/money.test.ts": `import { toCents } from "../src/money.js";
export const t = toCents;`,
};

function fakeSource(files: Record<string, string> = FILES) {
  return functionSource({
    listFiles: async () => Object.keys(files),
    readFile: async (p) => files[p] ?? null,
  });
}

describe("isIndexableSourcePath", () => {
  it("accepts TypeScript and JavaScript sources", () => {
    for (const p of ["src/a.ts", "src/a.tsx", "src/a.js", "a.mts"]) {
      expect(isIndexableSourcePath(p)).toBe(true);
    }
  });

  it("rejects build output, dependencies and declaration files", () => {
    for (const p of [
      "node_modules/x/index.js",
      "dist/index.js",
      "coverage/lcov.js",
      ".next/server/a.js",
      "src/types.d.ts",
      "README.md",
      "package.json",
    ]) {
      expect(isIndexableSourcePath(p), p).toBe(false);
    }
  });
});

describe("loadRepo from a non-local source", () => {
  it("resolves import edges with no filesystem at all", async () => {
    // The point of the whole change: the cluster has no checkout, so the graph
    // has to come from file contents alone.
    const loaded = await loadRepo(fakeSource(), "/unused");
    const { edges, files } = buildImportGraph(loaded.root, loaded.project);

    expect(files).toContain("src/invoice.ts");
    expect(edges).toContainEqual({ from: "src/invoice.ts", to: "src/money.ts" });
  });

  it("resolves a .js specifier to the .ts file it means", async () => {
    // These repos are ESM TypeScript importing "./money.js". Without NodeNext
    // resolution the graph comes back empty and looks like a repo with no
    // imports rather than a misconfiguration.
    const loaded = await loadRepo(fakeSource(), "/unused");
    const { edges } = buildImportGraph(loaded.root, loaded.project);
    expect(edges.length).toBeGreaterThan(0);
  });

  it("follows re-exports, so a barrel does not hide callers", async () => {
    const loaded = await loadRepo(fakeSource(), "/unused");
    const { edges } = buildImportGraph(loaded.root, loaded.project);
    expect(edges).toContainEqual({ from: "src/index.ts", to: "src/money.ts" });
  });

  it("keys source files by repo-relative path", async () => {
    // join(repoRoot, path) produced backslashes on Windows and matched nothing
    // in an in-memory project, so every file was skipped.
    const loaded = await loadRepo(fakeSource(), "/unused");
    expect([...loaded.sourceFiles.keys()]).toContain("src/money.ts");
    expect(loaded.contents.get("src/money.ts")).toContain("toCents");
  });

  it("skips files the source cannot read instead of failing the run", async () => {
    const source = functionSource({
      listFiles: async () => ["src/money.ts", "src/gone.ts"],
      readFile: async (p) => (p === "src/gone.ts" ? null : FILES["src/money.ts"]!),
    });
    const loaded = await loadRepo(source, "/unused");
    expect(loaded.contents.has("src/gone.ts")).toBe(false);
    expect(loaded.contents.has("src/money.ts")).toBe(true);
  });
});

describe("indexRepo zero-file guard", () => {
  /** Records every statement so a test can prove nothing was deleted. */
  function fakePool(indexedPaths: string[]) {
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text.trim().split("\n")[0]!.trim());
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      query: async (text: string) => {
        statements.push(text.trim().split("\n")[0]!.trim());
        if (text.includes("FROM repo_files")) {
          return { rows: indexedPaths.map((p) => ({ path: p, content_hash: "h" })) };
        }
        return { rows: [] };
      },
      connect: async () => client,
    } as unknown as pg.Pool;
    return { pool, statements };
  }

  const embedder = { embed: async () => [], stats: { requests: 0, inputs: 0 } } as unknown as Embedder;
  const emptySource = functionSource({ listFiles: async () => [], readFile: async () => null });

  it("throws rather than deleting when the source lists nothing", async () => {
    const { pool } = fakePool(["src/money.ts", "src/invoice.ts"]);
    await expect(
      indexRepo({ repo: "acme/widgets", repoRoot: "/unused", source: emptySource, pool, embedder }),
    ).rejects.toBeInstanceOf(EmptySourceError);
  });

  it("issues no DELETE at all when it refuses", async () => {
    // The assertion that matters. Throwing after deleting would be no better
    // than the original bug.
    const { pool, statements } = fakePool(["src/money.ts"]);
    await indexRepo({
      repo: "acme/widgets",
      repoRoot: "/unused",
      source: emptySource,
      pool,
      embedder,
    }).catch(() => {});

    expect(statements.some((s) => s.startsWith("DELETE"))).toBe(false);
    expect(statements.some((s) => s.startsWith("BEGIN"))).toBe(false);
  });

  it("names the source kind, so the cause is in the message", async () => {
    const { pool } = fakePool(["src/money.ts"]);
    const err = await indexRepo({
      repo: "acme/widgets",
      repoRoot: "/unused",
      source: emptySource,
      pool,
      embedder,
    }).catch((e: unknown) => e as EmptySourceError);

    expect(err).toBeInstanceOf(EmptySourceError);
    expect((err as EmptySourceError).message).toContain("github");
    expect((err as EmptySourceError).message).toContain("0 files");
    expect((err as EmptySourceError).indexedFiles).toBe(1);
  });

  it("allows a genuinely empty repo when nothing is indexed yet", async () => {
    // Zero files is only suspicious against a populated index. A first run on
    // an empty repository must still be allowed to proceed.
    const { pool } = fakePool([]);
    const stats = await indexRepo({
      repo: "acme/widgets",
      repoRoot: "/unused",
      source: emptySource,
      pool,
      embedder,
    });
    expect(stats.filesScanned).toBe(0);
    expect(stats.filesRemoved).toBe(0);
  });
});
