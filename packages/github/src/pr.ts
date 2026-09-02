import type { Octokit } from "@octokit/rest";
import type { RepoRef } from "./client.js";

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff hunks. Absent for binary files and very large diffs. */
  patch: string | null;
}

export interface PullRequestData {
  number: number;
  title: string;
  body: string | null;
  author: string;
  headSha: string;
  baseRef: string;
  files: ChangedFile[];
}

/** Files whose diffs are noise for review and expensive in tokens. */
const IGNORED = [/^package-lock\.json$/, /^pnpm-lock\.yaml$/, /^yarn\.lock$/, /\.min\.(js|css)$/];

export async function fetchPullRequest(
  gh: Octokit,
  { owner, repo }: RepoRef,
  pull_number: number,
): Promise<PullRequestData> {
  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number });
  const files = await gh.paginate(gh.rest.pulls.listFiles, { owner, repo, pull_number, per_page: 100 });

  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    author: pr.user?.login ?? "unknown",
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    files: files
      .filter((f) => !IGNORED.some((re) => re.test(f.filename)))
      .map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? null,
      })),
  };
}

/** Returns null rather than throwing when the path does not exist at that ref. */
export async function fetchFile(
  gh: Octokit,
  { owner, repo }: RepoRef,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await gh.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}
