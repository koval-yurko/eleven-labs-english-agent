import type { LessonListResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../lib/auth/bearer";
import { json, preflight } from "../../../../lib/http";
import { listLessons } from "../../../../lib/lessons";

// Owner-scoped read of live data; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lessons` — the learner's lessons, newest first.
 *
 * The same query `app/lessons/page.tsx` runs, unchanged: `listLessons` is already owner-scoped,
 * already drops soft-deleted lessons, already filters the embedded items to active ones (keeping
 * lessons with zero of them), and already orders `created_at` desc / `position` asc.
 *
 * Unpaginated (D53). The list is bounded by how many lessons one person makes by hand and every
 * field the row renders is already in the DTO. The trigger to revisit is a measurement — a payload
 * over ~100 KB or a visible pause on the device — and the fix then is `?limit=&cursor=`, not a
 * silent slice. A cap the client cannot see is a cap that lies (S4 D31).
 */
export const GET = withBearer(async (_req, ownerId) => {
  const body: LessonListResponse = { lessons: await listLessons(ownerId) };
  return json(body);
});
