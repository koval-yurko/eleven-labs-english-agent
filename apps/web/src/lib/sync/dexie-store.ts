/**
 * The browser's `MirrorStore`: IndexedDB via Dexie. The ONE module that knows the mirror is Dexie
 * — everything else in the sync layer talks to the contract in `src/shared/mirror-store.ts`.
 *
 * A native app adds a sibling (`expo-sqlite`) implementing the same interface, and
 * `engine.ts` / `mirror.ts` / `session-journal.ts` need no changes. The reactive reads are the
 * exception and stay per-platform in `./live.ts` — see the note in `shared/mirror-store.ts`.
 *
 * BROWSER-ONLY (`getDb()`).
 */
import type { OutboxRecord } from "@tutor/shared/sync-ops";
import type {
  MirrorOps,
  MirrorStore,
  SessionJournalEntry,
  SessionJournalOps,
} from "@tutor/shared/mirror-store";
import { getDb, type MirrorDB } from "./db";

/** The operation set, over either the live DB or an open transaction (Dexie exposes both as `db`). */
function ops(db: MirrorDB): MirrorOps {
  return {
    listLessons: () => db.lessons.orderBy("created_at").reverse().toArray(),
    getLesson: async (id) => (await db.lessons.get(id)) ?? null,
    putLesson: async (lesson) => {
      await db.lessons.put(lesson);
    },
    putLessons: async (lessons) => {
      if (lessons.length > 0) await db.lessons.bulkPut(lessons);
    },
    deleteLesson: (id) => db.lessons.delete(id),

    listItems: (lessonId) => db.items.where("lesson_id").equals(lessonId).sortBy("position"),
    listItemIds: (lessonId) => db.items.where("lesson_id").equals(lessonId).primaryKeys(),
    putItems: async (items) => {
      if (items.length > 0) await db.items.bulkPut(items);
    },
    deleteItems: async (ids) => {
      if (ids.length > 0) await db.items.bulkDelete(ids);
    },

    listOutbox: () => db.outbox.orderBy("seq").toArray(),
    maxOutboxSeq: async () => (await db.outbox.orderBy("seq").last())?.seq ?? 0,
    appendOutbox: async (record: OutboxRecord) => {
      await db.outbox.add(record);
    },
    deleteOutbox: async (ids) => {
      if (ids.length > 0) await db.outbox.bulkDelete(ids);
    },

    getMeta: async (key) => (await db.meta.get(key))?.value ?? null,
    setMeta: async (key, value) => {
      await db.meta.put({ key, value });
    },

    clearAll: async () => {
      await Promise.all([db.lessons.clear(), db.items.clear(), db.outbox.clear()]);
    },
  };
}

const journal = (db: MirrorDB): SessionJournalOps => ({
  get: async (lessonId) => (await db.sessionJournal.get(lessonId)) ?? null,
  put: async (entry: SessionJournalEntry) => {
    await db.sessionJournal.put(entry);
  },
  delete: (lessonId) => db.sessionJournal.delete(lessonId),
});

let store: MirrorStore | null = null;

/** The browser mirror store. Lazily built on the lazily-created Dexie instance — browser-only. */
export function getStore(): MirrorStore {
  if (store) return store;
  const db = getDb();
  store = {
    ...ops(db),
    // Dexie scopes a transaction to the tables it is given; inside the callback the same table
    // handles route through it, so re-deriving `ops(db)` yields transactional operations.
    transact: (fn) =>
      db.transaction("rw", db.lessons, db.items, db.outbox, db.meta, () => fn(ops(db))),
    journal: journal(db),
  };
  return store;
}
