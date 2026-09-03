import type { V1Job, V1PersistentVolumeClaim } from "@kubernetes/client-node";
import type { Budget } from "./runner.js";
import { imagePullPolicy, runnerImage } from "./image.js";

export const SANDBOX_NS = "srectl-sandbox";

/**
 * Both phases share a namespace because PVCs are namespaced: a dependency
 * volume filled by prep cannot be mounted from another namespace. They are
 * separated by pod label instead, which NetworkPolicy selects on.
 */
export const PREP_NS = SANDBOX_NS;
const IMAGE = runnerImage();
const PULL_POLICY = imagePullPolicy(IMAGE);
const UID = 10001;

/**
 * Every writable location under a read-only root, declared once.
 *
 * Node tooling wants more of these than expected. Discovering them one EPERM
 * at a time - each surfacing as an unrelated npm or vitest error rather than
 * as a permissions problem - is the failure mode this list exists to prevent.
 */
const WRITABLE_MOUNTS = [
  { name: "workspace", mountPath: "/workspace" },
  { name: "tmp", mountPath: "/tmp" },
  { name: "home", mountPath: "/home/runner" },
];

const ENV = [
  { name: "HOME", value: "/home/runner" },
  { name: "npm_config_cache", value: "/tmp/.npm" },
  { name: "SRECTL_WORKDIR", value: "/workspace" },
  { name: "CI", value: "true" },
];

/** Pod Security Admission at `restricted` requires exactly these. */
const POD_SECURITY = {
  runAsNonRoot: true,
  runAsUser: UID,
  runAsGroup: UID,
  // fsGroup makes a freshly-provisioned volume writable by the pod user. In
  // Docker this needed a separate root container to chown; here it is one
  // declarative field.
  fsGroup: UID,
  seccompProfile: { type: "RuntimeDefault" },
};

const CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

export function depsPvcName(lockfileHash: string): string {
  return `srectl-deps-${lockfileHash.slice(0, 16)}`;
}

export function depsPvc(lockfileHash: string, namespace: string): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: depsPvcName(lockfileHash),
      namespace,
      labels: { "app.kubernetes.io/managed-by": "srectl", "srectl/kind": "deps-cache" },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "2Gi" } },
    },
  };
}

/**
 * Phase A. Network is allowed; no untrusted code runs.
 *
 * `npm ci --ignore-scripts` is the whole reason this is safe: without it a
 * package postinstall would execute arbitrary code at exactly the moment
 * egress is open.
 */
export function prepJob(opts: {
  name: string;
  lockfileHash: string;
  packageJson: string;
  packageLock: string | null;
  timeoutSeconds: number;
}): V1Job {
  const script = [
    "set -e",
    "mkdir -p /tmp/install && cd /tmp/install",
    "cp /manifests/package.json package.json",
    "if [ -f /manifests/package-lock.json ]; then cp /manifests/package-lock.json package-lock.json; fi",
    "chmod u+w package.json package-lock.json 2>/dev/null || true",
    "if [ -f package-lock.json ]; then npm ci --ignore-scripts --no-audit --no-fund; else npm install --ignore-scripts --no-audit --no-fund; fi",
    "cp -R /tmp/install/node_modules/. /deps/",
    "touch /deps/.srectl-complete",
  ].join("; ");

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: opts.name,
      namespace: SANDBOX_NS,
      // Labelled with the PVC it fills, so a later run can ask "did a prep job
      // for this cache key ever actually succeed?" A bound-but-empty volume
      // from a half-finished job would otherwise read as a cache hit.
      labels: { "srectl/deps": depsPvcName(opts.lockfileHash) },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: opts.timeoutSeconds,
      ttlSecondsAfterFinished: 300,
      template: {
        // The label the allow-prep-egress policy selects on. Without it this
        // pod inherits the namespace deny-all and npm ci cannot reach the
        // registry.
        metadata: { labels: { "srectl/phase": "prep" } },
        spec: {
          restartPolicy: "Never",
          securityContext: POD_SECURITY,
          containers: [
            {
              name: "prep",
              image: IMAGE,
              imagePullPolicy: PULL_POLICY,
              securityContext: CONTAINER_SECURITY,
              command: ["sh", "-c", script],
              env: ENV,
              resources: {
                requests: { cpu: "500m", memory: "512Mi" },
                limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "2Gi" },
              },
              volumeMounts: [
                { name: "deps", mountPath: "/deps" },
                { name: "manifests", mountPath: "/manifests", readOnly: true },
                { name: "tmp", mountPath: "/tmp" },
                { name: "home", mountPath: "/home/runner" },
              ],
            },
          ],
          volumes: [
            { name: "deps", persistentVolumeClaim: { claimName: depsPvcName(opts.lockfileHash) } },
            { name: "manifests", configMap: { name: opts.name } },
            { name: "tmp", emptyDir: {} },
            { name: "home", emptyDir: {} },
          ],
        },
      },
    },
  };
}

/**
 * Phase B. No network at all; untrusted code runs.
 *
 * The source arrives as a ConfigMap and is materialised by the wrapper, and
 * the dependency PVC is mounted read-only so generated code cannot poison a
 * cache that later runs will reuse.
 */
export function execJob(opts: {
  name: string;
  lockfileHash: string;
  command: string[];
  budget: Budget;
  extraJsonPath?: string;
}): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: opts.name, namespace: SANDBOX_NS },
    spec: {
      // No retries. A sandbox run that failed is a data point, not something
      // to paper over by running it again.
      backoffLimit: 0,
      activeDeadlineSeconds: opts.budget.timeoutSeconds,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: { "srectl/job": opts.name, "srectl/phase": "exec" } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          securityContext: POD_SECURITY,
          containers: [
            {
              name: "exec",
              image: IMAGE,
              imagePullPolicy: PULL_POLICY,
              securityContext: CONTAINER_SECURITY,
              args: opts.command,
              env: [
                ...ENV,
                { name: "SRECTL_INJECT_JSON", value: "/injected/files.json" },
                ...(opts.extraJsonPath
                  ? [{ name: "SRECTL_EXTRA_JSON", value: opts.extraJsonPath }]
                  : []),
              ],
              resources: {
                requests: { cpu: "500m", memory: `${Math.floor(opts.budget.memoryMb / 2)}Mi` },
                limits: {
                  cpu: String(opts.budget.cpus),
                  memory: `${opts.budget.memoryMb}Mi`,
                  "ephemeral-storage": "2Gi",
                },
              },
              volumeMounts: [
                ...WRITABLE_MOUNTS,
                { name: "deps", mountPath: "/workspace/node_modules", readOnly: true },
                { name: "injected", mountPath: "/injected", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
            { name: "home", emptyDir: {} },
            { name: "deps", persistentVolumeClaim: { claimName: depsPvcName(opts.lockfileHash), readOnly: true } },
            { name: "injected", configMap: { name: opts.name } },
          ],
        },
      },
    },
  };
}
