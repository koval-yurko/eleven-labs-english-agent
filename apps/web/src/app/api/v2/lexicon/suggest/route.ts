import type { SuggestResponse } from "@tutor/shared/api";
import { SUGGEST_BUCKET_LIMIT, SUGGEST_LIMIT } from "@tutor/shared/api";

import { withBearer } from "../../../../../lib/auth/bearer";
import { json, preflight } from "../../../../../lib/http";
import { suggestWords } from "../../../../../lib/suggestions";

// The lexicon is static, but `owned` is per-learner and changes the moment a word is added.
export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/**
 * `GET /api/v2/lexicon/suggest?q=…&limit=…` — prefix suggestions for the add-word field.
 *
 * The first route to read `lexicon`, and the first whose data is NOT owner-scoped — but it is still
 * behind `withBearer`, and it has to be: `owned` is a join against the caller's own collection, so
 * the response does describe them. The dictionary half would be harmless to expose; the flag on it
 * is not.
 *
 * **`q` is passed through raw, deliberately.** Normalizing a prefix means `lesson_item_norm_key`
 * (unaccent + NFKC + case-fold), which only Postgres can compute — `CLAUDE.md` is explicit that
 * text → word identity never goes through a client-side or server-side guess, and doing it here
 * would be a second implementation of the key that the `owned` join depends on matching exactly.
 * The RPC does it, once. Escaping the LIKE metacharacters is likewise the RPC's job, next to the
 * pattern it builds, rather than something split across two files.
 *
 * A too-short, unparseable, or unmatched `q` all return `{ suggestions: [] }` and a 200. None of
 * them is an error: the client debounces through every one of those states on the way to a word,
 * and a 4xx would turn ordinary typing into a visible fault.
 */
export const GET = withBearer(async (req, ownerId) => {
  const params = new URL(req.url).searchParams;
  const prefix = params.get("q") ?? "";

  // A bad `limit` is clamped rather than rejected, and clamped AGAIN in the RPC — this is a
  // hostile-input surface reachable with a bearer token, and `Number("1e9")` is a finite number.
  //
  // The ceiling is `SUGGEST_BUCKET_LIMIT` (2,000), not a screenful, because a client fetches an
  // entire two-character bucket in one call and narrows it locally for every character after that
  // — one request per word instead of one per keystroke (§16). The worst case a token can pull
  // this way is the largest bucket, ~110 KB, which is less than the collection route already
  // returns.
  const raw = Number(params.get("limit"));
  const limit = Number.isFinite(raw)
    ? Math.min(Math.max(Math.trunc(raw), 1), SUGGEST_BUCKET_LIMIT)
    : SUGGEST_LIMIT;

  const body: SuggestResponse = { suggestions: await suggestWords(ownerId, prefix, limit) };
  return json(body);
});
