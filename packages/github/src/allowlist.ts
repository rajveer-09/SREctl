/**
 * The path allowlist is the real defence against prompt injection through the
 * data plane. Prompting alone is not sufficient: the model reads attacker-
 * controllable text, so any write it proposes is checked here, in code, before
 * it reaches the GitHub API.
 *
 * Two layers, in this order:
 *   1. HARD DENY — categories that are never writable, whatever the mode or
 *      the computed candidate set says. Checked first so a poisoned candidate
 *      list cannot grant them.
 *   2. Membership — the path must be in the set computed from the diff BEFORE
 *      the model ran.
 */

export type WriteMode = "review" | "testgen";

export interface AllowlistDecision {
  allowed: boolean;
  reason: string;
}

/** Never writable. Ordered most-specific-first so reasons stay informative. */
const HARD_DENY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\.github\//i, reason: "GitHub configuration (workflows, actions, templates)" },
  { pattern: /^\.circleci\//i, reason: "CI configuration" },
  { pattern: /^(Jenkinsfile|\.travis\.yml|appveyor\.yml|azure-pipelines\.ya?ml|\.gitlab-ci\.yml)$/i, reason: "CI configuration" },
  { pattern: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb)$/i, reason: "dependency manifest or lockfile" },
  { pattern: /(^|\/)tsconfig[^/]*\.json$/i, reason: "TypeScript build configuration" },
  { pattern: /(^|\/)(vite|vitest|rollup|webpack|jest|stryker)\.config\.[^/]+$/i, reason: "build or test-runner configuration" },
  { pattern: /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|Makefile)$/i, reason: "build or container configuration" },
  { pattern: /(^|\/)\.(npmrc|yarnrc|env|env\.[^/]*)$/i, reason: "credentials or registry configuration" },
];

export interface Allowlist {
  readonly mode: WriteMode;
  readonly candidates: readonly string[];
  check(path: string): AllowlistDecision;
  assert(path: string): void;
}

/** Rejects traversal, absolute paths, and Windows separators before matching. */
function normalize(path: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (path.length === 0) return { ok: false, reason: "empty path" };
  if (path.includes("\\")) return { ok: false, reason: "backslash in path" };
  if (path.includes("\0")) return { ok: false, reason: "null byte in path" };
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) return { ok: false, reason: "absolute path" };

  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "path traversal" };
  if (segments.some((s) => s === "")) return { ok: false, reason: "empty path segment" };

  return { ok: true, path };
}

export function computeAllowlist(opts: { mode: WriteMode; candidates?: string[] }): Allowlist {
  const mode = opts.mode;
  // A candidate that is itself hard-denied never enters the set.
  const candidates = (opts.candidates ?? []).filter((c) => {
    const n = normalize(c);
    return n.ok && !HARD_DENY.some((d) => d.pattern.test(n.path));
  });
  const set = new Set(candidates);

  const check = (path: string): AllowlistDecision => {
    const n = normalize(path);
    if (!n.ok) return { allowed: false, reason: `rejected: ${n.reason}` };

    for (const deny of HARD_DENY) {
      if (deny.pattern.test(n.path)) {
        return { allowed: false, reason: `denied: ${deny.reason}` };
      }
    }

    if (mode === "review") {
      return { allowed: false, reason: "denied: review mode grants no write capability" };
    }
    if (!set.has(n.path)) {
      return { allowed: false, reason: "denied: not in the allowlist computed from this diff" };
    }
    return { allowed: true, reason: "allowed: in the allowlist computed from this diff" };
  };

  return {
    mode,
    candidates,
    check,
    assert(path: string) {
      const decision = check(path);
      if (!decision.allowed) throw new Error(`path allowlist rejected "${path}" — ${decision.reason}`);
    },
  };
}

/** Where a test for `src/money.ts` is allowed to be written. */
export function testCandidatesFor(sourcePath: string, layout: "colocated" | "test-dir"): string[] {
  const match = /^(.*?)([^/]+)\.(ts|tsx|js|jsx|mts|cts)$/.exec(sourcePath);
  if (!match) return [];
  const [, dir, base, ext] = match;

  if (layout === "colocated") return [`${dir}${base}.test.${ext}`];
  return [`test/${base}.test.${ext}`, `tests/${base}.test.${ext}`];
}
