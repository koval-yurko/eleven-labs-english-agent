import { getOwnerId } from "../../lib/auth/session";
import {
  listItems,
  listItemFacets,
  CEFR_LEVELS,
  ITEM_KINDS,
  SORT_KEYS,
  UNLEVELED,
  type ItemKind,
  type ItemsQuery,
  type SortKey,
} from "../../lib/lesson-items";
import { ItemsBrowser } from "./ItemsBrowser";

// Per-request rendering: owner-scoped data driven by the URL's filter/sort params.
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function all(params: SearchParams, key: string): string[] {
  const v = params[key];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function one(params: SearchParams, key: string): string | undefined {
  return all(params, key)[0];
}

/**
 * The URL is the filter state: `?level=C1&level=unleveled&fav=1&kind=sentence&unassigned=1
 * &cat.topic=business&sort=practice&dir=desc&q=ubiq`. Shareable and back-button-correct, with no
 * client state machine. Everything here is whitelisted before it reaches the query.
 */
function parseQuery(params: SearchParams): ItemsQuery {
  const kind = one(params, "kind");
  const sort = one(params, "sort");
  const categories: Record<string, string> = {};
  for (const [key, raw] of Object.entries(params)) {
    if (!key.startsWith("cat.")) continue;
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) categories[key.slice(4)] = value;
  }

  return {
    levels: all(params, "level").filter(
      (l) => l === UNLEVELED || (CEFR_LEVELS as readonly string[]).includes(l),
    ),
    favoritesOnly: one(params, "fav") === "1",
    kind: (ITEM_KINDS as readonly string[]).includes(kind ?? "") ? (kind as ItemKind) : null,
    unassignedOnly: one(params, "unassigned") === "1",
    categories,
    sort: (SORT_KEYS as string[]).includes(sort ?? "") ? (sort as SortKey) : "practice",
    dir: one(params, "dir") === "asc" ? "asc" : "desc",
  };
}

/**
 * Every word / phrase / sentence the learner has, across all lessons — searchable, filterable by
 * level / favorite / kind / category, sortable by how much it has actually been practiced.
 *
 * An item removed from a lesson is NOT deleted: it stays here with no lesson attached and keeps
 * the practice count it earned. See
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export default async function LessonItemsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const ownerId = await getOwnerId();
  const query = parseQuery(params);

  const [items, facets] = ownerId
    ? await Promise.all([listItems(ownerId, query), listItemFacets(ownerId)])
    : [[], []];

  return (
    <>
      <h1>Words &amp; sentences</h1>
      <p className="muted">
        Everything across all your lessons. Removing an item from a lesson doesn&rsquo;t delete it
        — it stays here, keeping the practice it earned. <a href="/">← lessons</a>
      </p>

      {ownerId ? (
        <ItemsBrowser
          items={items}
          facets={facets}
          query={query}
          initialSearch={one(params, "q") ?? ""}
        />
      ) : (
        <section className="panel">
          <p className="muted">Log in to see your words.</p>
        </section>
      )}
    </>
  );
}
