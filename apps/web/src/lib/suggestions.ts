/**
 * SERVER-ONLY data access for the add-word autocomplete.
 *
 * Phase 2 of docs/2026-08-15-word-autocomplete-suggestions.md. A thin wrapper over the
 * `suggest_words` RPC (0012), which is where all the actual logic lives — normalizing the prefix,
 * escaping LIKE metacharacters, ranking, and joining the learner's collection for `owned`.
 *
 * The service-role client, like every other module here. The `lexicon` half of the query needs no
 * owner scoping (it is shared reference data, the one table in this schema that is not owner-scoped
 * — see supabase/README.md); the `words` half is scoped by the `p_owner_id` this function is
 * handed, which the route derives from the Bearer token and never from the request body.
 *
 * Not `lexicon-db.ts`: that direct-Postgres handle exists for the bulk jobs, which need temp tables
 * and 53k-row scans. This is a per-keystroke read of at most 8 rows on the request path, and it
 * belongs on the same pooled client as every other request-path query.
 */
import { getServiceSupabase } from "./supabase/server";
import { SUGGEST_LIMIT, SUGGEST_MIN_PREFIX, type WordSuggestion } from "@tutor/shared/api";
import { LEXICON_LEVELS, type LexiconLevel } from "@tutor/shared/word-types";

type SuggestRow = {
  text: string;
  level: string | null;
  ru: string[] | null;
  owned: boolean;
};

const LEVELS = new Set<string>(LEXICON_LEVELS);

/**
 * Prefix-match the lexicon for one learner.
 *
 * Returns `[]` rather than throwing for a prefix that is too short — the client debounces into that
 * state on the way to every word it types, and it is not an error condition. The RPC enforces the
 * same floor; this check just avoids the round trip.
 */
export async function suggestWords(
  ownerId: string,
  prefix: string,
  limit: number = SUGGEST_LIMIT,
): Promise<WordSuggestion[]> {
  // Length is measured on the RAW prefix. `lesson_item_norm_key` can only shorten a string, so
  // anything failing here would fail in Postgres too — but the reverse is not true, which is why
  // the RPC keeps its own check rather than trusting this one.
  if (prefix.trim().length < SUGGEST_MIN_PREFIX) return [];

  const { data, error } = await getServiceSupabase().rpc("suggest_words", {
    p_owner_id: ownerId,
    p_prefix: prefix,
    p_limit: limit,
  });
  if (error) throw new Error(`suggestWords: ${error.message}`);

  return ((data as SuggestRow[] | null) ?? []).map((row) => ({
    text: row.text,
    // `cefr_level` is an enum in Postgres and a union in TypeScript, and the RPC returns it as
    // text. Narrowing rather than casting: a level added to the enum but not to LEXICON_LEVELS
    // should render as "unlevelled", which is already a first-class state, instead of putting a
    // string the client cannot handle into a typed field.
    level: row.level !== null && LEVELS.has(row.level) ? (row.level as LexiconLevel) : null,
    ru: row.ru ?? [],
    owned: row.owned,
  }));
}
