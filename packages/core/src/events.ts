import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * The append-only event vocabulary for the whole system.
 *
 * Every subsystem writes into this union rather than inventing its own log
 * shape, because the dashboard renders exactly these types. Adding a subsystem
 * means adding members here first.
 *
 * The two views worth building - the retrieval trace and the test funnel - are
 * the reason `retrieval.completed` carries per-item reasons and
 * `testgen.attempt` is emitted per attempt rather than once per run. A schema
 * that only records outcomes can only ever show outcomes.
 */

const base = {
  id: z.string(),
  ts: z.string(),
  correlationId: z.string(),
};

/** Token accounting, carried on anything that calls a model. */
export const UsageSchema = z.object({
  promptTokens: z.number(),
  thoughtTokens: z.number(),
  candidateTokens: z.number().optional(),
  totalTokens: z.number(),
  /**
   * Which model actually served this call.
   *
   * Automatic fallback means a run can be served by a different model than the
   * one requested. Without recording it, "first-attempt pass rate" silently
   * becomes two blended populations and stops meaning anything.
   */
  model: z.string().optional(),
});

// --- ingest ------------------------------------------------------------------

export const WebhookReceivedSchema = z.object({
  ...base,
  type: z.literal("webhook.received"),
  deliveryId: z.string(),
  githubEvent: z.string(),
  action: z.string().optional(),
  repo: z.string().optional(),
  prNumber: z.number().int().optional(),
  handlingMs: z.number(),
});

export const WebhookRejectedSchema = z.object({
  ...base,
  type: z.literal("webhook.rejected"),
  reason: z.enum([
    "missing_signature",
    "malformed_signature",
    "bad_signature",
    "missing_delivery_id",
    "unparseable_body",
  ]),
  deliveryId: z.string().optional(),
  handlingMs: z.number(),
});

export const WebhookDuplicateSchema = z.object({
  ...base,
  type: z.literal("webhook.duplicate"),
  deliveryId: z.string(),
  githubEvent: z.string(),
  handlingMs: z.number(),
});

export const WebhookIgnoredSchema = z.object({
  ...base,
  type: z.literal("webhook.ignored"),
  deliveryId: z.string(),
  githubEvent: z.string(),
  action: z.string().optional(),
  handlingMs: z.number(),
});

export const JobEnqueuedSchema = z.object({
  ...base,
  type: z.literal("job.enqueued"),
  jobId: z.string(),
  kind: z.string(),
  repo: z.string(),
  prNumber: z.number().int().optional(),
});

// --- retrieval and review ----------------------------------------------------

/** One row of the retrieval trace: what was pulled in, and why. */
export const BundleItemSchema = z.object({
  tier: z.enum(["diff", "structural", "semantic", "conventions"]),
  path: z.string(),
  reason: z.string(),
  tokens: z.number(),
  score: z.number().optional(),
});

export const RetrievalCompletedSchema = z.object({
  ...base,
  type: z.literal("retrieval.completed"),
  repo: z.string(),
  prNumber: z.number().int(),
  items: z.array(BundleItemSchema),
  dropped: z.array(z.object({ path: z.string(), tier: z.string(), tokens: z.number() })),
  estimatedTokens: z.number(),
  actualTokens: z.number().optional(),
  baselineTokens: z.number(),
  structuralMs: z.number(),
  semanticMs: z.number(),
  totalMs: z.number(),
});

export const ReviewCompletedSchema = z.object({
  ...base,
  type: z.literal("review.completed"),
  repo: z.string(),
  prNumber: z.number().int(),
  findings: z.number(),
  severities: z.record(z.string(), z.number()).optional(),
  usage: UsageSchema,
  latencyMs: z.number(),
  posted: z.boolean(),
  url: z.string().optional(),
  injectionFindings: z.number(),
});

export const ReviewFailedSchema = z.object({
  ...base,
  type: z.literal("review.failed"),
  repo: z.string(),
  prNumber: z.number().int(),
  reason: z.string(),
  attempts: z.number(),
});

// --- test generation (the funnel) --------------------------------------------

export const TestgenStartedSchema = z.object({
  ...base,
  type: z.literal("testgen.started"),
  repo: z.string(),
  target: z.string(),
  uncoveredLines: z.number(),
  importers: z.number(),
  rankScore: z.number(),
  runner: z.string(),
});

