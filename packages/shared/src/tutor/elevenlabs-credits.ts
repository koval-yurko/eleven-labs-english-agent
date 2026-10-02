/**
 * Reading "is the ElevenLabs account out of credits?" off `GET /v1/user/subscription`, and the
 * sentence the learner reads when it is.
 *
 * Here rather than in `apps/web` because two deployables ask the question: the token routes before
 * a lesson is opened, and the LiveKit worker when its own TTS comes back empty mid-lesson
 * (docs/2026-10-02-livekit-silent-tts-on-spent-quota.md). The fetch stays with each of them — this
 * module has no network — but the DECISION must not drift between the two, because a wrong "out"
 * blocks or ends a lesson that would have worked.
 *
 * ## It only ever says "out" when it is sure
 *
 * Every shape that is not a clean, fully-typed "used up, and not allowed to go over" reads as null:
 *
 *   - **a shape that is not two numbers** — an API change must not become an outage;
 *   - **overage allowed** — both extension flags set means the platform bills past the limit
 *     rather than refusing, so a spent quota is not a refusal.
 */
export interface CreditsExhausted {
  /** When the quota refills, ISO. Null when the platform did not say. */
  resetsAt: string | null;
}

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
