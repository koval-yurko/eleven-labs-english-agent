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
import type { ItemsQuery } from "./items-query";
import { serializeItemsQuery } from "./items-query";
import type { LessonDetail, LessonItem, LessonListItem, LessonSession } from "./lesson-types";
import type { TranscriptLine, TutorItem } from "./tutor";
import type { TutorProviderId, TutorUsage } from "./tutor-transport";
import type { AddWordResult, ItemDetail, ItemFacet, ItemRow, LexiconLevel } from "./word-types";

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
  /** Mint an OpenAI Realtime client secret + its authoritative conversation id. */
  realtimeToken: `${API_V2}/words-agent/openai-token`,
  /** Save a finished conversation's transcript. Same body as the v1 beacon route. */
  lessonSession: `${API_V2}/lessons/session`,
  /** The learner's lessons, newest first. */
  lessons: `${API_V2}/lessons`,
  /** Replay outbox ops. The native client sends single-op batches; the shape is the same either way. */
  syncFlush: `${API_V2}/sync/flush`,
  /** The collection: every word the learner has, filtered and sorted server-side. */
  items: `${API_V2}/lesson-items`,
  /** +1 one word's popularity — the collection's only per-word write. */
  itemPopularity: `${API_V2}/lesson-items/popularity`,
  /**
   * Delete one word outright — it leaves every lesson and loses its practice statistics.
   *
   * `POST` to a literal path rather than `DELETE /lesson-items/:id`, for one specific reason:
   * `access-control-allow-methods` on this namespace is `GET,POST,OPTIONS` (`lib/http.ts`), so a
   * DELETE verb would work on the phone (a React Native fetch sends no `Origin` and preflights
   * nothing) and fail the preflight under `expo start --web` — a surface that exists, and the very
   * one the CORS block was written for. It also puts this beside the write it most resembles.
   */
  itemDelete: `${API_V2}/lesson-items/delete`,
  /** Prefix suggestions for the add-word field. Shared reference data, not owner-scoped. */
  suggest: `${API_V2}/lexicon/suggest`,
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

/**
 * `GET /api/v2/lessons/:id/items` — the editing screen's entire payload.
 *
 * Built FROM `lessonPath` so the id is encoded by one rule rather than two.
 */
export function lessonItemsPath(id: string): string {
  return `${lessonPath(id)}/items`;
}

/** `GET /api/v2/lesson-items/:id` — one word with its enrichment payload. */
export function itemPath(id: string): string {
  return `${API_V2_ROUTES.items}/${encodeURIComponent(id)}`;
}

/**
 * `GET /api/v2/lesson-items?…` — the collection, filtered and sorted.
 *
 * Built on `serializeItemsQuery`, which is **the only encoder of this grammar that may exist**. On
 * the web it encodes an address bar; here it encodes a request. The server decodes the result with
 * `parseItemsQuery`, and `pnpm check:shared` proves the two are inverse over 5,376 cases — a
 * property that holds only while there is one of each.
 *
 * The search term is deliberately NOT a parameter: `?q=` is not part of `ItemsQuery`, filtering by it
 * happens in memory (`searchItems`), and sending it would imply a server-side search that does not
 * exist. See docs/2026-08-13-expo-s6-collection.md D60, D61.
 */
export function itemsPath(query: ItemsQuery): string {
  const qs = serializeItemsQuery(query);
  return qs ? `${API_V2_ROUTES.items}?${qs}` : API_V2_ROUTES.items;
}

/**
 * Do not query below this many characters.
 *
 * Measured, not folklore: on the 53k lexicon a 1-character prefix matches 3,340 rows and a
 * 2-character one 604 — and a 1-character prefix is exactly where a suggestion is useless anyway.
 * Baymard's autocomplete research and every mainstream implementation land in the same place.
 * The client checks it before firing; the route and the RPC both re-check, because "the client
 * already checked" is not a property a server may assume.
 */
export const SUGGEST_MIN_PREFIX = 2;

/**
 * Rows in the dropdown. Fewer than ten (Baymard), and specifically eight because the list must not
 * need its own scroll region on a phone — a `FlatList` that scrolls inside the screen's scroll view
 * is the classic React Native gesture conflict. See §7 of the doc.
 */
export const SUGGEST_LIMIT = 8;

/**
 * The prefix length that defines a CACHE BUCKET, and the reason this route is called once per word
 * rather than once per keystroke.
 *
 * A client asks for every row matching the learner's first two characters, then narrows that set
 * itself as they keep typing. Measured over 10,122 prefixes of the 3,000 most frequent single
 * words, narrowing a complete 2-character bucket reproduces the server's top-8 **100.0% of the
 * time** — it cannot do otherwise, since every row matching `ubiq` also matches `ub` and
 * the sort is total. The average bucket is ~7 KB and the largest (`co`) is 1,920 rows.
 *
 * This is what phase 4 turned out to be, and it is not what the design doc proposed. A partial
 * local slice — zipf ≥ 4.0, ~10k rows — reproduces the top-8 for only 39.7% of prefixes, so the
 * list would visibly reshuffle when the server answered. See §16 of the doc.
 */
