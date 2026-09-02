import type { Budget, InjectedFile, SandboxRunner } from "@srectl/sandbox";
import type { Logger } from "@srectl/core";

export interface SurvivingMutant {
  line: number;
  mutator: string;
  replacement: string;
}

export interface MutationScore {
  score: number | null;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  total: number;
  survivingMutants: SurvivingMutant[];
  durationMs: number;
  error?: string;
}

/** Below this, a passing test is not asserting anything worth proposing. */
export const MUTATION_THRESHOLD = 40;

const REPORT_PATH = "/workspace/reports/mutation.json";

/**
 * Stryker configuration, scoped to one file.
 *
 * Stryker runs the test suite once per mutant. Fifty mutants against a
 * three-second suite is 150 seconds even when only one file is mutated, so two
 * controls are applied:
 *
 *   - `mutate` covers the single target file, never the whole source tree.
 *   - the test command runs ONLY the related test file, not the full suite.
 *
 * Without the second one, scoping `mutate` saves nothing: every mutant still
 * pays for every unrelated test in the repository.
 *
 * The COMMAND runner rather than the vitest runner, deliberately. Stryker's
 * vitest runner boots Vitest programmatically, which makes Vite bundle a
 * config file into `node_modules/.vite-temp` - and node_modules is a read-only
 * mount in the sandbox, so every run died with ENOENT before scoring a single
 * mutant. Invoking the vitest CLI with the test file as a positional argument
 * needs no config file, so nothing is bundled and nothing is written to
 * node_modules. It costs per-test coverage analysis, which for a single file
 * is a price worth paying to keep the dependency cache read-only.
 */
export function strykerConfig(opts: { targetPath: string; testPath: string }): InjectedFile {
  const config = {
    packageManager: "npm",
    testRunner: "command",
    commandRunner: {
      command: `node_modules/.bin/vitest run --coverage.enabled=false ${opts.testPath}`,
    },
    coverageAnalysis: "off",
    mutate: [opts.targetPath],
    reporters: ["json"],
    jsonReporter: { fileName: "reports/mutation.json" },
    // The root filesystem is read-only, so this has to sit on a writable mount.
    tempDirName: "/tmp/.stryker-tmp",
    cleanTempDir: true,
    disableTypeChecks: true,
    concurrency: 2,
    timeoutMS: 20_000,
  };

  return { path: "stryker.conf.json", content: JSON.stringify(config, null, 2) };
}

export async function scoreMutants(opts: {
  runner: SandboxRunner;
  artifactRef: string;
  repoRoot: string;
  targetPath: string;
  testPath: string;
  testContent: string;
  budget: Budget;
  logger?: Logger;
}): Promise<MutationScore> {
  const started = performance.now();

  const result = await opts.runner.exec({
    artifactRef: opts.artifactRef,
    repoRoot: opts.repoRoot,
    files: [
      { path: opts.testPath, content: opts.testContent },
      strykerConfig({ targetPath: opts.targetPath, testPath: opts.testPath }),
    ],
    command: ["node_modules/.bin/stryker", "run", "--fileLogLevel", "off", "--logLevel", "warn"],
    extraJsonPath: REPORT_PATH,
    ...opts.budget,
  });

  const durationMs = Math.round(performance.now() - started);
  const empty: MutationScore = {
    score: null,
    killed: 0,
    survived: 0,
    timeout: 0,
    noCoverage: 0,
    total: 0,
    survivingMutants: [],
    durationMs,
  };

  const parsed = parseMutationReport(result.envelope?.extra);
  if (parsed) return { ...parsed, durationMs };

  // Fall back to the console summary if the report file did not survive.
  const fromText = parseStrykerSummary(result.envelope?.stdout ?? result.rawTail);
  if (fromText) return { ...fromText, durationMs };

  return {
    ...empty,
    error: result.timedOut
      ? "mutation run exceeded its time budget"
      : `no mutation report produced (exit ${result.exitCode})`,
  };
}

/**
 * Stryker's JSON report, as returned in the envelope.
 *
 * The score is computed here rather than read from the report, because
 * "mutation score" has two definitions - over all mutants, and over covered
 * code only - and quoting the wrong one inflates the number.
 */
export function parseMutationReport(extra: unknown): Omit<MutationScore, "durationMs"> | null {
  if (!extra || typeof extra !== "object") return null;
  const files = (extra as { files?: Record<string, { mutants?: Array<{ status: string; location?: { start?: { line: number } }; mutatorName?: string; replacement?: string }> }> }).files;
  if (!files) return null;

  let killed = 0;
  let survived = 0;
  let timeout = 0;
  let noCoverage = 0;
  const survivingMutants: SurvivingMutant[] = [];

  for (const file of Object.values(files)) {
    for (const mutant of file.mutants ?? []) {
      switch (mutant.status) {
        case "Killed":
          killed += 1;
          break;
        case "Survived":
          survived += 1;
          survivingMutants.push({
            line: mutant.location?.start?.line ?? 0,
            mutator: mutant.mutatorName ?? "unknown",
            replacement: (mutant.replacement ?? "").slice(0, 80),
          });
          break;
        case "Timeout":
          timeout += 1;
          break;
        case "NoCoverage":
          noCoverage += 1;
          break;
        default:
          break;
      }
    }
  }

  const total = killed + survived + timeout + noCoverage;
  if (total === 0) return null;

  // Total score: uncovered mutants count against the test, because a mutant
  // nothing exercises is exactly what a weak test leaves behind.
  const score = Math.round(((killed + timeout) / total) * 1000) / 10;
  return { score, killed, survived, timeout, noCoverage, total, survivingMutants };
}

/** Last resort: Stryker's own console summary. */
export function parseStrykerSummary(output: string): Omit<MutationScore, "durationMs"> | null {
  const killed = matchCount(output, /(\d+)\s+killed/i);
  const survived = matchCount(output, /(\d+)\s+survived/i);
  const timeout = matchCount(output, /(\d+)\s+timeout/i);
  const noCoverage = matchCount(output, /(\d+)\s+no coverage/i);
  const scoreMatch = /mutation score[^:]*:\s*([\d.]+)\s*%/i.exec(output);
  const total = killed + survived + timeout + noCoverage;

  if (!scoreMatch && total === 0) return null;

  const score = scoreMatch
    ? Number(scoreMatch[1])
    : total === 0
      ? null
      : Math.round(((killed + timeout) / total) * 1000) / 10;

  return { score, killed, survived, timeout, noCoverage, total, survivingMutants: [] };
}

function matchCount(text: string, re: RegExp): number {
  const m = re.exec(text);
  return m?.[1] ? Number(m[1]) : 0;
}

export function clearsThreshold(score: MutationScore, threshold = MUTATION_THRESHOLD): boolean {
  return score.score !== null && score.score >= threshold;
}
