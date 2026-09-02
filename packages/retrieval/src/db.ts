import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * node-postgres currently treats sslmode=require as verify-full but warns that
 * it will adopt weaker libpq semantics in v9. State the intent explicitly.
 */
function harden(connectionString: string): string {
  return connectionString.replace(/sslmode=require\b/, "sslmode=verify-full");
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString: harden(connectionString),
    ssl: { rejectUnauthorized: true },
    max: 5,
  });
}

/**
 * Migrations run against the DIRECT connection, never the pooled one: the
 * pooler reuses sessions, so session-scoped statements do not behave the way
 * a migration assumes.
 */
export async function migrate(directConnectionString: string): Promise<string[]> {
  const client = new pg.Client({
    connectionString: harden(directConnectionString),
    ssl: { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query<{ name: string }>("SELECT name FROM _migrations");
    const applied = new Set(rows.map((r) => r.name));

    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        ran.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}

/** pgvector accepts a bracketed literal, not a Postgres array. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}
