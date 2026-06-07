import type { LogFields } from "./logger";

/**
 * Secret redaction (FR-012, research R6, 003-internal-logging).
 *
 * Defense in depth: at default (`info`) level the pipeline only emits counts/ids/model
 * ids, so secrets should never reach a field in the first place. This pass is the safety
 * net — any field whose KEY name looks secret, or whose VALUE matches a known secret
 * shape, is replaced with `"[redacted]"` before serialization. Applied recursively to
 * nested objects/arrays so a secret can't hide one level down.
 */

const REDACTED = "[redacted]";

/** Key names that should never have their value emitted, whatever the value is. */
const SECRET_KEY = /(?:api[-_]?key|secret|password|passwd|token|authorization|auth|bearer|credential|private[-_]?key|access[-_]?key|session)/i;

/** Value shapes that look like a secret regardless of the key they sit under. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI/Anthropic-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/, // Anthropic
  /\bxi-[A-Za-z0-9]{16,}\b/, // ElevenLabs xi-api-key style
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i, // bearer tokens
];

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value && typeof value === "object") {
    return redactObject(value as Record<string, unknown>);
  }
  return value;
}

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(value);
  }
  return out;
}

/** Return a redacted copy of `fields`; never mutates the input. */
export function redactFields(fields: LogFields): LogFields {
  return redactObject(fields);
}
