# Security

SREctl reads untrusted repository content, sends it to a language model, and
executes generated code. Each of those is a boundary, and this document
describes what is enforced at each one.

Everything below is implemented and verified in this repository. Where a control
is partial, or deliberately absent, it says so.

## Reporting a vulnerability

Open a [security advisory](https://github.com/rajveer-09/SREctl/security/advisories/new),
or an issue if the finding is not sensitive. This is a personal project with no
SLA; expect a best-effort response rather than a guaranteed window.

## Webhook boundary

Ingest is the only component reachable from the internet.

- **Signatures are verified before parsing.** `X-Hub-Signature-256` is checked
  with HMAC-SHA256 over the exact received bytes, compared using
  `crypto.timingSafeEqual` rather than `===`, so the comparison does not leak
  the expected digest through timing. A body that fails is rejected and never
  parsed as JSON.
- **Deliveries are deduplicated** on GitHub's delivery ID before anything is
  published, so a redelivery cannot enqueue the same work twice.
- **Ingest holds only what it uses.** It loads the webhook secret and the
  database URL. It has no GitHub write token and no model key, so a compromise
  there cannot post to a repository or spend model quota.

## Untrusted content reaching the model

Diff hunks, file contents, pull request titles and commit messages are all
attacker-controlled on a public repository.

- **Untrusted content is wrapped**, never concatenated into the prompt. Each
  block is delimited by a random nonce generated per call, so content cannot
  close its own block by guessing the delimiter.
- **Prose is neutralised and code is preserved.** Instructions embedded in
  comments are flagged rather than followed; the code itself is passed through
  unchanged, because rewriting it would defeat the review.
- **The write allowlist is computed in code, before any model runs.** The set of
  paths that may be written is derived from the request, not proposed by the
  model, so a model that asks to write `.github/workflows/deploy.yml` is refused
  by a check that never consulted it. Hard-denied paths cannot enter the
  candidate set at all.
- A corpus of injection attempts is checked in as tests (21 tests in
  `packages/agents/src/untrusted.test.ts`), so a regression in the wrapping
  fails the build.

## Sandbox

Generated tests and repository test suites execute inside a Kubernetes Job, in a
namespace with Pod Security Admission set to `restricted` (enforce, audit and
warn).

Each sandbox pod runs with:

| Control | Setting |
|---|---|
| User | `runAsNonRoot`, uid 10001 |
| Root filesystem | `readOnlyRootFilesystem: true` |
| Privilege escalation | `allowPrivilegeEscalation: false` |
| Capabilities | `drop: ["ALL"]` |
| Seccomp | `RuntimeDefault` |
| Service account token | `automountServiceAccountToken: false` |
| Wall clock | `activeDeadlineSeconds` |
| Memory | cgroup limit, OOM-killed at the ceiling |

Network egress is denied by NetworkPolicy. Execution is split in two phases:
a prep Job installs dependencies with network access and `npm ci
--ignore-scripts`, then an exec Job runs the code with no network at all and a
read-only mount of the dependency cache, so generated code cannot poison it for
the next run.

**These are verified by trying to violate them.** `scripts/k8s-isolation.ts`
runs 11 checks — egress, DNS, cluster API reachability, mounted credentials,
filesystem writability, the dependency cache, the uid, the memory ceiling and
the deadline — plus a control case that runs the same image with no
NetworkPolicy and must succeed. The control matters: without it, a check that
fails for the wrong reason is indistinguishable from a check that passes. All 11
pass on GKE Autopilot with Dataplane V2, and on Minikube with Calico.

## Actions on GitHub

- **Reviews are comments.** A posted review uses `event: "COMMENT"`, never
  `APPROVE` or `REQUEST_CHANGES`, so the agent cannot satisfy a required-review
  rule or gate a merge.
- **No autonomous merges.** The agent opens pull requests and files findings.
  Humans merge.
- **API calls are capped.** Every write is spent against an `ActionBudget`, so a
  loop cannot exhaust a rate limit or open unbounded pull requests.

## Credentials

- **No service-account keys exist.** CI authenticates to Google Cloud through
  Workload Identity Federation. The OIDC provider carries an attribute condition
  binding it to a single repository, and the deploy account can only be
  impersonated by a principal set scoped to that same repository. There is no
  JSON key to leak, rotate, or find in a fork.
- **Secrets are per-service.** Each component requests only the secrets it uses,
  and IAM grants `secretAccessor` per secret rather than project-wide. The
  dashboard can read the database URL and nothing else; ingest cannot read the
  model key or the GitHub token.
- **Secrets are not in images.** Build contexts exclude every `.env` at any
  depth. This is verified by searching a built image's filesystem for the actual
  secret values, not by pattern matching.
- Runtime secrets are mounted from Secret Manager, never baked into an image or
  passed as a plaintext environment variable in a manifest.

## Known limitations

Stated rather than left to be discovered.

- **The deployed dashboard is public and unauthenticated.** It is deliberately
  `allUsers`-invokable for demonstration. It is read-only and exposes no
  credentials, but it does expose event history: repository names, pull request
  numbers, review findings and token counts. Anyone with the URL can read it.
- **The sandbox has not been audited by a third party.** The guarantees above
  are enforced and tested, but the threat model is container escape resistance
  on a managed cluster, not defence against a determined attacker with a kernel
  exploit.
- **A model can still be wrong.** Injection defences prevent instructions in
  repository content from being followed. They do not make findings correct.
  Every finding is a suggestion for a human.
- **The reliability monitor ranks hypotheses.** It does not claim root causes,
  and its output should not be treated as a diagnosis.
