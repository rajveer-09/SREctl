import type { V1Pod } from "@kubernetes/client-node";

export const CHAOS_NS = "srectl-chaos";

/**
 * Deliberately broken workloads with known answers.
 *
 * Hypothesis accuracy is only meaningful against faults whose cause is decided
 * in advance, so ground truth lives here beside the manifest that produces it.
 * Splitting them into a YAML directory and a separate answer key is how the
 * two drift apart.
 *
 * Four classes, chosen because they fail in visibly different ways: one never
 * starts, one starts and is killed, one starts and exits, one starts and stays
 * unready. A monitor that only recognises CrashLoopBackOff would score 25%.
 */
export type FaultClass =
  | "bad-image"
  | "memory-limit-too-low"
  | "missing-env-var"
  | "failing-probe"
  /**
   * Deliberately NOT answerable by a deterministic rule.
   *
   * Without these the suite scores 100% with zero model calls, which reads as
   * a strong result and is actually a statement about the rules covering the
   * cases they were written against. These exercise the path the rules are
   * supposed to defer on.
   */
  | "application-error";

export interface ChaosCase {
  name: string;
  faultClass: FaultClass;
  /** What a correct top-ranked hypothesis has to say. */
  expectedCause: string;
  /** Observable state a monitor should key on. */
  expectedSignal: string;
  pod: V1Pod;
}

const IMAGE = process.env.SRECTL_RUNNER_IMAGE ?? "srectl-runner:dev";

function basePod(name: string, faultClass: FaultClass): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: CHAOS_NS,
      labels: { "srectl/chaos": "true", "srectl/fault-class": faultClass },
    },
    spec: { restartPolicy: "Always", containers: [] },
  };
}

/** Never starts: the image reference cannot be resolved. */
function badImage(name: string, image: string, why: string): ChaosCase {
  const pod = basePod(name, "bad-image");
  pod.spec!.containers = [
    { name: "app", image, command: ["node", "-e", "setInterval(()=>{},1000)"] },
  ];
  return {
    name,
    faultClass: "bad-image",
    expectedCause: `the image reference cannot be pulled: ${why}`,
    expectedSignal: "ImagePullBackOff / ErrImagePull",
    pod,
  };
}

/** Starts, then is killed by the kernel for exceeding its memory limit. */
function memoryLimit(name: string, limitMi: number): ChaosCase {
  const pod = basePod(name, "memory-limit-too-low");
  pod.spec!.containers = [
    {
      name: "app",
      image: IMAGE,
      imagePullPolicy: "Never",
      command: ["node", "-e", "const a=[];setInterval(()=>a.push(new Array(2e6).fill(7)),50)"],
      resources: {
        requests: { memory: `${limitMi}Mi`, cpu: "50m" },
        limits: { memory: `${limitMi}Mi`, cpu: "500m" },
      },
    },
  ];
  return {
    name,
    faultClass: "memory-limit-too-low",
    expectedCause: `the container's memory limit of ${limitMi}Mi is too low for what it allocates`,
    expectedSignal: "OOMKilled, then CrashLoopBackOff",
    pod,
  };
}

/** Starts and exits immediately because required configuration is absent. */
function missingEnv(name: string, variable: string): ChaosCase {
  const pod = basePod(name, "missing-env-var");
  pod.spec!.containers = [
    {
      name: "app",
      image: IMAGE,
      imagePullPolicy: "Never",
      command: [
        "node",
        "-e",
        `if(!process.env.${variable}){console.error("FATAL: ${variable} is required but not set");process.exit(1)}setInterval(()=>{},1000)`,
      ],
    },
  ];
  return {
    name,
    faultClass: "missing-env-var",
    expectedCause: `the required environment variable ${variable} is not set in the pod spec`,
    expectedSignal: "CrashLoopBackOff with a fatal message in the previous container's log",
    pod,
  };
}

/** Runs fine, but never becomes Ready because the probe is misconfigured. */
function failingProbe(name: string, probePort: number, why: string): ChaosCase {
  const pod = basePod(name, "failing-probe");
  pod.spec!.containers = [
    {
      name: "app",
      image: IMAGE,
      imagePullPolicy: "Never",
      // Serves on 8080 and nothing else. The probe below points elsewhere.
      command: [
        "node",
        "-e",
        "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(8080)",
      ],
      readinessProbe: {
        httpGet: { path: "/healthz", port: probePort },
        initialDelaySeconds: 2,
        periodSeconds: 5,
        failureThreshold: 2,
      },
    },
  ];
  return {
    name,
    faultClass: "failing-probe",
    expectedCause: `the readiness probe ${why}, so the container runs but never becomes ready`,
    expectedSignal: "Running but not Ready, with Unhealthy events",
    pod,
  };
}

/** An application-level crash with a stack trace that could mean several things. */
function appCrash(name: string, script: string, cause: string): ChaosCase {
  const pod = basePod(name, "application-error");
  pod.spec!.containers = [
    { name: "app", image: IMAGE, imagePullPolicy: "Never", command: ["node", "-e", script] },
  ];
  return {
    name,
    faultClass: "application-error",
    expectedCause: cause,
    expectedSignal: "CrashLoopBackOff with an application stack trace",
    pod,
  };
}

export const CHAOS_CASES: ChaosCase[] = [
  // --- bad image reference (4) ---------------------------------------------
  badImage("bad-image-tag", "nginx:v99-does-not-exist", "the tag does not exist in the repository"),
  badImage("bad-image-repo", "docker.io/srectl/no-such-image:v1", "the repository does not exist"),
  badImage("bad-image-typo", "ngnix:latest", "the image name is misspelled"),
  badImage("bad-image-registry", "registry.invalid/team/app:1.0", "the registry host cannot be resolved"),

  // --- memory limit too low (4) --------------------------------------------
  memoryLimit("oom-tiny-limit", 16),
  memoryLimit("oom-small-limit", 24),
  memoryLimit("oom-modest-limit", 32),
  memoryLimit("oom-borderline-limit", 48),

  // --- missing required configuration (4) ----------------------------------
  missingEnv("missing-database-url", "DATABASE_URL"),
  missingEnv("missing-api-key", "API_KEY"),
  missingEnv("missing-service-host", "SERVICE_HOST"),
  missingEnv("missing-auth-token", "AUTH_TOKEN"),

  // --- failing readiness probe (3) -----------------------------------------
  failingProbe("probe-wrong-port", 9090, "targets port 9090 while the server listens on 8080"),
  failingProbe("probe-unused-port", 3000, "targets port 3000 where nothing is listening"),
  failingProbe("probe-closed-port", 5000, "targets port 5000 where nothing is listening"),

  // --- application-level crashes, no rule applies (3) ----------------------
  appCrash(
    "app-null-deref",
    "const cfg=JSON.parse('{\"server\":null}');console.log('starting');console.log(cfg.server.port);",
    "a null dereference reading cfg.server.port when server is null",
  ),
  appCrash(
    "app-unhandled-rejection",
    "console.log('connecting');Promise.reject(new Error('ECONNREFUSED 10.0.0.5:5432'));setTimeout(()=>{},50);",
    "an unhandled promise rejection from a refused database connection",
  ),
  appCrash(
    "app-assertion",
    "const assert=require('assert');console.log('validating schema');assert.strictEqual(process.versions.node,'18.0.0','node version mismatch');",
    "an assertion failure on an unexpected Node version",
  ),
];

export const FAULT_CLASSES: FaultClass[] = [
  "bad-image",
  "memory-limit-too-low",
  "missing-env-var",
  "failing-probe",
  "application-error",
];
