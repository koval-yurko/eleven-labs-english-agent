import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";

import {
  MAX_DEBUG_EVENTS,
  MAX_DEBUG_MESSAGE,
  emptySessionSnapshot,
  sanitizeDebugReport,
  trimDebugEvents,
  type DebugClientInfo,
  type DebugData,
  type DebugEvent,
  type DebugLevel,
  type DebugReportInput,
  type DebugReportKind,
  type SessionSnapshot,
} from "@tutor/shared/debug/report";
import type { DebugCode } from "@tutor/shared/debug/codes";
import type { TranscriptLine } from "@tutor/shared/tutor/session";
import type { TutorProviderId } from "@tutor/shared/tutor/transport";

import { env } from "@/env";

/**
 * The diagnostics bus: a bounded ring of structured events, at module scope.
 *
 * ## The failure it exists for
 *
 * On 2026-08-20 the ElevenLabs account ran dry, the platform answered every `startSession` with an
 * `error_event` carrying no message, and the app told the learner it might be a microphone
 * permission. `lib/tutor-error.ts` is the repair, and its docblock names the second failure plainly:
 * *"the diagnostics were thrown away"*. That repair made the SENTENCE honest. It did not make
 * anything else recoverable — a screenshot of one sentence is still the reporting channel, and
 * nothing anywhere says what the status transitions were, whether the mint succeeded, which
 * provider was selected, or whether the app owned the conversation.
 *
 * There are nineteen `catch {}` blocks in this directory and every one of them is correct: a
 * journal that breaks the lesson it insures is worse than no journal. **This module does not change
 * a single one of them.** It gives each one a line to write before it swallows. That is the whole
 * intervention.
 *
 * ## Why module scope, and not React state
 *
 * Three arguments, all of them already made elsewhere in this app:
 *
 *  1. **The session outlives every screen.** `TutorSessionProvider` sits above the router precisely
 *     so a lesson survives navigation, and `lib/lesson-card.ts` already holds module state for the
 *     same reason. A log that lived in a screen would have a hole in it exactly where the
 *     interesting navigation happened.
 *  2. **It must not re-render anything.** `tutor-session.tsx` makes this argument twice — for
 *     `usageRef` ("a value that changed on every turn would redraw the transcript for a number the
 *     learner never sees") and for the third `ActiveContext`. A log fed by every SDK callback is
 *     strictly worse than either.
 *  3. **It has to be writable from outside React.** `apiFetch` is a plain function, the
 *     `ErrorUtils` global handler is not in a component, and the lock-screen intent drain runs from
 *     a native event.
 *
 * The modal subscribes with `useSyncExternalStore` **only while it is open**, and `readEvents`
 * returns an array identity that changes only when the ring does.
 */

// ── the ring ─────────────────────────────────────────────────────────────────────────────────

let ring: DebugEvent[] = [];
/**
 * Monotonic ACROSS THE PROCESS, never reset per session. A report whose sequence numbers jump is a
 * report that dropped events, and being able to see that is worth more than tidy numbering.
 */
let seq = 0;
let sessionStartedAt = Date.now();
const listeners = new Set<() => void>();

/**
 * The snapshot frozen at the moment of the first error (§5.3).
 *
 * A learner hits an error at 14:02 and opens the modal at 14:07. By then `start` has been pressed
 * again, `setError(null)` has run, and the live snapshot describes a healthy session that is not
 * the one being reported. So the first `error`-level event after a clean period takes a copy, and
 * the report carries both, labelled. Cleared by `markSessionStart`, which is the same act that
 * clears the on-screen error.
 */
let frozen: SessionSnapshot | null = null;
let snapshotFn: (() => SessionSnapshot) | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

/** What an emitter supplies; `seq`, `at` and `since` are the bus's to write. */
export type DebugEmit = {
  level: DebugLevel;
  /** Closed on the phone — a typo here is a compile error. See `@tutor/shared/debug/codes`. */
  code: DebugCode;
  message: string;
  /**
   * Which STACK raised this, and therefore set only by the three transport adapters.
   *
   * The session's own events leave it `null` even while a provider is selected, and that is the
   * contract rather than an omission: the session names no provider (its whole design is that it
   * asks `capabilities` instead), the snapshot already carries which one is running, and reading
   * `providerRef` from a session callback is a React Compiler error anyway — `start` writes to it.
   */
  provider?: TutorProviderId | null;
  data?: DebugData;
};

/**
 * Append one event. **Never throws, never awaits, never allocates unboundedly.**
 *
 * Called from inside `catch` blocks whose entire contract is that they cannot fail, and from SDK
 * callbacks on the hot path of a live conversation — so the whole body is wrapped. A diagnostics
 * bus that can break the thing it observes is the `writeJournal` mistake with a different name.
 */
export function emit(event: DebugEmit): void {
  try {
    const next: DebugEvent = {
      seq: ++seq,
      at: new Date().toISOString(),
      since: Date.now() - sessionStartedAt,
      level: event.level,
      code: event.code,
      message: event.message.slice(0, MAX_DEBUG_MESSAGE),
      provider: event.provider ?? null,
      ...(event.data ? { data: event.data } : {}),
    };
    // The trim rule lives in shared because the SERVER applies the same one to an over-length
    // report — see `trimDebugEvents`. An error is never dropped to make room for chatter.
    ring = trimDebugEvents([...ring, next], MAX_DEBUG_EVENTS);
    if (event.level === "error" && frozen === null) frozen = readSnapshot();
    notify();
  } catch {
    // A diagnostics write must never be able to fail the thing it is diagnosing.
  }
}

