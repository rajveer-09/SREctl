import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { Conventions } from "./conventions.js";
import type { Embedder } from "./embed.js";
import { assembleContext } from "./search.js";

/**
 * A stub standing in for the corpus. Keeps these tests about assembly logic —
 * tier precedence, deduplication, budget — rather than about pgvector.
 */
function stubPool(opts: {
  importers?: Array<{ from_path: string; to_path: string }>;
  imports?: Array<{ from_path: string; to_path: string }>;
  chunksByPath?: Record<string, string>;
  semantic?: Array<{ path: string; symbol: string | null; kind: string; content: string; similarity: string }>;
  totalBytes?: number;
}): pg.Pool {
  const query = async (sql: string, params: unknown[]) => {
    if (sql.includes("to_path = ANY")) return { rows: opts.importers ?? [] };
    if (sql.includes("from_path = ANY")) return { rows: opts.imports ?? [] };
    if (sql.includes("FROM file_chunks WHERE repo")) {
      const path = params[1] as string;
      const content = opts.chunksByPath?.[path];
      return { rows: content ? [{ content }] : [] };
    }
    if (sql.includes("1 - (embedding")) {
      return {
        rows: (opts.semantic ?? []).map((s) => ({ ...s, start_line: 1, end_line: 5 })),
      };
    }
    if (sql.includes("SUM(size_bytes)")) return { rows: [{ total: String(opts.totalBytes ?? 0) }] };
    return { rows: [] };
  };
  return { query } as unknown as pg.Pool;
}

const stubEmbedder = {
  embed: async () => [new Array(768).fill(0.1)],
  stats: { requests: 0, inputs: 0, totalChars: 0 },
} as unknown as Embedder;

const conventions: Conventions = {
  testFramework: "vitest",
  testLayout: "test-dir",
  testGlob: null,
  moduleSystem: "ESM",
  strict: true,
  importExtension: "js-extension",
  scripts: {},
  notes: [],
};

const base = {
  repo: "o/r",
  prNumber: 1,
  headSha: "abc",
  embedder: stubEmbedder,
  conventions,
};

describe("tier precedence", () => {
  it("puts the diff first, then structural, then semantic, then conventions", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [{ path: "src/a.ts", patch: "+const a = 1;", status: "modified" }],
      pool: stubPool({
        importers: [{ from_path: "src/caller.ts", to_path: "src/a.ts" }],
        chunksByPath: { "src/caller.ts": "import { a } from './a.js';" },
        semantic: [{ path: "src/other.ts", symbol: "other", kind: "FunctionDeclaration", content: "fn", similarity: "0.9" }],
      }),
    });

    expect(bundle.items.map((i) => i.tier)).toEqual([
      "diff",
      "structural",
      "semantic",
      "conventions",
    ]);
  });

  it("explains a structural hit by naming the edge that produced it", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [{ path: "src/money.ts", patch: "+x", status: "modified" }],
      pool: stubPool({
        importers: [{ from_path: "src/invoice.ts", to_path: "src/money.ts" }],
        chunksByPath: { "src/invoice.ts": "body" },
      }),
    });

    const structural = bundle.items.find((i) => i.tier === "structural");
    expect(structural?.reason).toBe("imports src/money.ts, which this PR changes");
  });

  it("prefers callers over dependencies", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [{ path: "src/a.ts", patch: "+x", status: "modified" }],
      pool: stubPool({
        importers: [{ from_path: "src/caller.ts", to_path: "src/a.ts" }],
        imports: [{ from_path: "src/a.ts", to_path: "src/dep.ts" }],
        chunksByPath: { "src/caller.ts": "caller", "src/dep.ts": "dep" },
      }),
    });

    const structural = bundle.items.filter((i) => i.tier === "structural");
    expect(structural.map((i) => i.path)).toEqual(["src/caller.ts", "src/dep.ts"]);
  });
});

describe("deduplication", () => {
  it("does not repeat a changed file as its own structural neighbour", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [
        { path: "src/a.ts", patch: "+x", status: "modified" },
        { path: "src/b.ts", patch: "+y", status: "modified" },
      ],
      // b imports a, but both are already in the diff tier.
      pool: stubPool({
        importers: [{ from_path: "src/b.ts", to_path: "src/a.ts" }],
        chunksByPath: { "src/b.ts": "body" },
      }),
    });

    expect(bundle.items.filter((i) => i.path === "src/b.ts")).toHaveLength(1);
    expect(bundle.items.filter((i) => i.tier === "structural")).toHaveLength(0);
  });
});

describe("token budget", () => {
  const bigFile = "x".repeat(30_000);

  it("drops structural items that would exceed the budget, and says so", async () => {
    const bundle = await assembleContext({
      ...base,
      budgetTokens: 500,
      changedFiles: [{ path: "src/a.ts", patch: "+small", status: "modified" }],
      pool: stubPool({
        importers: [{ from_path: "src/huge.ts", to_path: "src/a.ts" }],
        chunksByPath: { "src/huge.ts": bigFile },
      }),
    });

    expect(bundle.items.some((i) => i.path === "src/huge.ts")).toBe(false);
    expect(bundle.dropped[0]).toMatchObject({
      path: "src/huge.ts",
      tier: "structural",
    });
    expect(bundle.dropped[0]?.reason).toContain("token budget");
  });

  it("never drops the diff, even when the diff alone blows the budget", async () => {
    const bundle = await assembleContext({
      ...base,
      budgetTokens: 10,
      changedFiles: [{ path: "src/a.ts", patch: bigFile, status: "modified" }],
      pool: stubPool({}),
    });

    expect(bundle.items.some((i) => i.tier === "diff")).toBe(true);
    expect(bundle.estimatedTokens).toBeGreaterThan(bundle.budgetTokens);
  });

  it("never drops the conventions digest", async () => {
    const bundle = await assembleContext({
      ...base,
      budgetTokens: 10,
      changedFiles: [{ path: "src/a.ts", patch: bigFile, status: "modified" }],
      pool: stubPool({}),
    });

    expect(bundle.items.some((i) => i.tier === "conventions")).toBe(true);
  });
});

describe("missing content", () => {
  it("skips a structural neighbour that has no indexed chunks", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [{ path: "src/a.ts", patch: "+x", status: "modified" }],
      pool: stubPool({
        importers: [{ from_path: "src/not-indexed.ts", to_path: "src/a.ts" }],
        chunksByPath: {},
      }),
    });

    expect(bundle.items.filter((i) => i.tier === "structural")).toHaveLength(0);
  });

  it("handles a binary file with no patch without crashing", async () => {
    const bundle = await assembleContext({
      ...base,
      changedFiles: [{ path: "logo.png", patch: null, status: "added" }],
      pool: stubPool({}),
    });

    const diff = bundle.items.find((i) => i.tier === "diff");
    expect(diff?.content).toContain("no textual diff available");
  });
});
