/**
 * SERVER-ONLY data access for the cross-lesson item list behind `/lesson-items` — every word,
 * phrase, and sentence the learner has ever had, with its practice statistics and attributes.
 *
 * Same rules as `src/lib/lessons.ts`: the service-role client, `owner_id` filtered/stamped
 * explicitly in code, RLS as defense-in-depth. See
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 *
 * The list is the `owner_items` view: the `words` collection, decorated with the cross-lesson
 * statistics derived from lesson_items + lesson_sessions. A word in no lesson is a normal row here
 * — either it was added directly (see `src/lib/words.ts`) or removed from every lesson it was in.
 * The only column this page writes is `popularity`; `level` belongs to the job in `./levels.ts`.
 *
 * The shapes and vocabularies these queries return live in `src/shared/` (pure, client-safe); this
 * module is the shell that fetches them. See docs/2026-08-09-shareable-core-refactor.md.
 */
import { getServiceSupabase } from "./supabase/server";
import { CEFR_LEVELS, UNLEVELED } from "@tutor/shared/words/types";
import type { ItemDetail, ItemFacet, ItemRow, WordDetails } from "@tutor/shared/words/types";
import type { ItemsQuery, SortKey } from "@tutor/shared/words/query";

/**
 * The rows a learner may see: their own, plus the UNOWNED ones.
 *
 * `owner_id is null` means "added anonymously" — today, through the MCP server, which authenticates
 * a shared secret rather than a person and therefore has no `sub` to stamp (0018_unowned_words.sql,
 * docs/2026-08-27-mcp-static-token-auth.md §2). Those words are part of the collection; a row no
 * query returns is a row that may as well not exist.
 *
 * **This is the one place the ownership rule is widened, and it is widened for READS only.** Every
 * write still stamps or filters an explicit `owner_id` — the MCP path stamps NULL on purpose, and
 * nothing else may. Expressed once, here, so "which words are visible?" has a single answer rather
 * than four `.or(…)` strings that drift.
 *
 * The value is double-quoted because an Auth0 sub contains `|`, and PostgREST parses `or=(…)` on
 * bare punctuation. `.or()` composes with AND against every other filter on the query, which is
 * what the level/kind/category filters below rely on.
 */
export function ownedOrUnowned(ownerId: string): string {
  return `owner_id.eq."${ownerId}",owner_id.is.null`;
}

/**
 * Sort key → the column it orders by. SERVER-ONLY: the keys are the page's public grammar (and live
 * in `shared/items-query.ts`), the columns are this table's business. Typed as a total map over
 * `SortKey`, so adding a key to the shared whitelist without mapping it here is a type error rather
 * than a runtime `undefined` reaching PostgREST.
 */
const SORT_COLUMNS: Record<SortKey, string> = {
  practice: "practice_count", // conversations held while the item was in a lesson
  lessons: "lesson_count",
  created: "first_added_at",
  practiced: "last_practiced_at",
  popularity: "popularity", // times the learner has met the word again (0017)
  level: "level", // free ordering — cefr_level is an enum
  text: "norm_key",
};

/**
 * The owner's items, filtered + sorted in Postgres. Search is NOT applied here: the whole
 * (filtered) list is small — hundreds of rows at the 50-items-per-lesson cap — so the page ships
 * it to the browser and the search box filters it in memory, which beats a round-trip per
 * keystroke.
 */
