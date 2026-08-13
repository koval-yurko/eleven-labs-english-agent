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
import type { TranscriptLine } from "./tutor";

// ── paths ────────────────────────────────────────────────────────────────────────────────────

/**
 * Route paths, relative to the app origin. A native client prefixes its API base URL; the browser
 * uses them as-is (same origin).
 */
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
