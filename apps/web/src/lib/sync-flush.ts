/**
 * SERVER-ONLY replay of the offline outbox — the op algebra applied to the owner-scoped data layer.
 *
 * It lives here, and not in the Server Action it was extracted from, because there are now TWO
 * callers with different auth and different cache concerns:
 *
 *   app/lessons/actions.ts   flushOutbox = getOwnerId() (COOKIE) + applyOps + revalidatePath + after()
 *   app/api/v2/sync/flush    POST        = withBearer   (BEARER) + applyOps +                  after()
 *
 * That is creation doc §3.2's pattern — validation + write in `lib/`, the action and the route as
 * thin callers — and here it is load-bearing rather than tidy. `flushOutbox` opens with
 * `getOwnerId()`, which is cookie-only permanently by the design that keeps the Bearer path from
 * ever running for the web app (creation doc §3.1). A v2 route calling it would get `null` for every
 * request and return `{ applied: [] }` — silently, looking like a server fault.
 *
 * See docs/2026-08-13-expo-s5-lessons.md D45.
 */
import { after } from "next/server";

import { LEVEL_AFTER_LIMIT, levelItems } from "./levels";
import { DETAILS_AFTER_LIMIT, enrichWords } from "./word-details";
import { createLesson, deleteLesson, removeLessonItem, upsertLessonItems } from "./lessons";
import {
  MAX_FLUSH_RECORDS,
  MAX_ITEMS,
  normalizeLessonTitle,
  opLessonId,
  type OutboxOp,
  type OutboxRecord,
} from "@tutor/shared/offline/ops";

/** Apply one queued op idempotently. Throws only on a real fault; an owner-gate rejection is a no-op. */
async function applyOp(ownerId: string, op: OutboxOp): Promise<void> {
  switch (op.kind) {
    case "createLesson":
      await createLesson(ownerId, {
        id: op.lesson.id,
        title: normalizeLessonTitle(op.lesson.title),
        items: op.lesson.items.slice(0, MAX_ITEMS),
      });
      return;
    case "addItems":
      await upsertLessonItems(ownerId, op.lessonId, op.items.slice(0, MAX_ITEMS));
      return;
    case "removeItem":
      await removeLessonItem(ownerId, op.lessonId, op.itemId);
      return;
    case "deleteLesson":
      await deleteLesson(ownerId, op.lessonId);
      return;
  }
}

/** What a replay produced, beyond the ids the client needs back. */
export interface ApplyOpsResult {
  /** Records durably applied, so the client can drop exactly those. See the note below. */
  applied: string[];
  /** Lessons an applied op touched — which pages the web caller revalidates. */
  touched: Set<string>;
  /** Whether any op introduced words, i.e. whether the level/enrichment fast paths are worth running. */
  addedItems: boolean;
  /** Whether a lesson was deleted — its words become unattached, which /lesson-items shows. */
  changedAttachment: boolean;
}

/**
 * Replay a batch in `seq` order. Each op is an idempotent upsert-by-id / soft-delete, so a partial
 * replay is safe to retry wholesale.
 *
 * ⚠️ **`applied` means "you may stop retrying this record", NOT "it had an effect".** The data-layer
 * functions report "I did nothing" by RETURNING, not by throwing — `upsertLessonItems` returns 0 for
 * a foreign lesson or an all-duplicate batch, `removeLessonItem` and `deleteLesson` return false for
 * an already-applied one — and those return values are deliberately discarded here. For the outbox
 * that is exactly right: retrying a no-op will never help. A client that needs to know what the data
 * now looks like re-reads it. See docs/2026-08-13-expo-s5-lessons.md §3.2 / D47.
 */
export async function applyOps(ownerId: string, records: OutboxRecord[]): Promise<ApplyOpsResult> {
  const result: ApplyOpsResult = {
    applied: [],
    touched: new Set<string>(),
    addedItems: false,
    changedAttachment: false,
  };
  if (!Array.isArray(records) || records.length === 0) return result;

  const ordered = [...records].slice(0, MAX_FLUSH_RECORDS).sort((a, b) => a.seq - b.seq);
  for (const record of ordered) {
    try {
      await applyOp(ownerId, record.op);
      result.applied.push(record.id);
      result.touched.add(opLessonId(record.op));
      if (record.op.kind === "createLesson" || record.op.kind === "addItems") {
        result.addedItems = true;
      }
      if (record.op.kind === "deleteLesson") result.changedAttachment = true;
    } catch {
      // Stop at the first failure: later ops may depend on this one (e.g. add-items after
      // create-lesson). The client keeps the unapplied tail and retries the whole batch —
      // already-applied ops replay as no-ops.
      break;
    }
  }
  return result;
}

/**
 * The level + enrichment fast paths, scheduled after the response.
 *
 * Here rather than copy-pasted into each caller because it has to run in BOTH: without it in the v2
 * route, a word added from the phone gets no CEFR level and no `details` until the next
 * `pnpm level:items` / `pnpm enrich:words` sweep, and nothing about that failure is visible at the
 * time (creation doc §3.2). Duplicated code is how one caller quietly loses it.
 *
 * One call each, not one per record — a flush can carry `MAX_FLUSH_RECORDS` ops, and both jobs read
 * their own newest-first queue, which is what makes the capped window safe. Both are best-effort and
 * swallow: the sweeps are the backstop, and a failure costs a chip until the next one.
 */
export function scheduleWordJobs(ownerId: string): void {
  after(async () => {
    try {
      await levelItems(ownerId, { limit: LEVEL_AFTER_LIMIT });
    } catch {
      // The sweep is the backstop.
    }
  });
  // A separate call from the level job on purpose: different batch size and model, and one job's
  // failure shouldn't sink the other.
  after(async () => {
    try {
      await enrichWords(ownerId, { limit: DETAILS_AFTER_LIMIT });
    } catch {
      // `pnpm enrich:words` is the backstop.
    }
  });
}
