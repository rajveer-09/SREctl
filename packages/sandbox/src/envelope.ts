import { z } from "zod";

export const BEGIN = "<<<SRECTL_RESULT";
export const END = "SRECTL_RESULT>>>";

export const EnvelopeSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
  durationMs: z.number().optional(),
  tests: z
    .object({
      total: z.number(),
      passed: z.number(),
      failed: z.number(),
      skipped: z.number(),
    })
    .optional(),
  failures: z
    .array(
      z.object({
        name: z.string(),
        file: z.string().nullable().optional(),
        message: z.string(),
      }),
    )
    .optional(),
  coverage: z
    .object({
      lines: z.number().nullable(),
      statements: z.number().nullable(),
      branches: z.number().nullable(),
      functions: z.number().nullable(),
      perFile: z
        .record(
          z.string(),
          z.object({
            pct: z.number().nullable(),
            covered: z.number(),
            total: z.number(),
          }),
        )
        .optional(),
    })
    .nullable()
    .optional(),
  /** Caller-nominated JSON file, returned via SRECTL_EXTRA_JSON. */
  extra: z.unknown().optional(),
  /** How file injection went. Zero files written is a failure worth seeing. */
  injected: z
    .object({
      count: z.number(),
      skipped: z.string().optional(),
      error: z.string().optional(),
      errors: z.array(z.string()).optional(),
    })
    .optional(),
  truncated: z.boolean().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  error: z.string().optional(),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

export type ParseFailure =
  | "no-begin-marker"
  | "no-end-marker"
  | "invalid-json"
  | "schema-mismatch";

export type ParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: ParseFailure; detail: string };

/**
 * Extracts the envelope from raw container output.
 *
 * Every branch here returns a typed failure rather than throwing. A sandbox
 * run that OOMs mid-write, or a test that prints the sentinel itself, must
 * degrade to "could not parse" and let the caller decide - not crash the
 * orchestrator that was supervising it.
 */
export function parseEnvelope(raw: string): ParseResult {
  // The LAST begin marker wins. A test whose own output contains the sentinel
  // would otherwise shadow the real envelope, which is printed at the end.
  const begin = raw.lastIndexOf(BEGIN);
  if (begin === -1) {
    return { ok: false, reason: "no-begin-marker", detail: tail(raw) };
  }

  const afterBegin = begin + BEGIN.length;
  const end = raw.indexOf(END, afterBegin);
  if (end === -1) {
    // Killed between printing the opening marker and finishing the payload -
    // an OOM or deadline during result writing looks exactly like this.
    return { ok: false, reason: "no-end-marker", detail: tail(raw.slice(afterBegin)) };
  }

  const json = raw.slice(afterBegin, end).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return { ok: false, reason: "invalid-json", detail: (err as Error).message };
  }

  const validated = EnvelopeSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: "schema-mismatch",
      detail: validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  return { ok: true, envelope: validated.data };
}

function tail(text: string, n = 500): string {
  return text.length <= n ? text : "..." + text.slice(-n);
}

/** One-line summary for logs and PR bodies. */
export function describeEnvelope(envelope: Envelope): string {
  if (envelope.error) return `wrapper error: ${envelope.error}`;
  const t = envelope.tests;
  if (!t) return envelope.ok ? "ok, no test results" : "failed, no test results";
  return `${t.passed}/${t.total} passed, ${t.failed} failed, ${t.skipped} skipped`;
}
