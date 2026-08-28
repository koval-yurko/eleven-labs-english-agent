/** The HTTP contract between any client and the API routes: the paths, the response bodies, and the error envelope.
 *  See ../docs/api.md. */
import type { ItemsQuery } from "./words/query";
import { serializeItemsQuery } from "./words/query";
import type { LessonDetail, LessonItem, LessonListItem, LessonSession } from "./lessons/types";
import type { TranscriptLine, TutorItem } from "./tutor/session";
import type { TutorProviderId, TutorUsage } from "./tutor/transport";
import type { AddWordResult, ItemDetail, ItemFacet, ItemRow, LexiconLevel } from "./words/types";

export const API_V2 = "/api/v2";

export const API_V2_ROUTES = {
  me: `${API_V2}/me`,
  agentVersions: `${API_V2}/agent-versions`,
  conversationToken: `${API_V2}/words-agent/token`,
  realtimeToken: `${API_V2}/words-agent/openai-token`,
  vapiToken: `${API_V2}/words-agent/vapi-token`,
  vapiWebhook: `${API_V2}/vapi/webhook`,
  lessonSession: `${API_V2}/lessons/session`,
  lessons: `${API_V2}/lessons`,
  syncFlush: `${API_V2}/sync/flush`,
  items: `${API_V2}/lesson-items`,
  itemPopularity: `${API_V2}/lesson-items/popularity`,
  itemDelete: `${API_V2}/lesson-items/delete`,
  suggest: `${API_V2}/lexicon/suggest`,
} as const;

export function lessonPath(id: string): string {
  return `${API_V2}/lessons/${encodeURIComponent(id)}`;
}

export function lessonItemsPath(id: string): string {
  return `${lessonPath(id)}/items`;
}

export function itemPath(id: string): string {
  return `${API_V2_ROUTES.items}/${encodeURIComponent(id)}`;
}

export function itemsPath(query: ItemsQuery): string {
  const qs = serializeItemsQuery(query);
  return qs ? `${API_V2_ROUTES.items}?${qs}` : API_V2_ROUTES.items;
}

export const SUGGEST_MIN_PREFIX = 2;

export const SUGGEST_LIMIT = 8;

export const SUGGEST_BUCKET_PREFIX = 2;

export const SUGGEST_BUCKET_LIMIT = 2000;

export function suggestPath(prefix: string, limit: number = SUGGEST_LIMIT): string {
  return `${API_V2_ROUTES.suggest}?q=${encodeURIComponent(prefix)}&limit=${limit}`;
}

export const API_ROUTES = {
  signedUrl: "/api/words-agent/signed-url",
  lessonSession: "/api/lessons/session",
  health: "/api/health",
} as const;

export function signedUrlPath(version?: string): string {
  return version
    ? `${API_ROUTES.signedUrl}?version=${encodeURIComponent(version)}`
    : API_ROUTES.signedUrl;
}

export function conversationTokenPath(version?: string): string {
  return version
    ? `${API_V2_ROUTES.conversationToken}?version=${encodeURIComponent(version)}`
    : API_V2_ROUTES.conversationToken;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function isApiError(body: unknown): body is ApiErrorBody {
  if (typeof body !== "object" || body === null) return false;
  const err = (body as ApiErrorBody).error;
  return typeof err === "object" && err !== null && typeof err.message === "string";
}

export interface SignedUrlResponse {
  signedUrl: string;
  version: string;
  appEnv: string;
}

export function isSignedUrlResponse(body: unknown): body is SignedUrlResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<SignedUrlResponse>;
  return Boolean(b.signedUrl) && typeof b.signedUrl === "string" && typeof b.appEnv === "string";
}

export interface TutorSessionInput {
  lessonId: string;
  conversationId: string;
  agentVersion: string;
  lines: TranscriptLine[];
  usage?: TutorUsage;
}

export interface LessonSessionResponse {
  ok: true;
}

export interface MeResponse {
  sub: string;
}

export function isMeResponse(body: unknown): body is MeResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<MeResponse>;
  return typeof b.sub === "string" && b.sub.length > 0;
}

export interface ConversationTokenResponse {
  token: string;
  conversationId: string;
  version: string;
  appEnv: string;
}

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

export interface RealtimeTokenRequest {
  lessonId: string;
  items: TutorItem[];
  version?: string;
}

export type RealtimeTurnDetection =
  | {
      type: "semantic_vad";
      eagerness: "low" | "medium" | "high" | "auto";
    }
  | {
      type: "server_vad";
      silence_duration_ms: number;
      idle_timeout_ms?: number;
    };

export interface RealtimeAudioInput {
  transcription?: { model: string };
  turn_detection: RealtimeTurnDetection;
}

export interface RealtimeTokenResponse {
  clientSecret: string;
  conversationId: string;
  version: string;
  model: string;
  expiresAt: number;
  audioInput: RealtimeAudioInput;
}

export function isRealtimeTokenResponse(body: unknown): body is RealtimeTokenResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<RealtimeTokenResponse>;
  return (
    typeof b.clientSecret === "string" &&
    b.clientSecret.length > 0 &&
    typeof b.conversationId === "string" &&
    b.conversationId.length > 0 &&
    typeof b.version === "string" &&
    typeof b.model === "string"
    // `audioInput` is deliberately NOT required here. It is pacing, and a response without it
    // degrades to "no idle timeout" — a lesson that works and does not re-engage — whereas failing
    // the guard would refuse to start one at all. The adapter reads it defensively for the same
    // reason.
  );
}

