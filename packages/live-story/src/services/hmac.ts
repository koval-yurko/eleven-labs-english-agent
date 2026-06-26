import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ElevenLabs post-call webhook signature verification (008-langsmith-tracing, R6).
 *
 * ElevenLabs signs each delivery with an HMAC-SHA256 over `"{timestamp}.{rawBody}"` using the
 * shared `ELEVENLABS_CONVAI_WEBHOOK_SECRET`, sent in the `ElevenLabs-Signature` header as
 * `t=<unix>,v0=<hex>`. The route MUST verify against the RAW request body before parsing —
 * this is the only thing standing between a public ingress and forged trace injection (FR-007).
 *
 * Pure + dependency-light (Node `crypto` only, an existing precedent). Returns a boolean;
 * callers map a false to a 401 and produce no trace.
 */

export interface VerifyHmacInput {
  /** The exact raw request body string (NOT re-serialized JSON). */
  rawBody: string;
  /** The `ElevenLabs-Signature` header value, e.g. `t=1718900000,v0=abcd…`. */
  signatureHeader: string | null | undefined;
  /** The shared secret; when absent the webhook is unconfigured and all posts are rejected. */
  secret: string | undefined;
  /**
   * Optional max age (seconds) for the signed timestamp to bound replay. Default 1800 (30 min);
   * pass 0 to disable the freshness check. The current time is injected for testability.
   */
  toleranceSeconds?: number;
  nowMs?: number;
}

/** Parse `t=…,v0=…` (order-independent, tolerant of spaces) into its parts. */
function parseSignatureHeader(header: string): { t?: string; v0?: string } {
  const out: { t?: string; v0?: string } = {};
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") out.t = v?.trim();
    else if (k?.trim() === "v0") out.v0 = v?.trim();
  }
  return out;
}

/** Constant-time hex compare that never throws on length mismatch. */
function safeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function verifyElevenLabsSignature(input: VerifyHmacInput): boolean {
  const { rawBody, signatureHeader, secret } = input;
  if (!secret || !signatureHeader) return false;

  const { t, v0 } = parseSignatureHeader(signatureHeader);
  if (!t || !v0) return false;

  const tolerance = input.toleranceSeconds ?? 1800;
  if (tolerance > 0) {
    const tsSec = Number.parseInt(t, 10);
    if (Number.isNaN(tsSec)) return false;
    const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSec - tsSec) > tolerance) return false;
  }

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return safeHexEqual(expected, v0);
}
