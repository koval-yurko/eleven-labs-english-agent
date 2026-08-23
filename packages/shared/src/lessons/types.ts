/** The lesson domain's shapes — a lesson, its items, and its tutor-session history.
 *  See ../../README.md#lessons. */
import type { TranscriptLine, TutorItem } from "../tutor/session";

export interface Lesson {
  id: string;
  title: string;
  items: string[]; 
  created_at: string;
  updated_at: string;
}

export interface LessonDetail extends Lesson {
  itemsDetailed: TutorItem[];
}

export interface LessonListItem extends Lesson {
  sessionCount: number;
}

export interface LessonItem {
  id: string;
  wordId: string | null;
  text: string;
  translationRu: string | null;
  position: number;
  created_at: string;
  removed_at: string | null;
}

export const ITEM_TRANSLATION_LIMIT = 2;

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

export interface NewLesson {
  id: string;
  title: string;
  items: { id: string; text: string }[];
}
