import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import { assessPod, IncidentCorrelator } from "./correlator.js";
import { applyRules, findFatalConfigLine } from "./rules.js";
import { isGone } from "./watcher.js";
import type { TriageBundle } from "./triage-bundle.js";

function pod(overrides: Partial<V1Pod["status"]> & { name?: string; owner?: string } = {}): V1Pod {
  const { name = "app-1", owner, ...status } = overrides;
  return {
    metadata: {
      name,
      namespace: "test",
      ...(owner ? { ownerReferences: [{ apiVersion: "apps/v1", kind: "ReplicaSet", name: owner, uid: "u" }] } : {}),
    },
    status: { phase: "Running", ...status },
  };
}

const containerStatus = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) => [
  { name: "app", image: "x", imageID: "", ready: false, restartCount: 0, ...state, ...extra },
];

describe("assessPod", () => {
  it("reports OOMKilled from the CURRENT terminated state", () => {
    const health = assessPod(
      pod({ containerStatuses: containerStatus({ state: { terminated: { reason: "OOMKilled", exitCode: 137 } } }) }),
    );
    expect(health.signal).toBe("OOMKilled");
    expect(health.exitCode).toBe(137);
  });

  /**
   * The case that makes naive detection wrong: once a container restarts, the
   * OOM reason moves to lastState and `waiting.reason` only says
   * CrashLoopBackOff. Reporting the loop discards the one field that names the
   * cause.
   */
  it("reports OOMKilled from lastState even when waiting says CrashLoopBackOff", () => {
    const health = assessPod(
      pod({
        containerStatuses: containerStatus(
          { state: { waiting: { reason: "CrashLoopBackOff" } } },
          { lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } }, restartCount: 3 },
        ),
      }),
    );
    expect(health.signal).toBe("OOMKilled");
    expect(health.restartCount).toBe(3);
  });

  it("reports ImagePullBackOff and ErrImagePull alike", () => {
    for (const reason of ["ImagePullBackOff", "ErrImagePull"]) {
      const health = assessPod(pod({ containerStatuses: containerStatus({ state: { waiting: { reason } } }) }));
      expect(health.signal).toBe("ImagePullBackOff");
    }
  });

  it("reports a plain non-zero exit as Error", () => {
    const health = assessPod(
      pod({ containerStatuses: containerStatus({ state: { terminated: { reason: "Error", exitCode: 1 } } }) }),
    );
    expect(health.signal).toBe("Error");
  });

  // Running-but-unready never crashes, so a crash-oriented monitor misses it
  // entirely - the pod just silently never serves traffic.
  it("reports a running-but-unready container as ProbeFailing", () => {
    const health = assessPod(
      pod({ phase: "Running", containerStatuses: containerStatus({ state: { running: {} } }, { ready: false }) }),
    );
    expect(health.signal).toBe("ProbeFailing");
  });

  it("reports a healthy pod as Healthy", () => {
    const health = assessPod(
      pod({ phase: "Running", containerStatuses: containerStatus({ state: { running: {} } }, { ready: true }) }),
    );
    expect(health.signal).toBe("Healthy");
  });
});

describe("IncidentCorrelator", () => {
  const crash = { signal: "CrashLoopBackOff" as const, reason: "CrashLoopBackOff", message: null, restartCount: 1, exitCode: 1, hasPrevious: true };

  /**
   * A crash-looping pod emits an event every few seconds. One incident per
   * event means fifteen broken pods produce hundreds of "incidents" and the
   * signal disappears into its own noise.
   */
  it("folds repeated observations into one incident", () => {
    const c = new IncidentCorrelator();
    const p = pod({ name: "app-1" });

    const first = c.observe(p, crash, "2026-01-01T00:00:00Z");
    const second = c.observe(p, { ...crash, restartCount: 2 }, "2026-01-01T00:00:05Z");
    const third = c.observe(p, { ...crash, restartCount: 3 }, "2026-01-01T00:00:10Z");

    expect(first?.id).toBe(second?.id);
    expect(second?.id).toBe(third?.id);
    expect(c.openIncidents()).toHaveLength(1);
    expect(third?.observations).toBe(3);
    expect(third?.restartCount).toBe(3);
  });

  it("treats a replaced pod of the same workload as the same incident", () => {
    const c = new IncidentCorrelator();
    c.observe(pod({ name: "web-abc", owner: "web-rs" }), crash, "2026-01-01T00:00:00Z");
    c.observe(pod({ name: "web-xyz", owner: "web-rs" }), crash, "2026-01-01T00:01:00Z");

    expect(c.openIncidents()).toHaveLength(1);
  });

  it("keeps unrelated workloads apart", () => {
    const c = new IncidentCorrelator();
    c.observe(pod({ name: "a" }), crash, "2026-01-01T00:00:00Z");
    c.observe(pod({ name: "b" }), crash, "2026-01-01T00:00:00Z");
    expect(c.openIncidents()).toHaveLength(2);
  });

  it("sharpens CrashLoopBackOff into OOMKilled, never the reverse", () => {
    const c = new IncidentCorrelator();
    const p = pod({ name: "app-1" });
    c.observe(p, crash, "2026-01-01T00:00:00Z");

    const sharpened = c.observe(p, { ...crash, signal: "OOMKilled", reason: "OOMKilled" }, "2026-01-01T00:00:05Z");
    expect(sharpened?.signal).toBe("OOMKilled");

    const notBlunted = c.observe(p, crash, "2026-01-01T00:00:10Z");
    expect(notBlunted?.signal).toBe("OOMKilled");
  });

  it("closes an incident when the workload recovers", () => {
    const c = new IncidentCorrelator();
    const p = pod({ name: "app-1" });
    c.observe(p, crash, "2026-01-01T00:00:00Z");
    c.observe(p, { ...crash, signal: "Healthy" }, "2026-01-01T00:01:00Z");
    expect(c.openIncidents()).toHaveLength(0);
  });
});

