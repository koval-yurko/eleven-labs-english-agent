/**
 * The HTTP contract between any client and this app's API routes: the paths, the response bodies,
 * and the error envelope.
 *
 * PURE — types and string constants. It describes the wire, it does not touch it: no `fetch`, no
 * `NextResponse`, no auth. `lib/http.ts` builds the actual responses and imports `ApiErrorBody`
 * from here, so the server's envelope is *definitionally* the shape declared below rather than a
 * parallel description of it.
 *
 * Why it is worth naming: the browser used to re-declare the signed-URL response inline at its call
 * site, which is survivable with one client. A second client (see
 * docs/2026-08-12-expo-app-creation.md) would hand-copy both the paths and the shapes, and a renamed
 * route or field would then fail at runtime on a device rather than at build time.
 * See docs/2026-08-09-shareable-core-refactor.md (R7).
 *
 * NOT covered here: `flushOutbox`, which is RPC over Next's own protocol (a native client cannot
 * call it; its op algebra lives in `./sync-ops.ts`), and the ElevenLabs webhook, which is an
 * inbound contract owned by ElevenLabs rather than by us.
 */
import type { LessonDetail, LessonSession } from "./lesson-types";
import type { TranscriptLine } from "./tutor";

// ── paths ────────────────────────────────────────────────────────────────────────────────────

/**
 * Route paths, relative to the app origin. A native client prefixes its API base URL; the browser
 * uses them as-is (same origin).
 */
/**
 * The native namespace. Everything the mobile app calls lives under here, and nothing under
 * `/api/*` is touched — which is what keeps the Bearer code path from ever running for the web app
 * (creation doc §3.1). A native client prefixes its own origin; there is no same-origin shortcut.
 */
export const API_V2 = "/api/v2";

/** Route paths under `API_V2`. Joined to the app's `apiBaseUrl` by the native client. */
export const API_V2_ROUTES = {
  /** Echoes the authenticated learner's Auth0 `sub`. An auth + liveness probe. */
  me: `${API_V2}/me`,
  /** Selectable tutor versions — version + label, never the agent id. */
  agentVersions: `${API_V2}/agent-versions`,
  /** Mint a WebRTC conversation token + its authoritative conversation id. */
  conversationToken: `${API_V2}/words-agent/token`,
  /** Save a finished conversation's transcript. Same body as the v1 beacon route. */
  lessonSession: `${API_V2}/lessons/session`,
} as const;

/**
 * `GET /api/v2/lessons/:id` — everything the tutor screen needs on first paint.
 *
 * `session` above is a LITERAL segment and this is a DYNAMIC one. Next matches literals first, so
 * `/api/v2/lessons/session` never resolves to a lesson whose id happens to be "session" — which uuids
 * make unreachable anyway. Worth stating because it reads like a collision and is not.
 */
export function lessonPath(id: string): string {
  return `${API_V2}/lessons/${encodeURIComponent(id)}`;
}

export const API_ROUTES = {
  /** Mint a short-lived signed WebSocket URL for a tutor version's agent. */
  signedUrl: "/api/words-agent/signed-url",
  /** Beacon twin of `saveLessonSessionAction` — save a live transcript from `pagehide`/`freeze`. */
  lessonSession: "/api/lessons/session",
  /** Machine-readable health of the integrations. */
  health: "/api/health",
} as const;

/** `?version=` selects a tutor prompt version; omitted means "newest active". */
export function signedUrlPath(version?: string): string {
  return version
    ? `${API_ROUTES.signedUrl}?version=${encodeURIComponent(version)}`
    : API_ROUTES.signedUrl;
}

/**
 * `?version=` selects a tutor prompt version; omitted means "newest active".
 *
 * Deliberately the same grammar as `signedUrlPath` — the two routes are transport twins, and one
 * of them having the version in a JSON body would be a second convention to remember. This is the
 * only place that grammar is written, on either side.
 */
