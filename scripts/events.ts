import { readFile } from "node:fs/promises";
import { createLogger, loadEnv, PgEventStore, SrectlEventSchema } from "@srectl/core";
import { createPool } from "@srectl/retrieval";

/**
 * Gate 5.1: promote the event store from JSONL to Postgres and backfill what
 * earlier phases already produced, so the dashboard opens with real numbers
 * rather than an empty state.
 */
const env = loadEnv();
const action = process.argv[2] ?? "stats";
const logger = createLogger(env.LOG_LEVEL, { svc: "events" });

if (action === "migrate") {
  await PgEventStore.migrate(env.DATABASE_URL_DIRECT!);
  logger.info("events schema applied");
  process.exit(0);
}

const pool = createPool(env.DATABASE_URL!);
const store = new PgEventStore(pool);

try {
  if (action === "backfill") {
    const path = process.argv[3] ?? ".data/events.jsonl";
    const raw = await readFile(path, "utf8").catch(() => "");
    const events = raw
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((line) => {
        const parsed = SrectlEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      });

    const written = await store.appendMany(events);
    console.log(`backfilled ${written} event(s) from ${path}`);
  }

  const counts = await store.countsByType();
  console.log(`\ntotal events: ${counts.reduce((s, c) => s + c.count, 0)} | max seq: ${await store.maxSeq()}`);
  console.table(counts);

  const tokens = await store.tokensBySubsystem();
  if (tokens.length) {
    console.log("\ntoken spend by subsystem:");
    console.table(tokens);
  }
} finally {
  await pool.end();
}
