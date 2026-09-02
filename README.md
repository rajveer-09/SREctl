# SREctl

Autonomous code review and reliability agent. Reviews pull requests with
repository-aware context, writes unit tests and verifies they work before
proposing them, executes untrusted code inside a hardened Kubernetes sandbox,
and watches the same cluster for failing workloads.

TypeScript, Google ADK, Kubernetes.

## Layout

```
apps/ingest        webhook receiver — HMAC verification, dedupe, enqueue
apps/dashboard     Next.js console — SSE event stream, retrieval traces, funnel
packages/core      event vocabulary, event store, queue, config
packages/retrieval hybrid retrieval — ts-morph import graph + pgvector
packages/agents    review, test-generation and SRE agents; trust boundary
packages/sandbox   two-phase execution — DockerRunner and K8sJobRunner
packages/github    Octokit client, path allowlist, PR and review writers
packages/monitor   Watch API, incident correlation, deterministic triage rules
infra/             runner image, Kubernetes namespace, NetworkPolicy, RBAC
eval/              chaos fixtures and scoring harness
```

## Setup

```bash
pnpm install
cp .env.example .env      # fill in: webhook secret, Neon URL, Gemini key, PAT
pnpm db:migrate
pnpm build:runner         # builds and loads the sandbox image
```

## Commands

```bash
pnpm test                 # unit tests
pnpm typecheck

pnpm index                # build the import graph and embed the corpus
pnpm retrieve --pr N      # print the context bundle with per-item reasons
pnpm review --pr N        # review a PR (add --post to publish)
pnpm testgen              # generate → run → repair → mutation-score → PR

pnpm test:isolation       # prove the sandbox guarantees on Kubernetes
pnpm chaos:up             # seed deliberately broken pods
pnpm eval:chaos           # score triage accuracy against known faults

pnpm dev:dashboard        # console on :3100
pnpm models               # model chain status and quota cooldowns
```

## Design constraints

- Nothing is proposed that has not been executed. A generated test that has not
  run is a guess.
- Repository content is untrusted input. It is wrapped, never followed, and the
  path allowlist is computed in code before any model runs.
- The reliability monitor ranks hypotheses with cited evidence. It does not
  claim root causes.
- No autonomous writes to production. The agent opens pull requests; humans
  merge.

## License

MIT © 2026 Rajveer Sharma
