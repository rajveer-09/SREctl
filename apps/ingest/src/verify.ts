import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyFailure = "missing_signature" | "malformed_signature" | "bad_signature";

export type VerifyResult = { ok: true } | { ok: false; reason: VerifyFailure };

const PREFIX = "sha256=";
const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Verifies GitHub's X-Hub-Signature-256 over the RAW request body.
 *
 * The body must never have been parsed and re-serialized before it gets here:
 * JSON.stringify(JSON.parse(x)) is not byte-identical to x, and the signature
 * is over bytes.
 */
export function verifySignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  secret: string,
): VerifyResult {
  if (!header) return { ok: false, reason: "missing_signature" };
  if (!header.startsWith(PREFIX)) return { ok: false, reason: "malformed_signature" };

  const provided = header.slice(PREFIX.length);
  if (!HEX_64.test(provided)) return { ok: false, reason: "malformed_signature" };

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(provided, "hex");

  // Lengths are both 32 by construction (HEX_64 above), so timingSafeEqual is
  // safe to call directly.
  if (expected.length !== actual.length) return { ok: false, reason: "bad_signature" };
  return timingSafeEqual(expected, actual) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** Test helper: produces the header GitHub would send for a given body. */
export function signBody(rawBody: string | Buffer, secret: string): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}