export const SUGGEST_BUCKET_PREFIX = 2;

/**
 * The cap on a bucket fetch. Above the largest real bucket (1,920) with room for the corpus to
 * grow; a client that receives exactly this many rows must treat the bucket as TRUNCATED and stop
 * trusting its own narrowing, because the rows past the cap are the ones it cannot see.
 */
export const SUGGEST_BUCKET_LIMIT = 2000;

/**
 * `GET /api/v2/lexicon/suggest?q=…&limit=…` — prefix suggestions for the add-word field.
 *
 * The prefix is sent RAW. Normalizing it is Postgres's job (`lesson_item_norm_key`, the same
 * function behind `words.norm_key`), for the reason `CLAUDE.md` gives about `resolve_words`: the
 * client cannot compute this key and must not guess at it. `wordInputKey` is not applied here
 * either — it trims, and a learner mid-word has a meaningful trailing state.
 */
export function suggestPath(prefix: string, limit: number = SUGGEST_LIMIT): string {
  return `${API_V2_ROUTES.suggest}?q=${encodeURIComponent(prefix)}&limit=${limit}`;
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
  /**
   * What the session cost, summed over its turns — present only for providers that report it live.
   *
   * It travels with the transcript because it has nowhere else to go: OpenAI has no post-call
   * webhook and no post-call transcript endpoint, so the client is the only witness to a finished
   * lesson. ElevenLabs omits it and keeps getting the richer numbers from its webhook.
   *
   * Advisory: a missing or wrong value costs an observability field, never a stored transcript. The
   * server treats it exactly that way — see docs/2026-08-22-openai-lesson-observability.md.
   */
  usage?: TutorUsage;
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
 * `POST /api/v2/words-agent/openai-token` — the OpenAI Realtime twin of `ConversationTokenResponse`.
 *
 * Shaped like its ElevenLabs sibling because the two routes have the same job: keep the provider's
 * api key server-side, keep the agent's identity out of the shipped binary, and hand the client one
 * short-lived credential plus the row key it must file its transcript under.
 *
 * The REQUEST differs, and that difference is the whole of §8. ElevenLabs takes the version in the
 * query string and injects the words at runtime through a dynamic variable; OpenAI has no dynamic
 * variables, so the words travel in the body and the server interpolates them into
 * `session.instructions` before minting anything.
 */
export interface RealtimeTokenRequest {
  lessonId: string;
  /** The lesson's active words, formatted server-side into the prompt. */
  items: TutorItem[];
  /** Requested prompt version, or absent for the default. */
  version?: string;
}

/** `POST /api/v2/words-agent/openai-token` — 200. */
export interface RealtimeTokenResponse {
  /** The ephemeral key (`ek_…`). Bearer for the SDP exchange, and ONLY for that. */
  clientSecret: string;
  /**
   * THE ROW KEY, minted here rather than derived from anything the transport says.
   *
   * OpenAI does mint an `rtc_…` call id, but only at SDP exchange — after the client would need it,
   * and from a place the server cannot see. So this is ours, for the same reason
   * `ConversationTokenResponse.conversationId` is: four writers converge on one `lesson_sessions`
   * row keyed by this column, and a derived id silently forks a learner's history.
   */
  conversationId: string;
  /** The version actually resolved (differs from the request when none was asked for). */
  version: string;
  /** The realtime model the session resolved to — an alias may not be what you asked for. */
  model: string;
  /** Unix seconds. Diagnostic: an expired credential should be readable, not mysterious. */
  expiresAt: number;
}

/** Narrow an already-parsed realtime token response. */
export function isRealtimeTokenResponse(body: unknown): body is RealtimeTokenResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<RealtimeTokenResponse>;
  return (
    typeof b.clientSecret === "string" &&
    b.clientSecret.length > 0 &&
    // Same rule as the ElevenLabs twin: a missing row key is an error, never something to invent.
    typeof b.conversationId === "string" &&
    b.conversationId.length > 0 &&
    typeof b.version === "string" &&
    typeof b.model === "string"
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
  /**
   * Which service runs this version — and therefore which transport the client must open.
   *
   * The server owns this mapping for the same reason it owns version → agent id: a client that
   * inferred a provider from a naming convention would be a second implementation of a rule that
   * cannot be hot-fixed. Picking a version IS picking a provider (§13 Q1/Q2, settled 2026-08-22),
   * which is why there is no separate provider control anywhere in the UI.
   */
  provider: TutorProviderId;
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

/**
 * `GET /api/v2/lessons` — 200.
 *
 * An object rather than a bare `LessonListItem[]`: an array response cannot grow a field later
 * without breaking every installed binary, and this is the route most likely to want one (a cursor,
 * if the payload ever justifies pagination — see docs/2026-08-13-expo-s5-lessons.md D53).
 *
 * `LessonListItem` already carries everything a row renders: `items` (the active texts, for the
 * preview line), `sessionCount`, and the timestamps.
 */
export interface LessonListResponse {
  /** Newest first — `listLessons` orders by `created_at` desc, items by `position` asc. */
  lessons: LessonListItem[];
}

/** Narrow an already-parsed lessons-list response. */
export function isLessonListResponse(body: unknown): body is LessonListResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<LessonListResponse>).lessons);
}

