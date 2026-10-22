/**
 * Reading "is the ElevenLabs account out of credits?" off `GET /v1/user/subscription`, and the
 * sentence the learner reads when it is.
 *
 * Here rather than in `@tutor/server` because two deployables ask the question: the token routes before
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
 *
 * "Used up" means fewer than `MIN_LESSON_CHARACTERS` left, not exactly zero. Report `51c8275b`
 * (2026-10-20): the account had 38 of 30,000 characters left, the check let the Start through, and
 * the agent closed the room before its first turn — the opening alone is 3,000+ characters.
 */
export interface CreditsExhausted {
  /** When the quota refills, ISO. Null when the platform did not say. */
  resetsAt: string | null;
}

/**
 * Below this many characters left, no lesson can get through its opening turn (~1 minute of speech;
 * an opening is a greeting plus a whole item), so the account is as good as out.
 */
export const MIN_LESSON_CHARACTERS = 1000;

export function readCreditsExhausted(body: unknown): CreditsExhausted | null {
  if (typeof body !== "object" || body === null) return null;
  const sub = body as Record<string, unknown>;
  const used = sub.character_count;
  const limit = sub.character_limit;
  if (typeof used !== "number" || typeof limit !== "number") return null;
  if (limit - used >= MIN_LESSON_CHARACTERS) return null;
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
