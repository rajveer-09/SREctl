import { describe, expect, it } from "vitest";
import { classify, scoreIncident, summarize } from "./score.js";

/**
 * The scorer is measurement apparatus, and broken apparatus is worse than
 * none: it reports a number that looks like a result.
 *
 * These strings are real model output from the chaos runs. The first version
 * of `classify` returned "unknown" for a hypothesis that named the TypeError,
 * the null value and the exact expression - a completely correct diagnosis
 * scored as a failure, and the headline accuracy was measuring the scorer
 * rather than the agent.
 */
describe("classify: real hypotheses from the chaos runs", () => {
  const cases: Array<[string, string]> = [
    [
      "application-error",
      "The container's command runs an inline Node.js script that parses a JSON string where the 'server' key is null, and then attempts to access 'cfg.server.port', causing a TypeError and process exit.",
    ],
    [
      "application-error",
      "An unhandled promise rejection from a refused connection to the database at 10.0.0.5:5432 terminates the process.",
    ],
    [
      "application-error",
      "An AssertionError is thrown because the running Node version 24.20.0 does not match the expected 18.0.0.",
    ],
    [
      "bad-image",
      'The image reference "nginx:v99-does-not-exist" cannot be pulled: the tag does not exist in that repository',
    ],
    [
      "memory-limit-too-low",
      "The container's memory limit of 16Mi is lower than what it allocates.",
    ],
    [
      "missing-env-var",
      "The container exits at startup because required configuration is absent: DATABASE_URL.",
    ],
    [
      "failing-probe",
      "The readiness probe (httpGet /healthz on port 9090) never succeeds, so the container runs but is never added to a Service.",
    ],
    // Names the image, and is still an application fault. Matching the bare
    // word "image" scored this as a pull failure.
    [
      "application-error",
      "The container image 'srectl-runner:dev' is running Node.js version 24.20.0, which causes the assertion in the command script expecting version 18.0.0 to fail.",
    ],
  ];

  for (const [expected, text] of cases) {
    it(`${expected}: ${text.slice(0, 52)}...`, () => {
      expect(classify(text)).toBe(expected);
    });
  }
});

describe("classify: discriminating overlaps", () => {
  // "limit" appears in both an image pull rate limit and a memory limit, so
  // tallying keyword hits would get this wrong. Order has to decide.
  it("does not read an image pull rate limit as a memory limit", () => {
    expect(classify("The image pull failed because the registry rate limit was exceeded")).toBe(
      "bad-image",
    );
  });

  it("does not read a memory-related crash as an application error", () => {
    expect(classify("The process was OOMKilled after exceeding its memory limit")).toBe(
      "memory-limit-too-low",
    );
  });

  it("returns unknown rather than guessing when nothing matches", () => {
    expect(classify("Something went wrong somewhere in the system")).toBe("unknown");
  });
});

describe("summarize", () => {
  const base = {
    expected: "bad-image" as const,
    top1: "bad-image" as const,
    top3Correct: true,
    confidence: "high",
    source: "rule" as const,
    evidenceCount: 2,
    detectionLatencyMs: 100,
  };

  it("computes accuracy over cases that were actually scored", () => {
    const summary = summarize([
      { ...base, case: "a", top1Correct: true },
      { ...base, case: "b", top1Correct: false, top3Correct: false },
    ]);
    expect(summary.top1Pct).toBe(50);
  });

  /**
   * An upstream 429 is an outage, not a wrong answer. Counting it as a failure
   * understates accuracy and hides the outage behind a quality metric.
   */
  it("excludes unavailable cases from the denominator", () => {
    const summary = summarize([
      { ...base, case: "a", top1Correct: true },
      { ...base, case: "b", top1Correct: false, top3Correct: false, unavailable: "429: quota" },
    ]);

    expect(summary.scorable).toBe(1);
    expect(summary.unavailable).toBe(1);
    expect(summary.top1Pct).toBe(100);
  });
});

describe("scoreIncident", () => {
  it("marks a hypothesis correct when its class matches ground truth", () => {
    const result = scoreIncident({
      caseName: "oom-tiny",
      expected: "memory-limit-too-low",
      hypotheses: [
        { cause: "memory limit of 16Mi is too low", confidence: "high", evidence: ["a"], nextStep: "b", source: "rule" },
      ],
      detectionLatencyMs: 50,
    });

    expect(result.top1Correct).toBe(true);
    expect(result.source).toBe("rule");
  });

  it("counts a correct answer ranked second as top-3 but not top-1", () => {
    const result = scoreIncident({
      caseName: "x",
      expected: "memory-limit-too-low",
      hypotheses: [
        { cause: "a TypeError in the entrypoint", confidence: "low", evidence: [], nextStep: "", source: "model" },
        { cause: "the memory limit is too low", confidence: "medium", evidence: [], nextStep: "", source: "model" },
      ],
      detectionLatencyMs: null,
    });

    expect(result.top1Correct).toBe(false);
    expect(result.top3Correct).toBe(true);
  });
});
