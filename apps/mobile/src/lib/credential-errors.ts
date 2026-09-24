/**
 * Which Auth0 credential failures end the session — pure, so `check.ts` can pin it down.
 *
 * Lives apart from `auth.tsx` for that reason alone: the provider imports React Native, and this
 * decision is the one whose mistakes are invisible on a device until a learner is locked out (keep
 * a dead token) or signed out by a tunnel (drop a live one).
 */

/**
 * Credential failures no retry can fix — the session is structurally over, so end it.
 *
 * Every code here describes the *stored entry*, not the moment: there is no refresh token, or it is
 * for a key pair this build cannot use, or the identity provider's own session ceiling has passed.
 * Trying again in a minute cannot change any of them.
 *
 * **`RENEW_FAILED` is deliberately NOT in this set.** iOS has no separate network *type* for a
 * renewal — Auth0.swift reports an unreachable token endpoint as `renewFailed`, exactly as it
 * reports a revoked refresh token. Treating the type as terminal would mean a tunnel, a captive
 * portal or a dropped connection *deleting a working refresh token*, and the learner
 * re-authenticating because a train went into a hill. The two are told apart by `code` instead —
 * see `REJECTED_REFRESH_CODES`. Whatever is left is reported as an ordinary, retryable error, and
 * the header's link to the account screen (and its **Log out**) is always there as the way out.
 */
export const TERMINAL_CREDENTIAL_ERRORS: ReadonlySet<string> = new Set([
  "NO_CREDENTIALS",
  "NO_REFRESH_TOKEN",
  "INVALID_CREDENTIALS",
  "SESSION_EXPIRED",
  // The DPoP family: credentials bound to a key pair this build cannot use. `useDPoP={false}` in
  // app/_layout.tsx means we never mint these, but a build that once had DPoP on leaves them
  // behind, and they are exactly as unrecoverable as a missing refresh token.
  "DPOP_KEY_MISSING",
  "DPOP_NOT_CONFIGURED",
  "DPOP_KEY_MISMATCH",
]);

/**
 * The `RENEW_FAILED` renewals that ARE final: Auth0 answered, and said no.
 *
 * The exception to the rule above, and the reason it is safe. The iOS bridge flattens every renewal
 * failure into `type: "RENEW_FAILED"`, but when the token endpoint actually replied it passes the
 * OAuth error through as `code` (NativeBridge.swift, `renewFailed` → `cause.code`), and the JS error
 * keeps it. A network failure never carries one of these codes — it never reached the server.
 *
 * `invalid_grant` is what Auth0 returns for a refresh token that expired (inactivity or absolute
 * lifetime), was revoked, or was rotated and then replayed. Before this set existed that token was
 * treated as "offline, try again": kept forever, the launch could not restore a profile from it, and
 * the app sat signed in with no user and no way out — the 2026-09-24 report.
 */
export const REJECTED_REFRESH_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_refresh_token",
]);

/** Read `type` off an Auth0 error (`CredentialsManagerError`, `WebAuthError`, …) without casting. */
export function errorType(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { type, code } = e as { type?: unknown; code?: unknown };
  if (typeof type === "string") return type;
  if (typeof code === "string") return code;
  return null;
}

/** The raw OAuth/bridge code (`invalid_grant`, …), which `type` normalizes away. */
export function errorCode(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const { code } = e as { code?: unknown };
  return typeof code === "string" ? code : null;
}

/** No retry can fix this — the stored credentials are finished and must be removed. */
export function isTerminalCredentialError(e: unknown): boolean {
  const type = errorType(e);
  if (type && TERMINAL_CREDENTIAL_ERRORS.has(type)) return true;
  const code = errorCode(e);
  return code !== null && REJECTED_REFRESH_CODES.has(code);
}
