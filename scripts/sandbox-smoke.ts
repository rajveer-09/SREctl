import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger, loadEnv } from "@srectl/core";
import { BUDGETS, DockerRunner, describeEnvelope, lockfileHash } from "@srectl/sandbox";

const env = loadEnv();
const logger = createLogger("info", { svc: "sandbox-smoke" });
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);

const runner = new DockerRunner(logger);
const { hash, source } = await lockfileHash(repoRoot);
console.log(`lockfile: ${source} -> ${hash.slice(0, 16)}`);

try {
  const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 300 });
  console.log("\nPREPARE", JSON.stringify(prep, null, 2));
  if (prep.error) process.exit(1);

  const result = await runner.exec({
    artifactRef: prep.artifactRef,
    repoRoot,
    files: [],
    command: [
      "node_modules/.bin/vitest",
      "run",
      "--reporter=json",
      "--outputFile=.srectl-results.json",
      "--coverage",
      "--coverage.reporter=json-summary",
    ],
    ...BUDGETS.test,
  });

  console.log("\nEXEC");
  console.log(JSON.stringify({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    oomKilled: result.oomKilled,
    durationMs: result.durationMs,
    parseFailure: result.parseFailure,
  }, null, 2));

  if (result.envelope) {
    console.log("\nENVELOPE:", describeEnvelope(result.envelope));
    console.log("coverage lines:", result.envelope.coverage?.lines);
  } else {
    console.log("\nNO ENVELOPE. raw tail:\n", result.rawTail.slice(-1500));
  }
} finally {
  await runner.cleanup();
}
