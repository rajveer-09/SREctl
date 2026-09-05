import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runReview } from "@srectl/agents";
import type { Emitter, Job, Logger } from "@srectl/core";
import {
  ActionBudget,
  createClient,
  fetchFile,
  fetchPullRequest,
  githubRepoFiles,
  parseRepo,
  postReview,
} from "@srectl/github";
import {
  assembleContext,
  createPool,
  detectTestLayout,
  Embedder,
  functionSource,
  indexRepo,
  localSource,
  readConventions,
} from "@srectl/retrieval";
import type pg from "pg";

export interface HandlerContext {
  pool: pg.Pool;
  emit: Emitter;
  logger: Logger;
  apiKey: string;
  githubToken: string;
  targetRepo: string;
  /**
   * Local checkout, used for indexing when one is present. In the cluster
   * there is none, and indexing reads the repository through the GitHub API
   * instead - see reindex().
   */
  repoRoot: string;
  /** Posting is opt-in so a misconfigured worker cannot spam a repository. */
  post: boolean;
}

export type HandlerResult =
  | { ok: true; summary: string }
  | {
      ok: false;
      error: string;
      /**
       * True when the failure says nothing about the job.
       *
       * An exhausted quota is an outage; a malformed job is not. Treating them
       * alike either burns recoverable work or retries a job that can never
       * succeed, forever.
       */
      retryable: boolean;
    };

/**
 * Routes a job to the agent that handles it.
 *
 * Deliberately thin: the orchestrator decides WHAT runs and WHEN, never HOW.
 * All the reasoning lives in the agent packages, so this file stays readable
 * and the agents stay testable without a queue.
 */
export async function handle(job: Job, ctx: HandlerContext): Promise<HandlerResult> {
  switch (job.kind) {
    case "review_pr":
      return reviewPullRequest(job, ctx);
    case "index_push":
      return reindex(job, ctx);
    default:
      return { ok: false, error: `no handler for job kind "${job.kind}"`, retryable: false };
  }
}

async function reviewPullRequest(job: Job, ctx: HandlerContext): Promise<HandlerResult> {
  if (job.prNumber === undefined) {
    return { ok: false, error: "review job has no PR number", retryable: false };
  }

  const ref = parseRepo(job.repo);
  const gh = createClient(ctx.githubToken);
  const budget = new ActionBudget(10);
  const correlationId = `pr-${job.prNumber}`;

  const pr = await fetchPullRequest(gh, ref, job.prNumber);

  const conventions = await readConventions((path) => fetchFile(gh, ref, path, pr.headSha));
  const { rows } = await ctx.pool.query<{ path: string }>(
    "SELECT path FROM repo_files WHERE repo = $1",
    [job.repo],
  );
  conventions.testLayout = detectTestLayout(rows.map((r) => r.path));

  const bundle = await assembleContext({
    repo: job.repo,
    prNumber: job.prNumber,
    headSha: pr.headSha,
    changedFiles: pr.files,
    pool: ctx.pool,
    embedder: new Embedder(ctx.apiKey),
    conventions,
  });

  await ctx.emit({
    type: "retrieval.completed",
    correlationId,
    repo: job.repo,
    prNumber: job.prNumber,
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
    apiKey: ctx.apiKey,
    bundle,
    pr: { number: pr.number, title: pr.title, body: pr.body, author: pr.author },
    logger: ctx.logger,
  });

  if (result.failure) {
    await ctx.emit({
      type: "review.failed",
      correlationId,
      repo: job.repo,
      prNumber: job.prNumber,
      reason: `${result.failure.code}: ${result.failure.message}`.slice(0, 300),
      attempts: result.attempts.length,
    });
    // An unavailable model is retryable; a bad review is not. The queue can
    // hand this back later rather than burning the job.
    return { ok: false, error: `model unavailable: ${result.failure.code}`, retryable: true };
  }

  if (!result.review) {
    // The model answered but declined to submit. Retrying would just spend
    // tokens to get the same non-answer.
    return { ok: false, error: "the model produced no review", retryable: false };
  }

  const outcome = await postReview({
    gh,
    ref,
    pullNumber: job.prNumber,
    commitId: pr.headSha,
    summary: result.review.summary,
    comments: result.review.findings.map((f) => ({
      path: f.path,
      line: f.line,
      body: `**${f.severity}: ${f.title}**\n\n${f.detail}\n\n<sub>confidence: ${f.confidence}</sub>`,
    })),
    budget,
    dryRun: !ctx.post,
  });

  const severities: Record<string, number> = {};
  for (const f of result.review.findings) {
    severities[f.severity] = (severities[f.severity] ?? 0) + 1;
  }

  await ctx.emit({
    type: "review.completed",
    correlationId,
    repo: job.repo,
    prNumber: job.prNumber,
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

  return {
    ok: true,
    summary: `PR #${job.prNumber}: ${result.review.findings.length} finding(s), ${
      outcome.posted
        ? `posted ${outcome.url}`
        : outcome.alreadyReviewed
          ? `already reviewed at this commit, left ${outcome.url} alone`
          : "dry run"
    }, served by ${result.servedBy}`,
  };
}

/**
 * A push changes the corpus, so the index has to follow it or the next review
 * retrieves against stale code. Incremental by content hash: a one-file push
 * re-embeds one file.
 */
async function reindex(job: Job, ctx: HandlerContext): Promise<HandlerResult> {
  /**
   * A checkout is used when one exists, and the GitHub API otherwise.
   *
   * The orchestrator runs in a container with no checkout, so this used to
   * scan zero files - and zero scanned files meant "everything was deleted",
   * which emptied the index on every push while reporting success.
   */
  const hasCheckout = existsSync(join(ctx.repoRoot, "package.json"));
  let source;

  if (hasCheckout) {
    source = localSource(ctx.repoRoot);
  } else {
    const ref = parseRepo(job.repo);
    const gh = createClient(ctx.githubToken);
    // The pushed commit when we have it, so the index matches the event that
    // triggered it rather than whatever the branch has moved to since.
    const sha = job.headSha ?? (await fetchDefaultBranchSha(gh, ref));
    source = functionSource(githubRepoFiles(gh, ref, sha));
    ctx.logger.info("indexing from the GitHub API", { repo: job.repo, sha: sha.slice(0, 7) });
  }

  const stats = await indexRepo({
    repo: job.repo,
    repoRoot: ctx.repoRoot,
    source,
    pool: ctx.pool,
    embedder: new Embedder(ctx.apiKey),
    logger: ctx.logger,
  });

  return {
    ok: true,
    summary: `indexed ${stats.filesChanged}/${stats.filesScanned} changed, ${stats.chunksWritten} chunks, ${stats.importEdges} edges, ${stats.embedRequests} embed request(s) via ${source.kind}`,
  };
}

async function fetchDefaultBranchSha(
  gh: ReturnType<typeof createClient>,
  ref: ReturnType<typeof parseRepo>,
): Promise<string> {
  const { data } = await gh.rest.repos.get({ ...ref });
  const { data: branch } = await gh.rest.repos.getBranch({ ...ref, branch: data.default_branch });
  return branch.commit.sha;
}

/** Kept so the orchestrator can run without a checkout in Phase 6. */
export async function readLocal(root: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    return null;
  }
}

export function defaultRepoRoot(targetRepo: string): string {
  return join(homedir(), "Desktop", targetRepo.split("/")[1] ?? "");
}

export { createPool };
