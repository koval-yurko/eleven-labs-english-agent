import type { LessonItemsResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../../lib/http";
import { getLesson, listLessonItemHistory } from "../../../../../../lib/lessons";

// Owner-scoped read of live data; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lessons/:id/items` — everything the words-editing screen needs.
 *
 * A route rather than a field on `GET /api/v2/lessons/:id`, for a reason stronger than the one S4's
 * D30 gave when it moved item history out of the tutor payload: **`LessonDetail` carries no item
 * ids at all** — `items` is `string[]`, `itemsDetailed` is `{ text, details }` — and the
 * `removeItem` op needs one. So this is not "history, additionally"; it is the editing screen's
 * whole payload, and the tutor never fetches it.
 *
 * Returns removed rows too. The active list and the change log are two derivations of one array,
 * exactly as `app/lessons/[id]/page.tsx` derives them from the same single query.
 * See docs/2026-08-13-expo-s5-lessons.md D44.
 */
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, ownerId, ctx) => {
  const { id } = await ctx.params;

  // The ownership gate comes first even though `listLessonItemHistory` is itself owner-scoped: on
  // its own it answers `[]` for a foreign lesson, and the screen renders that identically to a real
  // lesson with no words yet. One indexed read buys an unambiguous 404 — and 404 rather than 401 for
  // the same reason as the sibling routes: the caller is authenticated, so a 401 would send a
  // correctly signed-in phone back to a login screen.
  const lesson = await getLesson(ownerId, id);
  if (!lesson) return apiError(404, "not_found", "No such lesson.");

  const body: LessonItemsResponse = { items: await listLessonItemHistory(ownerId, lesson.id) };
  return json(body);
});
