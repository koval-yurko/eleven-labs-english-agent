/**
 * The offline outbox: its op algebra, its limits, and the pure rules that build an op.
 *
 * Every op is **idempotent by design** (upsert-by-id / soft-delete set), so replaying the whole
 * outbox — even one that half-succeeded on a previous flush — always converges.
 * See docs/2026-07-04-offline-support-and-sync.md.
 *
 * PURE. It holds no storage: the browser's Dexie transactions live in `lib/sync/engine.ts`, and
 * the server's replay in `app/lessons/actions.ts`. Both sides import their shared vocabulary from
 * here, which is what fixes the duplication this module was extracted to end —
 * `MAX_ITEMS` was declared twice (once per side) and the lesson-title cap three times, because
 * `lib/sync/engine.ts` is browser-only (it reaches for `getDb()`) so a Server Action physically
 * could not import from it. See docs/2026-08-09-shareable-core-refactor.md (R5, stage 1).
 */
import { clientDedupeKey, wordInputKey } from "./word-key";

// ── limits ───────────────────────────────────────────────────────────────────────────────────

/** Most items one lesson holds. Enforced by the UI when composing, and again on replay. */
export const MAX_ITEMS = 50;

/** Most outbox records one flush carries. A first-ever flush of a long-offline device is capped
 *  rather than unbounded; the remainder goes on the next trigger. */
export const MAX_FLUSH_RECORDS = 500;

/** Longest stored lesson title. */
export const MAX_LESSON_TITLE = 120;

// ── op algebra ───────────────────────────────────────────────────────────────────────────────

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

/** Soft-delete a whole lesson. The server keeps its rows (items + sessions); only the active list
 *  loses it. Idempotent like the rest — a re-applied delete is a no-op. */
export interface DeleteLessonOp {
  kind: "deleteLesson";
  lessonId: string;
}

export type OutboxOp = CreateLessonOp | AddItemsOp | RemoveItemOp | DeleteLessonOp;

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

/** The lesson an op mutates — used to know which pages to revalidate after a flush. */
export function opLessonId(op: OutboxOp): string {
  return op.kind === "createLesson" ? op.lesson.id : op.lessonId;
}

// ── building an op ───────────────────────────────────────────────────────────────────────────

/** A new item row, ready for both the mirror and the queued op. */
export interface PlannedItem {
  id: string;
  text: string;
  position: number;
}

/**
 * The ONE rule for turning typed lines into new item rows: normalize with `wordInputKey`, drop
 * blanks, drop anything that already exists in the lesson or repeats earlier in the same batch,
 * and number what survives from the end of the existing rows.
 *
 * Dedupe uses `clientDedupeKey`, which is deliberately weaker than the Postgres `norm_key`
 * identity — it may leave a duplicate for the server to skip but can never merge two words the
 * learner meant to keep apart (see the invariant in `word-key.ts`). The `linked` guard in
 * `lib/lessons.ts::linkWords` is what catches the remainder, and is load-bearing.
 *
 * `newId` is a parameter rather than a call to `crypto.randomUUID()` so this stays free of ambient
 * globals (React Native has no `crypto.randomUUID` without a polyfill) and so a test can pass a
 * counter and get deterministic output.
 *
 * NOT capped at `MAX_ITEMS`: the caller knows how much room the lesson has left (`MAX_ITEMS` minus
 * the rows already there), which is a stricter bound than this function could compute.
 */
export function planNewItems(
  texts: readonly string[],
  existing: readonly { text: string; position: number }[],
  newId: () => string,
): PlannedItem[] {
  const seen = new Set(existing.map((row) => clientDedupeKey(row.text)));
  let position = existing.reduce((max, row) => Math.max(max, row.position), -1);

  const planned: PlannedItem[] = [];
  for (const raw of texts) {
    const text = wordInputKey(raw);
    if (!text) continue;
    const key = clientDedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    position += 1;
    planned.push({ id: newId(), text, position });
  }
  return planned;
}

/** `null` when every text was blank or a duplicate — i.e. nothing to queue. */
export function buildAddItemsOp(
  lessonId: string,
  texts: readonly string[],
  existing: readonly { text: string; position: number }[],
  newId: () => string,
): AddItemsOp | null {
  const items = planNewItems(texts, existing, newId);
  return items.length === 0 ? null : { kind: "addItems", lessonId, items };
}

