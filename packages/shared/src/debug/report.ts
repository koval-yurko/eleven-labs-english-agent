/** The debug report as a wire contract: the event shape, the snapshot, the bounds, and the sanitizer both sides run.
 *  See ../../../../docs/2026-09-09-mobile-debug-reports-and-feedback.md §4.2, §6, §8. */
import type { HoldSnapshot } from "../tutor/pause";
import { sanitizeTranscript, type TranscriptLine } from "../tutor/session";
import type {
  TutorCapabilities,
  TutorProviderId,
  TutorStatus,
  TutorUsage,
} from "../tutor/transport";

/**
 * ## Why this file is in `packages/shared` and the ring buffer is not
 *
 * `CLAUDE.md`'s test — *if this had a bug, could I fix it by deploying the web app alone?* — splits
 * the diagnostics feature cleanly in two. The SHAPE is shared: the server has to reject an
 * over-large report from an old build, and the operator page has to render events an old build
 * wrote, so both need this file. The MECHANISM is not: the ring buffer, the console patch, the
 * snapshot registration and the spool are all fixed by shipping a build, which is the definition of
 * not-shared. They live in `apps/mobile/src/lib/diagnostics.ts`.
 *
 * The one thing that looks like mechanism and is not is `trimDebugEvents`. It is a BOUND — the rule
 * deciding which event a full ring throws away — and the server applies the identical rule to a
 * report that arrives over-length, so a trimmed report looks the same whichever side trimmed it.
 */

// ── the event ────────────────────────────────────────────────────────────────────────────────

export type DebugLevel = "debug" | "info" | "warn" | "error";

/** Flat and scalar-valued on purpose — see `MAX_DEBUG_DATA_KEYS`. */
export type DebugData = Record<string, string | number | boolean | null>;

export interface DebugEvent {
  /** Monotonic within the process. A GAP MEANS THE RING DROPPED, and that is information. */
  seq: number;
  /**
   * Absolute ISO-8601. Absolute rather than relative for the same reason `use-event-log` is: it is
   * the only way to line an event up against a server log, or against the moment you locked the
   * phone.
   */
  at: string;
  /** ms since the last `markSessionStart`. Negative before a session starts, deliberately. */
  since: number;
  level: DebugLevel;
  /**
   * A slug from `./codes.ts` — the groupable half.
   *
   * Typed `string` rather than `DebugCode`, and that is the openness the registry's docblock
   * promises: the phone's `emit` takes a `DebugCode` (a typo there is a compile error), while
   * everything downstream — this shape, the sanitizer, the operator page — accepts whatever an
   * older build sent. Use `isKnownDebugCode` to LABEL an unknown one, never to drop it.
   */
  code: string;
  /** One sentence for a human. Never the only carrier of a fact `data` should hold. */
  message: string;
  /** Which stack this came from; `null` for app-level events. */
  provider: TutorProviderId | null;
  /** Redacted structured detail. Bounded — see the limits below. */
  data?: DebugData;
}

// ── the snapshot ─────────────────────────────────────────────────────────────────────────────

/**
 * The session state machine as it stands, **including the refs no render can see.**
 *
 * `TutorSessionState` — the fourteen fields a screen renders — is the easy half and is not where
 * the bugs are. The bugs are in the refs, because the refs are what the callbacks read: a
 * transcript filed under the wrong conversation (`conversationId` vs `conversationLesson`), a save
 * that silently no-ops (`savedFor`), turns pushed into someone else's transcript (`owns`), a tutor
 * that never opens its mouth or opens it twice (`kickedOff`). Every one of those is documented in
 * `apps/mobile/src/lib/tutor-session.tsx` as a hazard designed against, and none of them is
 * observable from outside.
 *
 * Read it for DISAGREEMENT rather than for values: `focusedLesson ≠ conversationLesson`,
 * `conversationId ≠ savedFor`, and `owns === false` while `status === "connected"` are each one
 * glance from being obvious and each is a bug.
 *
 * `lines` is a COUNT, not the lines. The transcript is already stored server-side under
 * `conversationId` for the same owner; a second copy inside a diagnostic blob is a copy that
 * outlives a deletion.
 */
