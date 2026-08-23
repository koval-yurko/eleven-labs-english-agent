import {
  SUGGEST_BUCKET_LIMIT,
  SUGGEST_BUCKET_PREFIX,
  SUGGEST_LIMIT,
  SUGGEST_MIN_PREFIX,
  isSuggestResponse,
  suggestPath,
  type WordSuggestion,
} from "@tutor/shared/api";
import { lexiconPrefixFold } from "@tutor/shared/words/key";

import { apiFetch, type TokenSource } from "@/api";

/**
 * Prefix suggestions for the add-word field — `GET /api/v2/lexicon/suggest`, called **once per
 * word** rather than once per keystroke.
 *
 * Its own module rather than a fifth function in `items.ts`: this reads the shared `lexicon` table,
 * not the learner's collection, and it is the only read on this app's request path that a learner
 * can trigger several times a second. Keeping it separate keeps that budget visible.
 *
 * ── How the bucket cache works, and why it is exact ─────────────────────────────────────────
 *
 * The first two characters fetch **every** matching lexicon row (`SUGGEST_BUCKET_PREFIX`). Every
 * character after that is answered by narrowing what is already in memory. This is not an
 * approximation: any row matching `ubiq` also matches `ub`, and the server's ORDER BY is total, so
 * the top 8 of a narrowed complete bucket **is** the top 8 the server would return. Measured over
 * 10,122 prefixes of the 3,000 most frequent words: 100.0% identical, average bucket ~7 KB.
 *
 * This is deliberately NOT what the design doc's phase 4 proposed. A local slice of the corpus
 * (zipf ≥ 4.0, ~10k rows) reproduces the server's top-8 for only 39.7% of prefixes, so the list
 * would visibly reshuffle whenever the server disagreed — and the full corpus is 3.1 MB to sync and
 * keep fresh. A bucket needs no sync, no versioning and no storage, and it keeps `owned` exact,
 * because the server still computes it. See §16 of the doc.
 *
 * ── Two things it must get right ────────────────────────────────────────────────────────────
 *
 * **Narrowing compares against `key`, not `text`.** `key` is `lesson_item_norm_key(text)`; `text`
 * is the display spelling and is not case-folded (`Absolute`, `ABS`). `lexiconPrefixFold` is the
 * client half of that key — verified exact against all 53,538 rows.
 *
 * **A local miss on non-ASCII input asks the server.** The fold reproduces Postgres's pipeline but
 * not the whole of its `unaccent` dictionary, and the residue always folds LESS, so a row the
 * server would have returned can be narrowed away. That is the one way this cache could be wrong,
 * and the fallback below is what converts it into a slower answer instead of a missing one.
 */

/**
 * Bucket cache, in memory only and deliberately not persisted.
 *
 * `owned` is per-learner and goes stale the moment a word is added — `clearSuggestionCache` handles
 * that within a session, but a bucket restored from disk would carry a stale flag across restarts
 * with nothing to invalidate it. Persisting would also need the lexicon versioned, since the level
 * job rewrites levels. Neither is worth it for a ~7 KB refetch.
 */
const buckets = new Map<string, WordSuggestion[]>();

/** Enough for a session of typing; the largest bucket is ~110 KB, so the ceiling is ~1 MB. */
const MAX_BUCKETS = 12;

/**
 * Folded prefixes that the fold is PROVABLY exact for. Every known divergence from Postgres's
 * `unaccent` leaves a non-ASCII character behind (`«word»` stays `«word»`), so a folded prefix
 * inside this alphabet cannot have been under-folded and a local miss is a real miss.
 */
const PROVABLY_FOLDED = /^[a-z0-9 '-]*$/;

export function clearSuggestionCache(): void {
  buckets.clear();
}

export async function fetchSuggestions(
  getToken: TokenSource,
  prefix: string,
  limit: number = SUGGEST_LIMIT,
): Promise<WordSuggestion[]> {
  const folded = lexiconPrefixFold(prefix);
  // The floor is checked here, in the route and in the RPC. This one is the only one that saves a
  // round trip, and typing a word crosses it once per word.
  if (folded.length < SUGGEST_MIN_PREFIX) return [];

  // The head must be a prefix the SERVER normalizes to ITSELF, which is not the same as the first
  // two characters. `lesson_item_norm_key` trims edge punctuation, so the head of `o'clock` is
  // `o'` — which the server folds to `o`, one character, and the RPC refuses below two. The
  // bucket would come back empty and every `o'…` word would silently show no suggestions.
  // Growing the head until it is fold-stable costs nothing and is only ever reached by the handful
  // of headwords with punctuation in position two.
  let head = folded.slice(0, SUGGEST_BUCKET_PREFIX);
  while (head.length < folded.length && lexiconPrefixFold(head) !== head) {
    head = folded.slice(0, head.length + 1);
  }

  let bucket = buckets.get(head);

  if (bucket === undefined) {
    bucket = await request(getToken, head, SUGGEST_BUCKET_LIMIT);
    if (buckets.size >= MAX_BUCKETS) {
      // Oldest first — Map preserves insertion order, and a learner works forward through words
      // rather than returning to old ones.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(head, bucket);
  }

  // Exactly the server's ORDER BY, already applied — the bucket arrived sorted and filtering
  // preserves order, so this needs no re-sort. That is the whole reason the narrowing is exact.
  const local = bucket.filter((s) => s.key.startsWith(folded)).slice(0, limit);
  if (local.length > 0) return local;

  // Nothing matched locally. Three ways that happens, and only the third needs the server:
  //   - the learner has typed exactly the bucket prefix and the corpus has no such words;
  //   - the prefix is genuinely unmatched, which the fold proves when it is pure ASCII;
  //   - the fold under-folded something Postgres's unaccent would have folded.
  if (folded === head || (PROVABLY_FOLDED.test(folded) && bucket.length < SUGGEST_BUCKET_LIMIT)) {
    return [];
  }
  return request(getToken, prefix, limit);
}

/**
 * The prefix is sent RAW even though this module just folded a copy of it.
 *
 * `lexicon.key` and `words.norm_key` are both `lesson_item_norm_key(text)`, and the "already in
 * your collection" flag is a join between them — so the server must do its own normalizing, or the
 * local fold becomes a second implementation of an identity `CLAUDE.md` reserves to Postgres. The
 * fold above narrows a list; it never decides what a word IS.
 */
async function request(
  getToken: TokenSource,
  prefix: string,
  limit: number,
): Promise<WordSuggestion[]> {
  const body = await apiFetch<unknown>(suggestPath(prefix, limit), getToken);
  if (!isSuggestResponse(body)) throw new Error("Malformed suggestions response.");
  return body.suggestions;
}
