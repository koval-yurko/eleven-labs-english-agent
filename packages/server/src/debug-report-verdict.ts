import type { DebugEvent } from "@tutor/shared/debug/report";

import { elevenLabsConfig } from "./config";

/**
 * What the PROVIDER recorded about a conversation — the half of a failure the phone never sees.
 *
 * Reports `47a7f19c` and `470ddc9f` (2026-10-01) are why this exists. The phone's side of them was
 * `"Server error: Unknown error"` and then two sessions that connected and ended with no error at
 * all; the cause — the account out of credits — was one `GET` away, on the conversation's own
 * record, and nothing in the report said so:
 *
 *     "error": { "code": 1002, "error_type": "dependency_error",
 *                "reason": "This request exceeds your quota limit." }
 *     "error": { "code": 3000, "error_type": "call_initialization_error",
 *                "reason": "[quota_exceeded] You've run out of credits. …" }
 *
 * The same lookup settled the 2026-08-20 outage by hand
 * (`docs/2026-08-21-quota-outage-and-pause-panel.md` §1.2). A step that has decided the answer
 * twice belongs in the document rather than in the reader's memory.
 *
 * ElevenLabs only: it is the one provider with a per-conversation record that names a termination
 * reason. Same posture as `langsmithTraceUrl` — bounded, and it swallows everything, because a
 * report must still print when the provider is the thing that is down.
 */
const VERDICT_LOOKUP_MS = 4000;

export interface ProviderVerdict {
  conversationId: string;
  /** The provider's own lifecycle word: `done`, `failed`, `in-progress`, … */
  status: string | null;
  durationSecs: number | null;
  /** Why it ended, in the provider's words. Null when it recorded none — an ordinary hangup. */
  reason: string | null;
  errorType: string | null;
  code: string | null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

export async function elevenLabsVerdict(conversationId: string): Promise<ProviderVerdict | null> {
  const { apiKey } = elevenLabsConfig();
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(VERDICT_LOOKUP_MS) },
    );
    if (!res.ok) return null;
    // Read as a bare shape and every field defensively: this is an undocumented corner of the
    // payload (`metadata.error`), and a report that throws on a renamed field explains nothing.
    const body = (await res.json()) as {
      status?: unknown;
      metadata?: {
        call_duration_secs?: unknown;
        termination_reason?: unknown;
        error?: { code?: unknown; reason?: unknown; error_type?: unknown } | null;
      };
    };
    const meta = body.metadata ?? {};
    const error = meta.error ?? null;
    return {
      conversationId,
      status: text(body.status),
      durationSecs: typeof meta.call_duration_secs === "number" ? meta.call_duration_secs : null,
      // `error.reason` first: a session refused at initialization has an EMPTY `termination_reason`
      // and the whole explanation in `error`.
      reason: text(error?.reason) ?? text(meta.termination_reason),
      errorType: text(error?.error_type),
      code:
        typeof error?.code === "number" || typeof error?.code === "string"
          ? String(error.code)
          : null,
    };
  } catch {
    return null;
  }
}

/** How many conversations' verdicts one report asks the provider for. */
const MAX_VERDICTS = 5;

/**
 * The verdict on EVERY conversation in a report's timeline, oldest first — not only the one the
 * report is filed under.
 *
 * A report carries one `conversation_id` — the last — and the ring carries whatever came before it.
 * On `470ddc9f` that was three conversations: the lesson that died and two refused retries, and the
 * one the report named was the least informative of the three. `session.claim` is the event that
 * records a row key, so it is the list of conversations this phone actually opened.
 *
 * One function for `pnpm report` and the operator page, so the two cannot disagree about which
 * conversations a report is about. Empty for any provider but ElevenLabs, and whenever the provider
 * could not be asked.
 */
export async function reportVerdicts(report: {
  provider: string | null;
  conversation_id: string | null;
  events: DebugEvent[] | null;
}): Promise<ProviderVerdict[]> {
  if (report.provider !== "elevenlabs") return [];
  const claimed = [...(report.events ?? [])]
    .sort((a, b) => a.seq - b.seq)
    .filter((e) => e.code === "session.claim")
    .map((e) => e.data?.conversationId)
    .filter((c): c is string => typeof c === "string");
  const conversations = [...new Set([...claimed, report.conversation_id ?? ""])]
    .filter(Boolean)
    // The newest few: a ring can hold a long day, and each row is a network call.
    .slice(-MAX_VERDICTS);
  return (await Promise.all(conversations.map(elevenLabsVerdict))).filter((v) => v !== null);
}

/** `dependency_error · code 1002`, or null when the provider recorded no error. */
export function verdictErrorLabel(verdict: ProviderVerdict): string | null {
  const label = [verdict.errorType, verdict.code && `code ${verdict.code}`]
    .filter(Boolean)
    .join(" · ");
  return label || null;
}

/** Is this the account being out of credits? The one verdict that is not a bug in this repo. */
export function isQuotaVerdict(verdict: ProviderVerdict): boolean {
  const haystack = `${verdict.reason ?? ""} ${verdict.errorType ?? ""}`.toLowerCase();
  return haystack.includes("quota") || haystack.includes("credit");
}
