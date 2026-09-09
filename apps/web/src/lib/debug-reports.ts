import type {
  DebugEvent,
  DebugReportInput,
  DebugReportKind,
  SessionSnapshot,
} from "@tutor/shared/debug/report";
import type { TranscriptLine } from "@tutor/shared/tutor/session";

import { getServiceSupabase } from "./supabase/server";

/**
 * The `debug_reports` table, as the two things that touch it need it: the route that inserts one,
 * and the rate limit that decides whether to.
 *
 * Server-only, and the same posture as `lib/tutor-session.ts`: the owner is established by the
 * caller's auth and stamped here, never taken from the body. The payload SHAPE lives in
 * `@tutor/shared/debug/report` — a phone has to construct it — and this module is the half that
 * knows about Postgres.
 *
 * See docs/2026-09-09-mobile-debug-reports-and-feedback.md §9, §10.
 */

/**
 * How many reports one owner may file per hour before they are dropped.
 *
 * This is NOT about abuse: the route is authenticated, and the whole surface is one person. It is
 * about a **retry loop** — a spooled report that fails to send, is retried on every foreground, and
 * eventually succeeds a hundred times because the failure was on the response rather than on the
 * write. Twenty is far above any human filing rate and far below a loop's.
 */
export const DEBUG_REPORTS_PER_HOUR = 20;

/** Reports this owner has filed in the last hour. Used only to decide whether to drop the next. */
export async function countRecentDebugReports(ownerId: string): Promise<number> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await getServiceSupabase()
    .from("debug_reports")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .gte("created_at", since);
  if (error) throw new Error(`countRecentDebugReports: ${error.message}`);
  return count ?? 0;
}

/**
 * Store one report and return its id.
 *
 * `lessonId` is passed separately from `report` because the route resolves it first: a report whose
 * lesson id is unknown is still stored, with the column nulled. See the route for why refusing it
 * would be exactly backwards.
 */
