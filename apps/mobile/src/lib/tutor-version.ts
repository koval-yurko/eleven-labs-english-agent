/**
 * Which tutor version the picker shows — the precedence rule, alone and pure.
 *
 * Split from `tutor-preference.ts`, which owns the storage, for one reason: `check.ts` runs under
 * plain `tsx` and cannot import anything that reaches `expo-sqlite`. A precedence rule that cannot
 * be checked is exactly the kind of bug this file is about — a picker that resolves wrongly looks
 * identical to a picker that forgot, and neither is visible until a learner notices weeks later
 * that they are talking to the wrong tutor.
 *
 * See `tutor-preference.ts` for why the device remembers a version at all (debug report
 * `9158f95b`).
 */

/** What the picker should show, and where that value came from. */
export type ResolvedTutorVersion = {
  version: string | null;
  source: "session" | "preference" | "default" | "unknown";
  /** A stored preference that is no longer offered, dropped in favour of the default. */
  stale: string | null;
};

/**
 * Resolve the version the picker shows, in falling order of authority.
 *
 * 1. **The live session**, when it is this lesson's. What is actually running outranks any
 *    preference — the picker is disabled while connected precisely because it is then a readout,
 *    not a control.
 * 2. **The stored preference**, if it is still offered. This is the new step.
 * 3. **The server's default**, which is a server-side rule (`resolveVersion(null)`) the client is
 *    deliberately not allowed to re-derive — see the `agent-versions` route.
 *
 * Pure, and separated from the storage above so the precedence can be read in one place. The
 * `stale` field is returned rather than logged here: this runs on every render, and a warning that
 * fires sixty times is a warning nobody reads.
 */
export function resolveTutorVersion(input: {
  /** `session.version` when the live session is this lesson's, `null` otherwise. */
  sessionVersion: string | null;
  /** What `readPreferredVersion` returned, or `null` while it is still loading. */
  preferred: string | null;
  /** The versions `/api/v2/agent-versions` offers, or `null` before it has answered. */
  offered: readonly string[] | null;
  defaultVersion: string | null;
}): ResolvedTutorVersion {
  const { sessionVersion, preferred, offered, defaultVersion } = input;
  if (sessionVersion) return { version: sessionVersion, source: "session", stale: null };

  // Before the registry answers there is nothing to validate against, so the preference is held
  // back rather than trusted: showing it and then swapping it a moment later is the one outcome
  // worse than showing nothing, because it looks like the app changed its mind on its own.
  if (offered === null) return { version: null, source: "unknown", stale: null };

  if (preferred && offered.includes(preferred)) {
    return { version: preferred, source: "preference", stale: null };
  }
  return {
    version: defaultVersion,
    source: "default",
    stale: preferred && !offered.includes(preferred) ? preferred : null,
  };
}
