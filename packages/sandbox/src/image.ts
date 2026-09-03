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

/**
 * How Kubernetes should obtain the image.
 *
 * On Minikube the image is side-loaded with `minikube image load` and exists
 * only on the node, so `Never` is correct and `Always` would fail trying to
 * pull a tag no registry has. On GKE the node has no local store and the image
 * must come from Artifact Registry.
 *
 * The tag itself says which situation we are in: a registry path carries a
 * host with a dot in it (asia-south1-docker.pkg.dev/...), a side-loaded tag
 * does not.
 */
export function imagePullPolicy(image = runnerImage()): "Never" | "IfNotPresent" {
  const [first] = image.split("/");
  const isRegistryPath = image.includes("/") && (first?.includes(".") || first?.includes(":"));
  return isRegistryPath ? "IfNotPresent" : "Never";
}
