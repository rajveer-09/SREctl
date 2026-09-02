import { loadEnv } from "@srectl/core";
import pg from "pg";

const env = loadEnv();
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set — see Gate 1.1");

// Neon's string says sslmode=require. node-postgres currently treats that as
// verify-full but warns that it will adopt weaker libpq semantics in v9. Say
// what we actually want, so the behaviour survives that change.
const connectionString = env.DATABASE_URL.replace(/sslmode=require\b/, "sslmode=verify-full");

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true } });

const started = performance.now();
await client.connect();
const connectMs = Math.round(performance.now() - started);

// A pg Client is a single connection and cannot run queries concurrently —
// Promise.all here silently serializes and emits a deprecation warning.
const version = await client.query<{ v: string }>("SELECT version() AS v");
const vector = await client.query<{ extversion: string }>(
  "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
);
const hnsw = await client.query("SELECT amname FROM pg_am WHERE amname = 'hnsw'");

// Prove the vector type works, rather than trusting the extension row.
// The pooled URL reuses the underlying session, so a TEMP table can outlive
// what looks like a fresh connection — drop it rather than assume it is gone.
await client.query("DROP TABLE IF EXISTS _srectl_probe");
await client.query("CREATE TEMP TABLE _srectl_probe (id int, embedding vector(3))");
await client.query("INSERT INTO _srectl_probe VALUES (1, '[1,2,3]'), (2, '[4,5,6]')");
const nearest = await client.query<{ id: number; d: string }>(
  "SELECT id, embedding <=> '[1,2,3]' AS d FROM _srectl_probe ORDER BY d LIMIT 1",
);

await client.end();

console.log(
  JSON.stringify(
    {
      ok: true,
      connectMs,
      postgres: version.rows[0]?.v.split(" ").slice(0, 2).join(" ") ?? "unknown",
      pgvector: vector.rows[0]?.extversion ?? null,
      hnswIndexAvailable: hnsw.rowCount === 1,
      cosineProbe: { nearestId: nearest.rows[0]?.id, distance: Number(nearest.rows[0]?.d) },
    },
    null,
    2,
  ),
);
