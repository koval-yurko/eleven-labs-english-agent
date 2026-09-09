/**
 * When is a failed write worth trying again?
 *
 * One predicate, because there are now two places that must answer identically and they protect the
 * same thing — a transcript that exists only on this device:
 *
 *   - the debug-report spool (`diagnostics-spool.ts`), draining reports that could not be sent;
 *   - the journal restore (`tutor-session.tsx`), pushing a transcript the last session died holding.
 *
 * Two copies of a retry policy is how the two eventually disagree, and the disagreement is silent:
 * one of them starts either losing data or hammering an endpoint that will never accept it.
 *
 * Pure and dependency-free so `apps/mobile/check.ts` can import it — the rule decides whether a
 * learner's conversation survives, and it is not observable on a device until it has already gone
 * wrong.
 */

/**
 * Did the server give an answer that another attempt cannot change?
 *
 * **4xx only.** The server looked at this request and refused it: the lesson was soft-deleted, the
 * body was malformed, the token is not this owner's. Every future attempt sends the same request to
 * the same rule and gets the same answer, so retrying is a loop that cannot terminate in success —
 * once per app launch, forever.
 *
 * Everything else means *nobody answered*: a 5xx is the server failing rather than deciding, and
 * `status: 0` is what `ApiFetchError` carries for a request that never completed at all — no
 * network, DNS gone, or `getToken` refusing while signed out. Those are worth another try, and for
 * the journal they are exactly the case that used to destroy the only copy of a transcript.
 *
 * A 401 is deliberately final HERE even though it looks transient: `apiFetch` already retries it
 * once with a freshly minted token, so a 401 reaching a caller is the second one, and the token
 * source has by then given up and started signing the app out.
 */
export function isFinalRefusal(status: number): boolean {
  return status >= 400 && status < 500;
}
