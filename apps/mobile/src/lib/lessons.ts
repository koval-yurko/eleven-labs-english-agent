import {
  API_V2_ROUTES,
  isLessonItemsResponse,
  isLessonListResponse,
  lessonItemsPath,
  type LessonItemsResponse,
  type LessonListResponse,
} from "@tutor/shared/api";
import type { LessonItem, LessonListItem } from "@tutor/shared/lessons/types";
import type { FlushResult, OutboxOp, OutboxRecord } from "@tutor/shared/offline/ops";

import { apiFetch, type TokenSource } from "@/api";
import { newId } from "@/lib/ids";

/**
 * Reading and writing lessons over `/api/v2/*`.
 *
 * Thin on purpose: it holds no state and owns no cache. Its whole job is that three screens do not
 * each rebuild "post an op, read `applied`, decide whether that counted".
 */

/**
 * What to render for a lesson whose stored title is empty.
 *
 * Not a cosmetic nicety: `lessons.title` is `not null` but has no non-empty check, so `''` is a
 * legal row — and a create path that forgot the `nextLessonTitle` fallback wrote a number of them
 * (see docs/2026-08-18-collection-and-lessons-list-fixes.md §1). An empty title renders as an empty
 * heading and an empty list row, i.e. a lesson the learner can see the metadata of but cannot name
 * or find. The write path is fixed; this is what keeps the rows that predate the fix reachable.
 *
 * Deliberately NOT written back to the database: the row genuinely has no title, and inventing one
 * on read is honest where inventing one on a background write would be a silent edit.
 */
export function lessonTitleOrFallback(title: string): string {
  return title.trim() || "Untitled lesson";
}

export async function fetchLessons(getToken: TokenSource): Promise<LessonListItem[]> {
  const body = await apiFetch<unknown>(API_V2_ROUTES.lessons, getToken);
  if (!isLessonListResponse(body)) throw new Error("Malformed lessons response.");
  return (body as LessonListResponse).lessons;
}

/** A lesson's item rows INCLUDING removed ones — the active list and the change log come from it. */
export async function fetchLessonItems(
  getToken: TokenSource,
  lessonId: string,
): Promise<LessonItem[]> {
  const body = await apiFetch<unknown>(lessonItemsPath(lessonId), getToken);
  if (!isLessonItemsResponse(body)) throw new Error("Malformed lesson items response.");
  return (body as LessonItemsResponse).items;
}

/**
 * Send one op and resolve only if the server took responsibility for it.
 *
 * A single-op batch, which is the point of routing native writes through the outbox algebra rather
 * than four bespoke mutations: when the offline mirror lands, the only change is where the op waits
 * before it gets here (creation doc §3.3).
 *
 * ⚠️ **A resolved promise does NOT mean the data changed.** `applied` answers "may I stop retrying
 * this record", and the data layer reports "I did nothing" by returning rather than throwing — a
 * foreign lesson, an all-duplicate batch and an already-removed item all come back applied. The
 * caller's job after this resolves is therefore to **re-read**, never to assume its optimistic view
 * was right. See docs/2026-08-13-expo-s5-lessons.md §3.2 / D47.
 *
 * `seq` is always 1 and the record id is fresh per call: there is one op in flight at a time, so
 * there is no ordering to preserve yet. That is exactly the part that changes when ops start
 * outliving the screen.
 */
export async function postOp(getToken: TokenSource, op: OutboxOp): Promise<void> {
  const record: OutboxRecord = {
    id: newId(),
    seq: 1,
    createdAt: new Date().toISOString(),
    op,
  };
  const result = await apiFetch<FlushResult>(API_V2_ROUTES.syncFlush, getToken, {
    method: "POST",
    body: JSON.stringify([record]),
  });
  if (!result.applied?.includes(record.id)) {
    // The op threw server-side — the batch stopped at it. It is still valid and still idempotent,
    // so the caller keeps it and offers a retry rather than losing what the learner typed.
    throw new Error("The server could not save that change.");
  }
}