export function conversationTokenPath(version?: string): string {
  return version
    ? `${API_V2_ROUTES.conversationToken}?version=${encodeURIComponent(version)}`
    : API_V2_ROUTES.conversationToken;
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────

/**
 * The error envelope every route returns on failure — built by `apiError` in `lib/http.ts`.
 * A response is an error if and only if `error` is present.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/** Narrow an already-parsed body to the error envelope. */
export function isApiError(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as ApiErrorBody).error;
  return typeof err === "object" && err !== null && typeof err.message === "string";
}

// ── responses ────────────────────────────────────────────────────────────────────────────────

/** `GET /api/words-agent/signed-url` — 200. */
export interface SignedUrlResponse {
  /** Short-lived ElevenLabs conversation URL. The API key never leaves the server. */
  signedUrl: string;
  /** The tutor version actually resolved (may differ from the request when none was asked for). */
  version: string;
  /** Echoed back so the client stamps it as the `app_env` dynamic variable; the post-call webhook
   *  reads it to route the event to the right environment. */
  appEnv: string;
}

/**
 * Narrow an already-parsed body to a usable signed-URL response.
 *
 * Requires `appEnv` as well as `signedUrl`: it becomes the conversation's `app_env` dynamic
 * variable, which the post-call webhook reads to decide WHICH ENVIRONMENT the session belongs to.
 * Defaulting a missing one would silently file dev sessions under prod, so a response without it
 * is treated as an error rather than quietly patched.
 */
export function isSignedUrlResponse(body: unknown): body is SignedUrlResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<SignedUrlResponse>;
  return Boolean(b.signedUrl) && typeof b.signedUrl === "string" && typeof b.appEnv === "string";
}

/**
 * `POST /api/lessons/session` — the REQUEST body. Also the argument of the `saveLessonSessionAction`
 * server action, so both save paths describe the same payload.
 *
 * Declared here rather than beside the handler because a client has to *construct* it, and the
 * handler lives in a server-only module (`lib/tutor-session.ts` imports `next/cache`) that a native
 * client could never import. `lines` is sanitized server-side regardless of what arrives —
 * `ownerId` is re-derived from the session and `lessonId` is checked against it, so nothing here is
 * trusted.
 */
export interface TutorSessionInput {
  lessonId: string;
  conversationId: string;
  agentVersion: string;
  lines: TranscriptLine[];
}

/** `POST /api/lessons/session` — 200. */
export interface LessonSessionResponse {
  ok: true;
}

/**
 * `GET /api/v2/me` — 200. The whole point is that `sub` is the SAME owner id the cookie path
 * produces, so every owner-scoped query works unchanged whichever client asked.
 */
export interface MeResponse {
  sub: string;
}

/** Narrow an already-parsed body to a usable `/api/v2/me` response. */
export function isMeResponse(body: unknown): body is MeResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<MeResponse>;
  return typeof b.sub === "string" && b.sub.length > 0;
}

/**
 * `POST /api/v2/words-agent/token` — 200. The WebRTC twin of `SignedUrlResponse`.
 *
 * React Native cannot use the signed-URL path at all: the SDK throws for `connectionType:
 * "websocket"` / `signedUrl`, because that transport needs `AudioContext` and `AudioWorkletNode`.
 * See docs/2026-08-12-expo-app-creation.md §2.
 */
export interface ConversationTokenResponse {
  /** Short-lived (900 s) LiveKit access token. The xi-api-key never leaves the server. */
  token: string;
  /**
   * The AUTHORITATIVE conversation id, minted alongside the token.
   *
   * Returned rather than read off the SDK because the WebRTC transport DERIVES its id from the
   * LiveKit room name and falls back to `room_${Date.now()}` when that name is empty — an id no
   * other writer will ever produce. Four writers converge on one `lesson_sessions` row keyed by
   * this column, so a derived id silently forks a learner's history.
   * See docs/2026-08-13-expo-s3-conversation-token.md §3.
   */
  conversationId: string;
  /** The version actually resolved (differs from the request when none was asked for). */
  version: string;
  /** Stamped as the `app_env` dynamic variable; the post-call webhook routes on it. */
  appEnv: string;
}

