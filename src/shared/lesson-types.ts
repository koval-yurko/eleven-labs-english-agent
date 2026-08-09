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
  id: string;
  text: string;
  position: number;
  created_at: string;
  removed_at: string | null;
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
