import { serve } from "@hono/node-server";
import {
  createLogger,
  FileDedupe,
  FileEventStore,
  FileQueue,
  loadEnv,
  loadSecrets,
  PgEventStore,
  PgQueue,
  PubSubQueue,
} from "@srectl/core";
import pg from "pg";

// In GCP the configuration lives in Secret Manager; locally it is already in
// the environment. loadSecrets() handles both, so nothing below has to care.
// Only what ingest uses. It verifies signatures and enqueues; it has no
// reason to hold the Gemini key or a GitHub write token, and this is the
// service exposed to the internet.
await loadSecrets({ only: ["GITHUB_WEBHOOK_SECRET", "DATABASE_URL"] });
import { Hono, type Context } from "hono";
import { handleDelivery, type HandlerDeps } from "./handler.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, { svc: "ingest" });

/**
 * Postgres when it is configured, files otherwise.
 *
 * The file-backed pair was fine while one process both received and handled
 * webhooks. Ingest and the orchestrator are separate processes by design -
 * ingest must answer GitHub inside its ~10s timeout while agent work takes
 * minutes - so they need shared storage, not two views of the same directory.
 * The fallback keeps `pnpm dev:ingest` working with no database at all.
 */
const pool = env.DATABASE_URL
  ? new pg.Pool({
      connectionString: env.DATABASE_URL.replace(/sslmode=require/, "sslmode=verify-full"),
      ssl: { rejectUnauthorized: true },
      max: 4,
    })
  : null;

/**
 * Pub/Sub in the cloud, Postgres locally.
 *
 * This is the boundary the deployment shape depends on: ingest runs on Cloud
 * Run and must answer inside ~10s, while the orchestrator runs inside the
 * cluster and takes minutes. Cloud Run cannot reach a Postgres queue in a
 * private cluster without VPC plumbing, and does not need to.
 */
const useCloudQueue = Boolean(process.env["SRECTL_PUBSUB_TOPIC"]);
const queue = useCloudQueue
  ? new PubSubQueue(process.env["SRECTL_PUBSUB_TOPIC"]!, "", { logger })
  : pool
    ? new PgQueue(pool, "ingest")
    : new FileQueue(env.DATA_DIR);

const deps: HandlerDeps = {
  secret: env.GITHUB_WEBHOOK_SECRET,
  // Deduplication stays HERE, before publishing, because Pub/Sub is
  // at-least-once and cannot promise what the Postgres primary key did.
  dedupe: new FileDedupe(env.DATA_DIR),
  queue,
  store: pool ? new PgEventStore(pool) : new FileEventStore(env.DATA_DIR),
  logger,
};

logger.info("storage selected", {
  queue: useCloudQueue ? "pubsub" : pool ? "postgres" : "files",
  events: pool ? "postgres" : "files",
});

const app = new Hono();

/**
 * Health is served on both paths deliberately.
 *
 * Google's frontend intercepts the literal path `/healthz` on *.run.app and
 * answers it itself with an HTML 404 - the request never reaches the container.
 * Every other path, `/healthz/` included, is forwarded normally. So a probe
 * against /healthz reports the service as down while it is serving traffic
 * perfectly well. `/health` is the one that works on Cloud Run; `/healthz` is
 * kept for Kubernetes and local runs, where it is not intercepted.
 */
const health = (c: Context) => c.json({ ok: true, service: "srectl-ingest" });
app.get("/health", health);
app.get("/healthz", health);

app.post("/webhook", async (c) => {
  // Raw text, before any parsing — the signature is over these exact bytes.
  const rawBody = await c.req.text();

  const outcome = await handleDelivery(
    {
      rawBody,
      signature: c.req.header("x-hub-signature-256") ?? null,
      deliveryId: c.req.header("x-github-delivery") ?? null,
      githubEvent: c.req.header("x-github-event") ?? null,
    },
    deps,
  );

  return c.json(outcome.body, outcome.status as 200);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info("ingest listening", { port: info.port, url: `http://localhost:${info.port}/webhook` });
});
