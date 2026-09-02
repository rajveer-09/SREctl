import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkFile, embeddingText } from "./chunker.js";
import { buildImportGraph, importersOf, importsOf, openProject } from "./import-graph.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "aliased");

describe("buildImportGraph", () => {
  const { edges, files } = buildImportGraph(FIXTURE);
  const pairs = edges.map((e) => `${e.from} -> ${e.to}`).sort();

  it("finds every file the tsconfig includes", () => {
    expect(files).toEqual([
      "src/app.ts",
      "src/direct.ts",
      "src/leaf.ts",
      "src/lib/core.ts",
      "src/lib/index.ts",
    ]);
  });

  it("resolves a path alias to a real file", () => {
    expect(pairs).toContain("src/app.ts -> src/lib/index.ts");
  });

  it("follows `export *` so a barrel is not a dead end", () => {
    expect(pairs).toContain("src/lib/index.ts -> src/lib/core.ts");
  });

  it("resolves a relative .js specifier to the .ts source", () => {
    expect(pairs).toContain("src/direct.ts -> src/lib/core.ts");
  });

  it("produces exactly these edges and no others", () => {
    expect(pairs).toEqual([
      "src/app.ts -> src/lib/index.ts",
      "src/direct.ts -> src/lib/core.ts",
      "src/lib/index.ts -> src/lib/core.ts",
    ]);
  });

  // The whole reason the import graph exists: embeddings would not connect
  // app.ts to core.ts, because they share no vocabulary.
  it("names the callers of a changed file", () => {
    expect(importersOf(edges, "src/lib/core.ts").sort()).toEqual([
      "src/direct.ts",
      "src/lib/index.ts",
    ]);
    expect(importersOf(edges, "src/leaf.ts")).toEqual([]);
  });

  it("names the dependencies of a file", () => {
    expect(importsOf(edges, "src/app.ts")).toEqual(["src/lib/index.ts"]);
  });
});

describe("chunkFile", () => {
  const project = openProject(FIXTURE);

  it("splits on declaration boundaries and names the symbol", () => {
    const core = project.getSourceFileOrThrow((f) => f.getFilePath().endsWith("lib/core.ts"));
    const chunks = chunkFile(core);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "FunctionDeclaration", symbol: "coreThing", startLine: 1 });
    expect(chunks[0]?.content).toContain("return n * 2");
  });

  it("does not emit a chunk for a bare import statement", () => {
    const app = project.getSourceFileOrThrow((f) => f.getFilePath().endsWith("src/app.ts"));
    const chunks = chunkFile(app);

    expect(chunks.map((c) => c.symbol)).toEqual(["viaBarrelAndAlias"]);
  });

  // A barrel is kept so structural retrieval can still read it, but tagged so
  // semantic search can exclude it: its text is nothing but re-exports.
  it("tags a re-export-only file as a Barrel", () => {
    const barrel = project.getSourceFileOrThrow((f) => f.getFilePath().endsWith("lib/index.ts"));
    const chunks = chunkFile(barrel);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("Barrel");
  });

  it("prepends path and symbol so search can match on naming, not just body", () => {
    const core = project.getSourceFileOrThrow((f) => f.getFilePath().endsWith("lib/core.ts"));
    const text = embeddingText("src/lib/core.ts", chunkFile(core)[0]!);

    expect(text.startsWith("src/lib/core.ts — FunctionDeclaration coreThing")).toBe(true);
  });
});
