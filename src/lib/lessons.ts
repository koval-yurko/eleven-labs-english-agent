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
  items: string[]; // derived convenience: active item texts in position order
  created_at: string;
  updated_at: string;
}

export interface LessonListItem extends Lesson {
  sessionCount: number;
}

/** One word/phrase/sentence row. A removed item keeps its row (removed_at set) for history. */
export interface LessonItem {
  id: string;
  text: string;
  position: number;
  created_at: string;
  removed_at: string | null;
}

// Shape of the embedded lesson_items rows in a lesson select.
type EmbeddedItem = { text: string; position: number };

export interface LessonSession {
  id: string;
  conversation_id: string;
  agent_version: string | null;
  transcript: TranscriptLine[];
  summary: string | null;
  duration_secs: number | null;
  created_at: string;
}

/** All of the owner's lessons, newest first, each with its active items + session count. */
export async function listLessons(ownerId: string): Promise<LessonListItem[]> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select(
      "id, title, created_at, updated_at, lesson_sessions(count), lesson_items(text, position, removed_at)",
    )
    .eq("owner_id", ownerId)
    // Filter the embedded items to active ones (keeps lessons with zero active items).
    .is("lesson_items.removed_at", null)
    .order("created_at", { ascending: false })
    .order("position", { referencedTable: "lesson_items", ascending: true });
  if (error) throw new Error(`listLessons: ${error.message}`);
  type Row = Omit<Lesson, "items"> & {
    lesson_sessions: { count: number }[];
    lesson_items: EmbeddedItem[];
  };
  return ((data as Row[] | null) ?? []).map(({ lesson_sessions, lesson_items, ...lesson }) => ({
    ...lesson,
    items: (lesson_items ?? []).map((i) => i.text),
    sessionCount: lesson_sessions[0]?.count ?? 0,
  }));
}

/** One lesson, owner-scoped, with its active items. Null when it doesn't exist / isn't yours. */
export async function getLesson(ownerId: string, lessonId: string): Promise<Lesson | null> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, title, created_at, updated_at, lesson_items(text, position, removed_at)")
    .eq("owner_id", ownerId)
    .eq("id", lessonId)
    .is("lesson_items.removed_at", null)
    .order("position", { referencedTable: "lesson_items", ascending: true })
    .maybeSingle();
  if (error) throw new Error(`getLesson: ${error.message}`);
  if (!data) return null;
  const row = data as Omit<Lesson, "items"> & { lesson_items: EmbeddedItem[] };
  const { lesson_items, ...lesson } = row;
  return { ...lesson, items: (lesson_items ?? []).map((i) => i.text) };
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

/** A brand-new lesson, with all ids minted by the caller (client) so it is fully-formed
 *  before it ever reaches the server — the enabler for offline create + idempotent sync. */
export interface NewLesson {
  id: string;
  title: string;
  items: { id: string; text: string }[];
}

/**
 * Create a lesson with its initial items (one row each) and return its id. Ids are
 * client-supplied and the write is an **idempotent upsert-by-id** (INSERT … ON CONFLICT (id)
 * DO NOTHING): re-running a create — e.g. an offline-queued op replayed on reconnect — is a
 * no-op, and a client id that happens to collide with an existing row is ignored (never
 * clobbering another owner's lesson). See docs/2026-07-04-offline-support-and-sync.md.
 */
export async function createLesson(ownerId: string, lesson: NewLesson): Promise<string> {
  const db = getServiceSupabase();
  const { error } = await db
    .from("lessons")
    .upsert(
      { id: lesson.id, owner_id: ownerId, title: lesson.title },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`createLesson: ${error.message}`);

  const rows = lesson.items.map((it, i) => ({
    id: it.id,
    lesson_id: lesson.id,
    owner_id: ownerId,
    text: it.text,
    position: i,
  }));
  if (rows.length > 0) {
    const { error: itemsError } = await db
      .from("lesson_items")
      .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
    if (itemsError) throw new Error(`createLesson items: ${itemsError.message}`);
  }
  return lesson.id;
}

/** Bump lessons.updated_at so the home list can surface recently-edited lessons. */
async function touchLesson(lessonId: string, ownerId: string): Promise<void> {
  await getServiceSupabase()
    .from("lessons")
    .update({ updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("id", lessonId);
}

/**
 * Idempotent, id-driven add — the one add path, used by the offline sync replay (`flushOutbox`).
 * The client mints each item's `id` and `position` and updates its mirror optimistically, so
 * replaying a delivered "add items" op is a no-op (ON CONFLICT (id) DO NOTHING). Verifies the
 * lesson belongs to the caller before inserting. Returns rows offered.
 */
export async function upsertLessonItems(
  ownerId: string,
  lessonId: string,
  items: { id: string; text: string; position: number }[],
): Promise<number> {
  const clean = items
    .map((it) => ({ ...it, text: it.text.trim() }))
    .filter((it) => it.id && it.text);
  if (clean.length === 0) return 0;

  // Ownership gate: never attach an item to a foreign / non-existent lesson.
  const lesson = await getLesson(ownerId, lessonId);
  if (!lesson) return 0;

  const rows = clean.map((it) => ({
    id: it.id,
    lesson_id: lessonId,
    owner_id: ownerId,
    text: it.text,
    position: it.position,
  }));
  const { error } = await getServiceSupabase()
    .from("lesson_items")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`upsertLessonItems: ${error.message}`);
  await touchLesson(lessonId, ownerId);
  return rows.length;
}

/**
 * Soft-delete one item (set removed_at) — the row stays for history. Owner + lesson + id are
 * all matched, so a foreign or already-removed item is a no-op. Returns whether a row changed.
 */
export async function removeLessonItem(
  ownerId: string,
  lessonId: string,
  itemId: string,
): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("lesson_items")
    .update({ removed_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("lesson_id", lessonId)
    .eq("id", itemId)
    .is("removed_at", null)
    .select("id");
  if (error) throw new Error(`removeLessonItem: ${error.message}`);
  const changed = ((data as { id: string }[] | null) ?? []).length > 0;
  if (changed) await touchLesson(lessonId, ownerId);
  return changed;
}

/**
 * All item rows for a lesson including removed ones, oldest first — the raw material for the
 * lesson's change history (created_at = added, removed_at = removed).
 */
export async function listLessonItemHistory(
  ownerId: string,
  lessonId: string,
): Promise<LessonItem[]> {
  const { data, error } = await getServiceSupabase()
    .from("lesson_items")
    .select("id, text, position, created_at, removed_at")
    .eq("owner_id", ownerId)
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: true })
    .order("position", { ascending: true });
  if (error) throw new Error(`listLessonItemHistory: ${error.message}`);
  return (data as LessonItem[] | null) ?? [];
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
