import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "./verify.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = JSON.stringify({ action: "opened", repository: { full_name: "a/b" } });

describe("verifySignature", () => {
  it("accepts a signature GitHub would have produced", () => {
    expect(verifySignature(BODY, signBody(BODY, SECRET), SECRET)).toEqual({ ok: true });
  });

  it("rejects when a single body byte is flipped", () => {
    const sig = signBody(BODY, SECRET);
    const tampered = BODY.replace('"opened"', '"closed"');
    expect(verifySignature(tampered, sig, SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with the wrong secret", () => {
    const sig = signBody(BODY, "wrong-secret-wrong-secret-1234567");
    expect(verifySignature(BODY, sig, SECRET)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a missing header", () => {
    expect(verifySignature(BODY, null, SECRET)).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifySignature(BODY, undefined, SECRET)).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a header without the sha256= prefix", () => {
    const bare = signBody(BODY, SECRET).slice("sha256=".length);
    expect(verifySignature(BODY, bare, SECRET)).toEqual({ ok: false, reason: "malformed_signature" });
  });

  it("rejects a wrong-length digest without throwing", () => {
    expect(verifySignature(BODY, "sha256=abc123", SECRET)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("rejects non-hex characters without throwing", () => {
    expect(verifySignature(BODY, "sha256=" + "z".repeat(64), SECRET)).toEqual({
      ok: false,
      reason: "malformed_signature",
    });
  });

  it("is sensitive to whitespace, since the signature is over raw bytes", () => {
    const sig = signBody(BODY, SECRET);
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifySignature(reserialized, sig, SECRET)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});
