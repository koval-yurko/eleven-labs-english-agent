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
import { wordInputKey } from "@tutor/shared/word-key";
import type { AddWordResult } from "@tutor/shared/word-types";

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
  ownerId: string,
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
 * Text that normalizes to nothing (punctuation only) still gets a row — `words_set_norm_key` falls
 * back to `lower(btrim(text))`, matching what lesson_items did.
 */
export async function addWord(ownerId: string, rawText: string): Promise<AddWordResult> {
  const text = wordInputKey(rawText);
  if (!text) return { status: "empty", id: null, text: "" };

  const resolved = await resolveWords(ownerId, [text]);
  const word = resolved.get(text);
  if (!word) return { status: "empty", id: null, text };

  return { status: word.created ? "added" : "already-present", id: word.id, text };
}
