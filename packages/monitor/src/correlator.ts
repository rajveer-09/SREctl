import type { V1Pod } from "@kubernetes/client-node";

export type Signal =
  | "ImagePullBackOff"
  | "OOMKilled"
  | "CrashLoopBackOff"
  | "Error"
  | "ProbeFailing"
  | "Pending"
  | "Healthy";

export interface PodHealth {
  signal: Signal;
  /** Reason string straight from the container status, when there is one. */
  reason: string | null;
  message: string | null;
  restartCount: number;
  exitCode: number | null;
  /** True when the previous container terminated, so its log is readable. */
  hasPrevious: boolean;
}

/**
 * Reads a pod's state into one signal.
 *
 * Ordered by specificity, not by how the phases happen to be reported. A pod
 * that is OOMKilled is also in CrashLoopBackOff, and reporting the loop rather
 * than the kill throws away the only piece of information that identifies the
 * cause.
 */
export function assessPod(pod: V1Pod): PodHealth {
  const status = pod.status?.containerStatuses?.[0];
  const waiting = status?.state?.waiting;
  const terminated = status?.state?.terminated;
  const lastTerminated = status?.lastState?.terminated;

  const restartCount = status?.restartCount ?? 0;
  const hasPrevious = Boolean(lastTerminated) || restartCount > 0;

  // OOM first: the kill reason lives on lastState once the container restarts,
  // and by then `waiting.reason` only says CrashLoopBackOff.
  if (terminated?.reason === "OOMKilled" || lastTerminated?.reason === "OOMKilled") {
    return {
      signal: "OOMKilled",
      reason: "OOMKilled",
      message: terminated?.message ?? lastTerminated?.message ?? null,
      restartCount,
      exitCode: terminated?.exitCode ?? lastTerminated?.exitCode ?? null,
      hasPrevious,
    };
  }

  if (waiting?.reason === "ImagePullBackOff" || waiting?.reason === "ErrImagePull") {
    return {
      signal: "ImagePullBackOff",
      reason: waiting.reason,
      message: waiting.message ?? null,
      restartCount,
      exitCode: null,
      hasPrevious,
    };
  }

  if (waiting?.reason === "CrashLoopBackOff") {
    return {
      signal: "CrashLoopBackOff",
      reason: waiting.reason,
      message: waiting.message ?? null,
      restartCount,
      exitCode: lastTerminated?.exitCode ?? null,
      hasPrevious,
    };
  }

  if (terminated && terminated.exitCode !== 0) {
    return {
      signal: "Error",
      reason: terminated.reason ?? "Error",
      message: terminated.message ?? null,
      restartCount,
      exitCode: terminated.exitCode,
      hasPrevious,
    };
  }

  // Running but not Ready is a distinct failure: the process is alive, so
  // nothing crashes and nothing appears in a crash-oriented view at all.
  if (pod.status?.phase === "Running" && status && !status.ready && restartCount === 0) {
    return {
      signal: "ProbeFailing",
      reason: "Unhealthy",
      message: null,
      restartCount,
      exitCode: null,
      hasPrevious,
    };
  }

  if (pod.status?.phase === "Pending") {
    return { signal: "Pending", reason: null, message: null, restartCount, exitCode: null, hasPrevious };
  }

  return { signal: "Healthy", reason: null, message: null, restartCount, exitCode: null, hasPrevious };
}

export interface Incident {
  id: string;
  namespace: string;
  podName: string;
  workload: string;
  signal: Signal;
  firstSeen: string;
  lastSeen: string;
  /** How many observations rolled into this one incident. */
  observations: number;
  restartCount: number;
  reason: string | null;
  message: string | null;
  resolved: boolean;
}

/**
 * Groups observations into incidents.
 *
 * A crash-looping pod emits an event every few seconds. One incident per event
 * would mean fifteen broken pods generate hundreds of "incidents", and the
 * signal disappears into its own noise. The key is the workload, not the pod:
 * a pod replaced by its controller is the same problem continuing, not a new
 * one starting.
 */
export class IncidentCorrelator {
  private readonly open = new Map<string, Incident>();

  /** Strips the generated suffix so pod-per-restart stays one incident. */
  static workloadKey(pod: V1Pod): string {
    const owner = pod.metadata?.ownerReferences?.[0];
    if (owner) return `${owner.kind}/${owner.name}`;
    return `Pod/${pod.metadata?.name ?? "unknown"}`;
  }

  observe(pod: V1Pod, health: PodHealth, at: string): Incident | null {
    const namespace = pod.metadata?.namespace ?? "default";
    const workload = IncidentCorrelator.workloadKey(pod);
    const key = `${namespace}/${workload}`;
    const existing = this.open.get(key);

    if (health.signal === "Healthy" || health.signal === "Pending") {
      if (existing && health.signal === "Healthy") {
        existing.resolved = true;
        existing.lastSeen = at;
        this.open.delete(key);
      }
      return null;
    }

    if (existing) {
      existing.lastSeen = at;
      existing.observations += 1;
      existing.restartCount = Math.max(existing.restartCount, health.restartCount);
      // A signal can sharpen: CrashLoopBackOff that turns out to be OOMKilled
      // should become the more specific one, never the reverse.
      if (existing.signal === "CrashLoopBackOff" && health.signal === "OOMKilled") {
        existing.signal = "OOMKilled";
        existing.reason = health.reason;
        existing.message = health.message;
      }
      return existing;
    }

    const incident: Incident = {
      id: `${namespace}-${workload}-${Date.parse(at)}`.replace(/[^a-zA-Z0-9-]/g, "-"),
      namespace,
      podName: pod.metadata?.name ?? "unknown",
      workload,
      signal: health.signal,
      firstSeen: at,
      lastSeen: at,
      observations: 1,
      restartCount: health.restartCount,
      reason: health.reason,
      message: health.message,
      resolved: false,
    };
    this.open.set(key, incident);
    return incident;
  }

  openIncidents(): Incident[] {
    return [...this.open.values()];
  }
}
