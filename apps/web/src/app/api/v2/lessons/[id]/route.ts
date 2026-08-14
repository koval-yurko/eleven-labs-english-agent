import { MAX_LESSON_SESSIONS, type LessonDetailResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { getLesson, listLessonSessions } from "../../../../../lib/lessons";

// Owner-scoped read of live data; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lessons/:id` — everything the native tutor screen needs on first paint.
 *
 * The first DYNAMIC route in the v2 namespace, which is why `withBearer` grew a context parameter
 * (S4 D32): Next hands a dynamic handler `{ params }` as its second argument, and the old wrapper
 * dropped it.
 *
 * The two queries are the same ones `app/lessons/[id]/page.tsx` already runs — no new query, no new
 * shape. What differs is only what is left out: the lesson's item history powers the web's "Word
 * changes" disclosure, which is editing history and belongs to S5's screen rather than to the tutor.
 * See docs/2026-08-13-expo-s4-tutor-screen.md D30.
 */
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, ownerId, ctx) => {
  const { id } = await ctx.params;

  // `getLesson` is already owner-scoped and already treats a soft-deleted lesson as absent, so one
  // null covers "no such lesson", "not yours" and "deleted". Answering them differently would leak
  // which ids exist; 404 rather than 401 for the same reason the session route uses it — the caller
  // is authenticated, so a 401 would send a correctly signed-in phone back to a login screen.
  const lesson = await getLesson(ownerId, id);
  if (!lesson) return apiError(404, "not_found", "No such lesson.");

  const all = await listLessonSessions(ownerId, lesson.id);

  const body: LessonDetailResponse = {
    lesson,
    // Newest first (the query orders by created_at desc), capped — and the total goes with it so the
    // client can say how many it is not showing. See LessonDetailResponse.
    sessions: all.slice(0, MAX_LESSON_SESSIONS),
    sessionCount: all.length,
  };
  return json(body);
});
