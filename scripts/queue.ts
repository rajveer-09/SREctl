import { loadEnv, PgQueue } from "@srectl/core";
import { createPool } from "@srectl/retrieval";

const env = loadEnv();
const action = process.argv[2] ?? "stats";

if (action === "migrate") {
  await PgQueue.migrate(env.DATABASE_URL_DIRECT!);
  console.log("jobs table ready");
  process.exit(0);
}

const pool = createPool(env.DATABASE_URL!);
try {
  console.table(await new PgQueue(pool).stats());
} finally {
  await pool.end();
}
