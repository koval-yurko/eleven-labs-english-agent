import {
  API_V2_ROUTES,
  isAddWordResponse,
  isItemDetailResponse,
  isItemsResponse,
  itemPath,
  itemsPath,
  type AddWordRequest,
  type AddWordResponse,
  type DeleteWordRequest,
  type DeleteWordResponse,
  type PopularityRequest,
  type PopularityResponse,
  type ItemDetailResponse,
  type ItemsResponse,
} from "@tutor/shared/api";
import type { ItemsQuery } from "@tutor/shared/items-query";
import type { ItemDetail } from "@tutor/shared/word-types";

import { apiFetch, type TokenSource } from "@/api";

/**
 * Reading and writing the collection over `/api/v2/lesson-items`.
 *
 * Its own module rather than an extension of `src/lib/lessons.ts`: it is a different domain with a
 * different write path. **These writes do not go through the outbox** — add-word and popularity are
 * direct routes, because `MirrorItem` is keyed on a `lesson_id` a standalone word does not have, so
 * queueing them would durably store an intent no screen could render. That asymmetry exists on the
 * web too and is carried over deliberately (creation doc §5 / S6 D62).
 */

/**
 * The collection for one query, plus the category facets.
 *
 * `itemsPath` runs `serializeItemsQuery` — the same encoder the web URL uses, and the only one that
 * may exist. The server decodes it with `parseItemsQuery`; `pnpm check:shared` proves the two are
 * inverse over 10,752 cases, which is the whole reason phone and web can be trusted to agree.
 *
 * The search term is NOT sent. `?q=` is not part of `ItemsQuery`: the filtered list is small (70
 * items when measured) so `searchItems` filters it in memory, and a round trip per keystroke would
 * be the wrong interaction.
 */
export async function fetchItems(
  getToken: TokenSource,
  query: ItemsQuery,
): Promise<ItemsResponse> {
  const body = await apiFetch<unknown>(itemsPath(query), getToken);
  if (!isItemsResponse(body)) throw new Error("Malformed items response.");
  return body;
}

export async function fetchItem(getToken: TokenSource, id: string): Promise<ItemDetail> {
  const body = await apiFetch<unknown>(itemPath(id), getToken);
  if (!isItemDetailResponse(body)) throw new Error("Malformed word response.");
  return (body as ItemDetailResponse).item;
}

/**
 * Add one word straight to the collection, in no lesson.
 *
 * Returns the full result rather than a boolean because `already-present` is an ANSWER: the
 * collection groups by `norm_key`, so adding a duplicate changes nothing on screen and reads as a
 * broken button unless the UI says so.
 */
export async function addWord(getToken: TokenSource, text: string): Promise<AddWordResponse> {
  const body = await apiFetch<unknown>(API_V2_ROUTES.items, getToken, {
    method: "POST",
    body: JSON.stringify({ text } satisfies AddWordRequest),
  });
  if (!isAddWordResponse(body)) throw new Error("Malformed add-word response.");
  return body;
}

/**
 * +1 one word's popularity, returning the NEW count — "I met this word again".
 *
 * Keyed by the word **id**, like `deleteWord` below. Its predecessor (`setFavorite`) was keyed by
 * `norm_key` and this module carried a warning about it being the odd one out; that asymmetry is
 * gone rather than ported.
 *
 * The count comes from the server rather than being incremented locally. A counter is not a toggle:
 * an optimistic +1 that lost a race would show a number that was never true, and there would be
 * nothing to revert it to.
 */
export async function bumpPopularity(getToken: TokenSource, id: string): Promise<number> {
  const body = await apiFetch<PopularityResponse>(API_V2_ROUTES.itemPopularity, getToken, {
    method: "POST",
    body: JSON.stringify({ id } satisfies PopularityRequest),
  });
  // `ok: false` means no row matched — someone else's id, or a word already deleted.
  if (!body.ok || body.popularity === null) throw new Error("That word could not be updated.");
  return body.popularity;
}

/**
 * Delete one word for good.
 *
 * Keyed by **id**, like `bumpPopularity` above.
 *
 * ⚠️ This is not the lesson’s `removeItem`. That detaches a word and keeps everything;
 * this destroys the word, its membership in every lesson, and the practice statistics derived from
 * those links. The caller must have confirmed it — see
 * docs/2026-08-18-collection-and-lessons-list-fixes.md §4.
 */
export async function deleteWord(getToken: TokenSource, id: string): Promise<void> {
  const body = await apiFetch<DeleteWordResponse>(API_V2_ROUTES.itemDelete, getToken, {
    method: "POST",
    body: JSON.stringify({ id } satisfies DeleteWordRequest),
  });
  // `ok: false` means no row matched — someone else’s id, or one already deleted. Surfaced
  // rather than swallowed: the row is still on screen, so a silent success would be a lie.
  if (!body.ok) throw new Error("That word could not be deleted.");
}
