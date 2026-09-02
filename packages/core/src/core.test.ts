import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileDedupe } from "./dedupe.js";
import { FileEventStore } from "./event-store.js";
import { newEvent, SrectlEventSchema } from "./events.js";
import { FileQueue, type Job } from "./queue.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "srectl-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("events", () => {
  it("stamps id and ts, and the result validates against the union", () => {
    const e = newEvent({
      type: "webhook.received",
      correlationId: "d1",
      deliveryId: "d1",
      githubEvent: "pull_request",
      repo: "a/b",
      prNumber: 3,
      handlingMs: 1.2,
    });

    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => SrectlEventSchema.parse(e)).not.toThrow();
  });

  it("rejects an event with an unknown type", () => {
    expect(SrectlEventSchema.safeParse({ type: "nope", id: "1", ts: "t", correlationId: "c" }).success).toBe(false);
  });
});

describe("FileEventStore", () => {
  it("round-trips appended events and returns [] before the file exists", async () => {
    const store = new FileEventStore(dir);
    expect(await store.read()).toEqual([]);

    const e = newEvent({
      type: "job.enqueued",
      correlationId: "c1",
      jobId: "j1",
      kind: "review_pr",
      repo: "a/b",
    });
    await store.append(e);
    await store.append(e);

    const read = await store.read();
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(e);
  });
});

describe("FileQueue", () => {
  const job: Job = {
    id: "j1",
    kind: "review_pr",
    repo: "a/b",
    prNumber: 1,
    receivedAt: new Date().toISOString(),
    raw: { hello: "world" },
  };

  it("enqueues, reports size, and empties on drain", async () => {
    const q = new FileQueue(dir);
    expect(await q.size()).toBe(0);

    await q.enqueue(job);
    await q.enqueue({ ...job, id: "j2" });
    expect(await q.size()).toBe(2);

    const drained = await q.drain();
    expect(drained.map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(await q.size()).toBe(0);
  });
});

describe("FileDedupe", () => {
  it("reports first sight as new and repeats as seen", async () => {
    const d = new FileDedupe(dir);
    expect(await d.seen("a")).toBe(false);
    expect(await d.seen("a")).toBe(true);
    expect(await d.seen("b")).toBe(false);
  });

  it("survives a process restart", async () => {
    await new FileDedupe(dir).seen("a");
    expect(await new FileDedupe(dir).seen("a")).toBe(true);
  });

  // A real burst hit ingest three times in 6ms after smee reconnected. Here
  // the calls all start before the first disk read resolves, which is the
  // cold-instance case: every ID must survive, not just the last one.
  it("records every ID when a burst arrives before the first load resolves", async () => {
    const d = new FileDedupe(dir);

    const first = await Promise.all([d.seen("a"), d.seen("b"), d.seen("c")]);
    expect(first).toEqual([false, false, false]);

    expect(await d.seen("a")).toBe(true);
    expect(await d.seen("b")).toBe(true);
    expect(await d.seen("c")).toBe(true);
  });

  it("keeps the same delivery ID single-use under concurrency", async () => {
    const d = new FileDedupe(dir);
    const results = await Promise.all([d.seen("dup"), d.seen("dup"), d.seen("dup")]);
    expect(results.filter((seen) => !seen)).toHaveLength(1);
  });
});
