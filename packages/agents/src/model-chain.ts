import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@srectl/core";

/**
 * Model selection with automatic fallback.
 *
 * Each Gemini model carries its own free-tier allowance, so exhausting one
 * does not mean the API is unavailable - it means this model is. Falling back
 * down a chain turns a hard stop into a degradation.
 *
 * The awkward part is that Gemini does NOT distinguish "you are going too
 * fast" from "you are done for the day". Both arrive as 429, and both carry a
 * short `retry in Ns` hint - an exhausted DAILY quota (limit: 20) still
 * advises a ~53s wait it will never honour. Trusting that advice is how a run
 * burns five minutes and still fails, which is exactly what happened before
 * this module existed.
 *
 * So the policy is empirical rather than semantic: wait ONCE, because a
 * genuine per-minute limit clears in about a minute; if the same model refuses
 * again, treat it as spent for this process and move down the chain. Being
 * wrong costs one wasted minute in one direction and a stalled pipeline in the
 * other.
 */

/** Ordered by capability. Later entries are cheaper and have larger allowances. */
export const DEFAULT_MODEL_CHAIN = [
  "gemini-3.5-flash",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
];

export type FailureKind = "rate-limit" | "overloaded" | "no-such-model" | "other";

export interface Classified {
  kind: FailureKind;
  code: string;
  /** What the API advised. A hint, never a promise - see the note above. */
  retryAfterMs: number | null;
}

const RATE_LIMIT = new Set(["429"]);
const OVERLOADED = new Set(["500", "502", "503", "504"]);

/** Capped: a multi-minute wait is never worth it when another model is one call away. */
const MAX_WAIT_MS = 70_000;

export function classifyFailure(failure: string): Classified {
  const code = failure.split(":")[0]?.trim() ?? "";
  const advised = /retry in ([\d.]+)s/i.exec(failure)?.[1];
  const retryAfterMs = advised
    ? Math.min(Math.ceil(Number(advised) * 1000) + 1000, MAX_WAIT_MS)
    : null;

  if (RATE_LIMIT.has(code)) return { kind: "rate-limit", code, retryAfterMs };
  if (OVERLOADED.has(code)) return { kind: "overloaded", code, retryAfterMs };
  if (code === "404" || /not found|is not supported|does not exist/i.test(failure)) {
    return { kind: "no-such-model", code, retryAfterMs: null };
  }
  return { kind: "other", code, retryAfterMs };
}

/**
 * Models known to be spent or unusable, with an expiry.
 *
 * Without this, every later call re-discovers the exhausted model and pays a
 * full request plus a wait to learn what the previous one already knew.
 */
const unusable = new Map<string, { why: string; until: number }>();

/**
 * How long a spent model stays skipped.
 *
 * Long enough that a sequence of CLI runs does not re-pay the discovery cost,
 * short enough that a per-minute limit mistaken for exhaustion recovers on its
 * own. Quotas reset; this must never be permanent.
 */
const COOLDOWN_MS = 15 * 60_000;

/**
 * Persisted, because process memory alone is useless here.
 *
 * Every `pnpm review` is a fresh process, so an in-memory note is forgotten
 * immediately and the next run pays the same ~50s wait to rediscover the same
 * exhausted model. Observed live: three consecutive runs, three identical
 * waits. A small file with a TTL turns that into nothing.
 */
const STATE_FILE = join(process.env.SRECTL_DATA_DIR ?? ".data", "model-state.json");
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<
      string,
      { why: string; until: number }
    >;
    const now = Date.now();
    for (const [model, entry] of Object.entries(raw)) {
      if (entry.until > now) unusable.set(model, entry);
    }
  } catch {
    // No state yet, or it is unreadable. Starting clean is always safe: the
    // worst case is rediscovering an exhausted model once.
  }
}

function persist(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(unusable)), "utf8");
  } catch {
    // Losing the cache costs one wasted wait, never correctness.
  }
}

export function markUnusable(model: string, why: string, cooldownMs = COOLDOWN_MS): void {
  load();
  unusable.set(model, { why, until: Date.now() + cooldownMs });
  persist();
}

