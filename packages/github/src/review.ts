import type { Octokit } from "@octokit/rest";
import type { ActionBudget, RepoRef } from "./client.js";

export interface ReviewComment {
  path: string;
  line: number | null;
  body: string;
}

export interface PostReviewOptions {
  gh: Octokit;
  ref: RepoRef;
  pullNumber: number;
  commitId: string;
  summary: string;
  comments: ReviewComment[];
  budget: ActionBudget;
  dryRun?: boolean;
  /**
   * Skip posting when this commit already carries an SREctl review.
   * On by default; pass false only to deliberately post a second one.
   */
  skipIfAlreadyReviewed?: boolean;
}

export interface PostReviewResult {
  posted: boolean;
  reviewId?: number;
  url?: string;
  inlineComments: number;
  demotedToSummary: number;
  /** A review for this exact commit was already there, so nothing was posted. */
  alreadyReviewed?: boolean;
}

/**
 * Footer on every review we post, and the marker used to recognise our own
 * work on a later pass. It has to stay in the posted body for the duplicate
 * check to keep working.
 */
export const REVIEW_MARKER = "<sub>Posted by SREctl.";

/**
 * Posts one review with inline comments anchored to diff hunks.
 *
 * GitHub rejects the whole review if any comment points at a line outside the
 * diff, so anchors are checked against the actual patch first and anything
 * unanchorable is folded into the summary rather than lost.
 */
export async function postReview(opts: PostReviewOptions): Promise<PostReviewResult> {
  const { gh, ref, pullNumber, commitId } = opts;

  const anchorable: ReviewComment[] = [];
  const orphaned: ReviewComment[] = [];

  const files = await gh.paginate(gh.rest.pulls.listFiles, {
    ...ref,
    pull_number: pullNumber,
    per_page: 100,
  });
  const linesByPath = new Map(files.map((f) => [f.filename, addedLines(f.patch ?? "")]));

  for (const comment of opts.comments) {
    const lines = linesByPath.get(comment.path);
    if (comment.line !== null && lines?.has(comment.line)) anchorable.push(comment);
    else orphaned.push(comment);
  }

  const body = [
    opts.summary,
    orphaned.length
      ? "\n\n**Findings not anchored to a changed line:**\n" +
        orphaned
          .map((c) => `- \`${c.path}${c.line ? `:${c.line}` : ""}\` — ${c.body.replace(/\n+/g, " ")}`)
          .join("\n")
      : "",
    "\n\n<sub>Posted by SREctl. Findings are suggestions; a human merges.</sub>",
  ].join("");

  if (opts.dryRun) {
    return { posted: false, inlineComments: anchorable.length, demotedToSummary: orphaned.length };
  }

  /**
   * Pub/Sub is at-least-once, so the same review job can arrive twice - a pod
   * restart mid-review is enough. Ingest deduplicates on the GitHub delivery
   * ID, but that is upstream of the message already in flight, so it cannot
   * help here. Without this check the second delivery posts a second review on
   * the same commit, which is what happened on the first cloud run.
   */
  if (opts.skipIfAlreadyReviewed !== false) {
    opts.budget.spend("list pull request reviews");
    const existing = await gh.paginate(gh.rest.pulls.listReviews, {
      ...ref,
      pull_number: pullNumber,
      per_page: 100,
    });
    const mine = existing.find(
      (r) => r.commit_id === commitId && (r.body ?? "").includes(REVIEW_MARKER),
    );
    if (mine) {
      return {
        posted: false,
        alreadyReviewed: true,
        reviewId: mine.id,
        url: mine.html_url,
        inlineComments: anchorable.length,
        demotedToSummary: orphaned.length,
      };
    }
  }

  opts.budget.spend("create pull request review");
  const { data } = await gh.rest.pulls.createReview({
    ...ref,
    pull_number: pullNumber,
    commit_id: commitId,
    // COMMENT, never APPROVE or REQUEST_CHANGES: the agent files findings,
    // it does not gate a merge.
    event: "COMMENT",
    body,
    comments: anchorable.map((c) => ({ path: c.path, line: c.line as number, body: c.body })),
  });

  return {
    posted: true,
    reviewId: data.id,
    url: data.html_url,
    inlineComments: anchorable.length,
    demotedToSummary: orphaned.length,
  };
}

/** Line numbers in the file's NEW version that the diff actually touches. */
export function addedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }

    // "+++ b/file" and "--- a/file" are file headers, not content. GitHub's
    // patch field usually omits them, but a "+" prefix check alone would count
    // "+++ b/file" as an added line at position 0.
    if (!inHunk || raw.startsWith("+++ ") || raw.startsWith("--- ")) continue;

    if (raw.startsWith("+")) {
      lines.add(newLine);
      newLine += 1;
    } else if (raw.startsWith("-")) {
      // Removed lines do not advance the new-file counter.
    } else if (raw.startsWith(" ")) {
      newLine += 1;
    }
  }

  return lines;
}
