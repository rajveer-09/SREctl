import { homedir } from "node:os";
import { join } from "node:path";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";
import { createLogger, loadEnv } from "@srectl/core";
import { BUDGETS, K8sJobRunner, lockfileHash, runnerImage, SANDBOX_NS } from "@srectl/sandbox";

/**
 * Proves the sandbox's guarantees by trying to violate them.
 *
 * Two rules make this meaningful rather than decorative:
 *
 *   1. Enforcement is checked with a real workload attempting the forbidden
 *      thing, never by reading a manifest. Vanilla Minikube applies
 *      NetworkPolicy objects and enforces nothing, and `kubectl get netpol`
 *      looks identical either way.
 *   2. There is a CONTROL for the network check, in a namespace with no
 *      policy. Without it, "blocked" could just mean the cluster has no
 *      internet, and the suite would pass on a machine where nothing works.
 *
 * Note that Calico DROPS rather than rejects, so denied egress surfaces as a
 * timeout, not an immediate error. Every network probe carries its own
 * deadline shorter than the Job's, or a blocked probe is indistinguishable
 * from a hung one.
 */

const env = loadEnv();
const logger = createLogger("warn", { svc: "k8s-isolation" });
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);

const runner = new K8sJobRunner(logger);
const { hash } = await lockfileHash(repoRoot);
const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 600 });
if (prep.error) throw new Error(prep.error);

type Exec = Awaited<ReturnType<K8sJobRunner["exec"]>>;

interface Check {
  name: string;
  guarantee: string;
  command: string[];
  budget: typeof BUDGETS.test;
  verdict: (r: Exec) => boolean;
}

const NODE = (script: string) => ["node", "-e", script];

const checks: Check[] = [
  {
    name: "egress-denied",
    guarantee: "no network egress from the sandbox",
    command: NODE(
      "const c=AbortSignal.timeout(8000);" +
        "fetch('https://example.com',{signal:c}).then(()=>process.exit(9)).catch(()=>process.exit(0))",
    ),
    budget: { ...BUDGETS.test, timeoutSeconds: 60 },
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "dns-denied",
    guarantee: "name resolution blocked, not just connections",
    command: NODE(
      "require('dns').promises.resolve('example.com').then(()=>process.exit(9)).catch(()=>process.exit(0))",
    ),
    budget: { ...BUDGETS.test, timeoutSeconds: 60 },
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "cluster-api-denied",
    guarantee: "cannot reach the Kubernetes API to escalate",
    command: NODE(
      "const c=AbortSignal.timeout(8000);" +
        "fetch('https://kubernetes.default.svc/api',{signal:c}).then(()=>process.exit(9)).catch(()=>process.exit(0))",
    ),
    budget: { ...BUDGETS.test, timeoutSeconds: 60 },
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "no-serviceaccount-token",
    guarantee: "no mounted credentials to steal",
    command: NODE(
      "const f=require('fs');process.exit(f.existsSync('/var/run/secrets/kubernetes.io/serviceaccount/token')?9:0)",
    ),
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "readonly-root",
    guarantee: "cannot write outside the declared writable mounts",
    command: NODE(
      "try{require('fs').writeFileSync('/etc/srectl-probe','x');process.exit(9)}catch(e){process.exit(0)}",
    ),
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "deps-cache-readonly",
    guarantee: "generated code cannot poison the shared dependency cache",
    command: NODE(
      "try{require('fs').writeFileSync('/workspace/node_modules/evil.js','x');process.exit(9)}catch(e){process.exit(0)}",
    ),
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "writable-mounts-work",
    guarantee: "the paths we DO declare writable actually are",
    command: NODE(
      "const fs=require('fs');fs.writeFileSync('/tmp/x','x');fs.writeFileSync(process.env.HOME+'/y','y');fs.writeFileSync('/workspace/z','z');process.exit(0)",
    ),
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "non-root",
    guarantee: "runs as the expected unprivileged uid",
    command: NODE("process.exit(process.getuid() === 10001 ? 0 : 9)"),
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "memory-limit",
    guarantee: "OOMKilled at the configured ceiling",
    /**
     * Buffers, not JS arrays, and that distinction is the whole check.
     *
     * Two things conspire here. GKE Autopilot enforces a resource floor and
     * SILENTLY REWRITES a limit below it - a requested 256Mi arrives as a
     * 512Mi cgroup. And Node sizes its heap from that cgroup, landing at
     * ~259MB, which is BELOW the real limit. So a JS array loop exhausts V8
     * first and exits 1 with "JavaScript heap out of memory" while the kernel
     * OOM killer never fires, and the check reports "not enforced" for a limit
     * that is working perfectly.
     *
     * Buffer memory is external to the V8 heap, so it counts against the
     * cgroup without hitting the heap ceiling, and the kill is a real OOM.
     */
    command: NODE(
      "const b=[];for(;;){b.push(Buffer.allocUnsafe(64*1024*1024).fill(1));}",
    ),
    budget: { ...BUDGETS.test, memoryMb: 512, timeoutSeconds: 120 },
    // Kubernetes reports this on the container status directly, so there is no
    // guessing from exit codes that a self-limiting runtime never produces.
    verdict: (r) => r.oomKilled,
  },
  {
    name: "deadline",
    guarantee: "activeDeadlineSeconds terminates a hung run",
    command: NODE("setInterval(()=>{},1000)"),
    budget: { ...BUDGETS.test, timeoutSeconds: 20 },
    verdict: (r) => r.timedOut,
  },
];

