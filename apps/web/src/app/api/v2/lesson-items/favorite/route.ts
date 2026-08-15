import type { FavoriteRequest, FavoriteResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { setItemFavorite } from "../../../../../lib/lesson-items";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/lesson-items/favorite` — the collection's only per-word write.
 *
 * Keyed by **`norm_key`**, not by the word id. That is `setItemFavorite`'s existing signature, not a
 * choice made here: `norm_key` is the identity `owner_items` groups by, and it is what the row
 * exposes for the purpose. Worth stating because every other write in this app is id-keyed, so
 * sending an id here fails silently — it matches no row and reports `ok: false`.
 *
 * The `owner_id` filter IS the ownership gate: a key the caller does not have updates zero rows.
 * The 500-char clamp mirrors `setItemFavoriteAction`.
 *
 * A direct route rather than an outbox op, deliberately, carrying the web's asymmetry across:
 * `/lesson-items` is online-only on both clients because `MirrorItem` is keyed on a `lesson_id` a
 * standalone word does not have (creation doc §5).
 */
export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<FavoriteRequest> | null;
  if (!body || typeof body.normKey !== "string" || !body.normKey) {
    return apiError(400, "bad_request", "normKey is required.");
  }

  const ok = await setItemFavorite(ownerId, body.normKey.slice(0, 500), Boolean(body.isFavorite));

  const response: FavoriteResponse = { ok };
  return json(response);
});
