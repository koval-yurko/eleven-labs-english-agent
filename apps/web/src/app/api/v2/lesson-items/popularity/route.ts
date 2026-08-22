import type { PopularityRequest, PopularityResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { bumpWordPopularity } from "../../../../../lib/lesson-items";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/lesson-items/popularity` — +1 one word, the collection's only per-word write.
 *
 * Replaces the `favorite` route it grew out of (0017). Two things changed with the flag:
 *
 * **It is keyed by the word id.** Its predecessor was keyed by `norm_key` — the odd one out among
 * this app's writes, inherited from a signature that predated the `words` table. Both callers hold
 * a real id now (the suggestion row carries `wordId`, the detail page IS an id), so this matches
 * `delete` beside it instead.
 *
 * **There is no amount and no direction.** The action means "I met this word again", which is worth
 * exactly one, and a body that could carry `-1` or `+1000` would be a hostile-input surface reachable
 * with a bearer token for no gain at all.
 *
 * The `owner_id` filter inside the RPC IS the ownership gate: an id the caller does not have updates
 * zero rows and reports `ok: false`. The new count rides back on the response so the client renders
 * the true total rather than a local increment that a concurrent bump has already overtaken.
 *
 * A direct route rather than an outbox op, deliberately, carrying the web's asymmetry across:
 * `/lesson-items` is online-only on both clients because `MirrorItem` is keyed on a `lesson_id` a
 * standalone word does not have (creation doc §5).
 */
export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<PopularityRequest> | null;
  if (!body || typeof body.id !== "string" || !body.id) {
    return apiError(400, "bad_request", "id is required.");
  }

  const popularity = await bumpWordPopularity(ownerId, body.id);

  const response: PopularityResponse = { ok: popularity !== null, popularity };
  return json(response);
});
