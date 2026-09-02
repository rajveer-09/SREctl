import type pg from "pg";
import { describe, expect, it } from "vitest";
import { coverageDelta, normalizeCoveragePath, rankTargets } from "./coverage.js";
import {
  clearsThreshold,
  MUTATION_THRESHOLD,
  parseMutationReport,
  parseStrykerSummary,
  strykerConfig,
} from "./mutation.js";
import { stripFences } from "./test-agent.js";

function stubPool(importers: Record<string, number>): pg.Pool {
  return {
    query: async () => ({
      rows: Object.entries(importers).map(([to_path, n]) => ({ to_path, importers: String(n) })),
    }),
  } as unknown as pg.Pool;
}

const file = (pct: number, covered: number, total: number) => ({ pct, covered, total });

describe("normalizeCoveragePath", () => {
  it("strips the container workdir prefix", () => {
    expect(normalizeCoveragePath("/workspace/src/money.ts")).toBe("src/money.ts");
  });

  it("normalizes Windows separators", () => {
    expect(normalizeCoveragePath("/workspace\\src\\money.ts")).toBe("src/money.ts");
  });

  it("leaves an already-relative path alone", () => {
    expect(normalizeCoveragePath("src/money.ts")).toBe("src/money.ts");
  });
});

describe("rankTargets", () => {
  const coverage = {
    lines: 20,
    statements: 20,
    branches: 20,
    functions: 20,
    perFile: {
      "/workspace/src/money.ts": file(35, 11, 31), // 20 uncovered, 4 importers
      "/workspace/src/lonely.ts": file(0, 0, 30), // 30 uncovered, 0 importers
      "/workspace/src/covered.ts": file(100, 10, 10), // nothing to do
      "/workspace/src/index.ts": file(0, 0, 5), // barrel
      "/workspace/test/money.test.ts": file(100, 20, 20), // a test
      "/workspace/src/types.d.ts": file(0, 0, 9), // declarations
    },
  };

  it("weights uncovered lines by importer count", async () => {
    const ranked = await rankTargets({
      repo: "o/r",
      pool: stubPool({ "src/money.ts": 4, "src/lonely.ts": 0 }),
      coverage,
    });

    // money: 20 * (1+4) = 100 beats lonely: 30 * (1+0) = 30, despite fewer
    // uncovered lines. That is the whole point of using the import graph.
    expect(ranked.map((t) => t.path)).toEqual(["src/money.ts", "src/lonely.ts"]);
    expect(ranked[0]?.score).toBe(100);
    expect(ranked[1]?.score).toBe(30);
  });

  it("excludes files that are already fully covered", async () => {
    const ranked = await rankTargets({ repo: "o/r", pool: stubPool({}), coverage });
    expect(ranked.map((t) => t.path)).not.toContain("src/covered.ts");
  });

  it("excludes tests, barrels and declaration files", async () => {
    const ranked = await rankTargets({ repo: "o/r", pool: stubPool({}), coverage });
    const paths = ranked.map((t) => t.path);

    expect(paths).not.toContain("test/money.test.ts");
    expect(paths).not.toContain("src/index.ts");
    expect(paths).not.toContain("src/types.d.ts");
  });

  it("explains its ranking", async () => {
    const ranked = await rankTargets({ repo: "o/r", pool: stubPool({ "src/money.ts": 4 }), coverage });
    expect(ranked[0]?.reason).toBe("20 uncovered line(s), imported by 4 file(s)");
  });

  it("respects the limit", async () => {
    const ranked = await rankTargets({ repo: "o/r", pool: stubPool({}), coverage, limit: 1 });
    expect(ranked).toHaveLength(1);
  });
});

describe("coverageDelta", () => {
  const before = { lines: 18.9, statements: 0, branches: 0, functions: 0, perFile: { "/workspace/src/a.ts": file(0, 0, 10) } };
  const after = { lines: 33.1, statements: 0, branches: 0, functions: 0, perFile: { "/workspace/src/a.ts": file(100, 10, 10) } };

  it("reports file and repository movement", () => {
    expect(coverageDelta(before, after, "src/a.ts")).toEqual({
      fileBefore: 0,
      fileAfter: 100,
      totalBefore: 18.9,
      totalAfter: 33.1,
    });
  });

  it("reports zero for a file absent from the report", () => {
    expect(coverageDelta(before, after, "src/missing.ts").fileAfter).toBe(0);
  });
});

