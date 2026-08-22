/**
 * The vocabulary domain's shapes and vocabularies — the `words` collection, its CEFR level, its
 * kind, its enrichment payload, and the `owner_items` row the list/detail pages render.
 *
 * PURE. No imports, no I/O, no framework. These used to live inside the modules that query them
 * (`lib/lesson-items.ts`, `lib/word-details.ts`), which meant naming a type dragged in the
 * service-role Supabase client and LangChain — see docs/2026-08-09-shareable-core-refactor.md (R1).
 * The queries stayed where they were; only the shapes moved.
 */

export const CEFR_LEVELS = ["A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/**
 * The levels a DICTIONARY entry can carry — `CEFR_LEVELS` plus A1.
 *
 * Two vocabularies, deliberately, because they answer two different questions. `CefrLevel` is
 * "what level can a word in the learner's own collection be", and A1 is not a sensible answer:
 * `supabase/migrations/0004` calls A1 "headroom", the level job never assigns it, and the
 * `/lesson-items` filter does not offer it. `LexiconLevel` is "what level is this English word",
 * and there A1 is not only sensible but necessary — a dictionary contains `the` and `water`, and
 * CEFR-J grades 1,448 rows of the suggestion corpus A1.
 *
 * Widening `CEFR_LEVELS` itself was the alternative and it is the wrong move: it would widen the
 * `/lesson-items` URL grammar (`items-query.ts` whitelists these values, and `check.ts` proves
 * round-tripping over every combination of them) to add a level nothing can ever be filtered to.
 *
 * Derived by spread rather than retyped, so `CefrLevel` stays a strict subset of `LexiconLevel`
 * by construction — the one relationship between them that must never break.
 * See docs/2026-08-15-word-autocomplete-suggestions.md §6.
 */
export const LEXICON_LEVELS = ["A1", ...CEFR_LEVELS] as const;
export type LexiconLevel = (typeof LEXICON_LEVELS)[number];

/** Levels the *filter* accepts: the CEFR values plus the permanent "not classified yet" state. */
export const UNLEVELED = "unleveled";

export const ITEM_KINDS = ["word", "phrase", "sentence"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The enrichment payload stored in `words.details` (jsonb). Read by the word detail page. */
export interface WordDetails {
  /** Part of speech of the item exactly as listed ("verb", "noun", "phrase"). */
  pos: string;
  /** Several Russian options for the item as given, best/most-common first. */
  translations_ru: string[];
  /** The rest of the word family. Empty for many phrases/sentences — a normal state, not a gap. */
  forms: Array<{
    text: string;
    pos: string;
    translations_ru: string[];
  }>;
  /** A few sentences spread across the forms; `form` labels which one each demonstrates. */
  examples: Array<{
    text: string;
    form?: string;
    translation_ru?: string;
  }>;
}

/** One row of `owner_items` — a word plus its cross-lesson statistics. */
export interface ItemRow {
  /** The `words` row id. `norm_key` remains the display key the page renders by. */
  id: string;
  norm_key: string;
  text: string; // the most recently typed spelling
  kind: ItemKind;
  lesson_count: number;
  active_lesson_count: number;
  first_added_at: string;
  /** Lessons the item is CURRENTLY in. Empty = removed from every lesson (still listed). */
  lessons: { id: string; title: string }[];
  practice_count: number;
  last_practiced_at: string | null;
  level: CefrLevel | null;
  level_source: "job" | "user" | null;
  /**
   * How many times the learner has met this word again — bumped when they pick an already-owned
   * word out of the add-word suggestions, or re-add one through the Add button.
   *
   * Replaces the `is_favorite` flag (0017). Never null and never absent: 0 is a first-class value
   * that every row renders, which is what keeps the control column aligned from row to row.
   *
   * The one field on this row the UI writes. `level` and the enrichment payload belong to the
   * background jobs, and everything else is derived by the view.
   */
  popularity: number;
  categories: Record<string, string>;
  /**
   * Up to six Russian glosses, best/most-common first — the head of `WordDetails.translations_ru`,
   * derived by the `owner_items` view (0015, widened from three by 0016) rather than by any client.
   *
   * **Empty is the normal case, not a gap.** The enrichment job is a background sweep with no
   * deadline (`words.details_at` is an ATTEMPTED flag), so a word added a minute ago has none, and a
   * word the model could not gloss never will. A row renders what it has.
   *
   * The cap is in SQL on purpose: it is the answer to "how many translations does a list row show",
   * and every list of words has to agree on it. Six is `MAX_TRANSLATIONS`, the most the job stores,
   * so in practice this is now the whole gloss list rather than its head — a caller wanting fewer
   * clips at render time. The rest of the document — the forms, the examples — is
   * `ItemDetail.details`, read per-word by the detail page.
   */
  translations_ru: string[];
}

/**
 * One `owner_items` row plus the enrichment payload for the word detail page. `details` lives on
 * `words` (not `owner_items`), so it's read separately — see `getItem`. The three-way state the page
 * renders: `details` set = show it; both null = queued / in flight; `details` null but `details_at`
 * set = attempted, nothing came back.
 */
export interface ItemDetail extends ItemRow {
  details: WordDetails | null;
  details_at: string | null;
}

/**
 * The outcome of adding one word straight to the collection (`addWord`).
 *
 * `already-present` is a RESULT, not an error: `owner_items` groups by `norm_key`, so a duplicate add
 * changes nothing on screen and would read as a broken button unless the caller says so.
 *
 * Here rather than beside `addWord` because a native client has to *render* it, and `lib/words.ts`
 * imports the service-role Supabase client — the same reason every other DTO moved (R1). The query
 * stayed where it was; only the shape is shared.
 */
export interface AddWordResult {
  status: "added" | "already-present" | "empty";
  id: string | null;
  /** The stored spelling — trimmed, and what the list will show. */
  text: string;
  /**
   * The word's popularity AFTER the add: 0 for a word that was just created, the bumped count for
   * one that was already there, and null when nothing was written (`empty`).
   *
   * Present because `already-present` needs something true to say. Re-adding a word the learner
   * already has is the same statement as picking it out of the suggestions — "I met this again" —
   * so it bumps the counter, and a message that reports the new number is the difference between
   * an answer and a button that appears to do nothing.
   */
  popularity: number | null;
}

/** One (name, value) pair in use, for rendering the category filter from the data itself. */
export interface ItemFacet {
  name: string;
  value: string;
  item_count: number;
}
