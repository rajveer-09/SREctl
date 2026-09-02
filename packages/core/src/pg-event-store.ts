import pg from "pg";
import type { EventStore } from "./event-store.js";
import { SrectlEventSchema, subsystemOf, type SrectlEvent } from "./events.js";

export interface StoredEvent {
  /** Monotonic, gap-free per row. This is what Last-Event-ID resumes from. */
  seq: number;
  event: SrectlEvent;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq            bigserial PRIMARY KEY,
  id             text        NOT NULL UNIQUE,
  ts             timestamptz NOT NULL,
  type           text        NOT NULL,
  subsystem      text        NOT NULL,
  correlation_id text        NOT NULL,
  payload        jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS events_type_idx        ON events (type, seq DESC);
CREATE INDEX IF NOT EXISTS events_correlation_idx ON events (correlation_id, seq);
CREATE INDEX IF NOT EXISTS events_ts_idx          ON events (ts DESC);
`;

/**
 * Append-only event store.
 *
 * `seq` rather than a timestamp for ordering and resumption: two events written
 * in the same millisecond are indistinguishable by time, and a reconnecting
 * client that resumes from a timestamp either replays or skips them. A
 * bigserial gives an unambiguous cursor.
 *
 * Writes are idempotent on the event's own id, so a retried append cannot
 * duplicate a row - which matters because the ingest path already deduplicates
 * on delivery ID and should not be undone here.
 */
export class PgEventStore implements EventStore {
  constructor(private readonly pool: pg.Pool) {}

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

  async append(event: SrectlEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO events (id, ts, type, subsystem, correlation_id, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [event.id, event.ts, event.type, subsystemOf(event.type), event.correlationId, event],
    );
  }

  async appendMany(events: SrectlEvent[]): Promise<number> {
    if (events.length === 0) return 0;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await client.query(
          `INSERT INTO events (id, ts, type, subsystem, correlation_id, payload)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [event.id, event.ts, event.type, subsystemOf(event.type), event.correlationId, event],
        );
      }
      await client.query("COMMIT");
      return events.length;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async read(): Promise<SrectlEvent[]> {
    return (await this.since(0, 10_000)).map((r) => r.event);
  }

  /** Everything after `seq`, oldest first. The SSE resume path. */
  async since(seq: number, limit = 500): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query<{ seq: string; payload: unknown }>(
      `SELECT seq, payload FROM events WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
      [seq, limit],
    );
    return rows.flatMap((row) => {
      const parsed = SrectlEventSchema.safeParse(row.payload);
      // A row written by an older schema version must not break the stream for
      // everything after it.
      return parsed.success ? [{ seq: Number(row.seq), event: parsed.data }] : [];
    });
  }

  /** The most recent events, newest first. What a fresh page load renders. */
  async latest(limit = 100): Promise<StoredEvent[]> {
    const { rows } = await this.pool.query<{ seq: string; payload: unknown }>(
      `SELECT seq, payload FROM events ORDER BY seq DESC LIMIT $1`,
      [limit],
    );
    return rows.flatMap((row) => {
      const parsed = SrectlEventSchema.safeParse(row.payload);
      return parsed.success ? [{ seq: Number(row.seq), event: parsed.data }] : [];
    });
  }

  async maxSeq(): Promise<number> {
    const { rows } = await this.pool.query<{ max: string | null }>(
      "SELECT MAX(seq)::text AS max FROM events",
    );
    return Number(rows[0]?.max ?? 0);
  }

  async countsByType(): Promise<Array<{ type: string; count: number }>> {
    const { rows } = await this.pool.query<{ type: string; count: string }>(
      "SELECT type, count(*)::text AS count FROM events GROUP BY type ORDER BY count DESC",
    );
    return rows.map((r) => ({ type: r.type, count: Number(r.count) }));
  }

  /** Cumulative token spend per subsystem, for the cost view. */
  async tokensBySubsystem(): Promise<Array<{ subsystem: string; tokens: number; calls: number }>> {
    const { rows } = await this.pool.query<{ subsystem: string; tokens: string; calls: string }>(
      `SELECT subsystem,
              COALESCE(SUM((payload->'usage'->>'totalTokens')::bigint), 0)::text AS tokens,
              COUNT(payload->'usage')::text AS calls
         FROM events
        WHERE payload ? 'usage'
        GROUP BY subsystem
        ORDER BY 2 DESC`,
    );
    return rows.map((r) => ({
      subsystem: r.subsystem,
      tokens: Number(r.tokens),
      calls: Number(r.calls),
    }));
  }
}
