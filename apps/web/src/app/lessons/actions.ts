"use server";

import { revalidatePath } from "next/cache";
import { getOwnerId } from "../../lib/auth/session";
import { applyOps, scheduleWordJobs } from "../../lib/sync-flush";
import { persistTutorSession, type TutorSessionInput } from "../../lib/tutor-session";
import type { FlushResult, OutboxRecord } from "@tutor/shared/offline/ops";

// Lesson create/add/remove now flow through the offline outbox → `flushOutbox` below (the UI
// writes to the IndexedDB mirror optimistically). The former FormData actions
// (createLessonAction / addLessonItemsAction / removeLessonItemAction) were removed as the
// mirror + outbox path supersedes them; `flushOutbox` reuses the same owner-scoped data layer.

/**
 * Save the transcript of a just-finished tutor conversation, from the browser. The post-call
 * webhook later upserts the richer copy (summary, duration) onto the same conversation_id row,
 * so history shows up immediately even if the webhook is delayed or lost.
 *
 * The validation + write live in `persistTutorSession` because the beacon route
 * (`/api/lessons/session`) has to do exactly the same thing from `pagehide`, where a server action
 * cannot run.
 */
export async function saveLessonSessionAction(input: TutorSessionInput): Promise<void> {
  await persistTutorSession(input);
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
  if (!ownerId) return { applied: [] };

  const { applied, touched, addedItems, changedAttachment } = await applyOps(ownerId, records);

  if (applied.length > 0) {
    revalidatePath("/");
    for (const lessonId of touched) revalidatePath(`/lessons/${lessonId}`);
    // A deleted lesson's words become unattached, which the collection page shows.
    if (changedAttachment) revalidatePath("/lesson-items");
  }

  // Fast path for the level and word-details jobs, so a word added here is levelled and enriched in
  // seconds rather than at the next sweep. The v2 route calls the same function — see its comment
  // for why it is shared rather than copied.
  if (addedItems) scheduleWordJobs(ownerId);

  return { applied };
}