/**
 * Narrow an already-parsed token response.
 *
 * Requires `conversationId` and `appEnv` as well as the token: both are values the client must
 * never invent. A missing `conversationId` means the row key would have to be derived, and a
 * derived id is worse than no session at all; a missing `appEnv` files the session under the wrong
 * environment. Either one is an error, not something to patch client-side.
 */
export function isConversationTokenResponse(body: unknown): body is ConversationTokenResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<ConversationTokenResponse>;
  return (
    typeof b.token === "string" &&
    b.token.length > 0 &&
    typeof b.conversationId === "string" &&
    b.conversationId.length > 0 &&
    typeof b.appEnv === "string" &&
    b.appEnv.length > 0
  );
}

/**
 * One selectable tutor version.
 *
 * `agentId` is ABSENT on purpose. The app names a VERSION and the server owns version → agent id,
 * which is the seam that lets `pnpm sync:agents` retire a version without bricking every installed
 * binary. Adding the id here would compile agent ids into shipped apps.
 */
export interface AgentVersionSummary {
  version: string;
  label: string;
}

/** `GET /api/v2/agent-versions` — 200. */
export interface AgentVersionsResponse {
  /** Active versions in canonical order, oldest → newest. */
  versions: AgentVersionSummary[];
  /**
   * The version used when the client asks for none. Sent explicitly because "newest active" is a
   * SERVER-side rule; a client re-deriving it from array order would be a second implementation of
   * `resolveAgent` living in a binary that cannot be hot-fixed.
   */
  defaultVersion: string;
}

/** Narrow an already-parsed agent-versions response. */
export function isAgentVersionsResponse(body: unknown): body is AgentVersionsResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AgentVersionsResponse>;
  return (
    Array.isArray(b.versions) && typeof b.defaultVersion === "string" && b.defaultVersion.length > 0
  );
}

/**
 * `GET /api/v2/lessons/:id` — 200. One response, not three.
 *
 * The tutor screen wants the lesson, its words and its history together on first paint; three round
 * trips is three chances to half-load and three error states for data that is one owner-scoped read
 * on the server. See docs/2026-08-13-expo-s4-tutor-screen.md D30.
 *
 * Deliberately absent: the lesson's add/remove item history. That is EDITING history — it belongs to
 * the screen that generates the events (S5), not to the tutor's first paint.
 */
export interface LessonDetailResponse {
  /** The lesson plus `itemsDetailed` — the fat shape `formatItemsList` consumes. */
  lesson: LessonDetail;
  /**
   * Past conversations, newest first, CAPPED server-side (`MAX_LESSON_SESSIONS`).
   *
   * Sent fat (transcripts included) because the screen renders them on expand and a second route per
   * session would be a request per tap. If that turns out to dominate the payload, the answer is a
   * summaries-only list plus a per-session fetch — not a smaller silent cap.
   */
  sessions: LessonSession[];
  /**
   * How many the learner actually has, so a capped list can say "showing 20 of 37" rather than
   * implying that is all of them. A cap the client cannot see is a cap that lies.
   */
  sessionCount: number;
}

/** How many sessions `GET /api/v2/lessons/:id` returns. See `LessonDetailResponse.sessions`. */
export const MAX_LESSON_SESSIONS = 20;

/** Narrow an already-parsed lesson-detail response. */
export function isLessonDetailResponse(body: unknown): body is LessonDetailResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<LessonDetailResponse>;
  return (
    typeof b.lesson === "object" &&
    b.lesson !== null &&
    typeof b.lesson.id === "string" &&
    Array.isArray(b.lesson.itemsDetailed) &&
    Array.isArray(b.sessions) &&
    typeof b.sessionCount === "number"
  );
}

/** One integration probe in the health payload. */
export interface HealthCheck {
  ok: boolean;
  detail: string;
}

/** `GET /api/health` — 200 when every probe is green, 503 otherwise (body is the same shape). */
export interface HealthResponse {
  auth: HealthCheck;
  supabase: HealthCheck;
  elevenlabs: HealthCheck;
  anthropic: HealthCheck;
}
