import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

/**
 * Builds the runner image with a content-addressed tag and loads it into
 * Minikube.
 *
 * `minikube image load srectl-runner:dev` can be a NO-OP when it believes the
 * tag is unchanged. The cluster then runs stale code while local Docker has
 * the new build, and the symptom is arbitrary: in our case the sandbox silently
 * skipped file injection and every suite reported "0 tests collected". Nothing
 * about that points at a stale image.
 *
 * Tagging by content hash removes the ambiguity: a changed wrapper produces a
 * different tag, and a different tag cannot be mistaken for one already loaded.
 */

const INPUTS = [
  "infra/docker/runner.Dockerfile",
  "packages/sandbox/src/wrapper/run.mjs",
];

const hash = createHash("sha256");
for (const path of INPUTS) {
  hash.update(await readFile(path, "utf8"));
}
const tag = `srectl-runner:${hash.digest("hex").slice(0, 12)}`;

console.log(`building ${tag}`);
await run("docker", ["build", "-q", "-t", tag, "-f", "infra/docker/runner.Dockerfile", "."]);

const minikubePath = process.env.MINIKUBE_PATH ?? "C:\\Program Files\\Kubernetes\\Minikube\\minikube.exe";
console.log(`loading ${tag} into minikube`);
await run(minikubePath, ["image", "load", tag]);

// Written where every runner reads it, so nothing has to be told the tag.
await writeFile(".runner-image", tag + "\n", "utf8");
console.log(`\n${tag}\nwrote .runner-image — set SRECTL_RUNNER_IMAGE from it, or let the runners read it.`);

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
