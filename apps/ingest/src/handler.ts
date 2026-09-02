import {
  newEvent,
  type Dedupe,
  type EventStore,
  type Job,
  type Logger,
  type Queue,
} from "@srectl/core";
import { z } from "zod";
import { verifySignature } from "./verify.js";

export interface HandlerDeps {
  secret: string;
  dedupe: Dedupe;
  queue: Queue;
  store: EventStore;
  logger: Logger;
}

export interface DeliveryInput {
  rawBody: string;
  signature: string | null;
  deliveryId: string | null;
  githubEvent: string | null;
}

export interface DeliveryOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Payload extraction is deliberately narrow. The webhook body is attacker-
 * influenced, so we pull out the few fields we need through a schema and
 * ignore the rest of the shape.
 */
const PayloadSchema = z.object({
  action: z.string().optional(),
  repository: z.object({ full_name: z.string() }).optional(),
  pull_request: z
    .object({
      number: z.number().int(),
      head: z.object({ sha: z.string() }).optional(),
      draft: z.boolean().optional(),
    })
    .optional(),
  after: z.string().optional(),
  ref: z.string().optional(),
});

const REVIEWABLE_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

export async function handleDelivery(
  input: DeliveryInput,
  deps: HandlerDeps,
): Promise<DeliveryOutcome> {
  const started = performance.now();
  const ms = () => Math.round((performance.now() - started) * 1000) / 1000;

  const verdict = verifySignature(input.rawBody, input.signature, deps.secret);
  if (!verdict.ok) {
    await deps.store.append(
      newEvent({
        type: "webhook.rejected",
        correlationId: input.deliveryId ?? "unknown",
        reason: verdict.reason,
        ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
        handlingMs: ms(),
      }),
    );
    deps.logger.warn("webhook rejected", { reason: verdict.reason, handlingMs: ms() });
    return { status: 401, body: { ok: false, error: "signature verification failed" } };
  }

  if (!input.deliveryId) {
    await deps.store.append(
      newEvent({
        type: "webhook.rejected",
        correlationId: "unknown",
        reason: "missing_delivery_id",
        handlingMs: ms(),
      }),
    );
    return { status: 400, body: { ok: false, error: "missing X-GitHub-Delivery" } };
  }

  const correlationId = input.deliveryId;
  const githubEvent = input.githubEvent ?? "unknown";
  const log = deps.logger.child({ correlationId, githubEvent });

  // Dedupe before parsing: a retry of a body we cannot parse is still a retry.
  if (await deps.dedupe.seen(input.deliveryId)) {
    await deps.store.append(
      newEvent({
        type: "webhook.duplicate",
        correlationId,
        deliveryId: input.deliveryId,
        githubEvent,
        handlingMs: ms(),
      }),
    );
    log.info("duplicate delivery ignored", { handlingMs: ms() });
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  let payload: z.infer<typeof PayloadSchema>;
  try {
    payload = PayloadSchema.parse(JSON.parse(input.rawBody));
  } catch {
    await deps.store.append(
      newEvent({
        type: "webhook.rejected",
        correlationId,
        reason: "unparseable_body",
        deliveryId: input.deliveryId,
        handlingMs: ms(),
      }),
    );
    return { status: 400, body: { ok: false, error: "unparseable body" } };
  }

  const repo = payload.repository?.full_name;
  const job = toJob(input.deliveryId, githubEvent, payload);

  if (!job || !repo) {
    await deps.store.append(
      newEvent({
        type: "webhook.ignored",
        correlationId,
        deliveryId: input.deliveryId,
        githubEvent,
        ...(payload.action ? { action: payload.action } : {}),
        handlingMs: ms(),
      }),
    );
    log.debug("event ignored", { action: payload.action, handlingMs: ms() });
    return { status: 200, body: { ok: true, ignored: true } };
  }

  await deps.queue.enqueue(job);

  const handlingMs = ms();
  await deps.store.append(
    newEvent({
      type: "webhook.received",
      correlationId,
      deliveryId: input.deliveryId,
      githubEvent,
      ...(payload.action ? { action: payload.action } : {}),
      repo,
      ...(job.prNumber !== undefined ? { prNumber: job.prNumber } : {}),
      handlingMs,
    }),
  );
  await deps.store.append(
    newEvent({
      type: "job.enqueued",
      correlationId,
      jobId: job.id,
      kind: job.kind,
      repo,
      ...(job.prNumber !== undefined ? { prNumber: job.prNumber } : {}),
    }),
  );

  log.info("delivery accepted", { kind: job.kind, repo, prNumber: job.prNumber, handlingMs });
  return { status: 202, body: { ok: true, jobId: job.id, kind: job.kind, handlingMs } };
}

function toJob(
  deliveryId: string,
  githubEvent: string,
  payload: z.infer<typeof PayloadSchema>,
): Job | null {
  const repo = payload.repository?.full_name;
  if (!repo) return null;
  const receivedAt = new Date().toISOString();

  if (githubEvent === "pull_request" && payload.pull_request) {
    if (!payload.action || !REVIEWABLE_ACTIONS.has(payload.action)) return null;
    if (payload.pull_request.draft) return null;
    return {
      id: deliveryId,
      kind: "review_pr",
      repo,
      prNumber: payload.pull_request.number,
      ...(payload.pull_request.head?.sha ? { headSha: payload.pull_request.head.sha } : {}),
      receivedAt,
      raw: payload,
    };
  }

  if (githubEvent === "push") {
    return {
      id: deliveryId,
      kind: "index_push",
      repo,
      ...(payload.after ? { headSha: payload.after } : {}),
      receivedAt,
      raw: payload,
    };
  }

  return null;
}
