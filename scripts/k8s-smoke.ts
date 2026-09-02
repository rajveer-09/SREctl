import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, loadEnv } from "@srectl/core";
import { BUDGETS, describeEnvelope, K8sJobRunner, lockfileHash } from "@srectl/sandbox";

const env = loadEnv();
const logger = createLogger("info", { svc: "k8s-smoke" });
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);

const runner = new K8sJobRunner(logger);
const { hash, source } = await lockfileHash(repoRoot);
console.log(`lockfile: ${source} -> ${hash.slice(0, 16)}`);

try {
  const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 600 });
  console.log("\nPREPARE", JSON.stringify(prep, null, 2));
  if (prep.error) process.exit(1);

  const result = await runner.exec({
    artifactRef: prep.artifactRef,
    repoRoot,
    files: [],
    command: [
      "node_modules/.bin/vitest", "run",
      "--reporter=json", "--outputFile=.srectl-results.json",
      "--coverage", "--coverage.reporter=json-summary",
    ],
    ...BUDGETS.test,
  });

  console.log("\nEXEC", JSON.stringify({
    exitCode: result.exitCode, timedOut: result.timedOut,
    oomKilled: result.oomKilled, durationMs: result.durationMs,
    parseFailure: result.parseFailure,
  }, null, 2));

  if (result.envelope) console.log("\nENVELOPE:", describeEnvelope(result.envelope), "| coverage:", result.envelope.coverage?.lines);
  else console.log("\nNO ENVELOPE. tail:\n", result.rawTail.slice(-1500));
} finally {
  await runner.cleanup();
}