export interface SessionSnapshot {
  focusedLesson: string | null;
  conversationLesson: string | null;
  conversationId: string | null;
  savedFor: string | null;
  owns: boolean;
  starting: boolean;
  kickedOff: boolean;
  status: TutorStatus;
  provider: TutorProviderId | null;
  version: string | null;
  held: boolean;
  silenced: boolean;
  muted: boolean;
  speaking: boolean;
  /** How many lines this conversation has. The lines themselves are deliberately absent. */
  lines: number;
  carried: number;
  usage: TutorUsage | null;
  holdSnapshot: HoldSnapshot | null;
  resumeCause: string | null;
  resumeLines: number;
  /** Is the held-pause keep-alive timer actually running? */
  heartbeat: boolean;
  capabilities: TutorCapabilities | null;
  /** Invalidates an in-flight disk restore; a jump means a restore was abandoned. */
  restoreToken: number;
  /** The lock-screen card's idea of which lesson this is. */
  metaTitle: string | null;
  /** The learner-facing sentence currently on screen, if any. */
  lastError: string | null;
}

// ── the report ───────────────────────────────────────────────────────────────────────────────

export type DebugReportKind = "error" | "feedback" | "manual";

/** Which build this came from. Without it every investigation starts with "which build were you on". */
export interface DebugClientInfo {
  appVersion: string;
  buildNumber: string;
  variant: string;
  platform: string;
  osVersion: string;
  deviceModel: string;
  apiBaseUrl: string;
  online: boolean;
}

export interface DebugReportInput {
  /** What kind of report this is. The operator page's first filter. */
  kind: DebugReportKind;
  /** What the learner typed. The one field a machine cannot produce. */
  note: string;
  /** Join keys. Any may be null — a report about a lesson that would not start has no conversation. */
  lessonId: string | null;
  conversationId: string | null;
  provider: TutorProviderId | null;
  agentVersion: string | null;
  /** Denormalized for list rendering and grouping; also present inside `events`. */
  errorCode: string | null;
  errorMessage: string | null;
  client: DebugClientInfo;
  /** The live snapshot, plus the frozen one from the moment of the error when there is one. */
  state: { live: SessionSnapshot; atError: SessionSnapshot | null };
  events: DebugEvent[];
  /** Opt-in tail, empty by default: the transcript is already stored under `conversationId`. */
  transcriptTail: TranscriptLine[];
  /** When the PHONE built it. Separate from the row's `created_at`, so a spooled report cannot lie. */
  capturedAt: string;
}

// ── the bounds ───────────────────────────────────────────────────────────────────────────────

/**
 * `use-event-log` chose 400 for "a 3-minute test with room to spare". This ring carries denser
 * events, so 300 — about 60 KB serialized at ~200 bytes each.
 */
export const MAX_DEBUG_EVENTS = 300;
/** Mirrors `MAX_TRANSCRIPT_LINE_CHARS`'s reasoning, an order of magnitude down. */
export const MAX_DEBUG_MESSAGE = 400;
/** A flat scalar map that needs more than twelve keys is an object someone dumped. */
export const MAX_DEBUG_DATA_KEYS = 12;
/** Long enough for a URL path, short enough that a token cannot hide in it. */
export const MAX_DEBUG_DATA_VALUE = 200;
/** The one field a person writes. Long enough to describe a failure, short enough not to be a log. */
export const MAX_DEBUG_NOTE = 4000;
/** The opt-in transcript tail (§6) — "the last few lines", not the conversation. */
export const MAX_DEBUG_TRANSCRIPT_TAIL = 10;
/** Checked after serialization, on BOTH sides. */
export const MAX_REPORT_BYTES = 256 * 1024;

// ── redaction ────────────────────────────────────────────────────────────────────────────────

/** Keys whose value is never worth the risk, whatever it happens to contain today. */
const SECRET_KEY = /token|secret|key|authorization|password|bearer|jwt/i;
/** Three base64url segments — a JWT, wherever it ended up. */
const JWT_SHAPE = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
/** A query string carrying a credential. LiveKit's own URL is the reason this exists. */
const SECRET_QUERY = /[?&](access_?token|token|api_?key|key|jwt|sig|signature)=/i;