describe("parseMutationReport", () => {
  const report = {
    files: {
      "src/slug.ts": {
        mutants: [
          { status: "Killed" },
          { status: "Killed" },
          { status: "Survived", location: { start: { line: 4 } }, mutatorName: "MethodExpression", replacement: "toUpperCase()" },
          { status: "Timeout" },
          { status: "NoCoverage" },
          { status: "Ignored" },
        ],
      },
    },
  };

  it("counts by status and computes the total score", () => {
    const parsed = parseMutationReport(report);
    // killed 2 + timeout 1 = 3 of 5 scored mutants (Ignored is not scored)
    expect(parsed).toMatchObject({ killed: 2, survived: 1, timeout: 1, noCoverage: 1, total: 5, score: 60 });
  });

  it("counts uncovered mutants against the test", () => {
    // A mutant nothing exercises is exactly what a weak test leaves behind,
    // so NoCoverage must lower the score rather than be excluded.
    const parsed = parseMutationReport({ files: { a: { mutants: [{ status: "Killed" }, { status: "NoCoverage" }] } } });
    expect(parsed?.score).toBe(50);
  });

  it("records surviving mutants for the PR body", () => {
    expect(parseMutationReport(report)?.survivingMutants).toEqual([
      { line: 4, mutator: "MethodExpression", replacement: "toUpperCase()" },
    ]);
  });

  it("returns null for junk rather than throwing", () => {
    expect(parseMutationReport(undefined)).toBeNull();
    expect(parseMutationReport(null)).toBeNull();
    expect(parseMutationReport("not an object")).toBeNull();
    expect(parseMutationReport({ files: {} })).toBeNull();
  });
});

describe("parseStrykerSummary", () => {
  it("reads an explicit score line", () => {
    expect(parseStrykerSummary("Mutation score based on covered code: 66.67%")?.score).toBe(66.67);
  });

  it("returns null when there is nothing to read", () => {
    expect(parseStrykerSummary("stryker crashed")).toBeNull();
  });
});

describe("clearsThreshold", () => {
  const base = { killed: 0, survived: 0, timeout: 0, noCoverage: 0, total: 0, survivingMutants: [], durationMs: 0 };

  it("accepts at the threshold", () => {
    expect(clearsThreshold({ ...base, score: MUTATION_THRESHOLD })).toBe(true);
  });

  it("rejects below it", () => {
    expect(clearsThreshold({ ...base, score: 39.9 })).toBe(false);
  });

  it("rejects an unknown score rather than assuming success", () => {
    expect(clearsThreshold({ ...base, score: null })).toBe(false);
  });
});

describe("strykerConfig", () => {
  const config = JSON.parse(strykerConfig({ targetPath: "src/a.ts", testPath: "test/a.test.ts" }).content);

  it("mutates only the target file", () => {
    expect(config.mutate).toEqual(["src/a.ts"]);
  });

  it("runs only the related test file per mutant", () => {
    // Scoping `mutate` alone saves nothing: every mutant would still pay for
    // every unrelated test in the repository.
    expect(config.commandRunner.command).toContain("test/a.test.ts");
  });

  it("keeps its temp directory off the read-only root", () => {
    expect(config.tempDirName).toBe("/tmp/.stryker-tmp");
  });
});

describe("stripFences", () => {
  it("removes a fenced block the model added despite instructions", () => {
    expect(stripFences('```ts\nconst a = 1;\n```')).toBe("const a = 1;\n");
  });

  it("leaves unfenced content alone", () => {
    expect(stripFences("const a = 1;")).toBe("const a = 1;\n");
  });

  it("does not strip fences that appear inside the code", () => {
    const content = 'const md = "```";\nconst b = 2;';
    expect(stripFences(content)).toBe(content + "\n");
  });
});
