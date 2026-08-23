/** The local mirror's shapes and its storage contract — what the offline layer needs from a device database, stated without naming one.
 *  See ../../docs/offline.md. */
import type { OutboxRecord } from "./ops";
import type { TranscriptLine } from "../tutor/session";

export interface MirrorLesson {
  id: string;
  title: string;
  items: string[]; 
  created_at: string;
  updated_at: string;
  sessionCount: number;
}

export interface MirrorItem {
  id: string;
  lesson_id: string;
  text: string;
  position: number;
}

export interface SessionJournalEntry {
  lessonId: string;
  conversationId: string | null;
  agentVersion: string;
  lines: TranscriptLine[];
  updatedAt: string;
}

export interface MirrorOps {
  listLessons(): Promise<MirrorLesson[]>;
  getLesson(id: string): Promise<MirrorLesson | null>;
  putLesson(lesson: MirrorLesson): Promise<void>;
  putLessons(lessons: MirrorLesson[]): Promise<void>;
  deleteLesson(id: string): Promise<void>;

  listItems(lessonId: string): Promise<MirrorItem[]>;
  listItemIds(lessonId: string): Promise<string[]>;
  putItems(items: MirrorItem[]): Promise<void>;
  deleteItems(ids: string[]): Promise<void>;

  listOutbox(): Promise<OutboxRecord[]>;
  maxOutboxSeq(): Promise<number>;
  appendOutbox(record: OutboxRecord): Promise<void>;
  deleteOutbox(ids: string[]): Promise<void>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  clearAll(): Promise<void>;
}

export interface MirrorStore extends MirrorOps {
  transact<T>(fn: (tx: MirrorOps) => Promise<T>): Promise<T>;

  journal: SessionJournalOps;
}

export interface SessionJournalOps {
  get(lessonId: string): Promise<SessionJournalEntry | null>;
  put(entry: SessionJournalEntry): Promise<void>;
  delete(lessonId: string): Promise<void>;
}