/**
 * The BACKSTOP, not the mechanism.
 *
 * Nothing that must never be logged is filtered out here — it is structurally excluded upstream:
 * `data` is a flat scalar map with a 200-char cap, and `apiFetch` emits `{ path, status, ms }`, so
 * a bearer token never enters the bus and there is nothing to redact. This runs anyway, because a
 * future call site will eventually put something in `data` that its author did not think about, and
 * the cost of being wrong is a credential inside a blob that is filed, stored and read by a model.
 */
export function redactValue(key: string, value: string): string {
  if (SECRET_KEY.test(key)) return "<redacted>";
  if (JWT_SHAPE.test(value)) return "<jwt>";
  if (SECRET_QUERY.test(value)) {
    const cut = value.indexOf("?");
    return cut === -1 ? "<redacted>" : value.slice(0, cut);
  }
  return value;
}

// ── trimming ─────────────────────────────────────────────────────────────────────────────────

/**
 * Drop events until `max` remain — oldest first, **except that an error is never dropped while
 * anything cheaper is still there.**
 *
 * A ring flooded by `transport.usage` that dropped the connect failure is a ring that was not worth
 * keeping, and that is exactly what a plain `slice(-max)` produces: the interesting event is the
 * one at the start of the flood. So the order of sacrifice is `debug`, then `info`/`warn`, then —
 * only when there is nothing else left — `error`.
 *
 * Both sides run this: the phone's ring as it fills, and `sanitizeDebugReport` on a report that
 * arrives over-length. A trimmed report therefore looks the same whichever side trimmed it.
 */
export function trimDebugEvents(events: DebugEvent[], max: number = MAX_DEBUG_EVENTS): DebugEvent[] {
  if (events.length <= max) return events;
  const out = events.slice();
  while (out.length > max) {
    let i = out.findIndex((e) => e.level === "debug");
    if (i === -1) i = out.findIndex((e) => e.level !== "error");
    if (i === -1) i = 0;
    out.splice(i, 1);
  }
  return out;
}

// ── the sanitizer ────────────────────────────────────────────────────────────────────────────

function str(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  return value.slice(0, max);
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableStr(value: unknown, max: number): string | null {
  const s = str(value, max);
  return s === null || s.length === 0 ? null : s;
}

function sanitizeData(raw: unknown): DebugData | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: DebugData = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= MAX_DEBUG_DATA_KEYS) break;
    const name = key.slice(0, 64);
    if (typeof value === "string") out[name] = redactValue(name, value.slice(0, MAX_DEBUG_DATA_VALUE));
    else if (typeof value === "number" && Number.isFinite(value)) out[name] = value;
    else if (typeof value === "boolean") out[name] = value;
    else if (value === null) out[name] = null;
    // Anything else — an object, an array, a function, a NaN — is dropped rather than stringified.
    // `[object Object]` in a report is a field that looks answered and is not.
    else continue;
    kept += 1;
  }
  return kept > 0 ? out : undefined;
}

const LEVELS = new Set<DebugLevel>(["debug", "info", "warn", "error"]);
const PROVIDERS = new Set<string>(["elevenlabs", "openai", "vapi"]);
const KINDS = new Set<string>(["error", "feedback", "manual"]);

function sanitizeEvent(raw: unknown): DebugEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  const code = str(e.code, 64);
  if (!code) return null;
  const level = LEVELS.has(e.level as DebugLevel) ? (e.level as DebugLevel) : "info";
  const provider = typeof e.provider === "string" && PROVIDERS.has(e.provider)
    ? (e.provider as TutorProviderId)
    : null;
  const event: DebugEvent = {
    seq: num(e.seq),
    at: str(e.at, 40) ?? new Date(0).toISOString(),
    since: num(e.since),
    level,
    // PRESERVED even when unknown — see `codes.ts`. An old phone filing a code this deployment has
    // never heard of must still get a row.
    code,
    message: str(e.message, MAX_DEBUG_MESSAGE) ?? "",
    provider,
  };
  const data = sanitizeData(e.data);
  if (data) event.data = data;
  return event;
}

