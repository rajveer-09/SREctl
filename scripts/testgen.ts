import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  clearsThreshold,
  coverageDelta,
  generateAndVerify,
  MUTATION_THRESHOLD,
  rankTargets,
  scoreMutants,
} from "@srectl/agents";
import { createEmitter, createLogger, loadEnv, PgEventStore } from "@srectl/core";
import {
  ActionBudget,
  computeAllowlist,
  createClient,
  fetchFile,
  openPullRequest,
  parseRepo,
  testCandidatesFor,
} from "@srectl/github";
import { createPool, detectTestLayout, readConventions, renderConventions } from "@srectl/retrieval";
import { BUDGETS, DockerRunner, K8sJobRunner, lockfileHash, type SandboxRunner } from "@srectl/sandbox";

const env = loadEnv();
const args = process.argv.slice(2);
const fileArg = args.find((a) => a.startsWith("--file="))?.slice("--file=".length);
const post = args.includes("--post");
const skipMutation = args.includes("--no-mutation");
// The whole point of the SandboxRunner interface: the pipeline below does not
// know or care which one it is talking to.
const runnerKind = args.find((a) => a.startsWith("--runner="))?.slice("--runner=".length) ?? "docker";
const model = args.find((a) => a.startsWith("--model="))?.slice("--model=".length) ?? env.GEMINI_MODEL;

const logger = createLogger(env.LOG_LEVEL, { svc: "testgen" });
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);
const ref = parseRepo(env.TARGET_REPO!);
const gh = createClient(env.GITHUB_TOKEN!);
const pool = createPool(env.DATABASE_URL!);
const runner: SandboxRunner = runnerKind === "k8s" ? new K8sJobRunner(logger) : new DockerRunner(logger);
const budget = new ActionBudget(20);
const emit = createEmitter(new PgEventStore(pool), logger);

const COVERAGE_CMD = [
  "node_modules/.bin/vitest",
  "run",
  "--reporter=json",
  "--outputFile=.srectl-results.json",
  "--coverage",
  "--coverage.reporter=json-summary",
];

