import { CoreV1Api, KubeConfig, Metrics } from "@kubernetes/client-node";
import type { Incident } from "./correlator.js";

export interface TriageBundle {
  incident: Incident & { exitCode: number | null };
  spec: {
    image: string | null;
    command: string[] | null;
    memoryLimit: string | null;
    memoryRequest: string | null;
    cpuLimit: string | null;
    env: string[];
    readinessProbe: string | null;
    livenessProbe: string | null;
  };
  /** Logs of the PREVIOUS container. See collectTriage for why. */
  previousLogs: string;
  currentLogs: string;
  events: Array<{ reason: string; message: string; count: number; at: string }>;
  usage: { memory: string; cpu: string } | null;
}

/**
 * Gathers everything a hypothesis has to be supported by.
 *
 * The critical detail is `previous: true` on the log read. In a crash loop the
 * CURRENT container has usually just started or not started at all, so its log
 * is empty - the evidence of why it died is in the container that died. Reading
 * the current log yields nothing and makes every crash look inexplicable.
 */
export async function collectTriage(
  incident: Incident & { exitCode: number | null },
): Promise<TriageBundle> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);

  const pod = await core
    .readNamespacedPod({ name: incident.podName, namespace: incident.namespace })
    .catch(() => null);

  const container = pod?.spec?.containers?.[0];

  const previousLogs = await readLogs(core, incident, true);
  const currentLogs = await readLogs(core, incident, false);

  const events = await core
    .listNamespacedEvent({
      namespace: incident.namespace,
      fieldSelector: `involvedObject.name=${incident.podName}`,
    })
    .then((list) =>
      list.items
        .map((e) => ({
          reason: e.reason ?? "",
          message: (e.message ?? "").slice(0, 500),
          count: e.count ?? 1,
          at: String(e.lastTimestamp ?? e.eventTime ?? ""),
        }))
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .slice(0, 15),
    )
    .catch(() => []);

  return {
    incident,
    spec: {
      image: container?.image ?? null,
      command: container?.command ?? null,
      memoryLimit: (container?.resources?.limits?.["memory"] as string) ?? null,
      memoryRequest: (container?.resources?.requests?.["memory"] as string) ?? null,
      cpuLimit: (container?.resources?.limits?.["cpu"] as string) ?? null,
      env: (container?.env ?? []).map((e) => e.name),
      readinessProbe: describeProbe(container?.readinessProbe),
      livenessProbe: describeProbe(container?.livenessProbe),
    },
    previousLogs,
    currentLogs,
    events,
    usage: await readUsage(kc, incident),
  };
}

async function readLogs(
  core: CoreV1Api,
  incident: Incident,
  previous: boolean,
): Promise<string> {
  try {
    const logs = await core.readNamespacedPodLog({
      name: incident.podName,
      namespace: incident.namespace,
      previous,
      tailLines: 100,
    });
    return typeof logs === "string" ? logs : "";
  } catch {
    // No previous container yet, or the pod is gone. Absence is information,
    // not an error: it means this is the first start.
    return "";
  }
}

/** Limits without observed usage cannot distinguish "too low" from "leaking". */
async function readUsage(
  kc: KubeConfig,
  incident: Incident,
): Promise<{ memory: string; cpu: string } | null> {
  try {
    const metrics = new Metrics(kc);
    // The client exposes a namespace listing, not a single-pod read, so find
    // ours in it. A pod that has not been scraped yet is simply absent.
    const list = await metrics.getPodMetrics(incident.namespace);
    const entry = list.items.find((i) => i.metadata?.name === incident.podName);
    const container = entry?.containers?.[0];
    if (!container) return null;
    return {
      memory: container.usage?.memory ?? "unknown",
      cpu: container.usage?.cpu ?? "unknown",
    };
  } catch {
    return null;
  }
}

function describeProbe(probe: unknown): string | null {
  if (!probe || typeof probe !== "object") return null;
  const p = probe as {
    httpGet?: { path?: string; port?: number | string };
    tcpSocket?: { port?: number | string };
    exec?: { command?: string[] };
  };
  if (p.httpGet) return `httpGet ${p.httpGet.path ?? "/"} on port ${p.httpGet.port}`;
  if (p.tcpSocket) return `tcpSocket on port ${p.tcpSocket.port}`;
  if (p.exec) return `exec ${(p.exec.command ?? []).join(" ")}`;
  return null;
}
