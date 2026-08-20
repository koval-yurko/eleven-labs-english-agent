/**
 * The lesson domain's shapes — a lesson, its items, and its tutor session history.
 *
 * PURE. Only `./tutor` is imported (itself pure). These moved out of `lib/lessons.ts` so that
 * naming a lesson no longer pulls in the service-role Supabase client; the queries that build
 * these rows stayed exactly where they were. See docs/2026-08-09-shareable-core-refactor.md (R1).
 */
import type { TranscriptLine, TutorItem } from "./tutor";

export interface Lesson {
  id: string;
  title: string;
  items: string[]; // derived convenience: active item texts in position order
  created_at: string;
  updated_at: string;
}

/** A lesson plus its active items' curated enrichment payloads — the fat shape the tutor needs.
 *  Only `getLesson` builds this; the list view stays on the lean text-only `Lesson`. */
export interface LessonDetail extends Lesson {
  itemsDetailed: TutorItem[];
}

export interface LessonListItem extends Lesson {
  sessionCount: number;
}

/** One word/phrase/sentence row. A removed item keeps its row (removed_at set) for history. */
export interface LessonItem {
  /** The `lesson_items` row id — what the `removeItem` op addresses. NOT the word. */
  id: string;
  /**
   * The `words` row id — what `/lesson-items/:id` addresses, so a lesson row can link to its word.
   *
   * Nullable, and not defensively: word identity needs Postgres (unaccent + NFKC, via the
   * `resolve_words` RPC), so a client building an optimistic row after `buildAddItemsOp` mints only
   * the `lesson_items` id and cannot know this one until the re-read. A row with no `wordId` is a
   * word that exists and is not yet addressable — render it as text, not as a dead link.
   */
  wordId: string | null;
  text: string;
  /**
   * The first two of `words.details.translations_ru`, comma-joined — or null when the enrichment
   * job has not answered for this word yet (which is forever, for a word it cannot answer for).
   *
   * Two rather than one because a single Russian word routinely covers one shade of an English one
   * — `ephemeral` is мимолётный *or* недолговечный depending on what is being described — and
   * showing only the first asserts a precision the data does not have. Two is also where the lock
   * screen's single line stops fitting, which is why the cap is here rather than per client.
   */
  translationRu: string | null;
  position: number;
  created_at: string;
  removed_at: string | null;
}

/** How many translations a `LessonItem` carries. See `translationRu`. */
export const ITEM_TRANSLATION_LIMIT = 2;

/**
 * One line of "word — перевод", for a surface that shows a lesson's words with their Russian.
 *
 * Shared because two surfaces render it and they must not drift: the lock-screen Live Activity
 * (which pre-joins here, so the widget extension renders strings it is given rather than deciding
 * a format in Swift) and the lesson screen's Words panel. The NUMBER is not part of it — both
 * surfaces number by render position, and a line that carried its own index could not be windowed.
 */
export function itemLine(item: { text: string; translationRu: string | null }): string {
  return item.translationRu ? `${item.text} — ${item.translationRu}` : item.text;
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

/** A brand-new lesson, with all ids minted by the caller (client) so it is fully-formed
 *  before it ever reaches the server — the enabler for offline create + idempotent sync. */
export interface NewLesson {
  id: string;
  title: string;
  items: { id: string; text: string }[];
}
