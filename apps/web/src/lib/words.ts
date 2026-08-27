/**
 * SERVER-ONLY data access for `words` — the vocabulary collection itself, independent of any
 * lesson. See docs/2026-07-16-add-word-on-lesson-items-page.md.
 *
 * Same rules as the rest of the data layer: the service-role client, `owner_id` filtered/stamped
 * explicitly in code, RLS as defense-in-depth.
 *
 * A word's identity is its `norm_key`, which only Postgres can compute (unaccent + NFKC), so text →
 * word id resolution goes through the `resolve_words` RPC rather than being guessed here. That is
 * also what makes the offline path converge: the natural key is stable across devices, where a
 * client-minted uuid is stable only within one.
 */
import { getServiceSupabase } from "./supabase/server";
import { bumpWordPopularity, ownedOrUnowned } from "./lesson-items";
import { clientDedupeKey, wordInputKey } from "@tutor/shared/words/key";
import type { AddWordResult } from "@tutor/shared/words/types";

export interface ResolvedWord {
  id: string;
  /** False when the word was already in the collection — the row was updated, not inserted. */
  created: boolean;
}

type ResolveRow = { input_text: string; word_id: string; was_created: boolean };

/**
 * Upsert each text into the collection and hand back its word id, keyed by the TRIMMED input text
 * (the same key the caller can compute from what it sent).
 *
 * Re-adding an existing word refreshes its spelling — the "most recently typed form wins" rule that
 * `owner_items` used to apply with `array_agg(text order by created_at desc)`, now applied at write
 * time because there is finally a row to hold it.
 *
 * Note two inputs can collapse onto ONE word ("Don't" / "dont"), so the map may be smaller than the
 * input; callers that link words to a lesson must dedupe by id, not by text.
 */
export async function resolveWords(
  ownerId: string | null,
  texts: string[],
): Promise<Map<string, ResolvedWord>> {
  const clean = texts.map(wordInputKey).filter((t) => t.length > 0);
  if (clean.length === 0) return new Map();

  const { data, error } = await getServiceSupabase().rpc("resolve_words", {
    p_owner_id: ownerId,
    p_texts: clean,
  });
  if (error) throw new Error(`resolveWords: ${error.message}`);

  const out = new Map<string, ResolvedWord>();
  for (const row of (data as ResolveRow[] | null) ?? []) {
    out.set(row.input_text, { id: row.word_id, created: row.was_created });
  }
  return out;
}

/**
 * Add one word to the collection, attached to no lesson. The direct-add path behind `/lesson-items`.
 *
 * `already-present` is a real answer, not an error: `owner_items` groups by norm_key, so a duplicate
 * add would render as nothing happening at all. The caller is expected to say so.
 *
 * **A duplicate add BUMPS the word's popularity** (0017), and returns the new count so the caller has
 * something true to report — "already in your collection · 4" rather than a button that appears to do
 * nothing. Typing a word you already have is the same statement as picking it out of the suggestions:
 * *I met this again*.
 *
 * That makes this the FALLBACK path rather than the common one. A learner who reaches for a word the
 * autocomplete knows taps it in the dropdown, which bumps it and opens the word directly; this branch
 * is what serves everything the dictionary does not have — phrases, whole sentences, and words
 * outside the 53k lexicon — which is exactly why it has to do the same thing.
 *
 * A freshly created word reports `popularity: 0`: it has been met once, which is what adding it
 * already says, and starting the count at 1 would make "added" and "added then met again" the same
 * number.
 *
 * Text that normalizes to nothing (punctuation only) still gets a row — `words_set_norm_key` falls
 * back to `lower(btrim(text))`, matching what lesson_items did.
 */
export async function addWord(ownerId: string, rawText: string): Promise<AddWordResult> {
  const text = wordInputKey(rawText);
  if (!text) return { status: "empty", id: null, text: "", popularity: null };

  const resolved = await resolveWords(ownerId, [text]);
  const word = resolved.get(text);
  if (!word) return { status: "empty", id: null, text, popularity: null };

  if (word.created) return { status: "added", id: word.id, text, popularity: 0 };

  // The bump is the whole difference between this branch and a no-op. It must not be able to fail
  // the add, though: the word IS in the collection either way, and reporting an error for a counter
  // would turn a correct answer into a broken one.
  const popularity = await bumpWordPopularity(ownerId, word.id).catch(() => null);
  return { status: "already-present", id: word.id, text, popularity };
}

