import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawnTool } from "./lib/spawn-tool.js";

/**
 * Builds the runner image and pushes it to Artifact Registry.
 *
 * The tag is a hash of the Dockerfile plus the wrapper, exactly as for the
 * local build. That is not tidiness: `minikube image load` was observed to be
 * a silent no-op when it believed a tag unchanged, and the cluster then ran
 * stale code while local Docker had the fix. A registry has the same hazard
 * with `:latest`. A content tag cannot be mistaken for one already present.
 */

const REGION = process.env.SRECTL_REGION ?? "asia-south1";
const PROJECT = process.env.SRECTL_PROJECT ?? "srectl";
const REPO = "srectl";

const INPUTS = ["infra/docker/runner.Dockerfile", "packages/sandbox/src/wrapper/run.mjs"];

const hash = createHash("sha256");
for (const path of INPUTS) hash.update(await readFile(path, "utf8"));
const tag = hash.digest("hex").slice(0, 12);

const image = `${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/srectl-runner:${tag}`;

console.log(`image: ${image}\n`);

// One-time per host, and idempotent: without it `docker push` to a pkg.dev
// host fails with an unhelpful auth error.
console.log("configuring docker auth for Artifact Registry...");
await spawnTool("gcloud", ["auth", "configure-docker", `${REGION}-docker.pkg.dev`, "--quiet"]);

console.log("building...");
await spawnTool("docker", ["build", "-t", image, "-f", "infra/docker/runner.Dockerfile", "."]);

console.log("pushing...");
await spawnTool("docker", ["push", image]);

// The runners read this file, so nothing has to be told the tag by hand.
await writeFile(".runner-image", image + "\n", "utf8");

console.log(`\npushed. .runner-image now points at the registry copy.`);
console.log(`Local Minikube runs will use it too — set SRECTL_RUNNER_IMAGE to override.`);

