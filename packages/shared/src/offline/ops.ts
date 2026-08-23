/** The offline outbox: its op algebra, its limits, and the pure rules that build an op. Every op is idempotent by design.
 *  See ../../docs/offline.md. */
import { clientDedupeKey, wordInputKey } from "../words/key";

export const MAX_ITEMS = 50;

export const MAX_FLUSH_RECORDS = 500;

export const MAX_LESSON_TITLE = 120;

export interface CreateLessonOp {
  kind: "createLesson";
  lesson: { id: string; title: string; items: { id: string; text: string }[] };
}

export interface AddItemsOp {
  kind: "addItems";
  lessonId: string;
  items: { id: string; text: string; position: number }[];
}

export interface RemoveItemOp {
  kind: "removeItem";
  lessonId: string;
  itemId: string;
}

export interface DeleteLessonOp {
  kind: "deleteLesson";
  lessonId: string;
}

export type OutboxOp = CreateLessonOp | AddItemsOp | RemoveItemOp | DeleteLessonOp;

export interface OutboxRecord {
  id: string; 
  seq: number;
  createdAt: string;
  op: OutboxOp;
}

export interface FlushResult {
  applied: string[];
}

export function opLessonId(op: OutboxOp): string {
  return op.kind === "createLesson" ? op.lesson.id : op.lessonId;
}

export interface PlannedItem {
  id: string;
  text: string;
  position: number;
}

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

export function buildAddItemsOp(
  lessonId: string,
  texts: readonly string[],
  existing: readonly { text: string; position: number }[],
  newId: () => string,
): AddItemsOp | null {
  const items = planNewItems(texts, existing, newId);
  return items.length === 0 ? null : { kind: "addItems", lessonId, items };
}

export function buildCreateLessonOp(
  lessonId: string,
  title: string,
  texts: readonly string[],
  newId: () => string,
): CreateLessonOp {
  const items = planNewItems(texts, [], newId).map(({ id, text }) => ({ id, text }));
  return { kind: "createLesson", lesson: { id: lessonId, title: normalizeLessonTitle(title), items } };
}

export function normalizeLessonTitle(raw: string): string {
  return raw.trim().slice(0, MAX_LESSON_TITLE);
}

function lessonTitleStamp(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

export function nextLessonTitle(taken: ReadonlySet<string>, date: Date): string {
  const base = lessonTitleStamp(date);
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNewItem(value: unknown): boolean {
  return isRecord(value) && isId(value.id) && typeof value.text === "string";
}

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

export function parseOutboxRecords(body: unknown): OutboxRecord[] | null {
  if (!Array.isArray(body)) return null;
  return body.every(isOutboxRecord) ? (body as OutboxRecord[]) : null;
}
