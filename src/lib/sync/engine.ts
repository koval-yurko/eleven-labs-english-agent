/**
 * The offline write path + sync engine. BROWSER-ONLY (uses `getDb()` and the browser crypto /
 * Date). See docs/2026-07-04-offline-support-and-sync.md.
 *
 * Each mutation (create lesson, add items, remove item) updates the IndexedDB mirror AND appends
 * an outbox record in a single Dexie transaction, so the UI reflects it instantly (via the live
 * queries in the read islands) and the intent is durably queued. `flushOutboxNow` drains the
 * outbox through the owner-scoped `flushOutbox` Server Action — chosen over a REST `/api/sync`
 * route — applying each op idempotently and dropping the records the server confirms.
 */
import { getDb, type MirrorItem, type MirrorLesson } from "./db";
import type { OutboxOp, OutboxRecord } from "./types";
import { flushOutbox } from "../../app/lessons/actions";

const MAX_ITEMS = 50;

type MirrorDb = ReturnType<typeof getDb>;

function now(): string {
  return new Date().toISOString();
}

/** Next monotonic outbox sequence number (call inside the same transaction as the write). */
async function nextSeq(db: MirrorDb): Promise<number> {
  const last = await db.outbox.orderBy("seq").last();
  return (last?.seq ?? 0) + 1;
}

async function appendOutbox(db: MirrorDb, op: OutboxOp): Promise<void> {
  const record: OutboxRecord = {
    id: crypto.randomUUID(),
    seq: await nextSeq(db),
    createdAt: now(),
    op,
  };
  await db.outbox.add(record);
}

/** Rebuild a lesson's `items` preview (active texts in position order) after an item change. */
async function refreshLessonPreview(db: MirrorDb, lessonId: string, at: string): Promise<void> {
  const lesson = await db.lessons.get(lessonId);
  if (!lesson) return;
  const rows = await db.items.where("lesson_id").equals(lessonId).sortBy("position");
  await db.lessons.put({ ...lesson, items: rows.map((r) => r.text), updated_at: at });
}

/** Optimistically create a lesson (all ids client-minted) + queue the create op. */
export async function createLessonLocal(input: {
  id: string;
  title: string;
  items: { id: string; text: string }[];
}): Promise<void> {
  const db = getDb();
  const at = now();
  const lesson: MirrorLesson = {
    id: input.id,
    title: input.title,
    items: input.items.map((i) => i.text),
    created_at: at,
    updated_at: at,
    sessionCount: 0,
  };
  const items: MirrorItem[] = input.items.map((it, i) => ({
    id: it.id,
    lesson_id: input.id,
    text: it.text,
    position: i,
  }));
  await db.transaction("rw", db.lessons, db.items, db.outbox, async () => {
    await db.lessons.put(lesson);
    if (items.length > 0) await db.items.bulkPut(items);
    await appendOutbox(db, { kind: "createLesson", lesson: input });
  });
}

/** Optimistically append items to a lesson (skipping active dup texts) + queue the add op. */
export async function addItemsLocal(lessonId: string, texts: string[]): Promise<void> {
  const db = getDb();
  const at = now();
  await db.transaction("rw", db.lessons, db.items, db.outbox, async () => {
    const existing = await db.items.where("lesson_id").equals(lessonId).toArray();
    const activeNorm = new Set(existing.map((r) => r.text.trim().toLowerCase()));
    let pos = existing.reduce((max, r) => Math.max(max, r.position), -1);

    const rows: MirrorItem[] = [];
    for (const raw of texts) {
      const text = raw.trim();
      if (!text) continue;
      const norm = text.toLowerCase();
      if (activeNorm.has(norm)) continue;
      activeNorm.add(norm);
      pos += 1;
      rows.push({ id: crypto.randomUUID(), lesson_id: lessonId, text, position: pos });
    }
    if (rows.length === 0) return;

    await db.items.bulkPut(rows);
    await refreshLessonPreview(db, lessonId, at);
    await appendOutbox(db, {
      kind: "addItems",
      lessonId,
      items: rows.map((r) => ({ id: r.id, text: r.text, position: r.position })),
    });
  });
}

/** Optimistically remove one item + queue the (idempotent) remove op. */
export async function removeItemLocal(lessonId: string, itemId: string): Promise<void> {
  const db = getDb();
  const at = now();
  await db.transaction("rw", db.lessons, db.items, db.outbox, async () => {
    const item = await db.items.get(itemId);
    if (!item) return;
    await db.items.delete(itemId);
    await refreshLessonPreview(db, lessonId, at);
    await appendOutbox(db, { kind: "removeItem", lessonId, itemId });
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
  const db = getDb();
  const records = await db.outbox.orderBy("seq").toArray();
  if (records.length === 0) return 0;

  let applied: string[] = [];
  try {
    const result = await flushOutbox(records);
    applied = result.applied ?? [];
  } catch {
    return 0; // network/server error — keep the records and retry on the next trigger
  }
  if (applied.length > 0) await db.outbox.bulkDelete(applied);
  return applied.length;
}

export { MAX_ITEMS };
