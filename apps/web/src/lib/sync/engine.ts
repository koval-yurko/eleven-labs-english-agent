/**
 * The offline write path + sync engine. See docs/2026-07-04-offline-support-and-sync.md.
 *
 * Each mutation (create lesson, add items, remove item) updates the mirror AND appends an outbox
 * record in a single `store.transact`, so the UI reflects it instantly (via the live queries in the
 * read islands) and the intent is durably queued — one cannot happen without the other.
 * `flushOutboxNow` drains the outbox through the owner-scoped `flushOutbox` Server Action — chosen
 * over a REST `/api/sync` route — applying each op idempotently and dropping the records the server
 * confirms.
 *
 * Storage-agnostic: everything here goes through the `MirrorStore` contract
 * (`src/shared/mirror-store.ts`), so the only browser-specific things left are `crypto.randomUUID`,
 * `new Date()`, `navigator.onLine`, and the `getStore()` binding at the bottom of this file.
 */
import { getStore } from "./dexie-store";
import type { MirrorItem, MirrorOps, MirrorStore } from "@tutor/shared/offline/mirror";
import {
  buildAddItemsOp,
  buildCreateLessonOp,
  nextLessonTitle,
  type OutboxOp,
  type OutboxRecord,
} from "@tutor/shared/offline/ops";
import { flushOutbox } from "../../app/lessons/actions";

/** The mirror this engine writes to. One line to change for a different device database. */
function store(): MirrorStore {
  return getStore();
}

function now(): string {
  return new Date().toISOString();
}

/**
 * The title a new lesson gets when the learner doesn't type one — `nextLessonTitle`'s rule, deduped
 * against the mirror (the client's full view of the owner's lessons), which is authoritative for
 * the list. This wrapper is the storage half; the naming half is pure and lives in `shared`.
 */
export async function defaultLessonTitle(): Promise<string> {
  const taken = new Set((await store().listLessons()).map((l) => l.title));
  return nextLessonTitle(taken, new Date());
}

/** Queue an op with the next monotonic `seq`. Call inside the same transaction as the write. */
async function appendOutbox(tx: MirrorOps, op: OutboxOp): Promise<void> {
  const record: OutboxRecord = {
    id: crypto.randomUUID(),
    seq: (await tx.maxOutboxSeq()) + 1,
    createdAt: now(),
    op,
  };
  await tx.appendOutbox(record);
}

/** Rebuild a lesson's `items` preview (active texts in position order) after an item change. */
async function refreshLessonPreview(tx: MirrorOps, lessonId: string, at: string): Promise<void> {
  const lesson = await tx.getLesson(lessonId);
  if (!lesson) return;
  const rows = await tx.listItems(lessonId);
  await tx.putLesson({ ...lesson, items: rows.map((r) => r.text), updated_at: at });
}

/**
 * Optimistically create a lesson + queue the create op. Ids are still all client-minted (the
 * lesson's by the caller, each item's here) so the lesson is fully-formed before it ever reaches
 * the server — the enabler for offline create + idempotent sync.
 *
 * Texts go through `planNewItems` (inside `buildCreateLessonOp`), the same rule `addItemsLocal`
 * uses: normalized, blanks dropped, deduped. The mirror is built FROM the op, so the two cannot
 * disagree about what was created.
 */
export async function createLessonLocal(input: {
  id: string;
  title: string;
  texts: string[];
}): Promise<void> {
  const at = now();
  const op = buildCreateLessonOp(input.id, input.title, input.texts, () => crypto.randomUUID());
  const items: MirrorItem[] = op.lesson.items.map((it, i) => ({
    id: it.id,
    lesson_id: op.lesson.id,
    text: it.text,
    position: i,
  }));
  await store().transact(async (tx) => {
    await tx.putLesson({
      id: op.lesson.id,
      title: op.lesson.title,
      items: op.lesson.items.map((i) => i.text),
      created_at: at,
      updated_at: at,
      sessionCount: 0,
    });
    await tx.putItems(items);
    await appendOutbox(tx, op);
  });
}

/**
 * Optimistically append items to a lesson (skipping blanks and active dup texts) + queue the add
 * op. The dedupe/normalize/position rule is `planNewItems` in `shared/sync-ops.ts`; the mirror
 * rows are built from the op, so the optimistic view and the queued intent are the same list.
 */
export async function addItemsLocal(lessonId: string, texts: string[]): Promise<void> {
  const at = now();
  await store().transact(async (tx) => {
    const existing = await tx.listItems(lessonId);
    const op = buildAddItemsOp(lessonId, texts, existing, () => crypto.randomUUID());
    if (!op) return;

    await tx.putItems(op.items.map((it) => ({ ...it, lesson_id: lessonId })));
    await refreshLessonPreview(tx, lessonId, at);
    await appendOutbox(tx, op);
  });
}

/** Optimistically remove one item + queue the (idempotent) remove op. */
export async function removeItemLocal(lessonId: string, itemId: string): Promise<void> {
  const at = now();
  await store().transact(async (tx) => {
    const existing = await tx.listItems(lessonId);
    if (!existing.some((i) => i.id === itemId)) return;
    await tx.deleteItems([itemId]);
    await refreshLessonPreview(tx, lessonId, at);
    await appendOutbox(tx, { kind: "removeItem", lessonId, itemId });
  });
}

/**
 * Optimistically soft-delete a lesson: drop it and its items from the mirror (so it leaves the list
 * instantly) and queue the delete op. The op is appended unconditionally rather than collapsing an
 * unsynced create-then-delete: replay converges either way, and collapsing would race a concurrent
 * flush that had already sent the create — leaving the lesson stranded server-side. The server keeps
 * the lesson's rows (this is a soft delete); the mirror only holds active lessons, so locally it just
 * disappears. See docs/2026-07-17-delete-lesson-keep-words.md.
 */
export async function deleteLessonLocal(lessonId: string): Promise<void> {
  await store().transact(async (tx) => {
    await tx.deleteLesson(lessonId);
    await tx.deleteItems(await tx.listItemIds(lessonId));
    await appendOutbox(tx, { kind: "deleteLesson", lessonId });
  });
}

/** Ask the (single) SyncProvider to flush — decoupled so any island can request it. */
export function requestFlush(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("sync:flush"));
}

let flushing: Promise<number> | null = null;

/**
 * Drain the outbox once through the `flushOutbox` Server Action, in `seq` order. Concurrency-
 * guarded (a second call joins the in-flight flush). No-op when offline — records stay queued
 * for the next trigger. Returns how many records the server durably applied.
 */
export function flushOutboxNow(): Promise<number> {
  if (flushing) return flushing;
  flushing = doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush(): Promise<number> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return 0;
  const mirror = store();
  const records = await mirror.listOutbox();
  if (records.length === 0) return 0;

  let applied: string[] = [];
  try {
    const result = await flushOutbox(records);
    applied = result.applied ?? [];
  } catch {
    return 0; // network/server error — keep the records and retry on the next trigger
  }
  await mirror.deleteOutbox(applied);
  return applied.length;
}

