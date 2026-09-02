import {
  createLogger,
  MemoryDedupe,
  MemoryEventStore,
  MemoryQueue,
  type SrectlEvent,
} from "@srectl/core";
import { beforeEach, describe, expect, it } from "vitest";
import { handleDelivery, type HandlerDeps } from "./handler.js";
import { signBody } from "./verify.js";

const SECRET = "0123456789abcdef0123456789abcdef";

function makeDeps(): HandlerDeps & { store: MemoryEventStore; queue: MemoryQueue } {
  const store = new MemoryEventStore();
  const queue = new MemoryQueue();
  return {
    secret: SECRET,
    dedupe: new MemoryDedupe(),
    queue,
    store,
    logger: createLogger("error"),
  };
}

function delivery(payload: unknown, opts: { id?: string; event?: string; secret?: string } = {}) {
  const rawBody = JSON.stringify(payload);
  return {
    rawBody,
    signature: signBody(rawBody, opts.secret ?? SECRET),
    deliveryId: opts.id ?? "delivery-1",
    githubEvent: opts.event ?? "pull_request",
  };
}

const prOpened = {
  action: "opened",
  repository: { full_name: "rajveer-09/srectl-target" },
  pull_request: { number: 7, head: { sha: "abc1234" }, draft: false },
};

const types = (store: MemoryEventStore): SrectlEvent["type"][] => store.events.map((e) => e.type);

describe("handleDelivery", () => {
  let deps: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("accepts a signed pull_request.opened and enqueues one review job", async () => {
    const res = await handleDelivery(delivery(prOpened), deps);

    expect(res.status).toBe(202);
    expect(await deps.queue.size()).toBe(1);
    const [job] = await deps.queue.drain();
    expect(job).toMatchObject({
      id: "delivery-1",
      kind: "review_pr",
      repo: "rajveer-09/srectl-target",
      prNumber: 7,
      headSha: "abc1234",
    });
    expect(types(deps.store)).toEqual(["webhook.received", "job.enqueued"]);
  });

  it("returns 401 and enqueues nothing when the signature is wrong", async () => {
    const res = await handleDelivery(delivery(prOpened, { secret: "not-the-secret-xxxxxxx" }), deps);

    expect(res.status).toBe(401);
    expect(await deps.queue.size()).toBe(0);
    expect(types(deps.store)).toEqual(["webhook.rejected"]);
  });

  it("enqueues once when GitHub redelivers the same delivery ID", async () => {
    const d = delivery(prOpened);
    const first = await handleDelivery(d, deps);
    const second = await handleDelivery(d, deps);

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ duplicate: true });
    expect(await deps.queue.size()).toBe(1);
    expect(types(deps.store)).toContain("webhook.duplicate");
  });

  it("rejects a delivery with no X-GitHub-Delivery header", async () => {
    const d = { ...delivery(prOpened), deliveryId: null };
    const res = await handleDelivery(d, deps);

    expect(res.status).toBe(400);
    expect(await deps.queue.size()).toBe(0);
  });

  it("rejects a body that is signed but not JSON", async () => {
    const rawBody = "this is not json";
    const res = await handleDelivery(
      {
        rawBody,
        signature: signBody(rawBody, SECRET),
        deliveryId: "delivery-2",
        githubEvent: "pull_request",
      },
      deps,
    );

    expect(res.status).toBe(400);
    expect(types(deps.store)).toEqual(["webhook.rejected"]);
  });

  it("ignores pull_request actions we do not review", async () => {
    const res = await handleDelivery(delivery({ ...prOpened, action: "labeled" }), deps);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ignored: true });
    expect(await deps.queue.size()).toBe(0);
    expect(types(deps.store)).toEqual(["webhook.ignored"]);
  });

  it("ignores draft pull requests", async () => {
    const draft = { ...prOpened, pull_request: { ...prOpened.pull_request, draft: true } };
    const res = await handleDelivery(delivery(draft), deps);

    expect(res.body).toMatchObject({ ignored: true });
    expect(await deps.queue.size()).toBe(0);
  });

  it("turns a push into an index job", async () => {
    const push = {
      repository: { full_name: "rajveer-09/srectl-target" },
      after: "deadbeef",
      ref: "refs/heads/main",
    };
    const res = await handleDelivery(delivery(push, { id: "d-push", event: "push" }), deps);

    expect(res.status).toBe(202);
    const [job] = await deps.queue.drain();
    expect(job).toMatchObject({ kind: "index_push", headSha: "deadbeef" });
  });

  it("records a handling time on every accepted delivery", async () => {
    await handleDelivery(delivery(prOpened), deps);
    const received = deps.store.events.find((e) => e.type === "webhook.received");
    expect(received).toBeDefined();
    expect(received && "handlingMs" in received ? received.handlingMs : -1).toBeGreaterThanOrEqual(0);
  });
});
