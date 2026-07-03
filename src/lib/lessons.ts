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

/** Create a lesson with its initial items (one row each) and return its id. */
export async function createLesson(
  ownerId: string,
  title: string,
  items: string[],
): Promise<string> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("lessons")
    .insert({ owner_id: ownerId, title })
    .select("id")
    .single();
  if (error) throw new Error(`createLesson: ${error.message}`);
  const lessonId = (data as { id: string }).id;

  const rows = items.map((text, i) => ({
    lesson_id: lessonId,
    owner_id: ownerId,
    text,
    position: i,
  }));
  if (rows.length > 0) {
    const { error: itemsError } = await db.from("lesson_items").insert(rows);
    if (itemsError) throw new Error(`createLesson items: ${itemsError.message}`);
  }
  return lessonId;
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
 * Append words/sentences to a lesson (one row each), after the current max position. Skips
 * exact duplicates of currently-active items (case-insensitive). Verifies the lesson belongs
 * to the caller before inserting — an item row is never attached to a foreign lesson. Returns
 * how many rows were actually added.
 */
export async function addLessonItems(
  ownerId: string,
  lessonId: string,
  texts: string[],
): Promise<number> {
  // Ownership gate: never trust a lesson id from the browser.
  const lesson = await getLesson(ownerId, lessonId);
  if (!lesson) return 0;

  const db = getServiceSupabase();
  const { data: existing, error } = await db
    .from("lesson_items")
    .select("normalized_text, position, removed_at")
    .eq("owner_id", ownerId)
    .eq("lesson_id", lessonId);
  if (error) throw new Error(`addLessonItems read: ${error.message}`);

  type Existing = { normalized_text: string; position: number; removed_at: string | null };
  const rows = (existing as Existing[] | null) ?? [];
  // Don't re-add something already active; position monotonically after every existing row.
  const activeNorm = new Set(rows.filter((r) => r.removed_at === null).map((r) => r.normalized_text));
  let pos = rows.reduce((max, r) => Math.max(max, r.position), -1);

  const toInsert: { lesson_id: string; owner_id: string; text: string; position: number }[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const norm = text.toLowerCase();
    if (activeNorm.has(norm)) continue;
    activeNorm.add(norm); // also de-dupes within this batch
    pos += 1;
    toInsert.push({ lesson_id: lessonId, owner_id: ownerId, text, position: pos });
  }
  if (toInsert.length === 0) return 0;

  const { error: insErr } = await db.from("lesson_items").insert(toInsert);
  if (insErr) throw new Error(`addLessonItems: ${insErr.message}`);
  await touchLesson(lessonId, ownerId);
  return toInsert.length;
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
