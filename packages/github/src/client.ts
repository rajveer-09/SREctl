import { Octokit } from "@octokit/rest";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(fullName: string): RepoRef {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) throw new Error(`expected owner/name, got "${fullName}"`);
  return { owner, repo };
}

/**
 * Rate-limits actions per pull request. A hostile PR body cannot drive an
 * unbounded number of API calls, because the ceiling is enforced here rather
 * than by the model choosing to stop.
 */
export class ActionBudget {
  private used = 0;
  constructor(private readonly max: number) {}

  spend(what: string): void {
    this.used += 1;
    if (this.used > this.max) {
      throw new Error(`action budget exhausted (${this.max}) while attempting: ${what}`);
    }
  }

  get spent(): number {
    return this.used;
  }
}

export function createClient(token: string): Octokit {
  return new Octokit({
    auth: token,
    log: { debug() {}, info() {}, warn: console.warn, error: console.error },
  });
}
