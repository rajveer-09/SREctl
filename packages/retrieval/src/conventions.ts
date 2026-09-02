export interface Conventions {
  testFramework: string;
  testLayout: "colocated" | "test-dir" | "unknown";
  testGlob: string | null;
  moduleSystem: string;
  strict: boolean | null;
  importExtension: "js-extension" | "extensionless" | "unknown";
  scripts: Record<string, string>;
  notes: string[];
}

export type FileReader = (path: string) => Promise<string | null>;

function parseJsonc(raw: string): unknown {
  // tsconfig.json is JSONC: strip comments and trailing commas before parsing.
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * A small digest of how this repository is written, so generated code matches
 * house conventions instead of the model's defaults. Computed once per commit,
 * not once per file.
 */
export async function readConventions(read: FileReader): Promise<Conventions> {
  const notes: string[] = [];
  const conventions: Conventions = {
    testFramework: "unknown",
    testLayout: "unknown",
    testGlob: null,
    moduleSystem: "unknown",
    strict: null,
    importExtension: "unknown",
    scripts: {},
    notes,
  };

  const pkgRaw = await read("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        type?: string;
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      conventions.moduleSystem = pkg.type === "module" ? "ESM" : "CommonJS";
      conventions.scripts = pkg.scripts ?? {};

      if (deps["vitest"]) conventions.testFramework = "vitest";
      else if (deps["jest"]) conventions.testFramework = "jest";
      else if (deps["mocha"]) conventions.testFramework = "mocha";

      if (deps["@vitest/coverage-v8"]) notes.push("coverage via @vitest/coverage-v8");
      if (deps["@stryker-mutator/core"]) notes.push("mutation testing already configured");
    } catch {
      notes.push("package.json could not be parsed");
    }
  }

  const tsconfigRaw = await read("tsconfig.json");
  if (tsconfigRaw) {
    try {
      const tsconfig = parseJsonc(tsconfigRaw) as {
        compilerOptions?: { strict?: boolean; module?: string; moduleResolution?: string };
      };
      const options = tsconfig.compilerOptions ?? {};
      conventions.strict = options.strict ?? false;

      const resolution = (options.moduleResolution ?? options.module ?? "").toLowerCase();
      if (resolution.includes("nodenext") || resolution.includes("node16")) {
        conventions.importExtension = "js-extension";
        notes.push("relative imports must carry a .js extension (nodenext)");
      } else if (resolution) {
        conventions.importExtension = "extensionless";
      }
    } catch {
      notes.push("tsconfig.json could not be parsed");
    }
  }

  return conventions;
}

/** Decided from where tests actually live, not from a guess. */
export function detectTestLayout(paths: string[]): Conventions["testLayout"] {
  const testFiles = paths.filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
  if (testFiles.length === 0) return "unknown";
  const inTestDir = testFiles.filter((p) => /^tests?\//.test(p)).length;
  return inTestDir > testFiles.length / 2 ? "test-dir" : "colocated";
}

export function renderConventions(c: Conventions): string {
  const lines = [
    `module system: ${c.moduleSystem}`,
    `test framework: ${c.testFramework}`,
    `test layout: ${c.testLayout}`,
    `typescript strict: ${c.strict === null ? "unknown" : c.strict}`,
    `relative imports: ${c.importExtension}`,
  ];
  const scripts = Object.entries(c.scripts).map(([k, v]) => `  ${k}: ${v}`);
  if (scripts.length) lines.push("scripts:", ...scripts);
  if (c.notes.length) lines.push("notes:", ...c.notes.map((n) => `  - ${n}`));
  return lines.join("\n");
}
