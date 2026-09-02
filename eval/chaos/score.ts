import type { Hypothesis } from "@srectl/monitor";
import type { FaultClass } from "./cases.js";

/**
 * Maps a free-text hypothesis onto a fault class so it can be scored.
 *
 * Ordered, not scored by keyword count: "the memory limit is too low" contains
 * the word "limit", and so does "the image pull rate limit was exceeded". The
 * most specific discriminator has to win, which means checking in order rather
 * than tallying matches.
 */
export function classify(text: string): FaultClass | "unknown" {
  const t = text.toLowerCase();

  /**
   * "bad-image" means the image could not be PULLED, not that an image was
   * mentioned. Matching the bare word "image" was wrong: a correct diagnosis
   * of an application crash legitimately says "the container image runs Node
   * 24.20.0, which fails the assertion expecting 18.0.0" - naming the image
   * because that is where the runtime comes from. Requiring pull-failure
   * vocabulary keeps the class meaning what it says.
   */
  if (
    /\b(imagepullbackoff|errimagepull|manifest)\b/.test(t) ||
    /\b(image|tag|repository|registry)\b[^.]{0,60}\b(pull|not found|does not exist|cannot be resolved|unauthorized|denied|misspell)/.test(
      t,
    ) ||
    /\bpull(ed|ing)?\b[^.]{0,40}\b(image|tag|manifest|registry)\b/.test(t)
  ) {
    return "bad-image";
  }
  if (/\boom|out of memory|memory limit|exceeds? (its )?memory|memory ceiling\b/.test(t)) {
    return "memory-limit-too-low";
  }
  if (/\b(readiness|liveness)?\s*probe\b|never (becomes? )?ready|not ready\b/.test(t)) {
    return "failing-probe";
  }
  if (
    /environment variable|env var|\bconfiguration\b|\bnot set\b|\bmissing\b.*\b(config|variable|secret)\b/.test(
      t,
    ) ||
    /\b[A-Z][A-Z0-9_]{2,}\b.*\b(required|missing|not set)\b/.test(text)
  ) {
    return "missing-env-var";
  }
  if (/\bmemory\b/.test(t)) return "memory-limit-too-low";

  // Checked LAST: an application fault is recognised by what it is not, so any
  // earlier branch would shadow it.
  if (
    /\b(typeerror|referenceerror|assertionerror|assertion|exception|stack trace|econnrefused|unhandled)\b|cannot read|dereference|\bnull\b|\bundefined\b|\breject(ed|ion)?\b/.test(
      t,
    )
  ) {
    return "application-error";
  }

  return "unknown";
}

export interface ScoredIncident {
  case: string;
  expected: FaultClass;
  top1: FaultClass | "unknown";
  top1Correct: boolean;
  top3Correct: boolean;
  confidence: string;
  source: "rule" | "model" | "none";
  evidenceCount: number;
  detectionLatencyMs: number | null;
  /**
   * Set when triage could not run at all - an upstream 429 or 503, not a wrong
   * answer. Scoring these as failures understates accuracy and, worse, hides
   * an outage behind a quality number.
   */
  unavailable?: string;
}

export function scoreIncident(opts: {
  caseName: string;
  expected: FaultClass;
  hypotheses: Hypothesis[];
  detectionLatencyMs: number | null;
  unavailable?: string | undefined;
}): ScoredIncident {
  const [top] = opts.hypotheses;
  const top1 = top ? classify(top.cause) : "unknown";
  const top3 = opts.hypotheses.slice(0, 3).map((h) => classify(h.cause));

  return {
    case: opts.caseName,
    expected: opts.expected,
    top1,
    top1Correct: top1 === opts.expected,
    top3Correct: top3.includes(opts.expected),
    confidence: top?.confidence ?? "none",
    source: top?.source ?? "none",
    evidenceCount: top?.evidence.length ?? 0,
    detectionLatencyMs: opts.detectionLatencyMs,
    ...(opts.unavailable ? { unavailable: opts.unavailable } : {}),
  };
}

export function summarize(scored: ScoredIncident[]): {
  total: number;
  scorable: number;
  unavailable: number;
  top1: number;
  top3: number;
  top1Pct: number;
  top3Pct: number;
  byRule: number;
  byModel: number;
  latencyP50: number | null;
  latencyP95: number | null;
} {
  // Accuracy is measured over cases where triage actually ran.
  const scorable = scored.filter((s) => !s.unavailable);
  const total = scorable.length;
  const top1 = scorable.filter((s) => s.top1Correct).length;
  const top3 = scorable.filter((s) => s.top3Correct).length;
  const latencies = scored
    .map((s) => s.detectionLatencyMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);

  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 1000) / 10);
  const quantile = (q: number) =>
    latencies.length === 0 ? null : latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;

  return {
    total,
    scorable: total,
    unavailable: scored.length - total,
    top1,
    top3,
    top1Pct: pct(top1),
    top3Pct: pct(top3),
    byRule: scored.filter((s) => s.source === "rule").length,
    byModel: scored.filter((s) => s.source === "model").length,
    latencyP50: quantile(0.5),
    latencyP95: quantile(0.95),
  };
}