/**
 * Delete one word outright — the only destructive write in the collection.
 *
 * The `owner_id` filter IS the ownership gate, as everywhere else in this layer: an id that is not
 * the caller's matches zero rows and reports `false`. So does a second delete of the same id, which
 * makes this idempotent — the same "I did nothing" answer, reported rather than thrown.
 *
 * ⚠️ **This destroys the word's practice history**, and that is not a side effect to be tidied away
 * later. The `lesson_items` rows go with it by the FK cascade `0007` declared for exactly this
 * purpose — including the soft-removed ones — and `owner_item_practice` is a view over those links,
 * so `practice_count` and `last_practiced_at` are derived and vanish with them. `lesson_sessions`
 * (the transcripts) are keyed on `lesson_id` and survive untouched. The UI is obliged to say so
 * before it calls this; see docs/2026-08-18-collection-and-lessons-list-fixes.md §4.2.
 *
 * Hard, not soft, unlike `deleteLesson`. The reasoning is in `0014_delete_word.sql`, and the short
 * version is that a soft-deleted row would still win `unique (owner_id, norm_key)` in
 * `resolve_words` — so re-adding the word would silently do nothing.
 */
export async function deleteWord(ownerId: string, wordId: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("words")
    .delete()
    // Unowned words are deletable too, and that is not a widening of the gate by accident. The
    // whole mitigation for a model talked into calling `add_words_to_collection` is "junk
    // vocabulary, cleaned up with the existing delete" — an anonymous word the UI shows but cannot
    // remove would turn a recoverable annoyance into a permanent one.
    .or(ownedOrUnowned(ownerId))
    .eq("id", wordId)
    .select("id");
  if (error) throw new Error(`deleteWord: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length > 0;
}

export interface AddWordsResult {
  added: { id: string; text: string }[];
  alreadyPresent: { id: string; text: string; popularity: number | null }[];
  /** Normalized to nothing, or a duplicate of an earlier entry in the SAME call. */
  skipped: string[];
}

/**
 * Add many words in one pass — the batch twin of `addWord`, written for the MCP tool
 * (docs/2026-08-23-mcp-server-add-words.md §2.1).
 *
 * Not a loop over `addWord`: that is 2N round trips where `resolve_words` already takes an array.
 * This is one RPC plus one bump per duplicate.
 *
 * Three things it has to get right, all of which the singular path gets right for free:
 *
 * 1. **Dedupe the input BEFORE the RPC.** `resolve_words` upserts each element of the array in
 *    turn, so `["Ubiquitous.", "ubiquitous."]` comes back as two rows for one word and the second
 *    reports `was_created = false` — the caller would announce "already in your collection" for a
 *    word it created a millisecond earlier. `clientDedupeKey` is deliberately WEAKER than the
 *    Postgres identity, and that is the safe direction: merging less leaves a duplicate for the
 *    server to collapse, merging more would silently drop a word the learner typed.
 * 2. **Two surviving inputs can still collapse onto one word id** — "Don't" and "dont" differ under
 *    `clientDedupeKey` but not under `norm_key`, which is exactly what `resolveWords`' own doc
 *    comment warns about. Group the result by id, not by text, and count the group as added if ANY
 *    of its rows created the row.
 * 3. **A bump must not be able to fail the add.** Same reason as `addWord`: the word is in the
 *    collection either way, and reporting an error for a counter turns a correct answer into a
 *    broken one.
 *
 * `scheduleWordJobs` is deliberately NOT called here — it belongs to the request path, the way it
 * does for `addWord`'s callers, so this stays a pure data function.
 */
export async function addWords(
  ownerId: string | null,
  rawTexts: string[],
): Promise<AddWordsResult> {
  const skipped: string[] = [];
  const texts: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTexts) {
    const text = wordInputKey(raw);
    if (!text) {
      skipped.push(raw);
      continue;
    }
    const key = clientDedupeKey(raw);
    if (seen.has(key)) {
      skipped.push(raw);
      continue;
    }
    seen.add(key);
    texts.push(text);
  }

  if (texts.length === 0) return { added: [], alreadyPresent: [], skipped };

  const resolved = await resolveWords(ownerId, texts);

  // The LAST spelling the RPC saw for a group is the one now stored — `resolve_words` refreshes
  // `text` on every upsert ("most recently typed form wins") — so that is the one to report back.
  const groups = new Map<string, { text: string; created: boolean }>();
  for (const text of texts) {
    const word = resolved.get(text);
    if (!word) {
      // The RPC returns one row per input, so a gap is a dropped row, not a resolved word. Report
      // it as skipped rather than inventing an id for it.
      skipped.push(text);
      continue;
    }
    groups.set(word.id, { text, created: (groups.get(word.id)?.created ?? false) || word.created });
  }

  const added: AddWordsResult["added"] = [];
  const duplicates: { id: string; text: string }[] = [];
  for (const [id, group] of groups) {
    (group.created ? added : duplicates).push({ id, text: group.text });
  }

  const alreadyPresent = await Promise.all(
    duplicates.map(async (word) => ({
      ...word,
      popularity: await bumpWordPopularity(ownerId, word.id).catch(() => null),
    })),
  );

  return { added, alreadyPresent, skipped };
}
