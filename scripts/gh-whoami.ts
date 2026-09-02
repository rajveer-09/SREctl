import { loadEnv } from "@srectl/core";
import { Octokit } from "@octokit/rest";

/**
 * Verifies the PAT by exercising it, not by trusting the settings page.
 *
 * Fine-grained PATs do not expose their permission set through an API field,
 * so every check here is behavioural. One rule makes a probe valid:
 *
 *   THE ENDPOINT MUST REQUIRE AUTHENTICATION.
 *
 * Two earlier probes failed that rule and produced false alarms:
 *   - GET /actions/workflows returns 200 with NO credentials on a public repo.
 *   - GET /user/repos lists public repos by affiliation, so a token scoped to
 *     one repository still enumerates every public repo the user owns.
 * Neither says anything about the token. Listing collaborators does: it is
 * 401 unauthenticated, so reachability there tracks real granted access.
 */
const env = loadEnv();
if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set — see Gate 1.3");
if (!env.TARGET_REPO) throw new Error("TARGET_REPO is not set (owner/name)");

const [owner, repo] = env.TARGET_REPO.split("/");
if (!owner || !repo) throw new Error(`TARGET_REPO must be owner/name, got "${env.TARGET_REPO}"`);

const gh = new Octokit({ auth: env.GITHUB_TOKEN, log: { debug() {}, info() {}, warn() {}, error() {} } });

async function reachable(fn: () => Promise<unknown>): Promise<{ reachable: boolean; status?: number }> {
  try {
    await fn();
    return { reachable: true, status: 200 };
  } catch (err) {
    return { reachable: false, status: (err as { status?: number }).status };
  }
}

const collaborators = (o: string, r: string) => () => gh.rest.repos.listCollaborators({ owner: o, repo: r });

const { data: user } = await gh.request("GET /user");
const { data: target } = await gh.rest.repos.get({ owner, repo });
const { data: pulls } = await gh.rest.pulls.list({ owner, repo, state: "all", per_page: 5 });

// --- scope: reachable on the target, refused everywhere else ------------------
const onTarget = await reachable(collaborators(owner, repo));

const others = (await gh.paginate(gh.rest.repos.listForAuthenticatedUser, { per_page: 100 }))
  .filter((r) => r.full_name !== env.TARGET_REPO)
  .slice(0, 3);

const onOthers = [];
for (const r of others) {
  const res = await reachable(collaborators(r.owner.login, r.name));
  onOthers.push({ repo: r.full_name, ...res });
}

const scopeOk = onTarget.reachable && onOthers.every((r) => !r.reachable);

// --- capabilities that must be denied on the target itself -------------------
const denials = [];
for (const [capability, permission, fn] of [
  ["actions.secrets.list", "Secrets: read", () => gh.rest.actions.listRepoSecrets({ owner, repo })],
  ["actions.permissions.get", "Administration: read", () => gh.request("GET /repos/{owner}/{repo}/actions/permissions", { owner, repo })],
  ["webhooks.list", "Administration: read", () => gh.rest.repos.listWebhooks({ owner, repo })],
  ["collaborators.add", "Administration: write", () => gh.rest.repos.addCollaborator({ owner, repo, username: "octocat" })],
] as const) {
  const res = await reachable(fn);
  denials.push({ capability, permission, denied: !res.reachable, status: res.status });
}

const allDenied = denials.every((d) => d.denied);
const pass = scopeOk && allDenied;

console.log(
  JSON.stringify(
    {
      login: user.login,
      scope: {
        targetReachable: onTarget,
        otherReposRefused: onOthers,
        verdict: scopeOk ? "scoped to the target repository only" : "TOKEN REACHES REPOSITORIES IT SHOULD NOT",
      },
      target: { fullName: target.full_name, defaultBranch: target.default_branch, pullsSeen: pulls.length },
      mustBeDenied: denials,
      verdict: pass ? "PASS" : "FAIL",
    },
    null,
    2,
  ),
);

if (!pass) process.exitCode = 1;
