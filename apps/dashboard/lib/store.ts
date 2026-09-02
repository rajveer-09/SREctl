import { PgEventStore } from "@srectl/core";
import pg from "pg";

/**
 * One pool per process. Next.js re-evaluates modules on every hot reload in
 * development, and a new pool per reload exhausts Neon's connection limit
 * within a few edits.
 */
const globalForPool = globalThis as unknown as { srectlPool?: pg.Pool };

export function getStore(): PgEventStore {
  globalForPool.srectlPool ??= new pg.Pool({
    connectionString: (process.env.DATABASE_URL ?? "").replace(
      /sslmode=require\b/,
      "sslmode=verify-full",
    ),
    ssl: { rejectUnauthorized: true },
    max: 4,
  });
  return new PgEventStore(globalForPool.srectlPool);
}
