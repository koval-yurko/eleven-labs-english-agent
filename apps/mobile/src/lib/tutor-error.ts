/**
 * What to put on screen when the tutor SDK reports an error.
 *
 * ## The bug this exists for
 *
 * The screen used to render every error as one sentence:
 *
 *     `${message} — if you haven't allowed the microphone yet, that looks like this too.`
 *
 * On 2026-08-20 the ElevenLabs account ran out of credits. The platform answered every
 * `startSession` with an `error_event` carrying no message at all, the SDK turned that into
 * `"Server error: Unknown error"`, and the app appended the microphone sentence to it — so an
 * exhausted quota was reported to the learner, and to the person debugging it, as a possible
 * microphone-permission problem. Hours went into the wrong question.
 *
 * Two separate failures, and both are fixed here rather than at the call site:
 *
 * 1. **The hint was unconditional.** A `Server error:` is the platform refusing us; the microphone
 *    is not merely an unlikely cause there, it is a definitively wrong one. A hint that is right
 *    sometimes and misleading the rest of the time is worse than no hint, because it is trusted.
 * 2. **The diagnostics were thrown away.** `onError` is `(message, context?) => void` and the SDK
 *    fills `context` with `{ errorType, code, debugMessage, details }` straight off the wire
 *    (`BaseConversation.handleErrorEvent`). The screen's handler took one parameter, so everything
 *    that could have named the cause was dropped on the floor while the UI said "Unknown error".
 *
 * `context` is typed `any` by the SDK, so nothing here trusts its shape — every field is read
 * defensively and anything unrecognised is ignored rather than rendered as `[object Object]`.
 */

/** A `context` field worth showing: a non-empty string or a number. Anything else is noise. */
function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Did the platform refuse us, as opposed to something going wrong on this device?
 *
 * Read off the SDK's own prefix rather than a code list. `handleErrorEvent` is the ONLY thing that
 * writes `Server error: `, and it writes it for every `error_event` the server sends — so the
 * prefix is a complete and stable answer to "did this come from the far end", which no enumeration
 * of `errorType` values could be without ElevenLabs publishing one.
 */
function isServerError(message: string, errorType: string | null): boolean {
  return message.startsWith("Server error:") || errorType !== null;
}

/**
 * Does this look like the account being out of credits?
 *
 * Substring, not an error code, and deliberately: the failure that motivated this file arrived with
 * an EMPTY message, and the real text ("This request exceeds your quota limit.") was only readable
 * afterwards in the conversation's `termination_reason`. So this matches when the platform does say
 * something and simply does not fire when it doesn't — the generic server branch covers that case,
 * and mentions credits as a likely cause rather than asserting it.
 */
function looksLikeQuota(haystack: string): boolean {
  const text = haystack.toLowerCase();
  return text.includes("quota") || text.includes("credit") || text.includes("insufficient funds");
}

/**
 * Turn `onError(message, context)` into one sentence for the learner.
 *
 * Pure, and separated from the screen so the three branches can be asserted without a device — the
 * whole point being that the branch that matters most only fires when a real account runs dry.
 */
export function tutorErrorMessage(message: string, context?: unknown): string {
  const ctx = (typeof context === "object" && context !== null ? context : {}) as Record<
    string,
    unknown
  >;
  const errorType = scalar(ctx.errorType);
  const code = scalar(ctx.code);
  const debugMessage = scalar(ctx.debugMessage);

  // Everything the far end told us, in one parenthetical. Shown rather than logged: this string is
  // what gets screenshotted and pasted into a bug report, and "Unknown error" with the error type
  // sitting unread in a callback argument is how the quota outage stayed unexplained.
  const diagnostics = [errorType, code && `code ${code}`, debugMessage].filter(Boolean).join(" · ");
  const detail = diagnostics ? `${message} (${diagnostics})` : message;

  if (looksLikeQuota(`${message} ${debugMessage ?? ""} ${errorType ?? ""}`)) {
    return `${detail} — the tutor account is out of ElevenLabs credits. Lessons will work again once it is topped up; nothing on this phone needs fixing.`;
  }

  if (isServerError(message, errorType)) {
    // No microphone sentence. The server answered, which means the connection and the app are both
    // fine — and the single most common way this account has produced a bare server error is an
    // exhausted quota, so that is offered as the first thing to check rather than asserted.
    return `${detail} — the tutor service refused the session. This is usually the ElevenLabs account being out of credits; it is not a problem with this phone or your microphone.`;
  }

  return `${detail} — if you haven't allowed the microphone yet, that looks like this too.`;
}
