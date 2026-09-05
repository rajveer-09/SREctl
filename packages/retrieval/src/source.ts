import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildImportGraph, openProject, toRepoPath } from "./import-graph.js";
import { Project, type SourceFile } from "ts-morph";

/**
 * Where the indexer reads the repository from.
 *
 * This exists because the orchestrator runs inside the cluster, where there is
 * no checkout on disk. It used to read from `~/Desktop/<repo>` regardless, so
 * in the cluster it scanned zero files - and the indexer treats "in the
 * database but not on disk" as deleted, so every push silently emptied the
 * index. Retrieval then fell back to the diff alone with no structural or
 * semantic tier, and reported success while doing it.
 *
 * Keeping the source behind an interface means the local path stays fast (no
 * API calls) and the cluster path stops depending on a filesystem it does not
 * have.
 */
export interface RepoSource {
  readonly kind: "local" | "github";
  /** Repo-relative POSIX paths of the indexable source files. */
  listFiles(): Promise<string[]>;
  /** File content, or null when it cannot be read. */
  readFile(path: string): Promise<string | null>;
}

/** Extensions the import graph understands. Anything else is not indexed. */
const SOURCE_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/;
const SKIP_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.git)\//;

export function isIndexableSourcePath(path: string): boolean {
  return SOURCE_RE.test(path) && !SKIP_RE.test(path) && !path.endsWith(".d.ts");
}

/**
 * Reads from a checkout on disk.
 *
 * Uses the repository's own tsconfig, which decides whether `./money.js`
 * resolves to `money.ts`. Without it the graph comes back with no edges.
 */
export function localSource(repoRoot: string): RepoSource {
  return {
    kind: "local",
    async listFiles() {
      const project = openProject(repoRoot);
      return buildImportGraph(repoRoot, project).files;
    },
    async readFile(path) {
      try {
        return await readFile(join(repoRoot, path), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/**
 * Reads through two supplied functions rather than a client.
 *
 * The Octokit wiring lives in @srectl/github, which already depends on it;
 * this package stays free of that dependency and the source becomes trivial
 * to fake in a test.
 */
export function functionSource(opts: {
  kind?: RepoSource["kind"];
  listFiles: () => Promise<string[]>;
  readFile: (path: string) => Promise<string | null>;
}): RepoSource {
  return {
    kind: opts.kind ?? "github",
    listFiles: opts.listFiles,
    readFile: opts.readFile,
  };
}

export interface LoadedRepo {
  /** Path -> content, for every file that could be read. */
  contents: Map<string, string>;
  /**
   * Path -> parsed file, keyed by repo-relative path.
   *
   * The indexer used to re-derive this with `join(repoRoot, path)`, which is
   * wrong for an in-memory project: its paths are POSIX and rooted at "/",
   * while join() on Windows produces backslashes and matches nothing.
   */
  sourceFiles: Map<string, SourceFile>;
  project: Project;
  /** Root the project's paths are relative to. */
  root: string;
}

/**
 * Materialises a source into a ts-morph Project.
 *
 * A local source opens the real files so the repository's own tsconfig applies.
 * A remote source has no filesystem, so the files are written into ts-morph's
 * in-memory one and module resolution is configured explicitly - the target
 * repositories are ESM TypeScript that import with a `.js` extension, which
 * only resolves to `.ts` under NodeNext.
 */
export async function loadRepo(source: RepoSource, repoRoot: string): Promise<LoadedRepo> {
  const paths = (await source.listFiles()).filter(isIndexableSourcePath);

  const contents = new Map<string, string>();
  for (const path of paths) {
    const content = await source.readFile(path);
    if (content !== null) contents.set(path, content);
  }

  if (source.kind === "local") {
    const project = openProject(repoRoot);
    return { contents, sourceFiles: byRepoPath(project, repoRoot), project, root: repoRoot };
  }

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      allowJs: true,
      // 199 = ModuleKind.NodeNext, 99 = ModuleResolutionKind.NodeNext.
      // Numeric so this package does not need to import the TypeScript enum.
      module: 199,
      moduleResolution: 99,
      target: 99,
    },
  });

  // package.json with type=module, or NodeNext resolution treats every .ts as
  // CommonJS and refuses the extensionless/.js specifiers these repos use.
  project.getFileSystem().writeFileSync("/package.json", JSON.stringify({ type: "module" }));

  for (const [path, content] of contents) {
    project.createSourceFile(`/${path}`, content, { overwrite: true });
  }

  return { contents, sourceFiles: byRepoPath(project, "/"), project, root: "/" };
}

function byRepoPath(project: Project, root: string): Map<string, SourceFile> {
  const out = new Map<string, SourceFile>();
  for (const file of project.getSourceFiles()) {
    const path = toRepoPath(root, file.getFilePath());
    if (!path.startsWith("..")) out.set(path, file);
  }
  return out;
}

/** Re-exported so callers can map absolute project paths back to repo paths. */
export { toRepoPath };
