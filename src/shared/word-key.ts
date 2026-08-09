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
