import type { ItemDetailResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { getItem } from "../../../../../lib/lesson-items";

// Owner-scoped read of live data; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lesson-items/:id` — one word, with the enrichment payload the detail screen renders.
 *
 * `getItem` keeps its two-query shape: the `owner_items` row, then a narrow read of
 * `words.details` / `details_at`. That split is deliberate and predates this route — the list does
 * `select *` from the view, and a fat jsonb blob per row has no business in a payload the list
 * neither needs nor renders (docs/2026-07-18-word-details-enrichment-job.md).
 *
 * `details` is nullable forever, and `details_at` is the ATTEMPTED flag, so the client has three
 * states to render and only one of them is "loading". See S6 §6.3.
 *
 * `popularity` is a LITERAL sibling of this dynamic segment and Next matches literals first, so
 * `/lesson-items/popularity` never resolves to a word whose id happens to be "popularity" — which uuids
 * make unreachable anyway. Same non-collision as `/lessons/session`.
 */
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, ownerId, ctx) => {
  const { id } = await ctx.params;

  // `getItem` filters on owner_id, so one null covers "no such word" and "not yours" — answering
  // them differently would leak which ids exist. 404 rather than 401 for the same reason as every
  // other v2 route: the caller is authenticated, so a 401 would bounce a signed-in phone to login.
  const item = await getItem(ownerId, id);
  if (!item) return apiError(404, "not_found", "No such word.");

  const body: ItemDetailResponse = { item };
  return json(body);
});