/**
 * What the client sends to mint a Vapi call credential. Same shape as `RealtimeTokenRequest`, and
 * deliberately so: on every provider the words travel as DATA and the prompt stays on the server.
 */
export interface VapiTokenRequest {
  lessonId: string;
  items: TutorItem[];
  version?: string;
}

/**
 * What comes back.
 *
 * Vapi sits between the two providers we already had, and this shape is where that shows.
 * ElevenLabs returns a token bound to an agent the server provisioned; OpenAI returns an ephemeral
 * secret plus the WHOLE session config, because it has no remote object. Vapi returns a token AND
 * an assistant id — the assistant exists, `pnpm sync:agents` made it — plus the one piece of
 * per-lesson state that is not baked into it.
 */
export interface VapiTokenResponse {
  /**
   * A short-lived public-scope JWT, signed server-side and restricted to `assistantId`.
   *
   * Not the Vapi public API key. Both work in the SDK constructor, and the difference is what a
   * stolen one can do: the public key can start any assistant in the org for as long as it exists;
   * this expires and names one. Minted per lesson for the same reason the ElevenLabs conversation
   * token is.
   */
  token: string;
  /** The assistant `sync:agents` provisioned for this version, read from agents.lock.json. */
  assistantId: string;
  /**
   * The rendered word list, for `assistantOverrides.variableValues.items_list`.
   *
   * The counterpart of OpenAI's interpolated instructions: there the server builds the whole prompt,
   * here the prompt already sits on Vapi with `{{items_list}}` in it and only the value travels. The
   * CLIENT passes this through untouched — it never composes the string, so a shipped binary cannot
   * change what the lesson teaches, only fail to send it.
   */
  itemsList: string;
  /** The row key for `lesson_sessions`, minted by the server. */
  conversationId: string;
  version: string;
}

export function isVapiTokenResponse(body: unknown): body is VapiTokenResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<VapiTokenResponse>;
  return (
    typeof b.token === "string" &&
    b.token.length > 0 &&
    typeof b.assistantId === "string" &&
    b.assistantId.length > 0 &&
    typeof b.conversationId === "string" &&
    b.conversationId.length > 0 &&
    typeof b.version === "string" &&
    // `itemsList` is NOT required to be non-empty: a lesson with no words is a real state — a
    // learner can open one before adding any — and refusing to start it would be a worse failure
    // than a tutor that finds its list empty and says so.
    typeof b.itemsList === "string"
  );
}

export interface AgentVersionSummary {
  version: string;
  label: string;
  provider: TutorProviderId;
}

export interface AgentVersionsResponse {
  versions: AgentVersionSummary[];
  defaultVersion: string;
}

export function isAgentVersionsResponse(body: unknown): body is AgentVersionsResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AgentVersionsResponse>;
  return (
    Array.isArray(b.versions) && typeof b.defaultVersion === "string" && b.defaultVersion.length > 0
  );
}

export interface LessonDetailResponse {
  lesson: LessonDetail;
  sessions: LessonSession[];
  sessionCount: number;
}

export const MAX_LESSON_SESSIONS = 20;

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

export interface LessonListResponse {
  lessons: LessonListItem[];
}

export function isLessonListResponse(body: unknown): body is LessonListResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<LessonListResponse>).lessons);
}

export interface LessonItemsResponse {
  items: LessonItem[];
}

export function isLessonItemsResponse(body: unknown): body is LessonItemsResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<LessonItemsResponse>).items);
}

export interface ItemsResponse {
  items: ItemRow[];
  facets: ItemFacet[];
}

export function isItemsResponse(body: unknown): body is ItemsResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<ItemsResponse>;
  return Array.isArray(b.items) && Array.isArray(b.facets);
}

export interface ItemDetailResponse {
  item: ItemDetail;
}

export function isItemDetailResponse(body: unknown): body is ItemDetailResponse {
  if (typeof body !== "object" || body === null) return false;
  const item = (body as Partial<ItemDetailResponse>).item;
  return typeof item === "object" && item !== null && typeof item.id === "string";
}

export interface AddWordRequest {
  text: string;
}

export type AddWordResponse = AddWordResult;

export function isAddWordResponse(body: unknown): body is AddWordResponse {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Partial<AddWordResponse>;
  return b.status === "added" || b.status === "already-present" || b.status === "empty";
}

export interface PopularityRequest {
  id: string;
}

export interface PopularityResponse {
  ok: boolean;
  popularity: number | null;
}

export interface DeleteWordRequest {
  id: string;
}

export interface DeleteWordResponse {
  ok: boolean;
}

export interface WordSuggestion {
  key: string;
  text: string;
  level: LexiconLevel | null;
  ru: string[];
  wordId: string | null;
}

export interface SuggestResponse {
  suggestions: WordSuggestion[];
}

export function isSuggestResponse(body: unknown): body is SuggestResponse {
  if (typeof body !== "object" || body === null) return false;
  return Array.isArray((body as Partial<SuggestResponse>).suggestions);
}

export interface HealthCheck {
  ok: boolean;
  detail: string;
}

export interface HealthResponse {
  auth: HealthCheck;
  supabase: HealthCheck;
  elevenlabs: HealthCheck;
  anthropic: HealthCheck;
}
