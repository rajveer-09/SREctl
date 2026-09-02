import { describe, expect, it } from "vitest";
import { computeAllowlist, testCandidatesFor } from "./allowlist.js";

const testgen = (candidates: string[]) => computeAllowlist({ mode: "testgen", candidates });

describe("hard denials", () => {
  // These hold no matter what mode is active or what the candidate set says.
  const forbidden = [
    ".github/workflows/release.yml",
    ".github/dependabot.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    ".gitlab-ci.yml",
    "package.json",
    "packages/core/package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "stryker.config.mjs",
    "Dockerfile",
    "docker-compose.yml",
    ".npmrc",
    ".env",
    ".env.production",
  ];

  for (const path of forbidden) {
    it(`refuses ${path}`, () => {
      expect(testgen([]).check(path).allowed).toBe(false);
    });
  }

  it("refuses them even when they are handed in as candidates", () => {
    const list = testgen([".github/workflows/release.yml", "package.json", "src/a.test.ts"]);

    expect(list.candidates).toEqual(["src/a.test.ts"]);
    expect(list.check(".github/workflows/release.yml").allowed).toBe(false);
    expect(list.check("package.json").allowed).toBe(false);
  });
});

describe("path shape", () => {
  // Built from a char code so no source-level escaping can quietly turn this
  // into a path with no backslash in it at all.
  const BSLASH = String.fromCharCode(92);

  const bad: Array<[string, string]> = [
    ["../../etc/passwd", "path traversal"],
    ["src/../../../secrets.ts", "path traversal"],
    ["/etc/passwd", "absolute path"],
    ["C:/Windows/System32/x.ts", "absolute path"],
    [`src${BSLASH}money.test.ts`, "backslash in path"],
    ["src//money.test.ts", "empty path segment"],
    ["", "empty path"],
  ];

  for (const [path, reason] of bad) {
    it(`rejects ${JSON.stringify(path)} as ${reason}`, () => {
      const decision = testgen([path]).check(path);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toContain(reason);
    });
  }
});

describe("review mode", () => {
  it("grants no write capability at all", () => {
    const list = computeAllowlist({ mode: "review", candidates: ["src/money.test.ts"] });
    const decision = list.check("src/money.test.ts");

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("review mode grants no write capability");
  });
});

describe("testgen mode", () => {
  it("allows a path that was computed before the model ran", () => {
    expect(testgen(["test/money.test.ts"]).check("test/money.test.ts")).toEqual({
      allowed: true,
      reason: "allowed: in the allowlist computed from this diff",
    });
  });

  it("refuses a plausible-looking path that was not computed", () => {
    const decision = testgen(["test/money.test.ts"]).check("test/invoice.test.ts");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not in the allowlist");
  });

  it("throws on assert for a rejected path", () => {
    expect(() => testgen([]).assert("src/evil.ts")).toThrow(/path allowlist rejected/);
  });
});

describe("testCandidatesFor", () => {
  it("derives a colocated test path", () => {
    expect(testCandidatesFor("src/money.ts", "colocated")).toEqual(["src/money.test.ts"]);
  });

  it("derives test-directory paths", () => {
    expect(testCandidatesFor("src/lib/money.ts", "test-dir")).toEqual([
      "test/money.test.ts",
      "tests/money.test.ts",
    ]);
  });

  it("returns nothing for a non-source file", () => {
    expect(testCandidatesFor("README.md", "colocated")).toEqual([]);
  });
});
