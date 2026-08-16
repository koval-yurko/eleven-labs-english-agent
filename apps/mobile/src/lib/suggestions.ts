import {
  SUGGEST_LIMIT,
  SUGGEST_MIN_PREFIX,
  isSuggestResponse,
  suggestPath,
  type WordSuggestion,
} from "@tutor/shared/api";

import { apiFetch, type TokenSource } from "@/api";

/**
 * Prefix suggestions for the add-word field — `GET /api/v2/lexicon/suggest`.
 *
 * Its own module rather than a fifth function in `items.ts`: this reads the shared `lexicon` table,
 * not the learner's collection, and it is the only read on this app's request path that fires
 * per-keystroke. Keeping it separate keeps that budget visible.
 *
 * **The prefix is sent raw.** No trimming, no lower-casing, no accent folding. `lexicon.key` and
 * `words.norm_key` are both `lesson_item_norm_key(text)`, and the "already in your collection" flag
 * is a join between them — so normalizing here would be a second implementation of a key that only
 * Postgres can compute, which is the guess `CLAUDE.md` forbids. `Ubiqu` and `café` work because the
 * server folds them, not because we did.
 */
export async function fetchSuggestions(
  getToken: TokenSource,
  prefix: string,
  limit: number = SUGGEST_LIMIT,
): Promise<WordSuggestion[]> {
  // The floor is checked in three places on purpose — here, in the route, and in the RPC. This one
  // is the only one that saves a round trip, and typing a word crosses it once per word.
  if (prefix.trim().length < SUGGEST_MIN_PREFIX) return [];

  const body = await apiFetch<unknown>(suggestPath(prefix, limit), getToken);
  if (!isSuggestResponse(body)) throw new Error("Malformed suggestions response.");
  return body.suggestions;
}
