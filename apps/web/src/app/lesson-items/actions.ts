"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { getOwnerId } from "../../lib/auth/session";
import { bumpWordPopularity } from "../../lib/lesson-items";
import { LEVEL_AFTER_LIMIT, levelItems } from "../../lib/levels";
import { DETAILS_AFTER_LIMIT, enrichWords } from "../../lib/word-details";
import { addWord } from "../../lib/words";
import type { AddWordResult } from "@tutor/shared/word-types";

/**
 * +1 one word's popularity — the only mutation on `/lesson-items`, and the successor to the
 * favourite star (0017). Like every action here it re-derives the owner from the session and never
 * trusts the payload; the `owner_id` filter inside the RPC is what checks the word is the caller's.
 *
 * Returns the new count so the caller renders the true total rather than a local increment. Null
 * means no row matched — someone else's id, or a word already deleted.
 *
 * Online-only: this is not an outbox op, so the page (and this write) need a connection. See the
 * phase-2 note in docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export async function bumpItemPopularityAction(id: string): Promise<number | null> {
  const ownerId = await getOwnerId();
  if (!ownerId || typeof id !== "string" || !id) return null;

  const popularity = await bumpWordPopularity(ownerId, id);
  revalidatePath("/lesson-items");
  return popularity;
}

/**
 * Add one word to the collection, attached to no lesson.
 *
 * Online-only, deliberately, and a direct call rather than an outbox op:
 * `/lesson-items` is a server component with no IndexedDB read island, and `MirrorItem` is keyed on
 * a `lesson_id` that a standalone word does not have (IndexedDB cannot index null). Queuing this
 * offline would durably store an intent the page could not show. Phase 2 is a `words` store in the
 * mirror + an `addWords` op + a read island here — worth doing, and bigger than this feature. See
 * docs/2026-07-16-add-word-on-lesson-items-page.md.
 *
 * `already-present` is returned, not swallowed: `owner_items` groups by norm_key, so a duplicate add
 * changes nothing on screen and would read as a broken button.
 */
export async function addWordAction(text: string): Promise<AddWordResult> {
  const ownerId = await getOwnerId();
  if (!ownerId || typeof text !== "string") {
    return { status: "empty", id: null, text: "", popularity: null };
  }

  const result = await addWord(ownerId, text);

  if (result.status === "added") {
    revalidatePath("/lesson-items");
    // Same fast path as the lesson write (src/app/lessons/actions.ts): a level in seconds rather
    // than at the next `pnpm level:items` sweep. After the response, so a slow LLM call never
    // delays the add; swallowed, because the sweep is the backstop.
    after(async () => {
      try {
        await levelItems(ownerId, { limit: LEVEL_AFTER_LIMIT });
      } catch {
        // The sweep is the backstop.
      }
    });
    // The word-details job's fast path — same shape, its own sweep
    // (docs/2026-07-18-word-details-enrichment-job.md). Separate call from the level job: different
    // batch size and model, and one shouldn't fail the other.
    after(async () => {
      try {
        await enrichWords(ownerId, { limit: DETAILS_AFTER_LIMIT });
      } catch {
        // `pnpm enrich:words` is the backstop.
      }
    });
  }
  return result;
}
