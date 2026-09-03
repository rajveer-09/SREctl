import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { PubSub } from "@google-cloud/pubsub";
import { PubSubQueue } from "./pubsub-queue.js";
import type { Job } from "./queue.js";

/**
 * These cover one specific failure: pull() used to open a subscription, take a
 * message and close the stream before returning. Closing a streaming pull nacks
 * everything outstanding, so the ack() handed to the caller hit a dead stream
 * and the same job came back roughly once a second, forever. The logs showed
 * "job claimed" then "job done" on a loop, which reads exactly like success.
 */

class FakeSubscription extends EventEmitter {
  closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

function fakeClient(sub: FakeSubscription) {
  let subscriptionCalls = 0;
  const client = {
    subscription: () => {
      subscriptionCalls += 1;
      return sub;
    },
  } as unknown as PubSub;
  return { client, calls: () => subscriptionCalls };
}

function message(job: Partial<Job>) {
  let acked = 0;
  let nacked = 0;
  const full: Job = {
    id: "job-1",
    kind: "review_pr",
    repo: "acme/widgets",
    receivedAt: "2026-01-01T00:00:00.000Z",
    raw: {},
    ...job,
  };
  return {
    msg: {
      id: "m1",
      data: Buffer.from(JSON.stringify(full), "utf8"),
      ack: () => {
        acked += 1;
      },
      nack: () => {
        nacked += 1;
      },
    },
    acked: () => acked,
    nacked: () => nacked,
  };
}

describe("PubSubQueue", () => {
  it("leaves the subscription open so a later ack actually lands", async () => {
    const sub = new FakeSubscription();
    const { client } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    const pulling = queue.pull(1, 500);
    const m = message({ id: "job-a" });
    sub.emit("message", m.msg);

    const [pulled] = await pulling;
    expect(pulled?.job.id).toBe("job-a");

    // The regression: the stream must still be open at this point.
    expect(sub.closed).toBe(false);

    pulled!.ack();
    expect(m.acked()).toBe(1);
  });

  it("reuses one subscription across pulls instead of reopening per poll", async () => {
    const sub = new FakeSubscription();
    const { client, calls } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    await queue.pull(1, 10);
    await queue.pull(1, 10);
    await queue.pull(1, 10);

    expect(calls()).toBe(1);
  });

  it("returns an empty batch when nothing arrives before the timeout", async () => {
    const sub = new FakeSubscription();
    const { client } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    expect(await queue.pull(1, 20)).toEqual([]);
  });

  it("acks an unparseable message rather than letting it circulate", async () => {
    const sub = new FakeSubscription();
    const { client } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    const pulling = queue.pull(1, 100);
    let acked = 0;
    sub.emit("message", {
      id: "bad",
      data: Buffer.from("{not json", "utf8"),
      ack: () => {
        acked += 1;
      },
      nack: () => {},
    });

    expect(await pulling).toEqual([]);
    expect(acked).toBe(1);
  });

  it("retry() nacks so the job returns to the queue", async () => {
    const sub = new FakeSubscription();
    const { client } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    const pulling = queue.pull(1, 500);
    const m = message({ id: "job-b" });
    sub.emit("message", m.msg);
    const [pulled] = await pulling;

    pulled!.retry();
    expect(m.nacked()).toBe(1);
    expect(m.acked()).toBe(0);
  });

  it("close() shuts the stream down for shutdown draining", async () => {
    const sub = new FakeSubscription();
    const { client } = fakeClient(sub);
    const queue = new PubSubQueue("t", "s", { client });

    await queue.pull(1, 10);
    await queue.close();
    expect(sub.closed).toBe(true);
  });
});
