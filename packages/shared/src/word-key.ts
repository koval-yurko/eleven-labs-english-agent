/**
 * How a typed string becomes a word — the ONE place any client normalizes vocabulary text.
 *
 * There are three normalizations of this concept in the system, and only one of them is the
 * identity:
 *
 *   1. `wordInputKey()`      — trim + cap. The exact string `resolveWords` keys its result map by,
 *                              so a caller can look up what it sent. NOT an identity.
 *   2. `clientDedupeKey()`   — best-effort, for optimistic UI only (below). NOT an identity.
 *   3. Postgres `norm_key`   — THE identity. `lesson_item_norm_key(raw)` in migration 0004:
 *                              NFKC → smart-punctuation→ASCII → unaccent → lower → collapse
 *                              whitespace → trim edge punctuation, with `lower(btrim(text))` as
 *                              the fallback when that yields NULL.
 *
 * The browser cannot compute (3) — it needs `unaccent` and Postgres's exact punctuation table —
 * which is why text → word id always goes through the `resolve_words` RPC and never a client-side
 * guess (docs/2026-07-16-add-word-on-lesson-items-page.md).
 *
 * THE INVARIANT that makes (2) safe, and the rule any future change to it must satisfy:
 *
 *     clientDedupeKey(a) === clientDedupeKey(b)
 *         ⟹  norm_key(wordInputKey(a)) === norm_key(wordInputKey(b))
 *
 * Note `norm_key` is applied to the CAPPED text, not the raw text: `resolveWords` sends
 * `texts.map(wordInputKey)` to the RPC, so Postgres never sees anything past MAX_WORD_LENGTH.
 * That is also why `clientDedupeKey` is built on `wordInputKey` — without the cap, two strings
 * differing only past character 500 would be one word on the server and two in the mirror.
 *
 * The direction matters: the client may only ever merge LESS aggressively than Postgres, never
 * more. Merging less is harmless — the server's `linked` guard in `linkWords` skips the duplicate
 * and the mirror self-corrects on the next `seedLessonItems`. Merging MORE would silently drop a
 * word the learner typed, which is not recoverable. `toLowerCase` + trim is strictly weaker than
 * the Postgres pipeline (which also lowercases and trims), so the invariant holds.
 *
 * Verified against the live `lesson_item_norm_key` on 2026-08-09 over 528 pairs of adversarial
 * samples (smart quotes, accents, edge punctuation, ligatures, whitespace runs, the 500-char
 * boundary): 0 violations, and 17 cases in the intended safe direction — Postgres merges
 * "Don't"/"don’t" and "café"/"cafe", the client does not.
 *
 * Because of that asymmetry the server-side `linked` set in `lib/lessons.ts::linkWords` is
 * LOAD-BEARING, not belt-and-braces: "Don't" and "dont" survive this key as two distinct texts
 * and resolve to one word, and a second live link for one (lesson_id, word_id) is rejected by
 * `lesson_items_lesson_word_active_idx` — taking the whole batch with it. Do not remove it on the
 * grounds that "the client already deduped".
 *
 * PURE. See docs/2026-08-09-shareable-core-refactor.md (R3).
 */

/** Long enough for any sentence a learner would practice; a bound, not a feature. */
export const MAX_WORD_LENGTH = 500;

/**
 * The exact string `resolveWords` keys its result by: trim + cap, matching what the RPC echoes.
 * This is what gets SENT to the server, so every path that submits text should agree on it.
 */
export function wordInputKey(raw: string): string {
  return raw.trim().slice(0, MAX_WORD_LENGTH);
}

/**
 * Best-effort "are these the same word?" for OPTIMISTIC UI ONLY — deduping a batch the learner
 * just typed before it reaches the server. Never use it to decide what to store, what to delete,
 * or whether a word already exists: Postgres owns that answer (see the header).
 *
 * Built on `wordInputKey` so it compares the same capped text the server will actually receive.
 */
export function clientDedupeKey(raw: string): string {
  return wordInputKey(raw).toLowerCase();
}

/**
 * The Postgres `lesson_item_norm_key` pipeline, reimplemented in JS — the ONE exception to the rule
 * above, and it earns it by being an optimisation that fails safe rather than an identity.
 *
 * **What it is for.** The add-word suggestion cache fetches every lexicon row for the learner's
 * first two characters in one request, then narrows that bucket locally as they keep typing (§16).
 * Narrowing means comparing the typed prefix against `lexicon.key`, which is
 * `lesson_item_norm_key(text)` — so the client has to produce the same string, or `café` and the
 * iOS-smart-quoted `don’t` silently match nothing.
 *
 * **Why this does not contradict the header.** `clientDedupeKey` may merge LESS than Postgres and
 * stay safe because merging less only leaves a duplicate for the server to skip. Here the
 * asymmetry runs the other way — folding less means a row the server WOULD have returned is
 * filtered out, which is visible. So this one tries to be exact, and the caller treats an empty
 * local result as "ask the server" rather than as "no matches". That fallback is what makes an
 * inexact fold a latency cost instead of a wrong answer, and it is not optional.
 *
 * Steps, in the order migration 0004 applies them: NFKC → smart punctuation → ASCII → unaccent →
 * lower → collapse whitespace → trim edge punctuation. `unaccent` is Postgres's own table; NFD plus
 * dropping combining marks is equivalent for the Latin script these headwords are written in.
 *
 * Verified against the live `lexicon` table over all 53,538 rows — see §16 of
 * docs/2026-08-15-word-autocomplete-suggestions.md.
 */
const SMART_PUNCTUATION: Record<string, string> = {
  "’": "'",
  "‘": "'",
  ʼ: "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "\u00A0": " ",
  // Past migration 0004's translate table, these come from Postgres's `unaccent` dictionary,
  // which the decomposition step below cannot reproduce — `ß` and the dash family have no
  // combining-mark form. Only what a phone keyboard plausibly emits is here; `«»` and the rest
  // of unaccent's table are left to the caller's server fallback, which is what it is for.
  "‐": "-",
  "‑": "-",
  "‒": "-",
  "−": "-",
  ß: "ss",
};

/** `btrim(…, ' .,;:!?"''`()[]{}…-')` — edges only; internal apostrophes and hyphens survive. */
const EDGE_PUNCTUATION = " .,;:!?\"'`()[]{}…-";

export function lexiconPrefixFold(raw: string): string {
  let s = raw.normalize("NFKC");
  s = s.replace(
    /[\u2019\u2018\u02BC\u201C\u201D\u2013\u2014\u00A0\u2010\u2011\u2012\u2212\u00DF]/g,
    (ch) => SMART_PUNCTUATION[ch] ?? ch,
  );
  // unaccent: decompose, drop the combining marks, recompose. café → cafe, вездесу́щий → вездесущий.
  s = s
    .normalize("NFD")
    .replace(/[\u0300-\u036F]/g, "")
    .normalize("NFC");
  s = s.toLowerCase();
  s = s.replace(/\s+/g, " ");

  let start = 0;
  let end = s.length;
  while (start < end && EDGE_PUNCTUATION.includes(s[start]!)) start++;
  while (end > start && EDGE_PUNCTUATION.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}
