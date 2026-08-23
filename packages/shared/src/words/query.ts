/** The collection's filter/sort grammar and the single implementation of the URL it encodes to and decodes from.
 *  See ../../docs/words.md. */
import { CEFR_LEVELS, ITEM_KINDS, UNLEVELED, type ItemKind } from "./types";

export const SORT_KEYS = [
  "practice", // conversations held while the item was in a lesson
  "lessons",
  "created",
  "practiced",
  "popularity", // how often the learner has met the word again (0017)
  "level",
  "text",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type SortDir = "asc" | "desc";

export interface ItemsQuery {
  levels: string[];
  kind: ItemKind | null;
  unassignedOnly: boolean;
  categories: Record<string, string>;
  sort: SortKey;
  dir: SortDir;
}

export const DEFAULT_SORT: SortKey = "created";
export const DEFAULT_DIR: SortDir = "desc";

export type ItemsSearchParams = Record<string, string | string[] | undefined>;

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

const CATEGORY_PREFIX = "cat.";

export function isValidLevel(value: string): boolean {
  return value === UNLEVELED || (CEFR_LEVELS as readonly string[]).includes(value);
}

export function isValidSort(value: string | undefined): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value ?? "");
}

export function isValidKind(value: string | undefined): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value ?? "");
}

function all(params: ItemsSearchParams, key: string): string[] {
  const v = params[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function one(params: ItemsSearchParams, key: string): string | undefined {
  return all(params, key)[0];
}

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
    kind: isValidKind(kind) ? kind : null,
    unassignedOnly: one(params, "unassigned") === "1",
    categories,
    sort: isValidSort(sort) ? sort : DEFAULT_SORT,
    dir: one(params, "dir") === "asc" ? "asc" : DEFAULT_DIR,
  };
}

export function parseSearchTerm(params: ItemsSearchParams): string {
  return one(params, "q") ?? "";
}

export function serializeItemsQuery(query: ItemsQuery, search = ""): string {
  const params = new URLSearchParams();
  for (const level of query.levels) params.append("level", level);
  if (query.kind) params.set("kind", query.kind);
  if (query.unassignedOnly) params.set("unassigned", "1");
  for (const [name, value] of Object.entries(query.categories)) {
    params.set(`${CATEGORY_PREFIX}${name}`, value);
  }
  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort);
  if (query.dir !== DEFAULT_DIR) params.set("dir", query.dir);
  if (search) params.set("q", search);
  return params.toString();
}