/**
 * A snapshot describing nothing.
 *
 * Exported because two callers need "no session" to be a VALUE rather than a `null` they each
 * handle differently: the sanitizer, when a report arrives without one, and the phone, when a
 * report is filed from a screen where `TutorSessionProvider` has registered no reader. A shared
 * empty means the operator page renders one shape.
 */
export function emptySessionSnapshot(): SessionSnapshot {
  return { ...EMPTY_SNAPSHOT };
}

const EMPTY_SNAPSHOT: SessionSnapshot = {
  focusedLesson: null,
  conversationLesson: null,
  conversationId: null,
  savedFor: null,
  owns: false,
  starting: false,
  kickedOff: false,
  status: "disconnected",
  provider: null,
  version: null,
  held: false,
  silenced: true,
  muted: false,
  speaking: false,
  lines: 0,
  carried: 0,
  usage: null,
  holdSnapshot: null,
  resumeCause: null,
  resumeLines: 0,
  heartbeat: false,
  capabilities: null,
  restoreToken: 0,
  metaTitle: null,
  lastError: null,
};

const STATUSES = new Set<string>([
  "disconnected",
  "connecting",
  "connected",
  "disconnecting",
  "error",
]);

function sanitizeUsage(raw: unknown): TutorUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as Record<string, unknown>;
  return {
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    inputAudioTokens: num(u.inputAudioTokens),
    outputAudioTokens: num(u.outputAudioTokens),
    cachedInputTokens: num(u.cachedInputTokens),
  };
}

function sanitizeHoldSnapshot(raw: unknown): HoldSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Record<string, unknown>;
  return {
    aborted: bool(h.aborted),
    atLine: num(h.atLine),
    since: num(h.since),
    wasMuted: bool(h.wasMuted),
  };
}

function sanitizeCapabilities(raw: unknown): TutorCapabilities | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  return {
    silenceOutput: bool(c.silenceOutput),
    userActivity: bool(c.userActivity),
    cancelTurn: bool(c.cancelTurn),
    responseCorrection: bool(c.responseCorrection),
    // Absent from every report filed before this capability existed, and `bool` reads a missing
    // field as false — which is the right answer for those, since no provider opened by itself then.
    opensUnprompted: bool(c.opensUnprompted),
  };
}

function sanitizeSnapshot(raw: unknown): SessionSnapshot {
  if (typeof raw !== "object" || raw === null) return { ...EMPTY_SNAPSHOT };
  const s = raw as Record<string, unknown>;
  return {
    focusedLesson: nullableStr(s.focusedLesson, 64),
    conversationLesson: nullableStr(s.conversationLesson, 64),
    conversationId: nullableStr(s.conversationId, 128),
    savedFor: nullableStr(s.savedFor, 128),
    owns: bool(s.owns),
    starting: bool(s.starting),
    kickedOff: bool(s.kickedOff),
    status: STATUSES.has(s.status as string) ? (s.status as TutorStatus) : "disconnected",
    provider: typeof s.provider === "string" && PROVIDERS.has(s.provider)
      ? (s.provider as TutorProviderId)
      : null,
    version: nullableStr(s.version, 64),
    held: bool(s.held),
    silenced: bool(s.silenced),
    muted: bool(s.muted),
    speaking: bool(s.speaking),
    lines: num(s.lines),
    carried: num(s.carried),
    usage: sanitizeUsage(s.usage),
    holdSnapshot: sanitizeHoldSnapshot(s.holdSnapshot),
    resumeCause: nullableStr(s.resumeCause, 32),
    resumeLines: num(s.resumeLines),
    heartbeat: bool(s.heartbeat),
    capabilities: sanitizeCapabilities(s.capabilities),
    restoreToken: num(s.restoreToken),
    metaTitle: nullableStr(s.metaTitle, 200),
    lastError: nullableStr(s.lastError, MAX_DEBUG_MESSAGE),
  };
}

