/**
 * SERVER-ONLY data access for lessons (word sets) and their tutor session history.
 * Every query goes through the service-role client and explicitly filters/stamps
 * `owner_id` (the Auth0 sub); RLS is defense-in-depth, same as the rest of the app.
 */
import { getServiceSupabase } from "./supabase/server";
import { resolveWords, wordInputKey } from "./words";
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

// Shape of the embedded lesson_items rows in a lesson select. Since 0007 the text lives on `words`
// and lesson_items is a join table, so the spelling comes one level deeper.
//
// `words` is an OBJECT here, not an array: lesson_items.word_id is a to-one FK, and PostgREST
// embeds those as a single object. supabase-js can't see that without generated database types, so
// it infers `{text}[]` from the select string alone — hence the `as unknown as` at each call site.
type EmbeddedItem = { position: number; words: { text: string } | null };

/** Active item texts in position order, out of a lesson select's embedded rows. */
function embeddedTexts(items: EmbeddedItem[] | null | undefined): string[] {
  return (items ?? []).map((i) => i.words?.text).filter((t): t is string => Boolean(t));
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

/** All of the owner's lessons, newest first, each with its active items + session count. */
export async function listLessons(ownerId: string): Promise<LessonListItem[]> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select(
      "id, title, created_at, updated_at, lesson_sessions(count), lesson_items(position, removed_at, words(text))",
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
  return ((data as unknown as Row[] | null) ?? []).map(({ lesson_sessions, lesson_items, ...lesson }) => ({
    ...lesson,
    items: embeddedTexts(lesson_items),
    sessionCount: lesson_sessions[0]?.count ?? 0,
  }));
}

/** One lesson, owner-scoped, with its active items. Null when it doesn't exist / isn't yours. */
export async function getLesson(ownerId: string, lessonId: string): Promise<Lesson | null> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .select("id, title, created_at, updated_at, lesson_items(position, removed_at, words(text))")
    .eq("owner_id", ownerId)
    .eq("id", lessonId)
    .is("lesson_items.removed_at", null)
    .order("position", { referencedTable: "lesson_items", ascending: true })
    .maybeSingle();
  if (error) throw new Error(`getLesson: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as Omit<Lesson, "items"> & { lesson_items: EmbeddedItem[] };
  const { lesson_items, ...lesson } = row;
  return { ...lesson, items: embeddedTexts(lesson_items) };
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
  const { error } = await getServiceSupabase()
    .from("lessons")
    .upsert(
      { id: lesson.id, owner_id: ownerId, title: lesson.title },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) throw new Error(`createLesson: ${error.message}`);

  await linkWords(
    ownerId,
    lesson.id,
    lesson.items.map((it, i) => ({ id: it.id, text: it.text, position: i })),
  );
  return lesson.id;
}

/**
 * Resolve texts → words (creating any the owner doesn't have yet) and link them to a lesson.
 * The shared tail of both write paths; the caller owns the ownership gate.
 *
 * Two words are skipped rather than inserted: one already active in this lesson, and a second
 * mention within the same batch. Both would be a second live link for one (lesson_id, word_id),
 * which `lesson_items_lesson_word_active_idx` rejects — and the rejection would take the whole
 * batch with it. The client can't prevent this for us: `addItemsLocal` dedupes with
 * `text.trim().toLowerCase()`, so "Don't" and "dont" reach here as two texts and one word.
 *
 * Positions are the caller's and are left alone; a skip leaves a gap, which only orders rows.
 */
async function linkWords(
  ownerId: string,
  lessonId: string,
  items: { id: string; text: string; position: number }[],
): Promise<number> {
  const clean = items
    .map((it) => ({ ...it, text: wordInputKey(it.text) }))
    .filter((it) => it.id && it.text);
  if (clean.length === 0) return 0;

  const db = getServiceSupabase();
  const words = await resolveWords(
    ownerId,
    clean.map((it) => it.text),
  );

  const { data: existing, error: existingError } = await db
    .from("lesson_items")
    .select("word_id")
    .eq("lesson_id", lessonId)
    .is("removed_at", null);
  if (existingError) throw new Error(`linkWords: ${existingError.message}`);
  const linked = new Set(((existing as { word_id: string }[] | null) ?? []).map((r) => r.word_id));

  const rows = [];
  for (const it of clean) {
    const word = words.get(it.text);
    if (!word || linked.has(word.id)) continue;
    linked.add(word.id); // also dedupes the batch against itself
    rows.push({
      id: it.id,
      lesson_id: lessonId,
      owner_id: ownerId,
      word_id: word.id,
      position: it.position,
    });
  }
  if (rows.length === 0) return 0;

  // Still ON CONFLICT (id) DO NOTHING: a replayed op whose word was since removed from the lesson
  // passes the `linked` filter above, and its client-minted id is what makes the re-insert a no-op.
  const { error } = await db
    .from("lesson_items")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`linkWords: ${error.message}`);
  return rows.length;
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
 * replaying a delivered "add items" op is a no-op. Verifies the lesson belongs to the caller
 * before inserting. Returns rows inserted.
 *
 * Since 0007 this also puts each text in the owner's `words` collection (creating it if new) and
 * links that word — so a word added inside a lesson and one added directly on /lesson-items end up
 * as the same row.
 */
export async function upsertLessonItems(
  ownerId: string,
  lessonId: string,
  items: { id: string; text: string; position: number }[],
): Promise<number> {
  // Ownership gate: never attach an item to a foreign / non-existent lesson. Before resolveWords,
  // so a rejected call cannot create words as a side effect.
  const lesson = await getLesson(ownerId, lessonId);
  if (!lesson) return 0;

  const inserted = await linkWords(ownerId, lessonId, items);
  if (inserted > 0) await touchLesson(lessonId, ownerId);
  return inserted;
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
    // Since 0007 the spelling lives on `words`, not `lesson_items` — embed it (same to-one FK cast
    // as getLesson/listLessons) rather than selecting the dropped `lesson_items.text` column.
    .select("id, position, created_at, removed_at, words(text)")
    .eq("owner_id", ownerId)
    .eq("lesson_id", lessonId)
    .order("created_at", { ascending: true })
    .order("position", { ascending: true });
  if (error) throw new Error(`listLessonItemHistory: ${error.message}`);
  type Row = Omit<LessonItem, "text"> & { words: { text: string } | null };
  return ((data as unknown as Row[] | null) ?? []).map(({ words, ...row }) => ({
    ...row,
    text: words?.text ?? "",
  }));
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
