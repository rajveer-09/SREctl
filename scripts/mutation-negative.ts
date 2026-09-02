import { homedir } from "node:os";
import { join } from "node:path";
import { clearsThreshold, MUTATION_THRESHOLD, scoreMutants } from "@srectl/agents";
import { createLogger, loadEnv } from "@srectl/core";
import { BUDGETS, DockerRunner, lockfileHash } from "@srectl/sandbox";

/**
 * A threshold that never rejects anything is decoration.
 *
 * This runs a deliberately vacuous test - one that imports the module and
 * asserts nothing about its behaviour - and requires the mutation score to
 * fall BELOW the threshold. If this passes the gate, the gate is not a gate.
 */
const env = loadEnv();
const repoRoot = join(homedir(), "Desktop", env.TARGET_REPO!.split("/")[1]!);
const runner = new DockerRunner(createLogger("warn"));
const { hash } = await lockfileHash(repoRoot);
const prep = await runner.prepare({ repoRoot, lockfileHash: hash, timeoutSeconds: 600 });

const vacuous = `import { describe, expect, it } from "vitest";
import { slugify, truncateSlug } from "../src/slug.js";

describe("slug", () => {
  it("does not throw", () => {
    expect(() => slugify("Hello World")).not.toThrow();
    expect(() => truncateSlug("hello-world", 5)).not.toThrow();
  });

  it("returns a string", () => {
    expect(typeof slugify("Hello World")).toBe("string");
    expect(typeof truncateSlug("hello-world", 5)).toBe("string");
  });
});
`;

try {
  const score = await scoreMutants({
    runner,
    artifactRef: prep.artifactRef,
    repoRoot,
    targetPath: "src/slug.ts",
    testPath: "test/_vacuous.test.ts",
    testContent: vacuous,
    budget: BUDGETS.mutation,
  });

  console.table({
    "mutation score": score.score ?? "n/a",
    killed: score.killed,
    survived: score.survived,
    "no coverage": score.noCoverage,
    threshold: MUTATION_THRESHOLD,
    "clears threshold": clearsThreshold(score),
  });

  if (clearsThreshold(score)) {
    console.log("\nFAIL: a test asserting nothing cleared the threshold. The gate is not a gate.");
    process.exitCode = 1;
  } else {
    console.log(`\nPASS: rejected at ${score.score}%, below the ${MUTATION_THRESHOLD}% threshold.`);
    console.log(`Surviving mutants (first 5):`);
    for (const m of score.survivingMutants.slice(0, 5)) {
      console.log(`  line ${m.line}  ${m.mutator}  ->  ${m.replacement}`);
    }
  }
} finally {
  await runner.cleanup();
}
