import type { AddWordRequest, AddWordResponse, ItemsResponse } from "@tutor/shared/api";
import { parseItemsQuery, searchParamsToBag } from "@tutor/shared/words/query";

import { withBearer } from "../../../../lib/auth/bearer";
import { apiError, json, preflight } from "../../../../lib/http";
import { listItemFacets, listItems } from "../../../../lib/lesson-items";
import { scheduleWordJobs } from "../../../../lib/sync-flush";
import { addWord } from "../../../../lib/words";

// Owner-scoped read/write of live data; never cached.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lesson-items?…` — the collection, filtered and sorted.
 *
 * **The first v2 route with a query string**, and the parse is a security boundary rather than a
 * convenience. `listItems` interpolates the sort key into an `.order()` and each level into an
 * `.or()` clause, so `isValidLevel` / `isValidSort` / `isValidKind` inside `parseItemsQuery` are
 * what stop an arbitrary string reaching PostgREST. Reading `searchParams.get("sort")` here directly
 * would be an injection in the one place the whitelist is already written.
 *
 * `searchParamsToBag` is the conversion `parseItemsQuery` needs (a repeated `?level=` becomes an
 * array). It lives in `items-query.ts` beside the parser — it used to exist only inside `check.ts`,
 * where nothing outside a test could reach it. See docs/2026-08-13-expo-s6-collection.md D55.
 *
 * Facets ride along rather than getting their own route: they were measured at ZERO rows, so a
 * second round trip would fetch an empty array (S6 §3). Free-text search is deliberately absent —
 * `?q=` is not part of `ItemsQuery` and is applied by the client, in memory.
 */
export const GET = withBearer(async (req, ownerId) => {
  const query = parseItemsQuery(searchParamsToBag(new URL(req.url).searchParams));

  const [items, facets] = await Promise.all([
    listItems(ownerId, query),
    listItemFacets(ownerId),
  ]);

  const body: ItemsResponse = { items, facets };
  return json(body);
});

/**
 * `POST /api/v2/lesson-items` — add one word to the collection, attached to no lesson.
 *
 * The native twin of `addWordAction`, and the same thin caller of `addWord`. Two things must match
 * that action rather than being reinvented:
 *
 * - **`already-present` is returned, not swallowed.** The collection groups by `norm_key`, so a
 *   duplicate add changes nothing on screen and reads as a broken button unless the client says so.
 * - **`scheduleWordJobs` on a real add.** Without it a word added from the phone has no CEFR level
 *   and no `details` until the next `pnpm level:items` / `pnpm enrich:words` sweep — and nothing
 *   about that is visible at the time. It is the same failure S5's T8 guards on the lesson path,
 *   in a second place (S6 §5.3).
 *
 * No `revalidatePath`: that is the web caller's Next-cache concern, and the native client refetches.
 */
export const POST = withBearer(async (req, ownerId) => {
  const body = (await req.json().catch(() => null)) as Partial<AddWordRequest> | null;
  if (!body || typeof body.text !== "string") {
    return apiError(400, "bad_request", "text is required.");
  }

  const result = await addWord(ownerId, body.text);
  if (result.status === "added") scheduleWordJobs(ownerId);

  const response: AddWordResponse = result;
  return json(response);
});