try {
  const { hash } = await lockfileHash(repoRoot);
  const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 600 });
  if (prep.error) throw new Error(prep.error);
  logger.info("dependencies ready", { runner: runner.kind, cacheHit: prep.cacheHit, ms: prep.durationMs });

  // --- baseline: what does the existing suite cover? -------------------------
  const before = await runner.exec({
    artifactRef: prep.artifactRef,
    repoRoot,
    files: [],
    command: COVERAGE_CMD,
    ...BUDGETS.test,
  });
  if (!before.envelope?.coverage) throw new Error("baseline coverage run produced no coverage");

  const ranked = await rankTargets({
    repo: env.TARGET_REPO!,
    pool,
    coverage: before.envelope.coverage,
    limit: 10,
  });

  console.log("\nTARGET RANKING (uncovered lines x import centrality)");
  console.table(
    ranked.map((t) => ({
      path: t.path,
      "line %": t.linePct,
      uncovered: t.uncoveredLines,
      importers: t.importers,
      score: t.score,
    })),
  );

  const target = fileArg ? ranked.find((t) => t.path === fileArg) : ranked[0];
  if (!target) throw new Error(fileArg ? `${fileArg} is not a ranked target` : "no target found");
  console.log(`\nSELECTED: ${target.path} - ${target.reason}\n`);

  // --- allowlist, computed BEFORE the model runs -----------------------------
  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM repo_files WHERE repo = $1",
    [env.TARGET_REPO],
  );
  const paths = rows.map((r) => r.path);
  const layout = detectTestLayout(paths);
  const candidates = testCandidatesFor(target.path, layout === "colocated" ? "colocated" : "test-dir");
  const candidatePath = candidates[0]!;
  const allowlist = computeAllowlist({ mode: "testgen", candidates });
  logger.info("allowlist computed", { mode: "testgen", candidates: allowlist.candidates });

  const conventions = await readConventions((p) => readLocal(repoRoot, p));
  conventions.testLayout = layout;

  const exemplarPath = paths.find((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
  const exemplar = exemplarPath
    ? { path: exemplarPath, content: (await readLocal(repoRoot, exemplarPath)) ?? "" }
    : undefined;

  const source = (await readLocal(repoRoot, target.path)) ?? "";

  // --- generate -> execute -> repair ------------------------------------------
  const result = await generateAndVerify({
    apiKey: env.GEMINI_API_KEY!,
    ...(model ? { model } : {}),
    runner,
    artifactRef: prep.artifactRef,
    repoRoot,
    allowlist,
    budget: BUDGETS.test,
    candidatePath,
    target: {
      path: target.path,
      source,
      uncoveredLines: target.uncoveredLines,
      linePct: target.linePct,
    },
    exemplar,
    conventions: renderConventions(conventions),
    testCommand: (testPath) => [...COVERAGE_CMD, testPath],
    logger,
  });

  await emit({
    type: "testgen.started",
    correlationId: `testgen-${target.path}`,
    repo: env.TARGET_REPO!,
    target: target.path,
    uncoveredLines: target.uncoveredLines,
    importers: target.importers,
    rankScore: target.score,
    runner: runner.kind,
  });

  // One event per attempt, INCLUDING the failures. Without these, "what
  // fraction pass on the first attempt" is unanswerable.
  for (const a of result.attempts) {
    await emit({
      type: "testgen.attempt",
      correlationId: `testgen-${target.path}`,
      repo: env.TARGET_REPO!,
      target: target.path,
      attempt: a.attempt,
      outcome: a.outcome,
      ...(a.testsPassed !== undefined ? { testsPassed: a.testsPassed } : {}),
      ...(a.testsFailed !== undefined ? { testsFailed: a.testsFailed } : {}),
      ...(a.failureSummary ? { failureSummary: a.failureSummary.slice(0, 500) } : {}),
      usage: {
        promptTokens: a.usage.promptTokens,
        thoughtTokens: a.usage.thoughtTokens,
        candidateTokens: a.usage.candidateTokens,
        totalTokens: a.usage.totalTokens,
        ...(result.servedBy ? { model: result.servedBy } : {}),
      },
      durationMs: a.durationMs,
    });
  }

  console.log("ATTEMPTS");
  console.table(
    result.attempts.map((a) => ({
      "#": a.attempt,
      outcome: a.outcome,
      passed: a.testsPassed ?? "-",
      failed: a.testsFailed ?? "-",
      tokens: a.usage.totalTokens,
      model: result.servedBy ?? "-",
      ms: a.durationMs,
      why: (a.failureSummary ?? "").slice(0, 60),
    })),
  );

  if (!result.accepted) {
    // "after 3 attempts" was hardcoded, and printed even when the loop made
    // one. A metric line that misreports its own denominator is worse than no
    // metric line.
    const upstream = result.attempts.at(-1)?.outcome === "upstream-error";
    console.log(
      upstream
        ? `\nNOT ABANDONED — the model API was unavailable after ${result.attempts.length} attempt(s):\n  ${result.attempts.at(-1)?.failureSummary?.slice(0, 150)}\nThat is an outage, not a generation failure.`
        : `\nABANDONED after ${result.attempts.length} attempt(s). This is recorded, not swallowed.`,
    );
    await recordMetrics(result, null, null);
    process.exitCode = 1;
  } else {
    const delta = coverageDelta(before.envelope.coverage, result.finalEnvelope!.coverage!, target.path);
    console.log(
      `\nCOVERAGE  ${target.path}: ${delta.fileBefore}% -> ${delta.fileAfter}%  |  repo: ${delta.totalBefore}% -> ${delta.totalAfter}%`,
    );

    // --- mutation: does the test actually assert anything? -------------------
    let mutation = null;
    if (!skipMutation) {
      console.log("\nMutation testing (separate budget, 600s)...");
      mutation = await scoreMutants({
        runner,
        artifactRef: prep.artifactRef,
        repoRoot,
        targetPath: target.path,
        testPath: result.accepted.path,
        testContent: result.accepted.content,
        budget: BUDGETS.mutation,
        logger,
      });
      await emit({
        type: "testgen.mutation",
        correlationId: `testgen-${target.path}`,
        repo: env.TARGET_REPO!,
        target: target.path,
        score: mutation.score,
        killed: mutation.killed,
        survived: mutation.survived,
        timeout: mutation.timeout,
        threshold: MUTATION_THRESHOLD,
        cleared: clearsThreshold(mutation),
        durationMs: mutation.durationMs,
      });

      console.table({
        score: mutation.score ?? "n/a",
        killed: mutation.killed,
        survived: mutation.survived,
        timeout: mutation.timeout,
        threshold: MUTATION_THRESHOLD,
        verdict: mutation.error ?? (clearsThreshold(mutation) ? "CLEARS" : "BELOW THRESHOLD"),
        ms: mutation.durationMs,
      });
    }

    await recordMetrics(result, delta, mutation);

    const cleared = mutation !== null && clearsThreshold(mutation);
    await emit({
      type: "testgen.completed",
      correlationId: `testgen-${target.path}`,
      repo: env.TARGET_REPO!,
      target: target.path,
      accepted: skipMutation || cleared,
      reason: skipMutation ? "mutation skipped" : cleared ? "cleared threshold" : "below mutation threshold",
      attempts: result.attempts.length,
      coverageBefore: delta.fileBefore,
      coverageAfter: delta.fileAfter,
      totalDurationMs: result.totalDurationMs,
    });

    const accepted = skipMutation || (mutation !== null && clearsThreshold(mutation));
    if (!accepted) {
      console.log("\nDISCARDED: the test passes but does not kill enough mutants to be worth proposing.");
    } else {
      const body = prBody(target.path, result, delta, mutation);
      const branch = `srectl/test-${target.path.replace(/[^a-z0-9]+/gi, "-")}-${Date.now().toString(36)}`;

      const pr = await openPullRequest({
        gh,
        ref,
        baseBranch: "main",
        branchName: branch,
        title: `test: cover ${target.path}`,
        body,
        files: [{ path: result.accepted.path, content: result.accepted.content }],
        allowlist,
        budget,
        dryRun: !post,
      });

      console.log(
        post
          ? `\nopened: ${pr.url}`
          : `\ndry run: would open a PR on branch ${pr.branch}. Re-run with --post to publish.\n\n--- PR BODY ---\n${body}`,
      );
    }
  }
} finally {
  await runner.cleanup();
  await pool.end();
}

async function readLocal(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

type Result = Awaited<ReturnType<typeof generateAndVerify>>;
type Delta = ReturnType<typeof coverageDelta>;
type Mutation = Awaited<ReturnType<typeof scoreMutants>> | null;

function prBody(target: string, result: Result, delta: Delta, mutation: Mutation): string {
  const attempts = result.attempts.length;
  return [
    `Generated test for \`${target}\`.`,
    "",
    "**This test was executed before this PR was opened.** It is not a suggestion.",
    "",
    "| | |",
    "|---|---|",
    `| Coverage, \`${target}\` | ${delta.fileBefore}% → **${delta.fileAfter}%** |`,
    `| Coverage, repository | ${delta.totalBefore}% → ${delta.totalAfter}% |`,
    `| Mutation score | ${mutation?.score ?? "not run"}${mutation?.score !== null && mutation !== null ? `% (threshold ${MUTATION_THRESHOLD}%)` : ""} |`,
    `| Mutants killed / survived | ${mutation?.killed ?? "-"} / ${mutation?.survived ?? "-"} |`,
    `| Attempts to a passing test | ${attempts} |`,
    `| Total time | ${(result.totalDurationMs / 1000).toFixed(1)}s |`,
    "",
    attempts > 1
      ? `The first ${attempts - 1} attempt(s) failed and were repaired from the actual test output.`
      : "Passed on the first attempt.",
    "",
    "<sub>Opened by SREctl. Executed in a sandbox with no network egress. A human merges.</sub>",
  ].join("\n");
}

async function recordMetrics(result: Result, delta: Delta | null, mutation: Mutation): Promise<void> {
  await mkdir("eval/results", { recursive: true });
  const path = "eval/results/testgen.jsonl";
  const row = {
    ts: new Date().toISOString(),
    target: result.target,
    accepted: Boolean(result.accepted),
    attempts: result.attempts.length,
    firstAttemptPassed: result.attempts[0]?.outcome === "passed",
    outcomes: result.attempts.map((a) => a.outcome),
    tokens: result.attempts.reduce((s, a) => s + a.usage.totalTokens, 0),
    durationMs: result.totalDurationMs,
    coverage: delta,
    mutationScore: mutation?.score ?? null,
    clearedThreshold: mutation ? clearsThreshold(mutation) : null,
  };
  await writeFile(path, JSON.stringify(row) + "\n", { flag: "a" });
  console.log(`\nmetrics appended to ${path}`);
}
