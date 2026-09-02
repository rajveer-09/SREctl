import { createEmitter, createLogger, loadEnv, PgEventStore } from "@srectl/core";
import { runReview, summarizeFindings } from "@srectl/agents";
import {
  ActionBudget,
  createClient,
  fetchFile,
  fetchPullRequest,
  parseRepo,
  postReview,
} from "@srectl/github";
import {
  assembleContext,
  createPool,
  detectTestLayout,
  Embedder,
  readConventions,
} from "@srectl/retrieval";

const env = loadEnv();
for (const [name, value] of Object.entries({
  DATABASE_URL: env.DATABASE_URL,
  GEMINI_API_KEY: env.GEMINI_API_KEY,
  GITHUB_TOKEN: env.GITHUB_TOKEN,
  TARGET_REPO: env.TARGET_REPO,
})) {
  if (!value) throw new Error(`${name} is not set`);
}

const args = process.argv.slice(2);
const prArg = args.find((a) => a.startsWith("--pr"));
const prNumber = Number(prArg?.includes("=") ? prArg.split("=")[1] : args[args.indexOf("--pr") + 1]);
if (!Number.isInteger(prNumber)) throw new Error("usage: pnpm review --pr <number> [--post]");

// Posting is opt-in. A review run should never surprise anyone by appearing
// on a pull request because a script was executed to see what it would say.
const post = args.includes("--post");
const modelArg = args.find((a) => a.startsWith("--model="))?.slice("--model=".length) ?? env.GEMINI_MODEL;

const logger = createLogger(env.LOG_LEVEL, { svc: "review", pr: prNumber });
const ref = parseRepo(env.TARGET_REPO!);
const gh = createClient(env.GITHUB_TOKEN!);
const pool = createPool(env.DATABASE_URL!);
const budget = new ActionBudget(10);
const emit = createEmitter(new PgEventStore(pool), logger);

try {
  const pr = await fetchPullRequest(gh, ref, prNumber);

  const conventions = await readConventions((path) => fetchFile(gh, ref, path, pr.headSha));
  const { rows } = await pool.query<{ path: string }>(
    "SELECT path FROM repo_files WHERE repo = $1",
    [env.TARGET_REPO],
  );
  conventions.testLayout = detectTestLayout(rows.map((r) => r.path));

  const bundle = await assembleContext({
    repo: env.TARGET_REPO!,
    prNumber,
    headSha: pr.headSha,
    changedFiles: pr.files,
    pool,
    embedder: new Embedder(env.GEMINI_API_KEY!),
    conventions,
  });

  logger.info("context assembled", {
    items: bundle.items.length,
    estimatedTokens: bundle.estimatedTokens,
  });

  // The retrieval trace: what was pulled in, and why. This is the row the
  // dashboard renders, so the reasons have to survive here, not just be logged.
  await emit({
    type: "retrieval.completed",
    correlationId: `pr-${prNumber}`,
    repo: env.TARGET_REPO!,
    prNumber,
    items: bundle.items.map((i) => ({
      tier: i.tier,
      path: i.path,
      reason: i.reason,
      tokens: i.estimatedTokens,
      ...(i.score !== undefined ? { score: i.score } : {}),
    })),
    dropped: bundle.dropped.map((d) => ({ path: d.path, tier: d.tier, tokens: d.estimatedTokens })),
    estimatedTokens: bundle.estimatedTokens,
    baselineTokens: bundle.baselineTokens,
    structuralMs: bundle.timings.structuralMs,
    semanticMs: bundle.timings.semanticMs,
    totalMs: bundle.timings.totalMs,
  });

  const result = await runReview({
    apiKey: env.GEMINI_API_KEY!,
    ...(modelArg ? { model: modelArg } : {}),
    bundle,
    pr: { number: pr.number, title: pr.title, body: pr.body, author: pr.author },
    logger,
  });

  const line = "-".repeat(78);
  console.log(`\n${line}`);
  console.log(`REVIEW OF PR #${pr.number}  ${pr.title}`);
  console.log(line);

  if (result.failure) {
    console.log(`\nUPSTREAM FAILURE after ${result.attempts.length} attempt(s)`);
    console.log(`  ${result.failure.code}: ${result.failure.message}`);
    console.log("\nThis is the model API being unavailable, not the agent failing to review.");
    process.exitCode = 1;
  } else if (!result.review) {
    console.log("\nThe model answered but did not call submit_review. Raw output:\n");
    console.log(result.rawText || "(empty)");
    process.exitCode = 1;
  } else {
    console.log(`\nSUMMARY\n  ${result.review.summary}\n`);
    if (result.review.findings.length === 0) {
      console.log("FINDINGS\n  none\n");
    } else {
      console.log("FINDINGS");
      for (const f of result.review.findings) {
        console.log(`\n  [${f.severity}] ${f.title}`);
        console.log(`  ${f.path}${f.line ? `:${f.line}` : ""}  (confidence: ${f.confidence})`);
        for (const l of f.detail.split("\n")) console.log(`    ${l}`);
      }
      console.log("");
    }
  }

  console.log(line);
  console.table({
    "prompt tokens": result.usage.promptTokens,
    "thinking tokens": result.usage.thoughtTokens,
    "output tokens": result.usage.candidateTokens,
    "total tokens": result.usage.totalTokens,
    "latency ms": result.latencyMs,
    attempts: result.attempts.length,
    "context items": bundle.items.length,
    "served by": result.servedBy,
    "injection patterns seen": summarizeFindings(result.injectionFindings),
  });

  if (result.injectionFindings.length) {
    console.log("\nINJECTION ATTEMPTS DETECTED IN UNTRUSTED CONTENT");
    for (const f of result.injectionFindings) {
      console.log(`  [${f.action}] ${f.pattern}: ${JSON.stringify(f.match)}`);
    }
  }

  if (result.review) {
    const outcome = await postReview({
      gh,
      ref,
      pullNumber: prNumber,
      commitId: pr.headSha,
      summary: result.review.summary,
      comments: result.review.findings.map((f) => ({
        path: f.path,
        line: f.line,
        body: `**${f.severity}: ${f.title}**\n\n${f.detail}\n\n<sub>confidence: ${f.confidence}</sub>`,
      })),
      budget,
      dryRun: !post,
    });

    const severities: Record<string, number> = {};
    for (const f of result.review.findings) severities[f.severity] = (severities[f.severity] ?? 0) + 1;

    await emit({
      type: "review.completed",
      correlationId: `pr-${prNumber}`,
      repo: env.TARGET_REPO!,
      prNumber,
      findings: result.review.findings.length,
      severities,
      usage: {
        promptTokens: result.usage.promptTokens,
        thoughtTokens: result.usage.thoughtTokens,
        candidateTokens: result.usage.candidateTokens,
        totalTokens: result.usage.totalTokens,
        model: result.servedBy,
      },
      latencyMs: result.latencyMs,
      posted: outcome.posted,
      ...(outcome.url ? { url: outcome.url } : {}),
      injectionFindings: result.injectionFindings.length,
    });

    console.log(
      post
        ? `\nposted: ${outcome.url} (${outcome.inlineComments} inline, ${outcome.demotedToSummary} in summary)`
        : `\ndry run: would post ${outcome.inlineComments} inline comment(s), ${outcome.demotedToSummary} folded into the summary. Re-run with --post to publish.`,
    );
  }
} finally {
  await pool.end();
}