/**
 * `GET /api/v2/lessons/:id/items` — 200. The lesson's item rows, INCLUDING removed ones.
 *
 * Two consumers, one array, deliberately: the editable list is `items.filter(i => i.removed_at ===
 * null)` and the change log is the same array flat-mapped into added/removed events. That is what
 * `app/lessons/[id]/page.tsx` already does with the one `listLessonItemHistory` query.
 *
 * This route — rather than a field on `LessonDetailResponse` — is also the ONLY way a client learns
 * item **ids**: `LessonDetail.items` is `string[]` and `itemsDetailed` is `{ text, details }`, so
 * neither can address a row, and the `removeItem` op needs one. See
 * docs/2026-08-13-expo-s5-lessons.md D44.
 */
export interface LessonItemsResponse {
  /** Oldest first (`created_at` asc, then `position`) — the order the change log wants. */
  items: LessonItem[];
}

/** Narrow an already-parsed lesson-items response. */
export function isLessonItemsResponse(body: unknown): body is LessonItemsResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<LessonItemsResponse>).items);
}

/**
 * `GET /api/v2/lesson-items?…` — 200. The collection plus the category facets, in one response.
 *
 * One response rather than two calls because the facets are **empty**: `owner_item_facets` had zero
 * rows when this was measured (docs/2026-08-13-expo-s6-collection.md §3), so a second round trip
 * would fetch an empty array. They also change only when a category does, which is never so far.
 *
 * Unpaginated, for the reason the lessons list is (D53): measured at 70 rows / ~32 KB. The trigger to
 * revisit is a payload past ~100 KB, and the fix then is `?limit=&cursor=` — not a silent slice.
 */
export interface ItemsResponse {
  /** Filtered and sorted by Postgres. Free-text search is applied by the CLIENT, in memory. */
  items: ItemRow[];
  /** The (name, value) pairs actually in use — the source for the category filter rows. */
  facets: ItemFacet[];
}

/** Narrow an already-parsed collection response. */
export function isItemsResponse(body: unknown): body is ItemsResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<ItemsResponse>;
  return Array.isArray(b.items) && Array.isArray(b.facets);
}

/** `GET /api/v2/lesson-items/:id` — 200. */
export interface ItemDetailResponse {
  /** The `owner_items` row plus `details` / `details_at` — the three-state enrichment payload. */
  item: ItemDetail;
}

/** Narrow an already-parsed word-detail response. */
export function isItemDetailResponse(body: unknown): body is ItemDetailResponse {
  if (typeof body !== "object" || body === null) return false;
  const item = (body as Partial<ItemDetailResponse>).item;
  return typeof item === "object" && item !== null && typeof item.id === "string";
}

/** `POST /api/v2/lesson-items` — the request body. Adds one word, attached to no lesson. */
export interface AddWordRequest {
  text: string;
}

/**
 * `POST /api/v2/lesson-items` — 200.
 *
 * `AddWordResult` carries `status: "already-present"`, which is a RESULT and not an error: the
 * collection groups by `norm_key`, so a duplicate add changes nothing on screen. The client is
 * expected to say so out loud.
 */
export type AddWordResponse = AddWordResult;

/** Narrow an already-parsed add-word response. */
export function isAddWordResponse(body: unknown): body is AddWordResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AddWordResponse>;
  return b.status === "added" || b.status === "already-present" || b.status === "empty";
}

/**
 * `POST /api/v2/lesson-items/popularity` — the request body. +1, and only ever +1.
 *
 * Keyed by the word **id**, like `delete` beside it. Its predecessor (`favorite`) was keyed by
 * `norm_key` — "the odd one out among this app's writes", as three docblocks used to warn — because
 * `setItemFavorite`'s signature predated the `words` table. There is no such history here: the two
 * callers both hold a real id (the suggestion row carries `wordId`, the detail page IS an id), and
 * naming the row by id means a stale spelling cannot resolve to a different word than the one the
 * learner tapped.
 *
 * There is no amount and no direction. A counter that only ever goes up by one, from an action that
 * means "I met this word again", needs neither — and a body that could carry `-1` or `+50` would be
 * a hostile-input surface for no gain.
 */
