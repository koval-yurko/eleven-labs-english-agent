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
  is_favorite: boolean;
  categories: Record<string, string>;
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
}

/** One (name, value) pair in use, for rendering the category filter from the data itself. */
export interface ItemFacet {
  name: string;
  value: string;
  item_count: number;
}
