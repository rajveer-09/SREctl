import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, loadEnv } from "@srectl/core";
import { createPool, Embedder, indexRepo, migrate } from "@srectl/retrieval";

const env = loadEnv();
if (!env.DATABASE_URL || !env.DATABASE_URL_DIRECT) throw new Error("DATABASE_URL(_DIRECT) not set — Gate 1.1");
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set — Gate 1.2");
if (!env.TARGET_REPO) throw new Error("TARGET_REPO not set (owner/name)");

const args = process.argv.slice(2);
const force = args.includes("--force");
const rootArg = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);
const repoRoot = rootArg ?? join(homedir(), "Desktop", env.TARGET_REPO.split("/")[1] ?? "");

const logger = createLogger(env.LOG_LEVEL, { svc: "indexer" });

const ran = await migrate(env.DATABASE_URL_DIRECT);
if (ran.length) logger.info("migrations applied", { ran });

const pool = createPool(env.DATABASE_URL);
try {
  const stats = await indexRepo({
    repo: env.TARGET_REPO,
    repoRoot,
    pool,
    embedder: new Embedder(env.GEMINI_API_KEY),
    logger,
    force,
  });

  const { rows } = await pool.query<{ path: string; chunks: string; importers: string }>(
    `SELECT f.path,
            (SELECT count(*) FROM file_chunks c  WHERE c.repo = f.repo AND c.path = f.path)     AS chunks,
            (SELECT count(*) FROM import_edges e WHERE e.repo = f.repo AND e.to_path = f.path)  AS importers
       FROM repo_files f
      WHERE f.repo = $1
      ORDER BY importers DESC, f.path`,
    [env.TARGET_REPO],
  );

  console.log("\n" + JSON.stringify(stats, null, 2) + "\n");
  console.log("corpus:");
  console.table(
    rows.map((r) => ({ path: r.path, chunks: Number(r.chunks), importedBy: Number(r.importers) })),
  );
} finally {
  await pool.end();
}
