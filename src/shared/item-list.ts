/**
 * The pure logic behind the items list surface: how the in-memory search matches, how category
 * facets group into filter rows, and what each sort key is called.
 *
 * PURE — no React, no DOM. This lived inside `app/lesson-items/ItemsBrowser.tsx`, a 480-line
 * client component, which meant none of it could be exercised without a renderer. Extracted per
 * docs/2026-08-09-shareable-core-refactor.md (R4).
 *
 * Why search is client-side at all: filters and sort go through the URL to Postgres, but the
 * filtered list is small (hundreds of rows at the 50-items-per-lesson cap) so it is already in
 * memory — a round-trip per keystroke would be the wrong interaction. See
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
import type { ItemFacet } from "./word-types";
import { SORT_KEYS, type SortKey } from "./items-query";

/**
 * What each sort key is called in the UI. Total over `SortKey`, so adding a key to the whitelist
 * in `items-query.ts` without naming it here is a type error.
 *
 * This is display copy rather than a rule, and it sits in the shared core only because it is the
 * one place a `SortKey` is humanized — duplicating it per client is how the labels drift out of
 * step with the keys. If localization ever arrives, this becomes a key→message-id map and the
 * strings move to the catalogues.
 */
export const SORT_LABELS: Record<SortKey, string> = {
  practice: "Times practiced",
  lessons: "Lessons",
  created: "Date added",
  practiced: "Last practiced",
  favorite: "Favorites",
  level: "Level",
  text: "Alphabetical",
};

/** Sort keys in the order the UI offers them, each with its label. */
export function sortChoices(): { key: SortKey; label: string }[] {
  return SORT_KEYS.map((key) => ({ key, label: SORT_LABELS[key] }));
}

/**
 * Filter an already-loaded list by the learner's search box. Case-insensitive substring match on
 * the item's own spelling; an empty/whitespace term matches everything (returns the input array
 * unchanged, so a no-op search costs nothing).
 *
 * Matches `text` ONLY — the spelling as most recently typed. Note this is a plainer comparison
 * than the `norm_key` identity: searching "cafe" does not surface "café", even though Postgres
 * considers them one word. Widening it to also test `norm_key` would be a one-line change, but it
 * is a behaviour change and deliberately not part of R4.
 */
export function searchItems<T extends { text: string }>(items: T[], search: string): T[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return items;
  return items.filter((item) => item.text.toLowerCase().includes(needle));
}

/**
 * `[{name: "topic", value: "business"}, …]` → `[["topic", [{…}]], …]`, one filter row per name.
 * Insertion order is preserved, so the rows follow the order the server returned the facets in
 * (`listItemFacets` orders by name, then value).
 */
export function groupFacets(facets: ItemFacet[]): [string, ItemFacet[]][] {
  const byName = new Map<string, ItemFacet[]>();
  for (const facet of facets) {
    const list = byName.get(facet.name) ?? [];
    list.push(facet);
    byName.set(facet.name, list);
  }
  return [...byName.entries()];
}
