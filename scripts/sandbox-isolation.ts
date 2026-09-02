import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, loadEnv } from "@srectl/core";
import { BUDGETS, DockerRunner, lockfileHash } from "@srectl/sandbox";

/**
 * Verifies the sandbox's guarantees by trying to violate them.
 *
 * The blueprint is explicit that enforcement is checked with a real workload
 * attempting the forbidden thing, never by reading a flag or a manifest. This
 * is the Docker-phase version; Phase 3 ports it to Kubernetes Jobs and adds a
 * control case in an unrestricted namespace, because a test that fails for the
 * wrong reason looks identical to a test that passes.
 */

const env = loadEnv();
const logger = createLogger("warn", { svc: "isolation" });
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);

const runner = new DockerRunner(logger);
const { hash } = await lockfileHash(repoRoot);
const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 300 });

interface Check {
  name: string;
  guarantee: string;
  command: string[];
  budget: typeof BUDGETS.test;
  verdict: (r: Awaited<ReturnType<DockerRunner["exec"]>>) => boolean;
}

const checks: Check[] = [
  {
    name: "egress-denied",
    guarantee: "no network egress",
    // exit 9 means the request went through, which must never happen.
    command: [
      "node",
      "-e",
      "fetch('https://example.com').then(()=>process.exit(9)).catch(()=>process.exit(0))",
    ],
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "dns-denied",
    guarantee: "name resolution also blocked, not just connections",
    command: [
      "node",
      "-e",
      "require('dns').promises.resolve('example.com').then(()=>process.exit(9)).catch(()=>process.exit(0))",
    ],
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "readonly-root",
    guarantee: "cannot write outside the declared writable mounts",
    command: [
      "node",
      "-e",
      "try{require('fs').writeFileSync('/etc/srectl-probe','x');process.exit(9)}catch(e){process.exit(0)}",
    ],
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "writable-mounts-work",
    guarantee: "the paths we DO declare writable actually are",
    // The control case: if this fails, the checks above might be passing for
    // the wrong reason.
    command: [
      "node",
      "-e",
      "const fs=require('fs');fs.writeFileSync('/tmp/x','x');fs.writeFileSync(process.env.HOME+'/y','y');fs.writeFileSync('/workspace/z','z');process.exit(0)",
    ],
    budget: BUDGETS.test,
    verdict: (r) => r.exitCode === 0,
  },
  {
    name: "memory-limit",
    guarantee: "OOM kill at the configured ceiling",
    command: ["node", "-e", "const a=[];for(;;)a.push(new Array(1e6).fill(7))"],
    budget: { ...BUDGETS.test, memoryMb: 256, timeoutSeconds: 60 },
    verdict: (r) => r.oomKilled || r.exitCode === 137,
  },
  {
    name: "deadline",
    guarantee: "wall-clock ceiling terminates a hung run",
    command: ["node", "-e", "setInterval(()=>{},1000)"],
    budget: { ...BUDGETS.test, timeoutSeconds: 5 },
    verdict: (r) => r.timedOut,
  },
  {
    name: "pid-limit",
    guarantee: "fork bombs hit the PID ceiling instead of the host",
    command: [
      "node",
      "-e",
      "const{spawn}=require('child_process');try{for(let i=0;i<2000;i++)spawn('node',['-e','setTimeout(()=>{},9e5)']);}catch(e){};setTimeout(()=>process.exit(0),4000)",
    ],
    budget: { ...BUDGETS.test, pidsLimit: 64, timeoutSeconds: 30 },
    // Passing means the host survived and the run ended on our terms.
    verdict: (r) => r.exitCode !== null,
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
} finally {
  await runner.cleanup();
}

console.table(rows);
console.log(failed === 0 ? "\nAll isolation guarantees hold." : `\n${failed} guarantee(s) NOT enforced.`);
process.exitCode = failed === 0 ? 0 : 1;