const rows: Array<Record<string, unknown>> = [];
let failed = 0;

try {
  for (const check of checks) {
    const result = await runner.exec({
      artifactRef: prep.artifactRef,
      repoRoot,
      files: [],
      command: check.command,
      ...check.budget,
    });

    const pass = check.verdict(result);
    if (!pass) failed += 1;

    rows.push({
      check: check.name,
      guarantee: check.guarantee,
      verdict: pass ? "PASS" : "FAIL",
      exit: result.exitCode,
      timedOut: result.timedOut,
      oom: result.oomKilled,
      ms: result.durationMs,
    });
  }

  // --- the control -----------------------------------------------------------
  const control = await runControl();
  rows.push({
    check: "CONTROL egress-allowed",
    guarantee: "same image reaches the internet with no NetworkPolicy",
    verdict: control ? "PASS" : "FAIL",
    exit: control ? 0 : 1,
    timedOut: false,
    oom: false,
    ms: 0,
  });
  if (!control) failed += 1;
} finally {
  await runner.cleanup();
}

console.table(rows);
console.log(
  failed === 0
    ? "\nAll isolation guarantees hold, and the control proves the checks can fail."
    : `\n${failed} guarantee(s) NOT enforced. Do not trust the sandbox.`,
);
process.exitCode = failed === 0 ? 0 : 1;

/**
 * The same probe in `default`, where no NetworkPolicy applies. If this cannot
 * reach the internet either, every "blocked" above proves nothing.
 */
async function runControl(): Promise<boolean> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const core = kc.makeApiClient(CoreV1Api);
  const name = `srectl-control-${Date.now().toString(36)}`;

  await core.createNamespacedPod({
    namespace: "default",
    body: {
      metadata: { name },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "probe",
            image: runnerImage(),
            imagePullPolicy: "Never",
            command: ["node", "-e"],
            args: [
              "const c=AbortSignal.timeout(8000);fetch('https://example.com',{signal:c}).then(()=>process.exit(0)).catch(()=>process.exit(1))",
            ],
          },
        ],
      },
    },
  });

  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const pod = await core.readNamespacedPod({ name, namespace: "default" });
      const phase = pod.status?.phase;
      if (phase === "Succeeded") return true;
      if (phase === "Failed") return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  } finally {
    await core
      .deleteNamespacedPod({ name, namespace: "default", gracePeriodSeconds: 0 })
      .catch(() => undefined);
  }
}

void SANDBOX_NS;