function bundle(over: Partial<TriageBundle> = {}): TriageBundle {
  return {
    incident: {
      id: "i1", namespace: "test", podName: "app-1", workload: "Pod/app-1",
      signal: "CrashLoopBackOff", firstSeen: "", lastSeen: "", observations: 1,
      restartCount: 2, reason: null, message: null, resolved: false, exitCode: 1,
    },
    spec: { image: "app:1", command: null, memoryLimit: null, memoryRequest: null, cpuLimit: null, env: [], readinessProbe: null, livenessProbe: null },
    previousLogs: "", currentLogs: "", events: [], usage: null,
    ...over,
  } as TriageBundle;
}

describe("rules: deterministic where the model adds nothing", () => {
  it("resolves OOMKilled without deferring", () => {
    const result = applyRules(
      bundle({
        incident: { ...bundle().incident, signal: "OOMKilled" },
        spec: { ...bundle().spec, memoryLimit: "16Mi" },
        usage: { memory: "15900Ki", cpu: "10m" },
      }),
    );

    expect(result.conclusive).toBe(true);
    expect(result.rule).toBe("memory-limit-too-low");
    expect(result.hypotheses[0]?.source).toBe("rule");
    expect(result.hypotheses[0]?.evidence.join(" ")).toContain("16Mi");
  });

  it("names WHY an image pull failed, not just that it did", () => {
    const result = applyRules(
      bundle({
        incident: { ...bundle().incident, signal: "ImagePullBackOff" },
        events: [{ reason: "Failed", message: "manifest unknown", count: 3, at: "" }],
      }),
    );
    expect(result.hypotheses[0]?.cause).toContain("tag does not exist");
  });

  it("finds missing configuration in the CURRENT log when the previous one is gone", () => {
    // The runtime does not always retain the previous container's log. Reading
    // only that one loses the cause and the crash looks inexplicable.
    const result = applyRules(
      bundle({ previousLogs: "", currentLogs: "FATAL: API_KEY is required but not set" }),
    );

    expect(result.conclusive).toBe(true);
    expect(result.rule).toBe("missing-configuration");
    expect(result.hypotheses[0]?.nextStep).toContain("API_KEY");
  });

  it("DEFERS to the model on an ambiguous application crash", () => {
    // The restraint that makes the rules worth having: they must decline.
    const result = applyRules(
      bundle({
        currentLogs: "TypeError: Cannot read properties of null (reading 'port')\n    at Object.<anonymous>",
      }),
    );

    expect(result.conclusive).toBe(false);
    expect(result.hypotheses).toHaveLength(0);
  });
});

describe("findFatalConfigLine", () => {
  it("matches a fatal startup message naming a variable", () => {
    expect(findFatalConfigLine("FATAL: DATABASE_URL is required but not set")).toMatchObject({
      variable: "DATABASE_URL",
    });
  });

  it("does not classify an ordinary stack trace as configuration", () => {
    expect(findFatalConfigLine("TypeError: Cannot read properties of undefined")).toBeNull();
    expect(findFatalConfigLine("Error: connect ECONNREFUSED 127.0.0.1:5432")).toBeNull();
  });
});

describe("isGone", () => {
  // The failure every naive watch hits about an hour in.
  it("recognises an expired resourceVersion however it is reported", () => {
    expect(isGone({ statusCode: 410 })).toBe(true);
    expect(isGone({ code: 410 })).toBe(true);
    expect(isGone({ message: "too old resource version: 123 (456)" })).toBe(true);
  });

  it("does not treat an ordinary error as expiry", () => {
    expect(isGone({ statusCode: 500 })).toBe(false);
    expect(isGone(new Error("socket hang up"))).toBe(false);
  });
});