export async function insertDebugReport(
  ownerId: string,
  report: DebugReportInput,
  lessonId: string | null,
): Promise<string> {
  const { data, error } = await getServiceSupabase()
    .from("debug_reports")
    .insert({
      owner_id: ownerId,
      captured_at: report.capturedAt,
      kind: report.kind,
      note: report.note,
      lesson_id: lessonId,
      conversation_id: report.conversationId,
      provider: report.provider,
      agent_version: report.agentVersion,
      error_code: report.errorCode,
      error_message: report.errorMessage,
      client: report.client,
      state: report.state,
      events: report.events,
      transcript_tail: report.transcriptTail,
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertDebugReport: ${error.message}`);
  return (data as { id: string }).id;
}

// ── reading, for the operator page ───────────────────────────────────────────────────────────

/** One row, as the operator list renders it. Deliberately without the four fat jsonb columns. */
export interface DebugReportSummary {
  id: string;
  created_at: string;
  captured_at: string;
  kind: DebugReportKind;
  note: string;
  lesson_id: string | null;
  conversation_id: string | null;
  provider: string | null;
  agent_version: string | null;
  error_code: string | null;
  error_message: string | null;
  status: string;
  resolution: string | null;
}

/** The whole row. Only the detail page asks for this. */
export interface DebugReportRow extends DebugReportSummary {
  client: Record<string, unknown>;
  state: { live?: SessionSnapshot; atError?: SessionSnapshot | null };
  events: DebugEvent[];
  transcript_tail: TranscriptLine[];
}

/**
 * The list view's columns, and the reason `error_code` is one of them.
 *
 * A report is 40–80 KB and almost all of it is `events`. Selecting the jsonb for a hundred-row list
 * would be megabytes over the wire to render a table that shows none of it — which is exactly the
 * cost `error_code` was denormalized out of the blob to avoid (§9).
 */
const SUMMARY_COLUMNS =
  "id, created_at, captured_at, kind, note, lesson_id, conversation_id, provider, agent_version, error_code, error_message, status, resolution";

/** What the list can be narrowed by. Every field is optional; an absent one means "any". */
export interface DebugReportFilter {
  kind?: DebugReportKind;
  provider?: string;
  errorCode?: string;
  status?: string;
  /** ISO date-time. Rows created before this are excluded. */
  since?: string;
}

/**
 * The list, newest first.
 *
 * **Owner-scoped like everything else**, even though this is an operator surface: the page sits
 * behind the same Auth0 cookie session as the learner pages, and `owner_id` is the only scoping
 * this app has. A second operator would see their own reports and not the learner's — which is the
 * correct failure for a page whose whole premise (§12.1) is that the two are the same person.
 */
export async function listDebugReports(
  ownerId: string,
  filter: DebugReportFilter = {},
  limit = 100,
): Promise<DebugReportSummary[]> {
  let query = getServiceSupabase()
    .from("debug_reports")
    .select(SUMMARY_COLUMNS)
    .eq("owner_id", ownerId);

  if (filter.kind) query = query.eq("kind", filter.kind);
  if (filter.provider) query = query.eq("provider", filter.provider);
  if (filter.errorCode) query = query.eq("error_code", filter.errorCode);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.since) query = query.gte("created_at", filter.since);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`listDebugReports: ${error.message}`);
  return (data as unknown as DebugReportSummary[] | null) ?? [];
}

/**
 * The values the filters offer, taken from the rows that exist rather than declared.
 *
 * The same decision the `provider` and `status` columns make by being unconstrained text: a fourth
 * provider, or a triage state someone invented last week, appears in the filter the moment a row
 * carries it — no migration, no code change, and no list that quietly omits the thing you are
 * looking for because nobody updated an enum.
 */
export async function debugReportFacets(
  ownerId: string,
): Promise<{ providers: string[]; errorCodes: string[]; statuses: string[] }> {
  const { data, error } = await getServiceSupabase()
    .from("debug_reports")
    .select("provider, error_code, status")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`debugReportFacets: ${error.message}`);
  const rows =
    (data as { provider: string | null; error_code: string | null; status: string }[] | null) ?? [];
  const uniq = (values: (string | null)[]) =>
    [...new Set(values.filter((v): v is string => Boolean(v)))].sort();
  return {
    providers: uniq(rows.map((r) => r.provider)),
    errorCodes: uniq(rows.map((r) => r.error_code)),
    statuses: uniq(rows.map((r) => r.status)),
  };
}

/** One report in full, or null when it is not this owner's. */
export async function getDebugReport(ownerId: string, id: string): Promise<DebugReportRow | null> {
  const { data, error } = await getServiceSupabase()
    .from("debug_reports")
    .select(`${SUMMARY_COLUMNS}, client, state, events, transcript_tail`)
    .eq("owner_id", ownerId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getDebugReport: ${error.message}`);
  return (data as unknown as DebugReportRow | null) ?? null;
}

/**
 * The transcript for a report's conversation, from `lesson_sessions`.
 *
 * This is what makes §6's decision — the report carries the conversation id and NOT the transcript
 * — pay off: the lines are already stored under this key for this owner, so the page joins rather
 * than the blob duplicating. Null when the session never connected, which is not an error: that is
 * precisely the case `conversation_id` is not a foreign key for.
 */
export async function getSessionForConversation(
  ownerId: string,
  conversationId: string,
): Promise<{
  transcript: TranscriptLine[];
  summary: string | null;
  duration_secs: number | null;
  created_at: string;
} | null> {
  const { data, error } = await getServiceSupabase()
    .from("lesson_sessions")
    .select("transcript, summary, duration_secs, created_at")
    .eq("owner_id", ownerId)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`getSessionForConversation: ${error.message}`);
  return (data as {
    transcript: TranscriptLine[];
    summary: string | null;
    duration_secs: number | null;
    created_at: string;
  } | null) ?? null;
}

/**
 * Triage — the only mutable fields on a report, and the only write this page makes.
 *
 * Owner-scoped in the `eq` rather than only checked beforehand: the filter is what makes "not your
 * report" a no-op instead of an edit, with no window between the check and the write.
 */
export async function setDebugReportTriage(
  ownerId: string,
  id: string,
  triage: { status: string; resolution: string | null },
): Promise<void> {
  const { error } = await getServiceSupabase()
    .from("debug_reports")
    .update({
      status: triage.status.slice(0, 40),
      resolution: triage.resolution?.slice(0, 2000) ?? null,
    })
    .eq("owner_id", ownerId)
    .eq("id", id);
  if (error) throw new Error(`setDebugReportTriage: ${error.message}`);
}
