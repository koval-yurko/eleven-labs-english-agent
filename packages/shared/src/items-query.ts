/**
 * The `/lesson-items` filter/sort grammar — its shape, its whitelists, and the ONE implementation
 * of the URL it encodes to and decodes from.
 *
 * `?level=C1&level=unleveled&fav=1&kind=sentence&unassigned=1&cat.topic=business&sort=practice&dir=asc&q=ubiq`
 *
 * The URL is the filter state: shareable, back-button-correct, no client state machine. Everything
 * here is whitelisted before it reaches the query — `isValidLevel` / `isValidSort` / `isValidKind`
 * are what stop an arbitrary string reaching PostgREST, so treat them as security-relevant.
 *
 * WHY THIS IS ONE MODULE. The decoder used to live in `app/lesson-items/page.tsx` (`parseQuery`)
 * and the encoder in `app/lesson-items/ItemsBrowser.tsx` (`hrefWith`), 400 lines apart in files
 * sharing no import. They drifted: the encoder omitted `sort` when it equalled `"practice"` while
 * the decoder defaulted to `"created"`, so an omitted value round-tripped as a *different* sort and
 * "Times practiced" was silently unselectable. Both directions now read their defaults from
 * `DEFAULT_SORT` / `DEFAULT_DIR` below, which makes that class of bug unrepresentable.
 * See docs/2026-08-09-shareable-core-refactor.md (R2).
 *
 * PURE. Deliberately does NOT know the database column each sort key maps to: that mapping is
 * server-only and stays in `lib/lesson-items.ts`, typed `Record<SortKey, string>` so the two cannot
 * fall out of step either.
 */
import { CEFR_LEVELS, ITEM_KINDS, UNLEVELED, type ItemKind } from "./word-types";

/** Sort keys the page offers. Whitelisted: only these reach the query builder. */
export const SORT_KEYS = [
  "practice", // conversations held while the item was in a lesson
  "lessons",
  "created",
  "practiced",
  "favorite",
  "level",
  "text",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type SortDir = "asc" | "desc";

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
  dir: SortDir;
}

/**
 * The defaults a bare `/lesson-items` URL means. Read by BOTH directions — the decoder falls back
 * to them, the encoder omits values equal to them. Changing one here changes both.
 */
export const DEFAULT_SORT: SortKey = "created";
export const DEFAULT_DIR: SortDir = "desc";

/** URL parameters as a plain bag — what Next hands a page, and what any client can build. */
export type ItemsSearchParams = Record<string, string | string[] | undefined>;

/**
 * `URLSearchParams` → the bag `parseItemsQuery` reads, collapsing a repeated key to an array.
 *
 * Next hands a page this shape already, so the browser never needed the conversion — which is why it
 * lived only inside `check.ts`, where the round-trip suite had to reconstruct it. **A route handler
 * needs exactly the same step**, and the one thing worse than no implementation is two: the
 * repeated-key rule (`?level=B1&level=C1`) is the whole reason `levels` is an array, and a second
 * version of it that kept only the last value would silently drop a filter.
 *
 * Takes an iterable of pairs rather than `URLSearchParams` itself so this stays free of the DOM lib
 * — `packages/shared` compiles with `types: []` and no `DOM.Iterable` on purpose (CLAUDE.md), and
 * `URLSearchParams` is iterable everywhere it exists.
 *
 * See docs/2026-08-13-expo-s6-collection.md D55.
 */
export function searchParamsToBag(pairs: Iterable<[string, string]>): ItemsSearchParams {
  const bag: ItemsSearchParams = {};
  for (const [key, value] of pairs) {
    const prev = bag[key];
    if (prev === undefined) bag[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else bag[key] = [prev, value];
  }
  return bag;
}

/** Prefix marking a category filter parameter: `cat.topic=business`. */
const CATEGORY_PREFIX = "cat.";

// ── whitelists ───────────────────────────────────────────────────────────────────────────────

/** A level the filter accepts: a CEFR value, or the permanent "not classified yet" state. */
export function isValidLevel(value: string): boolean {
  return value === UNLEVELED || (CEFR_LEVELS as readonly string[]).includes(value);
}

export function isValidSort(value: string | undefined): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value ?? "");
}

export function isValidKind(value: string | undefined): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value ?? "");
}

// ── decode ───────────────────────────────────────────────────────────────────────────────────

function all(params: ItemsSearchParams, key: string): string[] {
  const v = params[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function one(params: ItemsSearchParams, key: string): string | undefined {
  return all(params, key)[0];
}

/** URL parameters → a validated query. Unknown/invalid values fall back to the defaults. */
export function parseItemsQuery(params: ItemsSearchParams): ItemsQuery {
  const kind = one(params, "kind");
  const sort = one(params, "sort");

  const categories: Record<string, string> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (!key.startsWith(CATEGORY_PREFIX)) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) categories[key.slice(CATEGORY_PREFIX.length)] = value;
  }

  return {
    levels: all(params, "level").filter(isValidLevel),
    favoritesOnly: one(params, "fav") === "1",
    kind: isValidKind(kind) ? kind : null,
    unassignedOnly: one(params, "unassigned") === "1",
    categories,
    sort: isValidSort(sort) ? sort : DEFAULT_SORT,
    dir: one(params, "dir") === "asc" ? "asc" : DEFAULT_DIR,
  };
}

/**
 * The free-text search term (`?q=`). Kept OUT of `ItemsQuery` on purpose: filters and sort go to
 * Postgres, search filters the already-loaded list in memory (the filtered list is small, and a
 * round-trip per keystroke would be the wrong interaction). It rides in the URL only so a reload
 * or a shared link keeps it. See docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export function parseSearchTerm(params: ItemsSearchParams): string {
  return one(params, "q") ?? "";
}

// ── encode ───────────────────────────────────────────────────────────────────────────────────

/**
 * A validated query → the URL's query string, WITHOUT a leading `?`. Returns `""` when the query is
 * the default and there is no search term, so the caller can render a bare `/lesson-items`.
 *
 * Inverse of `parseItemsQuery` + `parseSearchTerm`: for any `q` produced by the parser,
 * `parseItemsQuery(fromQueryString(serializeItemsQuery(q))) ` deep-equals `q`.
 */
export function serializeItemsQuery(query: ItemsQuery, search = ""): string {
  const params = new URLSearchParams();
  for (const level of query.levels) params.append("level", level);
  if (query.favoritesOnly) params.set("fav", "1");
  if (query.kind) params.set("kind", query.kind);
  if (query.unassignedOnly) params.set("unassigned", "1");
  for (const [name, value] of Object.entries(query.categories)) {
    params.set(`${CATEGORY_PREFIX}${name}`, value);
  }
  // Omitted when equal to the default — which is why both directions must name the same constant.
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.dir !== DEFAULT_DIR) params.set("dir", query.dir);
  if (search) params.set("q", search);
  return params.toString();
}
