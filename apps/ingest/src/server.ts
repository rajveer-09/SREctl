import { serve } from "@hono/node-server";
import {
  createLogger,
  FileDedupe,
  FileEventStore,
  FileQueue,
  loadEnv,
} from "@srectl/core";
import { Hono } from "hono";
import { handleDelivery, type HandlerDeps } from "./handler.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL, { svc: "ingest" });

const deps: HandlerDeps = {
  secret: env.GITHUB_WEBHOOK_SECRET,
  dedupe: new FileDedupe(env.DATA_DIR),
  queue: new FileQueue(env.DATA_DIR),
  store: new FileEventStore(env.DATA_DIR),
  logger,
};

const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "srectl-ingest" }));

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
