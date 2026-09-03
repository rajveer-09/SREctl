import { PubSub, type Message, type Subscription } from "@google-cloud/pubsub";
import { JobSchema, type Job, type Queue } from "./queue.js";
import type { Logger } from "./log.js";

/**
 * Pub/Sub implementation of the same Queue interface FileQueue and PgQueue
 * implement. Callers do not change.
 *
 * This is the boundary that makes the deployment shape work at all: ingest
 * runs on Cloud Run and must answer GitHub inside ~10s, while the orchestrator
 * runs inside the cluster and takes minutes. Cloud Run cannot reach a Postgres
 * queue inside a private cluster without VPC plumbing, and should not need to.
 *
 * Two properties are configured on the subscription rather than here:
 *   - a 600s ack deadline, because a review takes minutes and a shorter one
 *     redelivers while the first attempt is still running, reviewing the pull
 *     request twice;
 *   - a dead-letter topic after 5 attempts, so a poison job stops circulating
 *     instead of being retried forever.
 */
export class PubSubQueue implements Queue {
  private readonly pubsub: PubSub;
  /**
   * One subscription for the life of the process.
   *
   * This used to be opened and closed inside pull(), which was silently
   * catastrophic: closing a streaming pull nacks everything still outstanding,
   * so the ack() handed to the caller landed on a dead stream and Pub/Sub
   * redelivered the job about once a second, forever. It read as success in
   * the logs - "job claimed", "job done", over and over on the same id - and
   * for a review job it would have re-run the model on every redelivery.
   */
  private subscription: Subscription | undefined;
  private readonly ready: PulledJob[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly topicName: string,
    private readonly subscriptionName: string,
    opts: { projectId?: string; logger?: Logger; client?: PubSub } = {},
  ) {
    // `client` exists so the redelivery behaviour can be tested without a real
    // Pub/Sub: the bug this class had was only observable in ack plumbing.
    this.pubsub = opts.client ?? new PubSub(opts.projectId ? { projectId: opts.projectId } : {});
    this.logger = opts.logger;
  }

  private readonly logger: Logger | undefined;

  /**
   * Publishes with the delivery ID as an ordering key and attribute.
   *
   * Pub/Sub is at-least-once, so it cannot promise the exactly-once semantics
   * the Postgres queue got from a primary key. Deduplication therefore still
   * happens at ingest, on the GitHub delivery ID, before anything is published.
   */
  async enqueue(job: Job): Promise<void> {
    await this.pubsub.topic(this.topicName).publishMessage({
      data: Buffer.from(JSON.stringify(job), "utf8"),
      attributes: { jobId: job.id, kind: job.kind, repo: job.repo },
    });
  }

  /**
   * Pulls a batch, leaving each message unacknowledged.
   *
   * The caller acks on success and nacks on a retryable failure, which is the
   * Pub/Sub equivalent of PgQueue's complete/release split: a model outage
   * must return the job to the queue rather than burn it.
   */
  async pull(max = 1, timeoutMs = 10_000): Promise<PulledJob[]> {
    this.open(max);

    if (this.ready.length === 0) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.waiters = this.waiters.filter((w) => w !== finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        this.waiters.push(finish);
      });
    }

    return this.ready.splice(0, max);
  }

  /** Opens the subscription on first use and keeps it open. */
  private open(max: number): void {
    if (this.subscription || this.closed) return;

    // maxMessages bounds how many go unacked at once, which is what actually
    // limits concurrency here - the worker asks for `concurrency` at a time.
    const sub = this.pubsub.subscription(this.subscriptionName, {
      flowControl: { maxMessages: max, allowExcessMessages: false },
    });

    sub.on("message", (message: Message) => {
      let parsed;
      try {
        parsed = JobSchema.safeParse(JSON.parse(message.data.toString("utf8")));
      } catch {
        parsed = { success: false } as const;
      }

      if (!parsed.success) {
        // Unparseable: ack it, or it circulates until the dead-letter policy
        // catches it, wasting a delivery attempt each time.
        this.logger?.warn("dropping unparseable job", { id: message.id });
        message.ack();
        return;
      }

      this.ready.push({
        job: parsed.data,
        ack: () => message.ack(),
        retry: () => message.nack(),
      });

      const waiter = this.waiters.shift();
      if (waiter) waiter();
    });

    sub.on("error", (err) => {
      this.logger?.error("subscription error", { error: (err as Error).message });
      const waiter = this.waiters.shift();
      if (waiter) waiter();
    });

    this.subscription = sub;
  }

  /**
   * Closes the stream. Anything pulled but not yet acked is redelivered, which
   * is what we want on shutdown: the worker drains in-flight jobs first, and
   * whatever it never got to goes back to the queue rather than being lost.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter();
    await this.subscription?.close();
    this.subscription = undefined;
  }

  /** Interface compatibility. Prefer pull(), which exposes ack and retry. */
  async drain(): Promise<Job[]> {
    const pulled = await this.pull(100);
    for (const p of pulled) p.ack();
    return pulled.map((p) => p.job);
  }

  async size(): Promise<number> {
    // Pub/Sub does not expose an exact depth; the metric is in Cloud Monitoring
    // and is approximate by design. Reporting -1 is more honest than a zero
    // that would read as "queue empty".
    return -1;
  }
}

export interface PulledJob {
  job: Job;
  /** Done. The message will not be redelivered. */
  ack: () => void;
  /** Failed for a reason unrelated to the job. Redeliver it. */
  retry: () => void;
}
