/**
 * Seeding the IndexedDB mirror from server-rendered payloads, plus the owner guard.
 * BROWSER-ONLY (uses `getDb()`); call from client-island effects. See
 * docs/2026-07-04-offline-support-and-sync.md.
 */
import { getDb, type MirrorItem, type MirrorLesson } from "./db";

const OWNER_KEY = "owner";

/**
 * Ensure the mirror belongs to the current learner. On a shared device, logging in as a
 * different `sub` wipes lessons/items/outbox before anything is seeded, so one learner's
 * offline data can never surface to the next.
 */
export async function ensureOwner(sub: string): Promise<void> {
  const db = getDb();
  const current = await db.meta.get(OWNER_KEY);
  if (current?.value === sub) return;

  await db.transaction("rw", db.lessons, db.items, db.outbox, db.meta, async () => {
    if (current && current.value !== sub) {
      await Promise.all([db.lessons.clear(), db.items.clear(), db.outbox.clear()]);
    }
    await db.meta.put({ key: OWNER_KEY, value: sub });
  });
}

/**
 * Lesson ids with a still-pending `deleteLesson` op: removed locally but not yet confirmed by the
 * server, so a server payload may still list them as active. Guards the seeders below from
 * resurrecting a lesson the learner just deleted. (Once the delete flushes, listLessons stops
 * returning the lesson, so nothing reseeds it anyway — this only covers the pre-flush window.)
 */
async function pendingDeletedLessonIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const record of await getDb().outbox.toArray()) {
    if (record.op.kind === "deleteLesson") ids.add(record.op.lessonId);
  }
  return ids;
}

/**
 * Upsert the owner's lessons list into the mirror. Upsert-only for existing lessons (no
 * stale-deletion, which would clobber a lesson created optimistically offline but not yet pulled
 * back) — except lessons with a still-pending local delete, which are skipped so a stale payload
 * can't resurrect them.
 */
export async function seedLessons(lessons: MirrorLesson[]): Promise<void> {
  if (lessons.length === 0) return;
  const deleted = await pendingDeletedLessonIds();
  const effective = deleted.size === 0 ? lessons : lessons.filter((l) => !deleted.has(l.id));
  if (effective.length === 0) return;
  await getDb().lessons.bulkPut(effective);
}

/**
 * Item ids referenced by still-pending outbox ops: `add` = added locally but not yet confirmed
 * by the server (keep them on reseed), `remove` = removed locally but not yet confirmed (a
 * server payload still lists them as active — don't resurrect them). Guards the reseed below
 * against clobbering optimistic writes that haven't synced.
 */
async function pendingItemState(): Promise<{ add: Set<string>; remove: Set<string> }> {
  const add = new Set<string>();
  const remove = new Set<string>();
  for (const record of await getDb().outbox.toArray()) {
    const op = record.op;
    if (op.kind === "addItems") op.items.forEach((i) => add.add(i.id));
    else if (op.kind === "createLesson") op.lesson.items.forEach((i) => add.add(i.id));
    else if (op.kind === "removeItem") remove.add(op.itemId);
  }
  return { add, remove };
}

/**
 * Reconcile one lesson's active items with the server truth: upsert the provided rows and drop
 * any previously-mirrored rows for this lesson that are no longer active (i.e. removed on the
 * server). Scoped to the one lesson so it never touches other lessons' items, and honours
 * still-pending optimistic writes (keeps local-only adds, doesn't resurrect local-only removes).
 */
export async function seedLessonItems(lessonId: string, items: MirrorItem[]): Promise<void> {
  const db = getDb();
  // A lesson with a pending local delete is gone from the mirror; don't reseed its items.
  if ((await pendingDeletedLessonIds()).has(lessonId)) return;
  const { add, remove } = await pendingItemState();
  const effective = items.filter((i) => !remove.has(i.id));
  await db.transaction("rw", db.items, async () => {
    const existing = await db.items.where("lesson_id").equals(lessonId).primaryKeys();
    const keep = new Set(effective.map((i) => i.id));
    for (const id of add) keep.add(id); // don't delete a not-yet-synced local add
    const stale = existing.filter((id) => !keep.has(id));
    if (stale.length > 0) await db.items.bulkDelete(stale);
    if (effective.length > 0) await db.items.bulkPut(effective);
  });
}
