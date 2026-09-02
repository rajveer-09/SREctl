import { readFileSync } from "node:fs";

/**
 * Resolves the runner image tag.
 *
 * `.runner-image` is written by `pnpm build:runner` and holds a
 * content-addressed tag, so a changed wrapper cannot be confused with an image
 * already loaded into the cluster.
 */
export function runnerImage(): string {
  if (process.env.SRECTL_RUNNER_IMAGE) return process.env.SRECTL_RUNNER_IMAGE;
  try {
    return readFileSync(".runner-image", "utf8").trim();
  } catch {
    return "srectl-runner:dev";
  }
}