export interface PopularityRequest {
  id: string;
}

/** `POST /api/v2/lesson-items/popularity` — 200. */
export interface PopularityResponse {
  /** False when no row matched — an id that is not the caller's, or one already deleted. */
  ok: boolean;
  /**
   * The count AFTER the bump, straight from the RPC's `returning`. Null when `ok` is false.
   *
   * Returned rather than left to the client to guess: the detail page's +1 renders this, so a bump
   * that raced another device shows the true total instead of a local increment that is one behind.
   */
  popularity: number | null;
}

/**
 * `POST /api/v2/lesson-items/delete` — the REQUEST body.
 *
 * Keyed by the word **id**, like its `popularity` sibling: a delete has a real row to name, and
 * naming it by id means a stale spelling in the client cannot resolve to a different word than the
 * one the learner ticked.
 */
export interface DeleteWordRequest {
  id: string;
}

/** `POST /api/v2/lesson-items/delete` — 200. */
export interface DeleteWordResponse {
  /** False when no row matched — an id that is not the caller's, or one already deleted. */
  ok: boolean;
}

/**
 * One row of the add-word dropdown.
 *
 * Not an `ItemRow`, and not a partial one: this describes a word the learner has probably NEVER
 * added, so it has no `norm_key`, no statistics and no `created_at` — only a `wordId`, and only once
 * they do have it. Reusing the collection's row type would mean four fields that are structurally
 * meaningless here.
 */
export interface WordSuggestion {
  /**
   * `lesson_item_norm_key(text)` — the row's search key, and the only field a client may match
   * a typed prefix against. Present so a cached bucket can be narrowed locally
   * (`SUGGEST_BUCKET_PREFIX`); `lexiconPrefixFold` in `word-key.ts` is the matching
   * fold, and its caller must treat an empty local result on non-ASCII input as "ask the server"
   * rather than as "no matches".
   */
  key: string;
  /** The spelling that goes into the input on select — Wiktionary's headword, capitals intact. */
  text: string;
  /**
   * CEFR level, or null. `LexiconLevel` rather than `CefrLevel` because a dictionary contains A1
   * words and the learner's collection does not — see `word-types.ts`.
   *
   * Null is a real and permanent state, exactly as on `words.level`: 7,226 rows are unlevelled
   * because the model was asked and declined (they are Wiktionary fragments like `of the time`,
   * not vocabulary). Render the absence; do not invent a placeholder level.
   */
  level: LexiconLevel | null;
  /**
   * Up to three Russian glosses, best first, stress marks intact (`вездесу́щий`).
   *
   * Load-bearing, not decoration. It is the answer to "did I spell the word I meant", and it is
   * ALSO what makes a surprising level legible: `arms [C2]` looks like a bug next to `arm [A1]`
   * until the gloss says `герб`. Do not drop this column for width on small screens — truncate
   * it. See §13 of the doc.
   */
  ru: string[];
  /**
   * The learner's own `words.id` for this word, or null when they do not have it yet. **`wordId !==
   * null` is what "already in your collection" means** — there is no separate `owned` flag, because
   * two fields that must agree are how they stop agreeing.
   *
   * Computed server-side by joining `lexicon.key` to `words.norm_key` — the same function produces
   * both, so the match is exact. The screen does hold the whole collection in memory and could
   * match locally, but only through `clientDedupeKey`, which `CLAUDE.md` documents as deliberately
   * weaker than `norm_key`.
   *
   * The id (rather than the boolean this used to be) is what lets the dropdown ACT on an owned row:
   * bump its popularity and open `/lesson-items/:id`. That route is id-addressed, and a client may
   * not derive a word's identity from its text, so without this field the row could only ever
   * announce ownership — never navigate to it.
   *
   * ⚠️ A client caching suggestions must drop the cache when a word is DELETED as well as added:
   * this id outlives the row it names, and a stale one navigates to a word that is gone.
   */
  wordId: string | null;
}

/**
 * `GET /api/v2/lexicon/suggest` — 200.
 *
 * An object rather than a bare array, for the reason `LessonListResponse` gives: an array response
 * cannot grow a field later without breaking every installed binary.
 *
 * An empty `suggestions` is a normal answer — a prefix below `SUGGEST_MIN_PREFIX`, a prefix
 * containing a space (the learner is typing a phrase, and the corpus is headwords), or simply no
 * match. None of those is an error and none should surface as one.
 */
export interface SuggestResponse {
  suggestions: WordSuggestion[];
}

/** Narrow an already-parsed suggestions response. */
export function isSuggestResponse(body: unknown): body is SuggestResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<SuggestResponse>).suggestions);
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
