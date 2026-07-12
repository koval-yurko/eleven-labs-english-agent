/**
 * SERVER-ONLY data access for the cross-lesson item list behind `/lesson-items` — every word,
 * phrase, and sentence the learner has ever had, with its practice statistics and attributes.
 *
 * Same rules as `src/lib/lessons.ts`: the service-role client, `owner_id` filtered/stamped
 * explicitly in code, RLS as defense-in-depth. See
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 *
 * The list is DERIVED (the `owner_items` view over lesson_items + lesson_sessions); the only
 * thing stored per item is `lesson_item_attrs`, and the only thing this page writes to it is
 * `is_favorite`. Levels come from a future background job.
 */
import { getServiceSupabase } from "./supabase/server";

export const CEFR_LEVELS = ["A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/** Levels the *filter* accepts: the CEFR values plus the permanent "not classified yet" state. */
export const UNLEVELED = "unleveled";

export const ITEM_KINDS = ["word", "phrase", "sentence"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Sort keys the page offers → the column each maps to. Whitelisted: these reach PostgREST. */
const SORT_COLUMNS = {
  practice: "practice_count", // conversations held while the item was in a lesson
  lessons: "lesson_count",
  created: "first_added_at",
  practiced: "last_practiced_at",
  favorite: "is_favorite",
  level: "level", // free ordering — cefr_level is an enum
  text: "norm_key",
} as const;
export type SortKey = keyof typeof SORT_COLUMNS;
export const SORT_KEYS = Object.keys(SORT_COLUMNS) as SortKey[];

/** One row of `owner_items` — a distinct item plus its cross-lesson statistics. */
export interface ItemRow {
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

/** One (name, value) pair in use, for rendering the category filter from the data itself. */
export interface ItemFacet {
  name: string;
  value: string;
  item_count: number;
}

export interface ItemsQuery {
  /** CEFR levels and/or `UNLEVELED`. Empty = no level filter. */
  levels: string[];
  favoritesOnly: boolean;
  kind: ItemKind | null;
  /** Only items no longer in any lesson — "words I've dropped". */
  unassignedOnly: boolean;
  /** Category filters, ANDed: `{ topic: "business" }` → categories @> {"topic":"business"}. */
  categories: Record<string, string>;
  sort: SortKey;
  dir: "asc" | "desc";
}

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
 * Mark/unmark an item as a favorite — the page's only write. Upserts the sparse attrs row, so
 * favoriting an item nothing has ever touched creates it, and the (future) level job's columns
 * are left alone because only the columns in this payload are updated on conflict.
 *
 * The item must be one the caller actually has (an owner_id + norm_key that exists in their
 * lesson_items); ids from the browser are never trusted.
 */
export async function setItemFavorite(
  ownerId: string,
  normKey: string,
  isFavorite: boolean,
): Promise<boolean> {
  const db = getServiceSupabase();

  const { data: owned, error: ownerError } = await db
    .from("lesson_items")
    .select("norm_key")
    .eq("owner_id", ownerId)
    .eq("norm_key", normKey)
    .limit(1)
    .maybeSingle();
  if (ownerError) throw new Error(`setItemFavorite: ${ownerError.message}`);
  if (!owned) return false;

  const { error } = await db.from("lesson_item_attrs").upsert(
    {
      owner_id: ownerId,
      norm_key: normKey,
      is_favorite: isFavorite,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "owner_id,norm_key" },
  );
  if (error) throw new Error(`setItemFavorite: ${error.message}`);
  return true;
}
