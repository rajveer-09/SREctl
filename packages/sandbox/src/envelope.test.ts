import { describe, expect, it } from "vitest";
import { BEGIN, describeEnvelope, END, parseEnvelope } from "./envelope.js";

const wrap = (payload: unknown) => `${BEGIN}\n${JSON.stringify(payload)}\n${END}`;

const good = {
  ok: true,
  exitCode: 0,
  durationMs: 1200,
  tests: { total: 5, passed: 5, failed: 0, skipped: 0 },
  failures: [],
  coverage: { lines: 82.5, statements: 80, branches: 66.6, functions: 90, perFile: { "src/money.ts": { pct: 82.5, covered: 33, total: 40 } } },
  truncated: false,
  stdout: "",
  stderr: "",
};

describe("well-formed output", () => {
  it("parses an envelope surrounded by ordinary suite output", () => {
    const raw = `> vitest run\n\nsome noise\n${wrap(good)}\ntrailing noise`;
    const result = parseEnvelope(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.tests).toEqual({ total: 5, passed: 5, failed: 0, skipped: 0 });
    expect(result.envelope.coverage?.lines).toBe(82.5);
  });

  it("keeps failure details", () => {
    const failing = {
      ...good,
      ok: false,
      exitCode: 1,
      tests: { total: 2, passed: 1, failed: 1, skipped: 0 },
      failures: [{ name: "allocate > splits evenly", file: "test/money.test.ts", message: "expected 33 to be 34" }],
    };
    const result = parseEnvelope(wrap(failing));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.failures?.[0]?.message).toContain("expected 33");
  });
});

describe("hostile and broken output", () => {
  /**
   * A generated test can print anything, including our own sentinel. Taking
   * the LAST begin marker means the real envelope, printed at the very end by
   * the wrapper, always wins over anything the test forged earlier.
   */
  it("ignores a sentinel forged by the test itself", () => {
    const forged = wrap({ ok: true, tests: { total: 999, passed: 999, failed: 0, skipped: 0 } });
    const real = wrap({ ...good, ok: false, tests: { total: 1, passed: 0, failed: 1, skipped: 0 } });
    const result = parseEnvelope(`${forged}\nmore output\n${real}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.tests?.total).toBe(1);
    expect(result.envelope.ok).toBe(false);
  });

  it("reports a missing begin marker rather than throwing", () => {
    const result = parseEnvelope("the container died before printing anything useful");
    expect(result).toMatchObject({ ok: false, reason: "no-begin-marker" });
  });

  // OOM or deadline during result writing looks exactly like this.
  it("reports a truncated envelope rather than throwing", () => {
    const result = parseEnvelope(`noise\n${BEGIN}\n{"ok":true,"tests":{"tot`);
    expect(result).toMatchObject({ ok: false, reason: "no-end-marker" });
  });

  it("reports malformed JSON between valid markers", () => {
    const result = parseEnvelope(`${BEGIN}\n{ok: true, not json}\n${END}`);
    expect(result).toMatchObject({ ok: false, reason: "invalid-json" });
  });

  it("reports a payload that parses but is the wrong shape", () => {
    const result = parseEnvelope(wrap({ ok: "yes please" }));
    expect(result).toMatchObject({ ok: false, reason: "schema-mismatch" });
    if (result.ok) return;
    expect(result.detail).toContain("ok");
  });

  it("survives megabytes of noise before the envelope", () => {
    const noise = "x".repeat(2_000_000);
    const result = parseEnvelope(`${noise}\n${wrap(good)}`);
    expect(result.ok).toBe(true);
  });

  it("bounds the detail it reports back on failure", () => {
    const result = parseEnvelope("y".repeat(100_000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail.length).toBeLessThan(1_000);
  });
});

describe("describeEnvelope", () => {
  it("summarizes counts", () => {
    expect(describeEnvelope(good)).toBe("5/5 passed, 0 failed, 0 skipped");
  });

  it("surfaces a wrapper-level error", () => {
    expect(describeEnvelope({ ok: false, error: "failed to spawn: ENOENT" })).toContain("ENOENT");
  });
});
