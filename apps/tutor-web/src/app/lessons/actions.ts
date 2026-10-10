"use server";

import { revalidatePath } from "next/cache";
import { API_V2_ROUTES, type LessonSessionResponse, type TutorSessionInput } from "@tutor/shared/api";
import { opLessonId, type FlushResult, type OutboxRecord } from "@tutor/shared/offline/ops";

import { ApiError, apiFetch } from "../../lib/api";
import { getOwnerId } from "../../lib/auth/session";

// Lesson create/add/remove flow through the offline outbox → `flushOutbox` below (the UI writes to
// the IndexedDB mirror optimistically). Both actions are thin callers of services/api now; the
// owner-scoped writes, and the level/enrichment fast paths, run there.

/**
 * Save the transcript of a just-finished tutor conversation, from the browser. The post-call
 * webhook later upserts the richer copy (summary, duration) onto the same conversation_id row,
 * so history shows up immediately even if the webhook is delayed or lost.
 *
 * `POST /api/v2/lessons/session` — the same route the phone uses, and the one the `pagehide`
 * beacon reaches through tutor-web's `/api/lessons/session`.
 */
export async function saveLessonSessionAction(input: TutorSessionInput): Promise<void> {
  try {
    await apiFetch<LessonSessionResponse>(API_V2_ROUTES.lessonSession, {
      method: "POST",
      json: input,
    });
    revalidatePath(`/lessons/${input.lessonId}`);
  } catch (e) {
    // A lesson that is not this learner's (404) is a no-op, as it always was; anything else is real.
    if (!(e instanceof ApiError && e.status === 404)) throw e;
  }
}

/**
 * Drain the offline outbox in one round-trip: `POST /api/v2/sync/flush`, the same replay the phone
 * uses. Applies ops in `seq` order; each is an idempotent upsert-by-id / soft-delete, so a partial
 * flush is safe to retry wholesale. Returns the ids of records durably applied so the client can
 * drop exactly those from its outbox.
 *
 * Which pages to revalidate is derived from the records the API says it applied — the API answers
 * with ids only, and the op kinds say everything the old in-process `applyOps` result did.
 *
 * Non-redirecting on purpose: a background flush must not navigate.
 */
export async function flushOutbox(records: OutboxRecord[]): Promise<FlushResult> {
  if (!(await getOwnerId())) return { applied: [] };

  const { applied } = await apiFetch<FlushResult>(API_V2_ROUTES.syncFlush, {
    method: "POST",
    json: records,
  });

  if (applied.length > 0) {
    const done = new Set(applied);
    const appliedRecords = records.filter((r) => done.has(r.id));
    revalidatePath("/");
    for (const lessonId of new Set(appliedRecords.map((r) => opLessonId(r.op)))) {
      revalidatePath(`/lessons/${lessonId}`);
    }
    // A deleted lesson's words become unattached, which the collection page shows.
    if (appliedRecords.some((r) => r.op.kind === "deleteLesson")) revalidatePath("/lesson-items");
  }

  return { applied };
}
