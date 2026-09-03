import pg from "pg";
import { JobSchema, type Job, type Queue } from "./queue.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id           text PRIMARY KEY,
  kind         text        NOT NULL,
  repo         text        NOT NULL,
  payload      jsonb       NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at   timestamptz,
  claimed_by   text,
  attempts     integer     NOT NULL DEFAULT 0,
  done_at      timestamptz,
  error        text
);

CREATE INDEX IF NOT EXISTS jobs_pending_idx
  ON jobs (enqueued_at) WHERE done_at IS NULL AND claimed_at IS NULL;
`;

/**
 * Postgres-backed work queue.
 *
 * FileQueue was fine while one process both received and handled webhooks. It
 * stops working the moment ingest and the orchestrator are separate processes -
 * which they are by design, because ingest must answer GitHub in under ten
 * seconds and agent work takes minutes.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`: two orchestrators started by accident
 * take different jobs rather than both running the same review and posting it
 * twice. Phase 6 swaps this for Pub/Sub, which gives the same property with
 * managed delivery; the interface does not change.
 */
export class PgQueue implements Queue {
  constructor(
    private readonly pool: pg.Pool,
    private readonly owner: string = `worker-${process.pid}`,
  ) {}

  static async migrate(directConnectionString: string): Promise<void> {
    const client = new pg.Client({
      connectionString: directConnectionString.replace(/sslmode=require\b/, "sslmode=verify-full"),
      ssl: { rejectUnauthorized: true },
    });
    await client.connect();
    try {
      await client.query(SCHEMA);
    } finally {
      await client.end();
    }
  }

  /** Idempotent on the delivery ID, so a GitHub retry cannot double-queue. */
  async enqueue(job: Job): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (id, kind, repo, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [job.id, job.kind, job.repo, job],
    );
  }

  /**
   * Claims up to `limit` pending jobs.
   *
   * SKIP LOCKED rather than a plain SELECT: without it, two workers read the
   * same row, both run the agent, and the pull request gets two reviews.
   */
  async claim(limit = 1): Promise<Job[]> {
    const { rows } = await this.pool.query<{ payload: unknown }>(
      `UPDATE jobs SET claimed_at = now(), claimed_by = $1, attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
           WHERE done_at IS NULL AND claimed_at IS NULL
           ORDER BY enqueued_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING payload`,
      [this.owner, limit],
    );

    return rows.flatMap((r) => {
      const parsed = JobSchema.safeParse(r.payload);
      return parsed.success ? [parsed.data] : [];
    });
  }

  async complete(id: string, error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET done_at = now(), error = $2 WHERE id = $1`,
      [id, error ?? null],
    );
  }

  /**
   * Hands a claimed job back for a later attempt.
   *
   * For failures that say nothing about the job itself - an unavailable model,
   * a network blip. Marking those "done with error" burns work that would have
   * succeeded five minutes later, and quietly turns an outage into data loss.
   */
  async release(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET claimed_at = NULL, claimed_by = NULL WHERE id = $1 AND done_at IS NULL`,
      [id],
    );
  }

  /**
   * Returns a claimed-but-unfinished job to the queue.
   *
   * A worker killed mid-job leaves its claim behind, and without this the job
   * is invisible forever - the queue looks empty while work is silently lost.
   */
  async releaseStale(olderThanMinutes = 15): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET claimed_at = NULL, claimed_by = NULL
        WHERE done_at IS NULL
          AND claimed_at IS NOT NULL
          AND claimed_at < now() - ($1 || ' minutes')::interval
          AND attempts < 3`,
      [olderThanMinutes],
    );
    return rowCount ?? 0;
  }

  /** Drains without claiming. Kept for the Queue interface and for tests. */
  async drain(): Promise<Job[]> {
    const jobs = await this.claim(1000);
    for (const job of jobs) await this.complete(job.id);
    return jobs;
  }

  async size(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM jobs WHERE done_at IS NULL AND claimed_at IS NULL`,
    );
    return Number(rows[0]?.n ?? 0);
  }

  async stats(): Promise<{ pending: number; claimed: number; done: number; failed: number }> {
    const { rows } = await this.pool.query<{
      pending: string;
      claimed: string;
      done: string;
      failed: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE done_at IS NULL AND claimed_at IS NULL)::text AS pending,
         count(*) FILTER (WHERE done_at IS NULL AND claimed_at IS NOT NULL)::text AS claimed,
         count(*) FILTER (WHERE done_at IS NOT NULL AND error IS NULL)::text AS done,
         count(*) FILTER (WHERE error IS NOT NULL)::text AS failed
       FROM jobs`,
    );
    const r = rows[0];
    return {
      pending: Number(r?.pending ?? 0),
      claimed: Number(r?.claimed ?? 0),
      done: Number(r?.done ?? 0),
      failed: Number(r?.failed ?? 0),
    };
  }
}
