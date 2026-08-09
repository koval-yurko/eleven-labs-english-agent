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
 * The only column this page writes is `is_favorite`; `level` belongs to the job in `./levels.ts`.
 *
 * The shapes and vocabularies these queries return live in `src/shared/` (pure, client-safe); this
 * module is the shell that fetches them. See docs/2026-08-09-shareable-core-refactor.md.
 */
import { getServiceSupabase } from "./supabase/server";
import { CEFR_LEVELS, UNLEVELED } from "@tutor/shared/word-types";
import type { ItemDetail, ItemFacet, ItemRow, WordDetails } from "@tutor/shared/word-types";
import type { ItemsQuery, SortKey } from "@tutor/shared/items-query";

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
  favorite: "is_favorite",
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
  let q = getServiceSupabase().from("owner_items").select("*").eq("owner_id", ownerId);

  // "B2 or not-yet-classified" is one OR group; it ANDs with every other filter.
  const levels = query.levels.filter((l) => l === UNLEVELED || (CEFR_LEVELS as readonly string[]).includes(l));
  if (levels.length > 0) {
    const clauses = levels.map((l) => (l === UNLEVELED ? "level.is.null" : `level.eq.${l}`));
    q = q.or(clauses.join(","));
  }
  if (query.favoritesOnly) q = q.eq("is_favorite", true);
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
    .eq("owner_id", ownerId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getItem: ${error.message}`);
  const row = (data as ItemRow | null) ?? null;
  if (!row) return null;

  const { data: d, error: dErr } = await db
    .from("words")
    .select("details, details_at")
    .eq("owner_id", ownerId)
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
 * Mark/unmark a word as a favorite — the page's only write.
 *
 * A plain UPDATE since 0007 folded the attributes onto `words`: matching on `owner_id` IS the
 * ownership gate (a key the caller doesn't have updates zero rows), so the separate existence check
 * this needed against the FK-less attrs table is gone. Returns whether a row matched.
 */
export async function setItemFavorite(
  ownerId: string,
  normKey: string,
  isFavorite: boolean,
): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("words")
    .update({ is_favorite: isFavorite, updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("norm_key", normKey)
    .select("id");
  if (error) throw new Error(`setItemFavorite: ${error.message}`);
  return (data?.length ?? 0) > 0;
}