function sanitizeClient(raw: unknown): DebugClientInfo {
  const c = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    appVersion: str(c.appVersion, 32) ?? "",
    buildNumber: str(c.buildNumber, 32) ?? "",
    variant: str(c.variant, 32) ?? "",
    platform: str(c.platform, 16) ?? "",
    osVersion: str(c.osVersion, 32) ?? "",
    deviceModel: str(c.deviceModel, 64) ?? "",
    // A path, not a credential — but it goes through the redactor anyway, because a base URL is
    // exactly the kind of string someone eventually appends a query to.
    apiBaseUrl: redactValue("apiBaseUrl", str(c.apiBaseUrl, MAX_DEBUG_DATA_VALUE) ?? ""),
    online: bool(c.online),
  };
}

function sizeOf(report: DebugReportInput): number {
  // `length`, not a byte count: this runs on a phone with no `Buffer` and no `TextEncoder`
  // guarantee, and the two differ only for non-ASCII — where `length` UNDER-counts by at most 2×.
  // The cap is a bound on a blob, not an accounting figure, so a 2× margin is cheaper than a
  // polyfill. `MAX_REPORT_BYTES` is generous enough to absorb it.
  return JSON.stringify(report).length;
}

/**
 * A report from a client that is never trusted, made storable.
 *
 * Follows `sanitizeTranscript` exactly — same posture, same place in the architecture — and runs in
 * two places for two different reasons:
 *
 *  - on the SERVER, in the route, because the body is a stranger's;
 *  - on the PHONE, before spooling, so an over-large report is trimmed BEFORE it is written to the
 *    device rather than after it fails to upload.
 *
 * **Truncates rather than rejects wherever truncation is meaningful.** A trimmed report is worth
 * infinitely more than a 413, and the reports most likely to be over-length are the ones from the
 * longest, most broken sessions. Only what is structurally unusable is refused: not an object, or
 * no recognisable `kind`.
 */
export function sanitizeDebugReport(body: unknown): DebugReportInput | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== "string" || !KINDS.has(b.kind)) return null;

  const rawEvents: unknown[] = Array.isArray(b.events) ? b.events : [];
  const events = trimDebugEvents(
    rawEvents.map(sanitizeEvent).filter((e): e is DebugEvent => e !== null),
  );
  const state = (typeof b.state === "object" && b.state !== null ? b.state : {}) as Record<
    string,
    unknown
  >;

  const report: DebugReportInput = {
    kind: b.kind as DebugReportKind,
    note: str(b.note, MAX_DEBUG_NOTE) ?? "",
    lessonId: nullableStr(b.lessonId, 64),
    conversationId: nullableStr(b.conversationId, 128),
    provider: typeof b.provider === "string" && PROVIDERS.has(b.provider)
      ? (b.provider as TutorProviderId)
      : null,
    agentVersion: nullableStr(b.agentVersion, 64),
    errorCode: nullableStr(b.errorCode, 64),
    errorMessage: nullableStr(b.errorMessage, MAX_DEBUG_MESSAGE),
    client: sanitizeClient(b.client),
    state: {
      live: sanitizeSnapshot(state.live),
      atError: state.atError == null ? null : sanitizeSnapshot(state.atError),
    },
    events,
    transcriptTail: sanitizeTranscript(b.transcriptTail).slice(-MAX_DEBUG_TRANSCRIPT_TAIL),
    capturedAt: str(b.capturedAt, 40) ?? new Date(0).toISOString(),
  };

  /**
   * The size cap, spent in the order of what is least worth keeping.
   *
   * The transcript goes first because it is the one part that is REDUNDANT — the same lines are
   * already stored server-side under `conversationId`. Then events, halved until they fit, because
   * `trimDebugEvents` keeps the errors. The note is last and is only ever truncated, never dropped:
   * it is the single field a machine could not have produced.
   */
  if (sizeOf(report) > MAX_REPORT_BYTES) report.transcriptTail = [];
  while (sizeOf(report) > MAX_REPORT_BYTES && report.events.length > 1) {
    report.events = trimDebugEvents(report.events, Math.floor(report.events.length / 2));
  }
  if (sizeOf(report) > MAX_REPORT_BYTES) {
    report.events = [];
    report.note = report.note.slice(0, 1000);
  }
  return report;
}
