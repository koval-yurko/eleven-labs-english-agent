/**
 * The client-side IndexedDB mirror (Dexie) — the owner's lessons + items kept locally so the
 * UI can read them instantly and (with the sync engine) offline. See
 * docs/2026-07-04-offline-support-and-sync.md.
 *
 * BROWSER-ONLY. The Dexie instance is created lazily via `getDb()` so it is never constructed
 * during server-side rendering of the client islands (Node has no IndexedDB). Call `getDb()`
 * only from effects / event handlers / live-query callbacks, which run in the browser.
 *
 * Single database, guarded by an `owner` meta row rather than per-owner DB names: on a shared
 * device, logging in as a different learner wipes the mirror (see `ensureOwner`). This is more
 * robust across browsers (notably iOS Safari) than enumerating `indexedDB.databases()`.
 */
import Dexie, { type Table } from "dexie";
import type { OutboxRecord } from "./types";
import type { TranscriptLine } from "../tutor";

/** A lesson as the list/home surface needs it (mirrors `LessonListItem`). */
export interface MirrorLesson {
  id: string;
  title: string;
  items: string[]; // active item texts, position order — derived convenience for previews
  created_at: string;
  updated_at: string;
  sessionCount: number;
}

/** One active item row (removed items are not mirrored). */
export interface MirrorItem {
  id: string;
  lesson_id: string;
  text: string;
  position: number;
}

interface MetaRow {
  key: string;
  value: string;
}

/**
 * The transcript of a tutor session as it is being spoken, one row per lesson. iOS can discard the
 * tab (or suspend it hard enough that `onDisconnect` never runs), and in-memory lines would go with
 * it — so every line is journalled here as it arrives and cleared once the server has the session.
 * See docs/2026-08-07-ios-keep-session-alive-foreground.md.
 */
export interface SessionJournalEntry {
  lessonId: string;
  conversationId: string | null;
  agentVersion: string;
  lines: TranscriptLine[];
  updatedAt: string;
}

class MirrorDB extends Dexie {
  lessons!: Table<MirrorLesson, string>;
  items!: Table<MirrorItem, string>;
  outbox!: Table<OutboxRecord, string>;
  meta!: Table<MetaRow, string>;
  sessionJournal!: Table<SessionJournalEntry, string>;

  constructor() {
    super("idiomatic-mirror");
    this.version(1).stores({
      lessons: "id, created_at, updated_at",
      items: "id, lesson_id, position",
      outbox: "id, seq",
      meta: "key",
    });
    // v2 adds the live-transcript journal. Dexie carries unchanged stores forward; they are
    // repeated here so the current schema reads in one place.
    this.version(2).stores({
      lessons: "id, created_at, updated_at",
      items: "id, lesson_id, position",
      outbox: "id, seq",
      meta: "key",
      sessionJournal: "lessonId",
    });
  }
}

let instance: MirrorDB | null = null;

/** The lazily-created mirror DB. Browser-only — never call during SSR. */
export function getDb(): MirrorDB {
  if (!instance) instance = new MirrorDB();
  return instance;
}
