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

class MirrorDB extends Dexie {
  lessons!: Table<MirrorLesson, string>;
  items!: Table<MirrorItem, string>;
  outbox!: Table<OutboxRecord, string>;
  meta!: Table<MetaRow, string>;

  constructor() {
    super("idiomatic-mirror");
    this.version(1).stores({
      lessons: "id, created_at, updated_at",
      items: "id, lesson_id, position",
      outbox: "id, seq",
      meta: "key",
    });
  }
}

let instance: MirrorDB | null = null;

/** The lazily-created mirror DB. Browser-only — never call during SSR. */
export function getDb(): MirrorDB {
  if (!instance) instance = new MirrorDB();
  return instance;
}
