import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { Project, type SourceFile } from "ts-morph";

export interface ImportEdge {
  /** Repo-relative POSIX path of the importing file. */
  from: string;
  /** Repo-relative POSIX path of the imported file. */
  to: string;
}

export function toRepoPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).split("\\").join("/");
}

export function openProject(repoRoot: string): Project {
  const tsconfig = join(repoRoot, "tsconfig.json");

  // Using the real tsconfig matters: path aliases and moduleResolution decide
  // whether an import of "./money.js" resolves to money.ts. Glob-loading files
  // without it silently produces a graph with no edges.
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig })
    : new Project({ compilerOptions: { allowJs: true } });

  if (!existsSync(tsconfig)) {
    project.addSourceFilesAtPaths([
      join(repoRoot, "**/*.{ts,tsx,js,jsx,mts,cts}"),
      `!${join(repoRoot, "**/node_modules/**")}`,
      `!${join(repoRoot, "**/dist/**")}`,
    ]);
  }

  return project;
}

/**
 * Resolves real import edges, including re-exports from barrel files. This is
 * the deterministic half of retrieval: it finds the caller three directories
 * away that shares no vocabulary with the diff, which is exactly the file
 * embedding similarity misses.
 */
export function buildImportGraph(repoRoot: string, project?: Project): {
  edges: ImportEdge[];
  files: string[];
} {
  const proj = project ?? openProject(repoRoot);
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();
  const files: string[] = [];

  const sourceFiles = proj
    .getSourceFiles()
    .filter((f) => !f.getFilePath().includes("/node_modules/"));

  for (const sourceFile of sourceFiles) {
    const from = toRepoPath(repoRoot, sourceFile.getFilePath());
    if (from.startsWith("..")) continue; // outside the repo
    files.push(from);

    for (const target of resolvedTargets(sourceFile)) {
      const to = toRepoPath(repoRoot, target.getFilePath());
      // Only intra-repo edges. node_modules is not a structural neighbour.
      if (to.startsWith("..") || to.includes("node_modules/")) continue;
      if (to === from) continue;

      const key = `${from}\u0000${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to });
    }
  }

  return { edges, files: files.sort() };
}

function resolvedTargets(sourceFile: SourceFile): SourceFile[] {
  const out: SourceFile[] = [];

  for (const decl of sourceFile.getImportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) out.push(resolved);
  }

  // Barrel files re-export rather than import; without this, index.ts looks
  // like a leaf and everything behind it loses its callers.
  for (const decl of sourceFile.getExportDeclarations()) {
    const resolved = decl.getModuleSpecifierSourceFile();
    if (resolved) out.push(resolved);
  }

  return out;
}

/** Files that import `path` — the callers most likely to break. */
export function importersOf(edges: ImportEdge[], path: string): string[] {
  return edges.filter((e) => e.to === path).map((e) => e.from);
}

/** Files that `path` imports — its dependencies. */
export function importsOf(edges: ImportEdge[], path: string): string[] {
  return edges.filter((e) => e.from === path).map((e) => e.to);
}