export function unusableModels(): Array<{ model: string; why: string; until: number }> {
  load();
  const now = Date.now();
  return [...unusable.entries()]
    .filter(([, e]) => e.until > now)
    .map(([model, e]) => ({ model, why: e.why, until: e.until }));
}

/** Test seam, and a way to force a retry after a quota reset. */
export function resetModelState(): void {
  unusable.clear();
  loaded = true;
  persist();
}

export interface ModelCallResult<T> {
  value: T;
  /** Present when the call did not produce a usable answer. */
  failure?: string | undefined;
}

export interface FallbackAttempt {
  model: string;
  kind: FailureKind | "ok" | "skipped";
  code?: string;
  waitedMs?: number;
}

export interface FallbackResult<T> {
  value: T;
  /** The model that actually served the result. Recorded, because a silently
   * changed model turns one metric into two blended populations. */
  model: string;
  attempts: FallbackAttempt[];
  /** Set only when every model in the chain failed. */
  failure?: string;
}

export interface FallbackOptions<T> {
  /** An explicit pin. Fallback applies only when the caller has NOT chosen. */
  model?: string | undefined;
  chain?: string[];
  logger?: Logger;
  /** Attempts per model before moving on. One retry clears an RPM window. */
  attemptsPerModel?: number;
  call: (model: string) => Promise<ModelCallResult<T>>;
}

export async function runWithFallback<T>(opts: FallbackOptions<T>): Promise<FallbackResult<T>> {
  // An explicitly requested model is honoured rather than silently replaced:
  // being quietly downgraded is worse than failing when someone asked for a
  // specific model on purpose.
  const pinned = Boolean(opts.model);
  const chain = opts.model ? [opts.model] : (opts.chain ?? DEFAULT_MODEL_CHAIN);
  const attemptsPerModel = opts.attemptsPerModel ?? 2;

  load();
  const attempts: FallbackAttempt[] = [];
  let last: ModelCallResult<T> | undefined;

  for (const model of chain) {
    const known = unusable.get(model);
    if (known && known.until > Date.now() && !pinned) {
      attempts.push({ model, kind: "skipped" });
      opts.logger?.info("skipping model on cooldown", {
        model,
        why: known.why,
        resumesInS: Math.round((known.until - Date.now()) / 1000),
      });
      continue;
    }

    for (let attempt = 1; attempt <= attemptsPerModel; attempt += 1) {
      const result = await opts.call(model);
      last = result;

      if (!result.failure) {
        attempts.push({ model, kind: "ok" });
        return { value: result.value, model, attempts };
      }

      const classified = classifyFailure(result.failure);

      if (classified.kind === "no-such-model") {
        markUnusable(model, "not available to this API key");
        attempts.push({ model, kind: classified.kind, code: classified.code });
        break;
      }

      const transient = classified.kind === "rate-limit" || classified.kind === "overloaded";
      if (transient && attempt < attemptsPerModel) {
        const waitMs = classified.retryAfterMs ?? 3000 * attempt;
        opts.logger?.warn("model unavailable, waiting once before falling back", {
          model,
          code: classified.code,
          waitMs,
        });
        attempts.push({ model, kind: classified.kind, code: classified.code, waitedMs: waitMs });
        await sleep(waitMs);
        continue;
      }

      attempts.push({ model, kind: classified.kind, code: classified.code });

      // Refused twice. Assume spent rather than waiting on advice it will not
      // honour, and let the next model carry the work.
      if (classified.kind === "rate-limit") {
        markUnusable(model, `quota exhausted (${classified.code})`);
        opts.logger?.warn("model quota exhausted, falling back", {
          model,
          next: nextIn(chain, model) ?? "(end of chain)",
        });
      }
      break;
    }
  }

  return {
    value: last?.value as T,
    model: chain.at(-1) ?? "none",
    attempts,
    failure: last?.failure ?? "no model in the chain produced a result",
  };
}

function nextIn(chain: string[], model: string): string | null {
  const index = chain.indexOf(model);
  return index >= 0 && index + 1 < chain.length ? (chain[index + 1] as string) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