/**
 * Per attempt, not per run. "37% fail on first attempt, 71% pass after one
 * repair" is only answerable if every attempt is recorded, including the ones
 * that failed.
 */
export const TestgenAttemptSchema = z.object({
  ...base,
  type: z.literal("testgen.attempt"),
  repo: z.string(),
  target: z.string(),
  attempt: z.number(),
  outcome: z.string(),
  testsPassed: z.number().optional(),
  testsFailed: z.number().optional(),
  failureSummary: z.string().optional(),
  usage: UsageSchema,
  durationMs: z.number(),
});

export const TestgenMutationSchema = z.object({
  ...base,
  type: z.literal("testgen.mutation"),
  repo: z.string(),
  target: z.string(),
  score: z.number().nullable(),
  killed: z.number(),
  survived: z.number(),
  timeout: z.number(),
  threshold: z.number(),
  cleared: z.boolean(),
  durationMs: z.number(),
});

export const TestgenCompletedSchema = z.object({
  ...base,
  type: z.literal("testgen.completed"),
  repo: z.string(),
  target: z.string(),
  accepted: z.boolean(),
  reason: z.string(),
  attempts: z.number(),
  coverageBefore: z.number().optional(),
  coverageAfter: z.number().optional(),
  prUrl: z.string().optional(),
  totalDurationMs: z.number(),
});

// --- sandbox -----------------------------------------------------------------

export const SandboxExecSchema = z.object({
  ...base,
  type: z.literal("sandbox.exec"),
  runner: z.enum(["docker", "k8s"]),
  purpose: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  oomKilled: z.boolean(),
  durationMs: z.number(),
});

// --- reliability -------------------------------------------------------------

export const IncidentOpenedSchema = z.object({
  ...base,
  type: z.literal("incident.opened"),
  incidentId: z.string(),
  namespace: z.string(),
  podName: z.string(),
  workload: z.string(),
  signal: z.string(),
  restartCount: z.number(),
});

export const IncidentTriagedSchema = z.object({
  ...base,
  type: z.literal("incident.triaged"),
  incidentId: z.string(),
  topCause: z.string(),
  confidence: z.string(),
  /** Which layer answered. Restraint is only visible if it is recorded. */
  source: z.enum(["rule", "model"]),
  ruleName: z.string().nullable(),
  hypotheses: z.number(),
  evidenceCount: z.number(),
  usage: UsageSchema.optional(),
  durationMs: z.number(),
});

export const IncidentResolvedSchema = z.object({
  ...base,
  type: z.literal("incident.resolved"),
  incidentId: z.string(),
  openForMs: z.number(),
});

// --- union -------------------------------------------------------------------

export const SrectlEventSchema = z.discriminatedUnion("type", [
  WebhookReceivedSchema,
  WebhookRejectedSchema,
  WebhookDuplicateSchema,
  WebhookIgnoredSchema,
  JobEnqueuedSchema,
  RetrievalCompletedSchema,
  ReviewCompletedSchema,
  ReviewFailedSchema,
  TestgenStartedSchema,
  TestgenAttemptSchema,
  TestgenMutationSchema,
  TestgenCompletedSchema,
  SandboxExecSchema,
  IncidentOpenedSchema,
  IncidentTriagedSchema,
  IncidentResolvedSchema,
]);

export type SrectlEvent = z.infer<typeof SrectlEventSchema>;
export type SrectlEventType = SrectlEvent["type"];

/** Distributive Omit, so the union stays a union after stripping fields. */
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type NewEventInput = DistOmit<SrectlEvent, "id" | "ts">;

export function newEvent(input: NewEventInput): SrectlEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    ...input,
  } as SrectlEvent;
}

/** Which subsystem an event belongs to, for the cost tracker. */
export function subsystemOf(type: SrectlEventType): string {
  if (type.startsWith("webhook") || type.startsWith("job")) return "ingest";
  if (type.startsWith("retrieval") || type.startsWith("review")) return "review";
  if (type.startsWith("testgen")) return "testgen";
  if (type.startsWith("sandbox")) return "sandbox";
  return "reliability";
}
