import type { DeleteWordRequest, DeleteWordResponse } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../../lib/http";
import { deleteWord } from "../../../../../lib/words";

// Owner-scoped write; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `POST /api/v2/lesson-items/delete` — remove one word from the collection for good.
 *
 * **POST rather than `DELETE /lesson-items/:id`**, and not out of taste: this namespace advertises
 * `access-control-allow-methods: GET,POST,OPTIONS` (`lib/http.ts`). A DELETE verb would work on the
 * phone — a React Native `fetch` sends no `Origin` and preflights nothing — and fail the preflight
 * under `expo start --web`, which is a real surface and the reason that CORS block exists at all.
 * The path is a literal sibling of the `[id]` dynamic segment, and Next matches literals first, so
 * it never resolves to a word whose id happens to be `"delete"` — the same non-collision `popularity`
 * and `/lessons/session` already rely on.
 *
 * **A direct route, not an outbox op**, carrying the collection's asymmetry across exactly as
 * add-word and popularity do: `MirrorItem` is keyed on a `lesson_id` a standalone word does not have,
 * so queueing this would durably store an intent no screen could render (creation doc §5 / S6 D62).
 *
 * `ok: false` is an ANSWER, not an error — an id that is not the caller's and an id already deleted
 * report the same thing, which is what keeps a retry safe and keeps the response from leaking which
 * ids exist. `deleteWord` filters on `owner_id`, so that gate is in the query.
 *
 * No `scheduleWordJobs` twin here: a delete creates no work for the level or enrichment jobs. Their
 * queues are `where level_at is null` / `where details_at is null` over `words`, and the row is
 * gone.
 */
export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<DeleteWordRequest> | null;
  if (!body || typeof body.id !== "string" || !body.id) {
    return apiError(400, "bad_request", "id is required.");
  }

  const ok = await deleteWord(ownerId, body.id);

  const response: DeleteWordResponse = { ok };
  return json(response);
});
