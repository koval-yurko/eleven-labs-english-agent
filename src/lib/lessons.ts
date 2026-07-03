/**
 * SERVER-ONLY data access for lessons (word sets) and their tutor session history.
 * Every query goes through the service-role client and explicitly filters/stamps
 * `owner_id` (the Auth0 sub); RLS is defense-in-depth, same as the rest of the app.
 */
import { getServiceSupabase } from "./supabase/server";
import type { TranscriptLine } from "./tutor";

export interface Lesson {
  id: string;
  title: string;
  items: string[];
  created_at: string;
}

export interface LessonListItem extends Lesson {
  sessionCount: number;
}

export interface LessonSession {
  id: string;
  conversation_id: string;
  agent_version: string | null;
  transcript: TranscriptLine[];
  summary: string | null;
  duration_secs: number | null;
  created_at: string;
}

/** All of the owner's lessons, newest first, each with its session count. */
export async function listLessons(ownerId: string): Promise<LessonListItem[]> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, title, items, created_at, lesson_sessions(count)")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listLessons: ${error.message}`);
  type Row = Lesson & { lesson_sessions: { count: number }[] };
  return ((data as Row[] | null) ?? []).map(({ lesson_sessions, ...lesson }) => ({
    ...lesson,
    sessionCount: lesson_sessions[0]?.count ?? 0,
  }));
}

/** One lesson, owner-scoped. Null when it doesn't exist or belongs to someone else. */
export async function getLesson(ownerId: string, lessonId: string): Promise<Lesson | null> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, title, items, created_at")
    .eq("owner_id", ownerId)
    .eq("id", lessonId)
    .maybeSingle();
  if (error) throw new Error(`getLesson: ${error.message}`);
  return (data as Lesson | null) ?? null;
}

/**
 * Look a lesson up by id WITHOUT owner scoping — only for the post-call webhook, which has
 * no user session and takes the owner FROM the row (never from the webhook payload).
 */
export async function getLessonById(
  lessonId: string,
): Promise<{ id: string; owner_id: string } | null> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, owner_id")
    .eq("id", lessonId)
    .maybeSingle();
  if (error) throw new Error(`getLessonById: ${error.message}`);
  return (data as { id: string; owner_id: string } | null) ?? null;
}

/** Create a lesson and return its id. */
export async function createLesson(
  ownerId: string,
  title: string,
  items: string[],
): Promise<string> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .insert({ owner_id: ownerId, title, items })
    .select("id")
    .single();
  if (error) throw new Error(`createLesson: ${error.message}`);
  return (data as { id: string }).id;
}

/** Past tutor conversations for a lesson, newest first. */
export async function listLessonSessions(
  ownerId: string,
  lessonId: string,
): Promise<LessonSession[]> {
  const { data, error } = await getServiceSupabase()
    .from("lesson_sessions")
    .select("id, conversation_id, agent_version, transcript, summary, duration_secs, created_at")
    .eq("owner_id", ownerId)
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listLessonSessions: ${error.message}`);
  return (data as LessonSession[] | null) ?? [];
}

/**
 * Record (or enrich) one tutor conversation, keyed on conversation_id. Called from the
 * browser-side save (transcript only) and from the post-call webhook (richer transcript
 * + summary + duration) — whichever lands second only updates the columns it provides.
 */
export async function upsertLessonSession(session: {
  lessonId: string;
  ownerId: string;
  conversationId: string;
  agentVersion: string | null;
  transcript: TranscriptLine[];
  summary?: string | null;
  durationSecs?: number | null;
}): Promise<void> {
  const row: Record<string, unknown> = {
    lesson_id: session.lessonId,
    owner_id: session.ownerId,
    conversation_id: session.conversationId,
    agent_version: session.agentVersion,
    transcript: session.transcript,
  };
  if (session.summary !== undefined) row.summary = session.summary;
  if (session.durationSecs !== undefined) row.duration_secs = session.durationSecs;
  const { error } = await getServiceSupabase()
    .from("lesson_sessions")
    .upsert(row, { onConflict: "conversation_id" });
  if (error) throw new Error(`upsertLessonSession: ${error.message}`);
}
