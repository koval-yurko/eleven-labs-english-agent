/**
 * Is the ElevenLabs account out of credits? Asked before a lesson is opened, so the answer can be a
 * sentence instead of a room that connects and goes quiet.
 *
 * Reports `47a7f19c` and `470ddc9f` (2026-10-01) are the reason. With the account dry, the token
 * mint still answers 200 and the LiveKit room still connects; the platform then closes it ~100 ms
 * later with no `error_event`. The phone has since learned to call that shape a refusal
 * (`REFUSED_BEFORE_FIRST_TURN`), but it can only guess at the cause. This route does not have to
 * guess — `GET /v1/user/subscription` says so:
 *
 *     "character_count": 30000, "character_limit": 30000,
 *     "can_extend_character_limit": false, "allowed_to_extend_character_limit": false,
 *     "next_character_count_reset_unix": 1791748122
 *
 * (the account as it stood on 2026-10-02, the day after it ran dry).
 *
 * ## It only ever says "out" when it is sure
 *
 * A wrong "out" blocks a lesson that would have worked, which is worse than the failure this
 * exists to explain. So every path that is not a clean, fully-typed "used up, and not allowed to go
 * over" returns null and the Start proceeds exactly as it did before:
 *
 *   - **non-200** — including the 401 a key without `user_read` gets, which is how this stays
 *     harmless on a deployment whose key was never granted that permission;
 *   - **a timeout** — the budget is short because it sits in front of a button press;
 *   - **a shape that is not two numbers** — an API change must not become an outage;
 *   - **overage allowed** — both extension flags set means the platform bills past the limit
 *     rather than refusing, so a spent quota is not a refusal.
 *
 * It does NOT cover the account running dry MID-lesson, and nothing on this route can.
 * See docs/2026-10-01-quota-refusal-with-no-error.md.
 */
const CREDITS_LOOKUP_MS = 2500;

export interface CreditsExhausted {
  /** When the quota refills, ISO. Null when the platform did not say. */
  resetsAt: string | null;
}

export async function elevenLabsCreditsExhausted(apiKey: string): Promise<CreditsExhausted | null> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(CREDITS_LOOKUP_MS),
    });
    if (!res.ok) return null;
    return readCreditsExhausted(await res.json());
  } catch {
    return null;
  }
}

/** The decision, separated from the fetch so it can be read — and run — without a network. */
export function readCreditsExhausted(body: unknown): CreditsExhausted | null {
  if (typeof body !== "object" || body === null) return null;
  const sub = body as Record<string, unknown>;
  const used = sub.character_count;
  const limit = sub.character_limit;
  if (typeof used !== "number" || typeof limit !== "number") return null;
  if (used < limit) return null;
  if (sub.can_extend_character_limit === true && sub.allowed_to_extend_character_limit === true) {
    return null;
  }
  const reset = sub.next_character_count_reset_unix;
  return {
    resetsAt:
      typeof reset === "number" && Number.isFinite(reset) && reset > 0
        ? new Date(reset * 1000).toISOString()
        : null,
  };
}

/**
 * The sentence the learner reads. Asserted, unlike the phone's own wording for the silent refusal,
 * because here the platform has actually said so.
 */
export function creditsExhaustedMessage(exhausted: CreditsExhausted): string {
  const when = exhausted.resetsAt
    ? ` or the quota resets on ${exhausted.resetsAt.slice(0, 10)}`
    : "";
  return `The tutor account is out of ElevenLabs credits. Lessons will work again once it is topped up${when}; nothing on this phone needs fixing.`;
}
