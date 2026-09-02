import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const CANDIDATES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "package.json"];

/**
 * Cache key for the prep artifact.
 *
 * Hashing the lockfile rather than the whole repo is the point: dependencies
 * change far less often than code, so most runs reuse an existing artifact and
 * skip the network phase entirely. Falls back to package.json for a repo with
 * no lockfile, which is weaker but still stable across code-only edits.
 */
export async function lockfileHash(repoRoot: string): Promise<{ hash: string; source: string }> {
  for (const name of CANDIDATES) {
    try {
      const content = await readFile(join(repoRoot, name), "utf8");
      // Normalize line endings: on Windows a checkout can flip CRLF/LF and
      // change the bytes without changing a single dependency.
      const normalized = content.split("\r\n").join("\n");
      return { hash: createHash("sha256").update(normalized).digest("hex"), source: name };
    } catch {
      continue;
    }
  }
  throw new Error(`no lockfile or package.json found in ${repoRoot}`);
}
