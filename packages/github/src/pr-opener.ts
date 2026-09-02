import type { Octokit } from "@octokit/rest";
import type { ActionBudget, RepoRef } from "./client.js";
import type { Allowlist } from "./allowlist.js";

export interface OpenPrOptions {
  gh: Octokit;
  ref: RepoRef;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
  allowlist: Allowlist;
  budget: ActionBudget;
  dryRun?: boolean;
}

export interface OpenPrResult {
  opened: boolean;
  number?: number;
  url?: string;
  branch: string;
}

/**
 * Opens a pull request with generated files on a new branch.
 *
 * Never pushes to the default branch and never merges. Every path is checked
 * against the allowlist here as well as at generation time - this is the last
 * point before the GitHub API, so it is the one that has to be right.
 */
export async function openPullRequest(opts: OpenPrOptions): Promise<OpenPrResult> {
  const { gh, ref } = opts;

  for (const file of opts.files) {
    opts.allowlist.assert(file.path);
  }

  if (opts.dryRun) {
    return { opened: false, branch: opts.branchName };
  }

  opts.budget.spend("read base ref");
  const { data: base } = await gh.rest.git.getRef({
    ...ref,
    ref: `heads/${opts.baseBranch}`,
  });

  opts.budget.spend("create branch");
  await gh.rest.git.createRef({
    ...ref,
    ref: `refs/heads/${opts.branchName}`,
    sha: base.object.sha,
  });

  for (const file of opts.files) {
    opts.budget.spend(`write ${file.path}`);
    // Look up an existing blob so an update carries the right sha; a create
    // must not send one at all.
    let sha: string | undefined;
    try {
      const { data } = await gh.rest.repos.getContent({
        ...ref,
        path: file.path,
        ref: opts.branchName,
      });
      if (!Array.isArray(data) && "sha" in data) sha = data.sha;
    } catch {
      sha = undefined;
    }

    await gh.rest.repos.createOrUpdateFileContents({
      ...ref,
      path: file.path,
      message: `test: add coverage for ${file.path}`,
      content: Buffer.from(file.content, "utf8").toString("base64"),
      branch: opts.branchName,
      ...(sha ? { sha } : {}),
    });
  }

  opts.budget.spend("open pull request");
  const { data: pr } = await gh.rest.pulls.create({
    ...ref,
    title: opts.title,
    head: opts.branchName,
    base: opts.baseBranch,
    body: opts.body,
  });

  return { opened: true, number: pr.number, url: pr.html_url, branch: opts.branchName };
}
