import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  type V1Job,
  type V1Pod,
} from "@kubernetes/client-node";
import type { Logger } from "@srectl/core";
import { parseEnvelope } from "./envelope.js";
import { depsPvc, depsPvcName, execJob, PREP_NS, prepJob, SANDBOX_NS } from "./job-builder.js";
import type { ExecResult, ExecSpec, PrepResult, PrepSpec, SandboxRunner } from "./runner.js";

/**
 * Kubernetes implementation of the same two-phase contract DockerRunner
 * implements. Callers do not change.
 *
 * The typed client, not shelled-out kubectl: parsing kubectl stdout is fragile,
 * loses structured status, and gives no way to react to state transitions.
 */
export class K8sJobRunner implements SandboxRunner {
  readonly kind = "k8s" as const;
  private readonly batch: BatchV1Api;
  private readonly core: CoreV1Api;
  private readonly created: Array<{ kind: "job" | "configmap"; name: string; ns: string }> = [];

  constructor(private readonly logger?: Logger) {
    const kc = new KubeConfig();
    // In-cluster when running as a Deployment (Phase 6), kubeconfig locally.
    // loadFromDefault handles both without a branch here.
    kc.loadFromDefault();
    this.batch = kc.makeApiClient(BatchV1Api);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  async prepare(spec: PrepSpec): Promise<PrepResult> {
    const started = performance.now();
    const pvcName = depsPvcName(spec.lockfileHash);

    if (await this.depsReady(pvcName)) {
      this.logger?.info("prep cache hit", { pvc: pvcName });
      return { artifactRef: spec.lockfileHash, cacheHit: true, durationMs: elapsed(started) };
    }

    await this.ensurePvc(spec.lockfileHash);

    const packageJson = await readFile(join(spec.repoRoot, "package.json"), "utf8");
    const packageLock = await readSafe(join(spec.repoRoot, "package-lock.json"));

    const name = `srectl-prep-${randomUUID().slice(0, 8)}`;
    await this.createConfigMap(name, PREP_NS, {
      "package.json": packageJson,
      ...(packageLock ? { "package-lock.json": packageLock } : {}),
    });

    const job = prepJob({
      name,
      lockfileHash: spec.lockfileHash,
      packageJson,
      packageLock,
      timeoutSeconds: spec.timeoutSeconds,
    });

    const outcome = await this.runJob(job, PREP_NS, name, spec.timeoutSeconds);

    if (!outcome.succeeded) {
      return {
        artifactRef: spec.lockfileHash,
        cacheHit: false,
        durationMs: elapsed(started),
        error: `prep job failed: ${outcome.reason}. ${outcome.logs.slice(-1200)}`,
      };
    }

    await this.markDepsReady(pvcName);
    return { artifactRef: spec.lockfileHash, cacheHit: false, durationMs: elapsed(started) };
  }

  async exec(spec: ExecSpec): Promise<ExecResult> {
    const started = performance.now();
    const name = `srectl-exec-${randomUUID().slice(0, 8)}`;

    // The whole working copy travels as a ConfigMap. There is no host to bind
    // mount from, and this is the same channel the generated files use.
    const files = [...(await collectRepoFiles(spec.repoRoot)), ...spec.files];

    await this.createConfigMap(name, SANDBOX_NS, {
      "files.json": JSON.stringify(files),
    });

    const job = execJob({
      name,
      lockfileHash: spec.artifactRef,
      command: spec.command,
      budget: {
        timeoutSeconds: spec.timeoutSeconds,
        memoryMb: spec.memoryMb,
        cpus: spec.cpus,
        pidsLimit: spec.pidsLimit,
      },
      ...(spec.extraJsonPath ? { extraJsonPath: spec.extraJsonPath } : {}),
    });

    const outcome = await this.runJob(job, SANDBOX_NS, name, spec.timeoutSeconds);
    const parsed = parseEnvelope(outcome.logs);

    return {
      envelope: parsed.ok ? parsed.envelope : null,
      ...(parsed.ok ? {} : { parseFailure: { reason: parsed.reason, detail: parsed.detail } }),
      exitCode: outcome.exitCode,
      timedOut: outcome.reason === "DeadlineExceeded",
      // Kubernetes reports this directly on the container status. No guessing
      // from exit codes, which a runtime that self-limits never produces.
      oomKilled: outcome.reason === "OOMKilled",
      durationMs: elapsed(started),
      rawTail: outcome.logs.slice(-4000),
    };
  }

  async cleanup(): Promise<void> {
    for (const item of this.created) {
      try {
        if (item.kind === "job") {
          await this.batch.deleteNamespacedJob({
            name: item.name,
            namespace: item.ns,
            propagationPolicy: "Background",
          });
        } else {
          await this.core.deleteNamespacedConfigMap({ name: item.name, namespace: item.ns });
        }
      } catch {
        // Already gone via ttlSecondsAfterFinished; nothing to do.
      }
    }
    this.created.length = 0;
  }

  // --- internals -------------------------------------------------------------

  /**
   * The PVC existing is not enough: a prep job that died halfway leaves a
   * bound but EMPTY volume, and reusing that reads as a cache hit with no
   * dependencies in it.
   *
   * The marker is a tiny ConfigMap, created only after the prep Job succeeds.
   * It was originally "did a prep Job for this key succeed", which never hit,
   * because cleanup() deletes those Jobs and ttlSecondsAfterFinished collects
   * the rest - the evidence was destroyed at the end of every run. A marker
   * this runner does not track outlives both.
   */
  private async depsReady(pvcName: string): Promise<boolean> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: PREP_NS });
      await this.core.readNamespacedConfigMap({ name: `${pvcName}-ready`, namespace: PREP_NS });
      return true;
    } catch {
      return false;
    }
  }

  private async markDepsReady(pvcName: string): Promise<void> {
    try {
      await this.core.createNamespacedConfigMap({
        namespace: PREP_NS,
        body: {
          metadata: { name: `${pvcName}-ready`, labels: { "srectl/kind": "deps-marker" } },
          data: { readyAt: new Date().toISOString() },
        },
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  private async ensurePvc(lockfileHash: string): Promise<void> {
    try {
      await this.core.createNamespacedPersistentVolumeClaim({
        namespace: PREP_NS,
        body: depsPvc(lockfileHash, PREP_NS),
      });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }

  private async createConfigMap(
    name: string,
    namespace: string,
    data: Record<string, string>,
  ): Promise<void> {
    await this.core.createNamespacedConfigMap({
      namespace,
      body: { metadata: { name, namespace }, data },
    });
    this.created.push({ kind: "configmap", name, ns: namespace });
  }

  private async runJob(
    job: V1Job,
    namespace: string,
    name: string,
    timeoutSeconds: number,
  ): Promise<{ succeeded: boolean; reason: string; exitCode: number | null; logs: string }> {
    await this.batch.createNamespacedJob({ namespace, body: job });
    this.created.push({ kind: "job", name, ns: namespace });

    const outcome = await this.waitForTerminal(namespace, name, timeoutSeconds);
    const status = outcome.pod?.status?.containerStatuses?.[0]?.state?.terminated;

    return {
      succeeded: status?.exitCode === 0,
      // A Job-level reason wins: on a deadline kill the pod is deleted, so the
      // container status is gone and only the Job knows why it ended.
      reason: outcome.jobReason ?? status?.reason ?? "Unknown",
      exitCode: status?.exitCode ?? null,
      logs: outcome.logs,
    };
  }

  /**
   * Polls to a terminal state, keeping the most recent logs as it goes.
   *
   * Two things make this less obvious than it looks:
   *
   *   - When activeDeadlineSeconds fires, the Job controller DELETES the pod.
   *     Logs read afterwards are gone, so they are captured during the run.
   *   - Kubernetes sets a `FailureTarget` condition immediately and the
   *     terminal `Failed` condition up to ~30s later. Waiting only for
   *     `Failed` turns a 20-second timeout into a 50-second one, or a missed
   *     detection entirely.
   *
   * Phase 4 replaces polling with the Watch API for the reliability monitor,
   * where reacting to transitions across the whole cluster is the point. Here
   * the job is single and short-lived, and polling costs less than a watch
   * that must also handle 410 Gone.
   */
  private async waitForTerminal(
    namespace: string,
    jobName: string,
    timeoutSeconds: number,
  ): Promise<{ pod: V1Pod | undefined; jobReason: string | undefined; logs: string }> {
    const deadline = Date.now() + (timeoutSeconds + 45) * 1000;
    let pod: V1Pod | undefined;
    let logs = "";
    let tick = 0;

    while (Date.now() < deadline) {
      const { items } = await this.core.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      if (items[0]) pod = items[0];

      // Refresh logs periodically so a pod deleted by the deadline still
      // leaves us whatever it managed to print.
      if (pod && tick % 4 === 0) {
        const fresh = await this.readLogs(namespace, pod.metadata?.name);
        if (fresh) logs = fresh;
      }
      tick += 1;

      const phase = pod?.status?.phase;
      if (phase === "Succeeded" || phase === "Failed") {
        const fresh = await this.readLogs(namespace, pod?.metadata?.name);
        if (fresh) logs = fresh;
        return { pod, jobReason: undefined, logs };
      }

      const { items: jobs } = await this.batch.listNamespacedJob({
        namespace,
        fieldSelector: `metadata.name=${jobName}`,
      });
      const condition = jobs[0]?.status?.conditions?.find(
        (c) => (c.type === "Failed" || c.type === "FailureTarget") && c.status === "True",
      );
      if (condition) {
        return { pod, jobReason: condition.reason ?? "Failed", logs };
      }

      await sleep(500);
    }

    return { pod, jobReason: "WatcherTimeout", logs };
  }

  private async readLogs(namespace: string, podName: string | undefined): Promise<string> {
    if (!podName) return "";
    try {
      const logs = await this.core.readNamespacedPodLog({ name: podName, namespace });
      return typeof logs === "string" ? logs : JSON.stringify(logs);
    } catch (err) {
      return `<could not read logs: ${(err as Error).message}>`;
    }
  }
}

const SOURCE_EXCLUDE = /(^|\/)(node_modules|\.git|coverage|dist|\.stryker-tmp)(\/|$)/;

/** The repository as a flat list, small enough to travel in a ConfigMap. */
async function collectRepoFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const { readdir, stat } = await import("node:fs/promises");
  const out: Array<{ path: string; content: string }> = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (SOURCE_EXCLUDE.test(rel)) continue;

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      const info = await stat(full);
      if (info.size > 512_000) continue;
      out.push({ path: rel, content: await readFile(full, "utf8") });
    }
  }

  await walk(root, "");
  return out;
}

async function readSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function isAlreadyExists(err: unknown): boolean {
  const code = (err as { code?: number; statusCode?: number }).code ?? (err as { statusCode?: number }).statusCode;
  return code === 409;
}

const elapsed = (from: number) => Math.round(performance.now() - from);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
