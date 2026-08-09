/**
 * The local mirror's shapes and its storage contract — what the offline layer needs from a device
 * database, stated without naming one.
 *
 * PURE: types only, no implementation. The browser's implementation is `lib/sync/dexie-store.ts`
 * (IndexedDB via Dexie); a native app would add an `expo-sqlite` one and change nothing else in
 * `lib/sync/engine.ts` or `lib/sync/mirror.ts`.
 * See docs/2026-08-09-shareable-core-refactor.md (R5, stage 2) and
 * docs/2026-07-04-offline-support-and-sync.md.
 *
 * WHAT THIS DELIBERATELY DOES NOT ABSTRACT: reactive reads. Dexie's `liveQuery` hooks IndexedDB's
 * own mutation events, and there is no honest generic version of that — a SQLite adapter would
 * need its own change notification. So the reactive layer stays per-platform behind the named
 * hooks in `lib/sync/live.ts` (`useMirrorLessons`, `useMirrorLesson`, `useMirrorItems`). Those
 * three hooks plus one `MirrorStore` implementation are the entire port surface; pretending the
 * subscription model was portable would have been the more dishonest design.
 */
import type { OutboxRecord } from "./sync-ops";
import type { TranscriptLine } from "./tutor";

// ── mirrored shapes ──────────────────────────────────────────────────────────────────────────

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

// ── the contract ─────────────────────────────────────────────────────────────────────────────

/**
 * Every read and write the offline layer performs. Ordering is part of the contract, not an
 * implementation detail — callers depend on it:
 *   - `listLessons`  newest first (`created_at` desc)
 *   - `listItems`    `position` ascending
 *   - `listOutbox`   `seq` ascending — this IS the replay order
 */
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
  /** Highest `seq` in the outbox, or 0 when empty. Call inside the same transaction as the write. */
  maxOutboxSeq(): Promise<number>;
  appendOutbox(record: OutboxRecord): Promise<void>;
  deleteOutbox(ids: string[]): Promise<void>;

  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  /**
   * Drop every mirrored lesson, item and outbox record. Used when a different learner signs in on
   * a shared device. On `MirrorOps` rather than only on the store so `ensureOwner` can wipe and
   * re-stamp the owner in ONE transaction — otherwise a failure between the two leaves a mirror
   * that is empty but still labelled with the previous learner.
   */
  clearAll(): Promise<void>;
}

export interface MirrorStore extends MirrorOps {
  /**
   * Run `fn` atomically across lessons, items, outbox and meta. This is not a convenience — the
   * core invariant of the offline layer is that a mutation updates the mirror AND appends its
   * outbox record together or not at all, so the UI can never show a change whose intent was
   * never queued.
   */
  transact<T>(fn: (tx: MirrorOps) => Promise<T>): Promise<T>;

  /** The live-transcript journal — separate because it is per-lesson crash safety, not sync state. */
  journal: SessionJournalOps;
}

export interface SessionJournalOps {
  get(lessonId: string): Promise<SessionJournalEntry | null>;
  put(entry: SessionJournalEntry): Promise<void>;
  delete(lessonId: string): Promise<void>;
}
