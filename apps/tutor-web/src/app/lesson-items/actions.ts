"use server";

import { revalidatePath } from "next/cache";
import {
  API_V2_ROUTES,
  type AddWordRequest,
  type AddWordResponse,
  type PopularityRequest,
  type PopularityResponse,
} from "@tutor/shared/api";
import type { AddWordResult } from "@tutor/shared/words/types";

import { apiFetch } from "../../lib/api";
import { getOwnerId } from "../../lib/auth/session";

/**
 * +1 one word's popularity — the only mutation on `/lesson-items`, and the successor to the
 * favourite star (0017). The owner is the API's to establish, from the access token `apiFetch`
 * sends; the payload is never trusted for it.
 *
 * Returns the new count so the caller renders the true total rather than a local increment. Null
 * means no row matched — someone else's id, or a word already deleted.
 *
 * Online-only: this is not an outbox op, so the page (and this write) need a connection. See the
 * phase-2 note in docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export async function bumpItemPopularityAction(id: string): Promise<number | null> {
  if (!(await getOwnerId()) || typeof id !== "string" || !id) return null;

  const body: PopularityRequest = { id };
  const { popularity } = await apiFetch<PopularityResponse>(API_V2_ROUTES.itemPopularity, {
    method: "POST",
    json: body,
  });
  revalidatePath("/lesson-items");
  return popularity;
}

/**
 * Add one word to the collection, attached to no lesson.
 *
 * Online-only, deliberately, and a direct call rather than an outbox op:
 * `/lesson-items` is a server component with no IndexedDB read island, and `MirrorItem` is keyed on
 * a `lesson_id` that a standalone word does not have (IndexedDB cannot index null). Queuing this
 * offline would durably store an intent the page could not show. See
 * docs/2026-07-16-add-word-on-lesson-items-page.md.
 *
 * `already-present` is returned, not swallowed: `owner_items` groups by norm_key, so a duplicate add
 * changes nothing on screen and would read as a broken button.
 *
 * The level + enrichment fast paths are no longer scheduled here: the API's
 * `POST /api/v2/lesson-items` runs them (`scheduleWordJobs`) after it answers, the same as for the
 * phone and the MCP tool.
 */
export async function addWordAction(text: string): Promise<AddWordResult> {
  if (!(await getOwnerId()) || typeof text !== "string") {
    return { status: "empty", id: null, text: "", popularity: null };
  }

  const body: AddWordRequest = { text };
  const result = await apiFetch<AddWordResponse>(API_V2_ROUTES.items, { method: "POST", json: body });
  if (result.status === "added") revalidatePath("/lesson-items");
  return result;
}
