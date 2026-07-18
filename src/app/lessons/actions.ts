"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getOwnerId } from "../../lib/auth/session";
import { LEVEL_AFTER_LIMIT, levelItems } from "../../lib/levels";
import {
  createLesson,
  deleteLesson,
  getLesson,
  removeLessonItem,
  upsertLessonItems,
  upsertLessonSession,
} from "../../lib/lessons";
import type { TranscriptLine } from "../../lib/tutor";
import type { FlushResult, OutboxOp, OutboxRecord } from "../../lib/sync/types";

const MAX_ITEMS = 50;
const MAX_LINES = 500;

// Lesson create/add/remove now flow through the offline outbox → `flushOutbox` below (the UI
// writes to the IndexedDB mirror optimistically). The former FormData actions
// (createLessonAction / addLessonItemsAction / removeLessonItemAction) were removed as the
// mirror + outbox path supersedes them; `flushOutbox` reuses the same owner-scoped data layer.

/**
 * Save the transcript of a just-finished tutor conversation, from the browser. The post-call
 * webhook later upserts the richer copy (summary, duration) onto the same conversation_id row,
 * so history shows up immediately even if the webhook is delayed or lost.
 */
export async function saveLessonSessionAction(input: {
  lessonId: string;
  conversationId: string;
  agentVersion: string;
  lines: TranscriptLine[];
}): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId) return;

  // The lesson must exist AND belong to the caller — never trust ids from the browser.
  const lesson = await getLesson(ownerId, input.lessonId);
  if (!lesson || !input.conversationId) return;

  const transcript = input.lines
    .slice(0, MAX_LINES)
    .filter((l) => (l.role === "user" || l.role === "agent") && typeof l.text === "string")
    .map((l) => ({ role: l.role, text: l.text.slice(0, 4000) }));

  await upsertLessonSession({
    lessonId: lesson.id,
    ownerId,
    conversationId: String(input.conversationId).slice(0, 200),
    agentVersion: String(input.agentVersion ?? "").slice(0, 100) || null,
    transcript,
  });
  revalidatePath(`/lessons/${lesson.id}`);
}

const MAX_FLUSH_RECORDS = 500;

/** The lesson id an op mutates — used to know which pages to revalidate after a flush. */
function opLessonId(op: OutboxOp): string {
  return op.kind === "createLesson" ? op.lesson.id : op.lessonId;
}

/** Apply one queued op idempotently. Returns false only if the owner gate rejected it. */
async function applyOp(ownerId: string, op: OutboxOp): Promise<void> {
  switch (op.kind) {
    case "createLesson":
      await createLesson(ownerId, {
        id: op.lesson.id,
        title: op.lesson.title.slice(0, 120),
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

/**
 * Drain the offline outbox in one round-trip — the sync path chosen over a dedicated
 * `/api/sync` route (see docs/2026-07-04-offline-support-and-sync.md). Reuses the
 * owner-scoped data-layer functions and, like every action, re-derives the owner from the
 * session (never trusts the payload). Applies ops in `seq` order; each is an idempotent
 * upsert-by-id / soft-delete, so a partial flush is safe to retry wholesale. Returns the ids
 * of records durably applied so the client can drop exactly those from its outbox.
 *
 * Non-redirecting on purpose (unlike `createLessonAction`): a background flush must not navigate.
 */
export async function flushOutbox(records: OutboxRecord[]): Promise<FlushResult> {
  const ownerId = await getOwnerId();
  if (!ownerId || !Array.isArray(records) || records.length === 0) return { applied: [] };

  const ordered = [...records].slice(0, MAX_FLUSH_RECORDS).sort((a, b) => a.seq - b.seq);
  const applied: string[] = [];
  const touched = new Set<string>();
  let addedItems = false;
  let changedAttachment = false; // a delete detaches words → the /lesson-items view changed
  for (const record of ordered) {
    try {
      await applyOp(ownerId, record.op);
      applied.push(record.id);
      touched.add(opLessonId(record.op));
      if (record.op.kind === "createLesson" || record.op.kind === "addItems") addedItems = true;
      if (record.op.kind === "deleteLesson") changedAttachment = true;
    } catch {
      // Stop at the first failure: later ops may depend on this one (e.g. add-items after
      // create-lesson). The client keeps the unapplied tail and retries the whole batch —
      // already-applied ops replay as no-ops.
      break;
    }
  }

  if (applied.length > 0) {
    revalidatePath("/");
    for (const lessonId of touched) revalidatePath(`/lessons/${lessonId}`);
    // A deleted lesson's words become unattached, which the collection page shows.
    if (changedAttachment) revalidatePath("/lesson-items");
  }

  // Fast path for the level job (docs/2026-07-16-level-assignment-background-job.md): new items get
  // a level in seconds rather than waiting for the next `pnpm level:items` sweep. Runs after the
  // response, so a slow LLM call never delays the add.
  //
  // One call, not one per record — a flush can carry MAX_FLUSH_RECORDS ops. levelItems reads its own
  // queue, so there's nothing to pass in; that queue is newest-first, which is what makes the limit
  // safe (any other order and the capped window could miss the word just typed). The cap keeps a
  // first-ever flush from running a whole backfill here; the uncapped sweep takes the rest.
  //
  // Swallowed: best-effort, and a failure costs a chip until the next sweep.
  if (addedItems) {
    after(async () => {
      try {
        await levelItems(ownerId, { limit: LEVEL_AFTER_LIMIT });
      } catch {
        // The sweep is the backstop.
      }
    });
  }
  return { applied };
}
