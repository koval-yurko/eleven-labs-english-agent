/** The pure logic behind the items list: in-memory search, category facet grouping, and sort labels.
 *  See ../../docs/words.md. */
import type { ItemFacet } from "./types";
import { SORT_KEYS, type SortKey } from "./query";
import { lexiconPrefixFold } from "./key";

export const SORT_LABELS: Record<SortKey, string> = {
  practice: "Times practiced",
  lessons: "Lessons",
  created: "Date added",
  practiced: "Last practiced",
  popularity: "Popularity",
  level: "Level",
  text: "Alphabetical",
};

export function sortChoices(): { key: SortKey; label: string }[] {
  return SORT_KEYS.map((key) => ({ key, label: SORT_LABELS[key] }));
}

export function searchItems<T extends { text: string }>(items: T[], search: string): T[] {
  const needle = lexiconPrefixFold(search);
  if (!needle) return items;
  return items.filter((item) => matchesSearch(item.text, needle));
}

function editBudget(length: number): number {
  if (length < 4) return 0;
  return length <= 6 ? 1 : 2;
}

function matchesSearch(text: string, needle: string): boolean {
  const hay = lexiconPrefixFold(text);
  if (hay.includes(needle)) return true;

  const budget = editBudget(needle.length);
  if (budget === 0) return false;

  for (const token of hay.split(" ")) {
    if (token.length + budget < needle.length) continue;
    if (prefixDistance(token, needle) <= budget) return true;
  }
  return false;
}

function prefixDistance(token: string, needle: string): number {
  const n = needle.length;
  let previous: number[] = Array.from({ length: n + 1 }, (_, j) => j);
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
    if (previous[n]! < best) best = previous[n]!;
  }
  return best;
}

export function groupFacets(facets: ItemFacet[]): [string, ItemFacet[]][] {
  const byName = new Map<string, ItemFacet[]>();
  for (const facet of facets) {
    const list = byName.get(facet.name) ?? [];
    list.push(facet);
    byName.set(facet.name, list);
  }
  return [...byName.entries()];
}
