"use server";

import { revalidatePath } from "next/cache";
import { getOwnerId } from "../../lib/auth/session";
import { setItemFavorite } from "../../lib/lesson-items";

/**
 * Mark/unmark one item as a favorite — the only mutation on `/lesson-items`. Like every action
 * here, it re-derives the owner from the session and never trusts the payload; `setItemFavorite`
 * additionally checks the key belongs to an item the caller actually has.
 *
 * Online-only for now: favoriting is not an outbox op, so the page (and this write) need a
 * connection. See the phase-2 note in
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export async function setItemFavoriteAction(normKey: string, isFavorite: boolean): Promise<void> {
  const ownerId = await getOwnerId();
  if (!ownerId || typeof normKey !== "string" || !normKey) return;

  await setItemFavorite(ownerId, normKey.slice(0, 500), Boolean(isFavorite));
  revalidatePath("/lesson-items");
}
