import type { TriageBundle } from "./triage-bundle.js";

export interface Hypothesis {
  cause: string;
  confidence: "high" | "medium" | "low";
  /** Specific log lines or spec fields. A hypothesis with no evidence is a guess. */
  evidence: string[];
  nextStep: string;
  /** Which layer produced this: the rules engine or the model. */
  source: "rule" | "model";
}

export interface RuleResult {
  hypotheses: Hypothesis[];
  /** True when the rules were decisive and no model call is warranted. */
  conclusive: boolean;
  rule: string | null;
}

/**
 * Deterministic classifiers, run before any model call.
 *
 * OOMKilled with usage at the memory limit is a memory limit problem. There is
 * no ambiguity to resolve, no judgement to apply, and asking a model costs
 * money and latency to be told what the status field already said.
 *
 * The model is for genuinely ambiguous cases - an application stack trace that
 * could mean several things. Knowing which is which is the point; a system
 * that calls the model for everything has not understood its own problem.
 */
export function applyRules(bundle: TriageBundle): RuleResult {
  const { incident, spec, events } = bundle;

  /**
   * Both logs, previous first.
   *
   * `previous: true` is the right primary source - in a crash loop the current
   * container has usually just started and printed nothing. But the previous
   * container's log is not always retained by the runtime, and when it is
   * missing the evidence sits in the current (already terminated) container
   * instead. Reading only one of the two loses the cause roughly half the time,
   * and the failure is invisible: it looks like an unexplained crash.
   */
  const logs = [bundle.previousLogs, bundle.currentLogs].filter(Boolean).join("\n");

  // --- image cannot be pulled ------------------------------------------------
  if (incident.signal === "ImagePullBackOff") {
    const image = spec.image ?? "unknown";
    const detail = imagePullDetail(incident.message, events);

    return {
      conclusive: true,
      rule: "image-pull-failure",
      hypotheses: [
        {
          cause: `The image reference "${image}" cannot be pulled: ${detail.summary}`,
          confidence: "high",
          evidence: detail.evidence.length ? detail.evidence : [`container image: ${image}`],
          nextStep: `Verify the tag exists: \`docker manifest inspect ${image}\`. If the registry is private, check imagePullSecrets on the pod spec.`,
          source: "rule",
        },
      ],
    };
  }

  // --- killed for exceeding its memory limit ---------------------------------
  if (incident.signal === "OOMKilled") {
    const limit = spec.memoryLimit ?? "not set";
    const usage = bundle.usage?.memory ?? "unknown";

    return {
      conclusive: true,
      rule: "memory-limit-too-low",
      hypotheses: [
        {
          cause:
            spec.memoryLimit === null
              ? "The container was OOMKilled with no memory limit set, so it exceeded what the node could give it."
              : `The container's memory limit of ${limit} is lower than what it allocates.`,
          confidence: "high",
          evidence: [
            `container terminated with reason OOMKilled`,
            `memory limit: ${limit}`,
            `observed usage at last scrape: ${usage}`,
            `restarts: ${incident.restartCount}`,
          ],
          nextStep:
            "Raise resources.limits.memory, or profile the workload's peak allocation. If the limit was set from a guess rather than a measurement, measure it.",
          source: "rule",
        },
      ],
    };
  }

  // --- alive but never ready -------------------------------------------------
  if (incident.signal === "ProbeFailing") {
    const probe = spec.readinessProbe;
    const unhealthy = events.filter((e) => e.reason === "Unhealthy").slice(0, 3);

    return {
      conclusive: Boolean(probe),
      rule: "readiness-probe-failing",
      hypotheses: [
        {
          cause: probe
            ? `The readiness probe (${probe}) never succeeds, so the container runs but is never added to a Service.`
            : "The container is running but not ready, and no readiness probe is declared on the spec.",
          confidence: probe ? "high" : "low",
          evidence: [
            `phase: Running, ready: false, restarts: ${incident.restartCount}`,
            ...(probe ? [`readinessProbe: ${probe}`] : []),
            ...unhealthy.map((e) => `event: ${e.message}`),
          ],
          nextStep: probe
            ? "Check that the probe's port and path match what the process actually serves. A probe pointing at the wrong port fails identically to a broken application."
            : "Add a readiness probe, or check why the container reports itself unready.",
          source: "rule",
        },
      ],
    };
  }

  // --- exited non-zero: sometimes obvious, often not -------------------------
  if (incident.signal === "CrashLoopBackOff" || incident.signal === "Error") {
    const fatal = findFatalConfigLine(logs);
    if (fatal) {
      return {
        conclusive: true,
        rule: "missing-configuration",
        hypotheses: [
          {
            cause: `The container exits at startup because required configuration is absent: ${fatal.variable ?? "see log"}.`,
            confidence: "high",
            evidence: [
              `container log: ${fatal.line}`,
              `exit code: ${incident.exitCode ?? "unknown"}`,
              `env vars present: ${spec.env.length ? spec.env.join(", ") : "(none)"}`,
            ],
            nextStep: fatal.variable
              ? `Set ${fatal.variable} in the pod spec's env, or from a ConfigMap or Secret.`
              : "Supply the configuration the log names.",
            source: "rule",
          },
        ],
      };
    }

    // Genuinely ambiguous. This is what the model is for.
    return { conclusive: false, rule: null, hypotheses: [] };
  }

  return { conclusive: false, rule: null, hypotheses: [] };
}

function imagePullDetail(
  message: string | null,
  events: TriageBundle["events"],
): { summary: string; evidence: string[] } {
  const text = [message ?? "", ...events.map((e) => e.message)].join("\n");
  const evidence = events
    .filter((e) => e.reason === "Failed" || e.reason === "BackOff")
    .slice(0, 2)
    .map((e) => `event: ${e.message}`);

  if (/manifest unknown|manifest for .* not found|not found: manifest/i.test(text)) {
    return { summary: "the tag does not exist in that repository", evidence };
  }
  if (/repository does not exist|pull access denied|insufficient_scope/i.test(text)) {
    return { summary: "the repository does not exist or the token cannot read it", evidence };
  }
  if (/no such host|dial tcp|server misbehaving|lookup .* no such host/i.test(text)) {
    return { summary: "the registry host cannot be resolved", evidence };
  }
  if (/unauthorized|authentication required/i.test(text)) {
    return { summary: "the registry requires credentials that were not supplied", evidence };
  }
  return { summary: "the pull failed; see the events for the registry's response", evidence };
}

/**
 * Matches the shape of a startup configuration failure.
 *
 * Deliberately narrow. A broad match on the word "error" would classify every
 * application crash as a configuration problem and skip the model exactly when
 * it is needed.
 */
export function findFatalConfigLine(logs: string): { line: string; variable: string | null } | null {
  const patterns = [
    /^.*\b(?:FATAL|Error|error)\b[^\n]*\b([A-Z][A-Z0-9_]{2,})\b[^\n]*\b(?:is )?(?:required|missing|not set|not defined|must be set)\b.*$/m,
    /^.*\b(?:required|missing|not set|not defined|must be set)\b[^\n]*\b([A-Z][A-Z0-9_]{2,})\b.*$/m,
    /^.*\benvironment variable\b[^\n]*\b([A-Z][A-Z0-9_]{2,})\b.*$/m,
  ];

  for (const re of patterns) {
    const m = re.exec(logs);
    if (m) return { line: m[0].trim().slice(0, 300), variable: m[1] ?? null };
  }
  return null;
}
