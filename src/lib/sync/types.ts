/**
 * Shared shapes for the offline outbox and its server-side replay (`flushOutbox`).
 * Both the browser (which queues ops while offline) and the Server Action that drains
 * them import these, so the wire contract lives in exactly one place.
 *
 * Every op is **idempotent by design** (upsert-by-id / soft-delete set), so replaying the
 * whole outbox — even one that half-succeeded on a previous flush — always converges.
 * See docs/2026-07-04-offline-support-and-sync.md.
 */

/** Create a lesson (all ids minted by the client). */
export interface CreateLessonOp {
  kind: "createLesson";
  lesson: { id: string; title: string; items: { id: string; text: string }[] };
}

/** Append one or more items to an existing lesson (ids + positions minted by the client). */
export interface AddItemsOp {
  kind: "addItems";
  lessonId: string;
  items: { id: string; text: string; position: number }[];
}

/** Soft-delete one item by its id. */
export interface RemoveItemOp {
  kind: "removeItem";
  lessonId: string;
  itemId: string;
}

export type OutboxOp = CreateLessonOp | AddItemsOp | RemoveItemOp;

/** One queued mutation. `seq` is a per-client monotonic counter defining replay order. */
export interface OutboxRecord {
  id: string; // outbox record id (client uuid) — NOT the entity id
  seq: number;
  createdAt: string;
  op: OutboxOp;
}

/** What `flushOutbox` reports back: the ids of records it durably applied (safe to drop). */
export interface FlushResult {
  applied: string[];
}