/**
 * A create op for a brand-new lesson. Runs the texts through the same `planNewItems` rule as the
 * add path, so creating a lesson from "novel" and "Novel" yields one item rather than two. The two
 * write paths previously disagreed — add deduped, create did not — and the mirror showed a
 * duplicate until the next reseed silently dropped it.
 *
 * ("Don't" and "dont" still yield two here, and one on the server. That is the intended asymmetry
 * of `clientDedupeKey`, not a gap in this rule — see the invariant in `word-key.ts`.)
 *
 * `position` is discarded: on create the server assigns positions from array order.
 */
export function buildCreateLessonOp(
  lessonId: string,
  title: string,
  texts: readonly string[],
  newId: () => string,
): CreateLessonOp {
  const items = planNewItems(texts, [], newId).map(({ id, text }) => ({ id, text }));
  return { kind: "createLesson", lesson: { id: lessonId, title: normalizeLessonTitle(title), items } };
}

// ── lesson titles ────────────────────────────────────────────────────────────────────────────

/** Trim and cap. Applied on both sides so what the mirror shows is what the server stores. */
export function normalizeLessonTitle(raw: string): string {
  return raw.trim().slice(0, MAX_LESSON_TITLE);
}

/** `dd-mm-yyyy` for a date — the stem of the default lesson title. */
function lessonTitleStamp(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

/**
 * The title a new lesson gets when the learner doesn't type one: today's date (`dd-mm-yyyy`), then
 * `dd-mm-yyyy 1`, `dd-mm-yyyy 2`, … if that is taken, so several lessons created the same day stay
 * distinct. `taken` is the set of existing titles; `date` is a parameter rather than `new Date()`
 * so the rule is testable and has no hidden clock.
 */
export function nextLessonTitle(taken: ReadonlySet<string>, date: Date): string {
  const base = lessonTitleStamp(date);
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

// ── validating a batch off the wire ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** `{ id, text }` — a create op's item, whose position comes from array order. */
function isNewItem(value: unknown): boolean {
  return isRecord(value) && isId(value.id) && typeof value.text === "string";
}

/** `{ id, text, position }` — an add op's item, which carries its own position. */
function isPlacedItem(value: unknown): boolean {
  return isNewItem(value) && typeof (value as { position: unknown }).position === "number";
}

function isOutboxOp(value: unknown): value is OutboxOp {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "createLesson": {
      const lesson = value.lesson;
      return (
        isRecord(lesson) &&
        isId(lesson.id) &&
        typeof lesson.title === "string" &&
        Array.isArray(lesson.items) &&
        lesson.items.every(isNewItem)
      );
    }
    case "addItems":
      return isId(value.lessonId) && Array.isArray(value.items) && value.items.every(isPlacedItem);
    case "removeItem":
      return isId(value.lessonId) && isId(value.itemId);
    case "deleteLesson":
      return isId(value.lessonId);
    default:
      // The one case the type system cannot cover: `applyOp` is an exhaustive switch over `OutboxOp`
      // with no `default`, so at runtime an unknown `kind` matches nothing, falls out of the
      // function without throwing, and gets REPORTED AS APPLIED. Over the Server Action that is only
      // a lie to our own client; over the Bearer route it is a lie to an arbitrary caller.
      return false;
  }
}

function isOutboxRecord(value: unknown): value is OutboxRecord {
  return (
    isRecord(value) &&
    isId(value.id) &&
    typeof value.seq === "number" &&
    typeof value.createdAt === "string" &&
    isOutboxOp(value.op)
  );
}

/**
 * Narrow an untrusted body to a batch of outbox records, or `null` if anything about it is wrong.
 *
 * Lives here rather than beside the route because `sync-ops.ts` owns the algebra: a new op kind
 * should be unable to be added without this guard being the next thing that fails to compile. It is
 * shape validation ONLY — ownership, existence and limits are the data layer's job, and `applyOps`
 * still caps the batch at `MAX_FLUSH_RECORDS`.
 *
 * All-or-nothing on purpose. A batch is replayed in `seq` order and later ops depend on earlier ones
 * (add-items after create-lesson), so silently dropping the malformed member of a batch would apply
 * a prefix and report success for the whole thing.
 *
 * See docs/2026-08-13-expo-s5-lessons.md D46.
 */
export function parseOutboxRecords(body: unknown): OutboxRecord[] | null {
  if (!Array.isArray(body)) return null;
  return body.every(isOutboxRecord) ? (body as OutboxRecord[]) : null;
}