/** For `useSyncExternalStore`. Returns the unsubscribe, so an effect can return it directly. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The ring, oldest first.
 *
 * A stable identity between emits: `useSyncExternalStore` compares by reference, and a fresh array
 * per read would make the modal re-render on every frame. The modal reverses it for display —
 * newest first is `use-event-log`'s argument, inherited verbatim: after a lock or a failure you
 * want what just happened at the top, not three minutes of scrolling away.
 */
export function readEvents(): readonly DebugEvent[] {
  return ring;
}

/**
 * A session is beginning: restart the RELATIVE clock and spend the frozen snapshot.
 *
 * The ring itself is deliberately **not** cleared. The events from before a Start are frequently
 * the explanation for the Start failing — a mint that 401'd, a background transition, a shim that
 * refused to install.
 */
export function markSessionStart(): void {
  sessionStartedAt = Date.now();
  frozen = null;
}

// ── the snapshot ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the session's state reader. A FUNCTION, not a value.
 *
 * Nothing re-renders and nothing is copied until something actually asks — which, while the modal
 * is closed, is only the error freeze above. `TutorSessionProvider` calls this once at mount with
 * an empty dependency array, so there is no churn and no cost.
 */
export function registerSnapshot(fn: () => SessionSnapshot): () => void {
  snapshotFn = fn;
  return () => {
    if (snapshotFn === fn) snapshotFn = null;
  };
}

/** The live session state, or `null` when no provider is mounted (the sign-in screen). */
export function readSnapshot(): SessionSnapshot | null {
  try {
    return snapshotFn ? snapshotFn() : null;
  } catch {
    // A snapshot that throws is a bug in the provider, not a reason to lose the report.
    return null;
  }
}

/** The state as it was when the first error landed, if one has. */
export function readFrozenSnapshot(): SessionSnapshot | null {
  return frozen;
}

// ── build identity ───────────────────────────────────────────────────────────────────────────

/**
 * Which build this is. Read once — none of it changes within a process.
 *
 * `apiBaseUrl` is read through a `try`: `env` THROWS when a value is unset (`src/env.ts`), and the
 * build whose env is misconfigured is exactly the build you most want a report from.
 */
function readClient(): DebugClientInfo {
  const expo = Constants.expoConfig;
  let apiBaseUrl = "<unset>";
  try {
    apiBaseUrl = env.apiBaseUrl;
  } catch {
    // Left as "<unset>" — see above.
  }
  return {
    appVersion: expo?.version ?? "",
    // `Constants.platform.ios.buildNumber` is the NATIVE binary's `CFBundleVersion` and
    // `expoConfig.ios.buildNumber` is what the (updatable) manifest says. They can disagree after an
    // OTA update, and the honest answer to "which build is this" is the one baked into the binary —
    // so that one is read first and the manifest is only the fallback.
    buildNumber: Constants.platform?.ios?.buildNumber ?? expo?.ios?.buildNumber ?? "",
    // Which EAS profile built this. `preview` and `production` behave differently enough (a
    // different scheme, a different API host) that "which build" is not answered without it.
    variant: (expo?.extra?.variant as string | undefined) ?? "",
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    deviceModel: Device.modelName ?? "",
    apiBaseUrl,
    // A placeholder until the spool arrives in S2: this build has no connectivity module, and
    // adding one for a boolean nobody reads yet would be a native dependency bought on credit.
    online: true,
  };
}

let client: DebugClientInfo | null = null;

export function debugClient(): DebugClientInfo {
  if (client === null) client = readClient();
  return client;
}

// ── the report ───────────────────────────────────────────────────────────────────────────────

/**
 * Everything the bus cannot know: what the person typed, and whether they want the tail included.
 */
export type BuildReportOptions = {
  kind: DebugReportKind;
  note: string;
  /** Off by default — see §6. The transcript is already stored server-side under `conversationId`. */
  transcriptTail?: TranscriptLine[];
};

/**
 * The ring, the snapshots and the build identity as one `DebugReportInput`.
 *
 * Sanitized HERE as well as on the server, and for a different reason: from S2 an over-large report
 * is written to the device before it is uploaded, and trimming it after the upload fails is trimming
 * it too late. Running the server's own function is also the cheapest way to keep the two honest —
 * there is no second implementation to drift.
 *
 * The error fields are lifted out of the ring rather than passed in, so a report filed from the
 * quiet entry point still names the failure that is on screen.
 */
export function buildDebugReport(options: BuildReportOptions): DebugReportInput {
  const events = readEvents();
  const live = readSnapshot();
  const atError = readFrozenSnapshot();
  // The most recent error, whichever source raised it. The ring is oldest-first, so search back.
  const lastError = [...events].reverse().find((e) => e.level === "error") ?? null;
  const state = atError ?? live;

  const draft: DebugReportInput = {
    kind: options.kind,
    note: options.note,
    lessonId: state?.conversationLesson ?? state?.focusedLesson ?? null,
    conversationId: state?.conversationId ?? null,
    provider: state?.provider ?? null,
    agentVersion: state?.version ?? null,
    errorCode: lastError?.code ?? null,
    errorMessage: lastError?.message ?? state?.lastError ?? null,
    client: debugClient(),
    // `null` becomes the shared empty rather than a hole: a report filed from a screen with no
    // session provider mounted still renders as one shape on the other end.
    state: { live: live ?? emptySessionSnapshot(), atError },
    events: [...events],
    transcriptTail: options.transcriptTail ?? [],
    capturedAt: new Date().toISOString(),
  };

  // `sanitizeDebugReport` refuses only what is structurally unusable, and `kind` is always one of
  // the three — so this cannot be null. Falling back to the draft keeps that from being a promise
  // this function makes on the sanitizer's behalf; the draft is already within every bound but the
  // outer size cap, which only the sanitizer applies.
  return sanitizeDebugReport(draft) ?? draft;
}
