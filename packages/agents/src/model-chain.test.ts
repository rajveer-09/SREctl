import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  DEFAULT_MODEL_CHAIN,
  resetModelState,
  runWithFallback,
  unusableModels,
} from "./model-chain.js";

/** The real 429 body, verbatim. Note it advises a wait it will not honour. */
const DAILY_EXHAUSTED =
  "429: You exceeded your current quota, please check your plan and billing details. " +
  "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
  "limit: 20, model: gemini-3.5-flash. Please retry in 53.14737379s.";

const OVERLOADED = "503: This model is currently experiencing high demand.";
const NOT_FOUND = "404: models/gemini-2.5-flash is not found for API version v1beta";

beforeEach(() => {
  resetModelState();
  vi.useFakeTimers();
});

/** Drives the fallback loop past its waits without actually sleeping. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  const promise = fn();
  await vi.runAllTimersAsync();
  return promise;
}

describe("classifyFailure", () => {
  it("classifies a quota refusal as a rate limit", () => {
    expect(classifyFailure(DAILY_EXHAUSTED)).toMatchObject({ kind: "rate-limit", code: "429" });
  });

  it("classifies overload separately from quota", () => {
    expect(classifyFailure(OVERLOADED).kind).toBe("overloaded");
  });

  it("classifies an unavailable model so it is never retried", () => {
    expect(classifyFailure(NOT_FOUND).kind).toBe("no-such-model");
  });

  it("reads the advised wait but caps it", () => {
    expect(classifyFailure(DAILY_EXHAUSTED).retryAfterMs).toBe(54_148);
    expect(classifyFailure("429: slow down. Please retry in 600s.").retryAfterMs).toBe(70_000);
  });

  it("tolerates a failure with no advice", () => {
    expect(classifyFailure("429: too many requests").retryAfterMs).toBeNull();
  });
});

describe("fallback policy", () => {
  it("returns the first model's answer when it works", async () => {
    const call = vi.fn(async (model: string) => ({ value: `ok from ${model}` }));
    const result = await run(() => runWithFallback({ call }));

    expect(result.model).toBe(DEFAULT_MODEL_CHAIN[0]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(result.failure).toBeUndefined();
  });

  /**
   * The behaviour this module exists for. A genuine per-minute limit clears in
   * about a minute, so one wait is worth taking - but only one, because a
   * daily exhaustion looks identical and will never clear.
   */
  it("waits once, then drops to the next model", async () => {
    const call = vi.fn(async (model: string) =>
      model === "gemini-3.5-flash"
        ? { value: null, failure: DAILY_EXHAUSTED }
        : { value: `ok from ${model}` },
    );

    const result = await run(() => runWithFallback({ call }));

    expect(call).toHaveBeenCalledTimes(3); // twice on the first model, once on the second
    expect(result.model).toBe("gemini-flash-latest");
    expect(result.attempts.filter((a) => a.waitedMs).length).toBe(1);
  });

  it("succeeds if the retry clears, without falling back", async () => {
    let calls = 0;
    const call = vi.fn(async (model: string) => {
      calls += 1;
      return calls === 1 ? { value: null, failure: DAILY_EXHAUSTED } : { value: `ok from ${model}` };
    });

    const result = await run(() => runWithFallback({ call }));
    expect(result.model).toBe("gemini-3.5-flash");
  });

  it("remembers a spent model and skips it on the next call", async () => {
    const call = vi.fn(async (model: string) =>
      model === "gemini-3.5-flash"
        ? { value: null, failure: DAILY_EXHAUSTED }
        : { value: `ok from ${model}` },
    );

    await run(() => runWithFallback({ call }));
    expect(unusableModels().map((u) => u.model)).toContain("gemini-3.5-flash");

    call.mockClear();
    const second = await run(() => runWithFallback({ call }));

    // Re-discovering the exhausted model would cost a request AND a wait to
    // learn what the previous call already knew.
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toBe("gemini-flash-latest");
    expect(second.model).toBe("gemini-flash-latest");
  });

  it("never retries a model the key cannot use", async () => {
    const call = vi.fn(async (model: string) =>
      model === "gemini-3.5-flash" ? { value: null, failure: NOT_FOUND } : { value: "ok" },
    );

    await run(() => runWithFallback({ call }));

    const onFirst = call.mock.calls.filter((c) => c[0] === "gemini-3.5-flash");
    expect(onFirst).toHaveLength(1);
  });

  it("retries an overloaded model once before moving on", async () => {
    const call = vi.fn(async (model: string) =>
      model === "gemini-3.5-flash" ? { value: null, failure: OVERLOADED } : { value: "ok" },
    );

    const result = await run(() => runWithFallback({ call }));
    expect(result.model).toBe("gemini-flash-latest");
  });

  it("reports a failure when every model refuses", async () => {
    const call = vi.fn(async (_model: string) => ({ value: null, failure: DAILY_EXHAUSTED }));
    const result = await run(() => runWithFallback({ call }));

    expect(result.failure).toContain("429");
    expect(new Set(call.mock.calls.map((c) => c[0])).size).toBe(DEFAULT_MODEL_CHAIN.length);
  });
});

describe("an explicit model is honoured, not replaced", () => {
  /**
   * Silently downgrading a model someone chose on purpose is worse than
   * failing: it produces results attributed to a model that never ran.
   */
  it("does not fall back when the caller pinned a model", async () => {
    const call = vi.fn(async (_model: string) => ({ value: null, failure: DAILY_EXHAUSTED }));
    const result = await run(() => runWithFallback({ model: "gemini-3.5-flash", call }));

    expect(new Set(call.mock.calls.map((c) => c[0]))).toEqual(new Set(["gemini-3.5-flash"]));
    expect(result.failure).toContain("429");
  });

  it("still uses a pinned model that was marked unusable", async () => {
    const failing = vi.fn(async (_model: string) => ({ value: null, failure: DAILY_EXHAUSTED }));
    await run(() => runWithFallback({ call: failing }));

    const call = vi.fn(async (model: string) => ({ value: `ok from ${model}` }));
    const result = await run(() => runWithFallback({ model: "gemini-3.5-flash", call }));

    expect(result.model).toBe("gemini-3.5-flash");
  });
});
