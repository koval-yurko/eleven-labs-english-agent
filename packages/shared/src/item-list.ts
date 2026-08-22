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
import { lexiconPrefixFold } from "./word-key";

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
  popularity: "Popularity",
  level: "Level",
  text: "Alphabetical",
};

/** Sort keys in the order the UI offers them, each with its label. */
export function sortChoices(): { key: SortKey; label: string }[] {
  return SORT_KEYS.map((key) => ({ key, label: SORT_LABELS[key] }));
}

/**
 * Filter an already-loaded list by the learner's search box — **typo-tolerant**, and folded the same
 * way the add-word autocomplete folds its prefixes.
 *
 * An empty/whitespace term matches everything and returns the input array *identity*, so a no-op
 * search costs nothing and does not defeat the caller's `useMemo`.
 *
 * ## Two passes, in order
 *
 * 1. **Substring, on the folded text.** `lexiconPrefixFold` is the client half of Postgres's
 *    `lesson_item_norm_key` (`word-key.ts`) — NFKC, smart punctuation, unaccent, lower, whitespace,
 *    edge punctuation. This is what makes `cafe` find `café` and `dont` find `don’t`, and it is a
 *    deliberate reversal of the note that used to stand here: the collection's own identity merges
 *    those pairs, so a search box that does not is the odd one out.
 * 2. **Bounded approximate match, per token.** For a needle of four characters or more, a token of
 *    the item matches if the needle is within a small edit distance of one of the token's own
 *    prefixes — `ubiqutous` finds `ubiquitous`, `recieve` finds `receive`, and a half-typed
 *    `recieved` still finds it. The budget is 1 edit up to six characters and 2 beyond, which is
 *    the standard ladder and is deliberately mean: at 3 edits a five-letter needle matches most of
 *    a page.
 *
 * ## Why prefixes rather than whole tokens
 *
 * Search is used mid-word — the learner types `ubiq` and expects `ubiquitous` — so a plain
 * Levenshtein against the whole token would score that 6 and reject it. Free-end DP (Sellers, but
 * anchored at the start) asks the question the box actually poses: *is what I have typed so far a
 * near-miss of how this word begins?*
 *
 * ## The order is the caller's, not ours
 *
 * Matches come back in input order. The list has a sort control the learner chose, and re-ranking
 * by match quality would silently override it — a fuzzy search that reshuffles a list sorted by
 * "last practiced" is answering a question nobody asked.
 *
 * The `T extends { text: string }` generic is unchanged: `text` is the spelling as most recently
 * typed, and it stays the only field searched. Translations are rendered on the row now but are not
 * matched here — that is a separate decision, not an oversight.
 */
export function searchItems<T extends { text: string }>(items: T[], search: string): T[] {
  // The fold trims and collapses whitespace, so it subsumes the `.trim()` this used to do.
  const needle = lexiconPrefixFold(search);
  if (!needle) return items;
  return items.filter((item) => matchesSearch(item.text, needle));
}

/**
 * Up to how many edits a needle of this length may be wrong by. Zero below four characters: a
 * 3-character needle one edit out matches an enormous slice of any collection, and the learner
 * typing `the` has not made a mistake worth guessing at.
 */
function editBudget(length: number): number {
  if (length < 4) return 0;
  return length <= 6 ? 1 : 2;
}

/** `needle` must already be folded; `text` is folded here. Exported only through `searchItems`. */
function matchesSearch(text: string, needle: string): boolean {
  const hay = lexiconPrefixFold(text);
  if (hay.includes(needle)) return true;

  const budget = editBudget(needle.length);
  if (budget === 0) return false;

  for (const token of hay.split(" ")) {
    // A token shorter than the needle by more than the budget cannot be within it, and neither can
    // one that would need more than `budget` edits before the needle even starts. Cheap to check,
    // and it skips the DP for nearly every token of a sentence.
    if (token.length + budget < needle.length) continue;
    if (prefixDistance(token, needle) <= budget) return true;
  }
  return false;
}

/**
 * The smallest edit distance between `needle` and any PREFIX of `token` — free at the end, anchored
 * at the start.
 *
 * Anchored deliberately. Letting the match float (a true approximate-substring search) would make
 * `ateful` find `ungrateful`, which is not what a search box is for and costs the whole width of
 * the haystack per row. Anchoring keeps it to one small matrix per token and keeps the results
 * explicable: what you typed is roughly how the word starts.
 *
 * One row of the DP at a time, `needle`-wide. Tokens and needles are both short — a 500-character
 * sentence is ~80 tokens of ~6 characters — so this is a few thousand integer operations for a row
 * the substring pass already rejected.
 */
function prefixDistance(token: string, needle: string): number {
  const n = needle.length;
  // `previous[j]` = distance between the token prefix processed so far and `needle[0..j]`.
  let previous: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  // The empty token prefix: the answer if the needle were empty, which `searchItems` already ruled
  // out — but `best` has to start somewhere total.
  let best = previous[n]!;

  for (let i = 1; i <= token.length; i++) {
    const current: number[] = new Array<number>(n + 1);
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      const substitution = previous[j - 1]! + (token[i - 1] === needle[j - 1] ? 0 : 1);
      const deletion = previous[j]! + 1;
      const insertion = current[j - 1]! + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
    // Free end: every prefix of the token is a candidate, so take the best of them all.
    if (previous[n]! < best) best = previous[n]!;
  }
  return best;
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
