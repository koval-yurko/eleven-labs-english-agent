import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyElevenLabsSignature } from "../../src/services/hmac";

/**
 * Contract test for ElevenLabs webhook HMAC verification (008-langsmith-tracing, T009).
 */

const SECRET = "whsec_test_secret";
const NOW_MS = Date.parse("2026-06-25T12:00:00.000Z");
const T = String(Math.floor(NOW_MS / 1000));

function sign(body: string, secret = SECRET, t = T): string {
  const v0 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v0=${v0}`;
}

describe("verifyElevenLabsSignature", () => {
  const rawBody = JSON.stringify({ type: "post_call_transcription_otel", data: {} });

  it("accepts a correctly-signed body", () => {
    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: sign(rawBody),
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: sign(rawBody, "whsec_wrong"),
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a tampered body (signature computed over different bytes)", () => {
    const header = sign(rawBody);
    expect(
      verifyElevenLabsSignature({
        rawBody: rawBody + " ",
        signatureHeader: header,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a missing header or missing secret", () => {
    expect(
      verifyElevenLabsSignature({ rawBody, signatureHeader: null, secret: SECRET, nowMs: NOW_MS }),
    ).toBe(false);
    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: sign(rawBody),
        secret: undefined,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", () => {
    const stale = sign(rawBody, SECRET, String(Math.floor(NOW_MS / 1000) - 4000));
    expect(
      verifyElevenLabsSignature({
        rawBody,
        signatureHeader: stale,
        secret: SECRET,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });
});
