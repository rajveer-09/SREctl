import {
  createEmitter,
  createLogger,
  loadEnv,
  loadSecrets,
  PgEventStore,
  PgQueue,
  PubSubQueue,
  type PulledJob,
} from "@srectl/core";

// Secret Manager in the cluster, environment locally.
// The orchestrator is the component that actually reviews code, so it needs
// the model key and a write token. It is not reachable from outside the
// cluster; ingest reaches it only through Pub/Sub.
await loadSecrets({ only: ["DATABASE_URL", "GEMINI_API_KEY", "GITHUB_TOKEN"] });
import { createPool } from "@srectl/retrieval";
import { defaultRepoRoot, handle } from "./handlers.js";

/**
 * The orchestrator.
 *
 * Ingest must answer GitHub inside its ~10s delivery timeout, and agent work
 * takes minutes, so the two cannot be the same process. Ingest verifies,
 * deduplicates and enqueues; this drains the queue and runs the agents.
 *
 * Concurrency is ONE by default, and that is a considered choice rather than a
 * simplification: the free tier allows a handful of model requests per minute,
 * so two workers racing would rate-limit each other into a fallback chain and
 * make every run slower AND worse. The setting exists for when that stops
 * being true.
 */
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
const once = args.includes("--once");
/**
 * Posting is opt-in from either side: `--post` locally, SRECTL_POST=true in a
 * deployment. A Deployment has no natural place to pass a CLI flag, and a
 * worker that reviews correctly but silently discards every result looks
 * identical in the logs to one that is working.
 */
const post = args.includes("--post") || process.env["SRECTL_POST"] === "true";
const pollMs = Number(args.find((a) => a.startsWith("--poll="))?.split("=")[1] ?? 3000);
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? 1);

const logger = createLogger(env.LOG_LEVEL, { svc: "orchestrator" });
const pool = createPool(env.DATABASE_URL!);
const emit = createEmitter(new PgEventStore(pool), logger);

/**
 * Pub/Sub when deployed, Postgres locally.
 *
 * Both give the same property the orchestrator depends on: a job is claimed by
 * exactly one worker, and a retryable failure returns it rather than burning
 * it. Postgres gets that from SKIP LOCKED, Pub/Sub from ack/nack.
 */
const subscription = process.env["SRECTL_PUBSUB_SUBSCRIPTION"];
const pubsub = subscription
  ? new PubSubQueue(process.env["SRECTL_PUBSUB_TOPIC"] ?? "", subscription, { logger })
  : null;
const queue = new PgQueue(pool);

const ctx = {
  pool,
  emit,
  logger,
  apiKey: env.GEMINI_API_KEY!,
  githubToken: env.GITHUB_TOKEN!,
  targetRepo: env.TARGET_REPO!,
  repoRoot: defaultRepoRoot(env.TARGET_REPO!),
  post,
};

let running = true;
let inFlight = 0;

/**
 * Stop taking new work, let what is running finish.
 *
 * Killing mid-review leaves a claimed job nobody will pick up until the stale
 * sweep releases it, and possibly a half-posted review.
 */
function shutdown(signal: string): void {
  if (!running) return;
  running = false;
  logger.info("draining before exit", { signal, inFlight });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

logger.info("orchestrator started", {
  backend: pubsub ? "pubsub" : "postgres",
  concurrency,
  pollMs,
  post,
  repo: env.TARGET_REPO,
  mode: once ? "once" : "continuous",
});

// Postgres only: a worker that died mid-job left its claim behind, and without
// this sweep the job is invisible forever while the queue looks empty. Pub/Sub
// does the equivalent itself when the ack deadline expires.
if (!pubsub) {
  const released = await queue.releaseStale(15);
  if (released > 0) logger.warn("released stale claims", { released });
}

try {
  do {
    // One shape for both backends: a job plus how to finish or return it.
    const claimed: PulledJob[] = pubsub
      ? await pubsub.pull(concurrency, Math.max(pollMs, 10_000))
      : (await queue.claim(concurrency)).map((job) => ({
          job,
          ack: () => void queue.complete(job.id),
          retry: () => void queue.release(job.id),
        }));

    if (claimed.length === 0) {
      if (once) break;
      await sleep(pollMs);
      continue;
    }

    await Promise.all(
      claimed.map(async ({ job, ack, retry }) => {
        inFlight += 1;
        const started = performance.now();
        const log = logger.child({ jobId: job.id, kind: job.kind });

        try {
          log.info("job claimed", { repo: job.repo, pr: job.prNumber });
          const result = await handle(job, ctx);
          const ms = Math.round(performance.now() - started);

          if (result.ok) {
            ack();
            log.info("job done", { ms, summary: result.summary });
          } else if (result.retryable) {
            // Handed back, not burned: redelivered once the upstream recovers.
            retry();
            log.warn("job deferred, will retry", { ms, error: result.error });
          } else {
            if (!pubsub) await queue.complete(job.id, result.error);
            else ack();
            log.warn("job failed", { ms, error: result.error });
          }
        } catch (err) {
          // An unexpected throw is not classified, so it is settled rather
          // than retried: a crash loop on a poison job is worse than a lost one.
          if (!pubsub) await queue.complete(job.id, (err as Error).message.slice(0, 500));
          else ack();
          log.error("job threw", { error: (err as Error).message });
        } finally {
          inFlight -= 1;
        }
      }),
    );
  } while (running && !once);

  logger.info("orchestrator stopped", pubsub ? { backend: "pubsub" } : await queue.stats());
} finally {
  // Closing the subscription nacks anything pulled but not acked, returning it
  // to the queue instead of waiting out the 600s ack deadline.
  await pubsub?.close();
  await pool.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
