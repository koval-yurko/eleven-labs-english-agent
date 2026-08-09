/**
 * The Dexie/IndexedDB schema behind the browser's mirror. Schema only — the operations the sync
 * layer calls live in `./dexie-store.ts`, behind the `MirrorStore` contract in
 * `src/shared/mirror-store.ts`. See docs/2026-07-04-offline-support-and-sync.md.
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
import type { OutboxRecord } from "../../shared/sync-ops";
import type { MirrorItem, MirrorLesson, SessionJournalEntry } from "../../shared/mirror-store";

interface MetaRow {
  key: string;
  value: string;
}

export class MirrorDB extends Dexie {
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
