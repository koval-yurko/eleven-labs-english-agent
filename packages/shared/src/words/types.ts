/** The vocabulary domain's shapes and vocabularies — CEFR levels, word kinds, the enrichment payload, and the rows the collection renders.
 *  See ../../docs/words.md. */
export const CEFR_LEVELS = ["A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

export const LEXICON_LEVELS = ["A1", ...CEFR_LEVELS] as const;
export type LexiconLevel = (typeof LEXICON_LEVELS)[number];

export const UNLEVELED = "unleveled";

export const ITEM_KINDS = ["word", "phrase", "sentence"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface WordDetails {
  pos: string;
  translations_ru: string[];
  forms: Array<{
    text: string;
    pos: string;
    translations_ru: string[];
  }>;
  examples: Array<{
    text: string;
    form?: string;
    translation_ru?: string;
  }>;
}

export interface ItemRow {
  id: string;
  norm_key: string;
  text: string; 
  kind: ItemKind;
  lesson_count: number;
  active_lesson_count: number;
  first_added_at: string;
  lessons: { id: string; title: string }[];
  practice_count: number;
  last_practiced_at: string | null;
  level: CefrLevel | null;
  level_source: "job" | "user" | null;
  popularity: number;
  categories: Record<string, string>;
  translations_ru: string[];
}

export interface ItemDetail extends ItemRow {
  details: WordDetails | null;
  details_at: string | null;
}

export interface AddWordResult {
  status: "added" | "already-present" | "empty";
  id: string | null;
  text: string;
  popularity: number | null;
}

export interface ItemFacet {
  name: string;
  value: string;
  item_count: number;
}