export async function listItems(ownerId: string, query: ItemsQuery): Promise<ItemRow[]> {
  let q = getServiceSupabase().from("owner_items").select("*").or(ownedOrUnowned(ownerId));

  // "B2 or not-yet-classified" is one OR group; it ANDs with every other filter.
  const levels = query.levels.filter((l) => l === UNLEVELED || (CEFR_LEVELS as readonly string[]).includes(l));
  if (levels.length > 0) {
    const clauses = levels.map((l) => (l === UNLEVELED ? "level.is.null" : `level.eq.${l}`));
    q = q.or(clauses.join(","));
  }
  if (query.kind) q = q.eq("kind", query.kind);
  if (query.unassignedOnly) q = q.eq("active_lesson_count", 0);
  for (const [name, value] of Object.entries(query.categories)) {
    q = q.contains("categories", { [name]: value });
  }

  const ascending = query.dir === "asc";
  q = q
    // Never-practiced items sort last on a descending practice sort, not first.
    .order(SORT_COLUMNS[query.sort], { ascending, nullsFirst: false })
    .order("norm_key", { ascending: true }); // stable tiebreak

  const { data, error } = await q;
  if (error) throw new Error(`listItems: ${error.message}`);
  return (data as ItemRow[] | null) ?? [];
}

/**
 * One item by its `words.id`, owner-scoped — backs the word detail page (`/lesson-items/[id]`).
 * Same `owner_items` row the list renders, so the detail page gets the text, level, kind, stats,
 * categories, and the lessons it currently participates in (the view's `lessons` is active-only) in
 * a single read. Null when the id doesn't exist or isn't the caller's (the `owner_id` filter is the
 * gate). See docs/2026-07-17-lesson-items-multiselect-and-word-detail.md.
 *
 * The enrichment payload (`words.details`) is read with a second, narrow query rather than added to
 * `owner_items`: the list page does `select *` from that view, and a fat jsonb blob per row has no
 * business in a payload the list neither needs nor renders. See
 * docs/2026-07-18-word-details-enrichment-job.md.
 */
export async function getItem(ownerId: string, id: string): Promise<ItemDetail | null> {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("owner_items")
    .select("*")
    .or(ownedOrUnowned(ownerId))
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getItem: ${error.message}`);
  const row = (data as ItemRow | null) ?? null;
  if (!row) return null;

  const { data: d, error: dErr } = await db
    .from("words")
    .select("details, details_at")
    .or(ownedOrUnowned(ownerId))
    .eq("id", id)
    .maybeSingle();
  if (dErr) throw new Error(`getItem details: ${dErr.message}`);
  const details = (d as { details: WordDetails | null; details_at: string | null } | null) ?? null;

  return { ...row, details: details?.details ?? null, details_at: details?.details_at ?? null };
}

/** The category (name:value) pairs actually in use — the source for the filter controls. */
export async function listItemFacets(ownerId: string): Promise<ItemFacet[]> {
  const { data, error } = await getServiceSupabase()
    .from("owner_item_facets")
    .select("name, value, item_count")
    .eq("owner_id", ownerId)
    .order("name", { ascending: true })
    .order("value", { ascending: true });
  if (error) throw new Error(`listItemFacets: ${error.message}`);
  return (data as ItemFacet[] | null) ?? [];
}

/**
 * +1 a word's popularity — the collection's only write, and the successor to the favourite star
 * (0017). Returns the NEW count, or null when no row matched.
 *
 * An RPC rather than an update from here, for two reasons. `popularity = popularity + 1` cannot be
 * expressed through PostgREST at all, and the read-modify-write that would replace it loses bumps
 * whenever two of them overlap — which is precisely the case this feature creates, since a learner
 * can tap a suggestion while an add is still in flight.
 *
 * The `owner_id` argument IS the ownership gate, exactly as the `.eq("owner_id", …)` filter is
 * everywhere else in this module: an id that is not the caller's updates zero rows and comes back
 * null. See `supabase/migrations/0017_word_popularity.sql`.
 */
export async function bumpWordPopularity(
  ownerId: string | null,
  wordId: string,
): Promise<number | null> {
  const { data, error } = await getServiceSupabase().rpc("bump_word_popularity", {
    p_owner_id: ownerId,
    p_id: wordId,
  });
  if (error) throw new Error(`bumpWordPopularity: ${error.message}`);
  // A scalar-returning function comes back as the value itself; no row matched is `null`.
  return typeof data === "number" ? data : null;
}
