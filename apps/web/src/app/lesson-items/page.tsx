import { getOwnerId } from "../../lib/auth/session";
import { listItems, listItemFacets } from "../../lib/lesson-items";
import {
  parseItemsQuery,
  parseSearchTerm,
  type ItemsSearchParams,
} from "@tutor/shared/words/query";
import { ItemsBrowser } from "./ItemsBrowser";

// Per-request rendering: owner-scoped data driven by the URL's filter/sort params.
export const dynamic = "force-dynamic";

/**
 * Every word / phrase / sentence the learner has, across all lessons — searchable, filterable by
 * level / kind / category, sortable by how much it has actually been practiced.
 *
 * An item removed from a lesson is NOT deleted: it stays here with no lesson attached and keeps
 * the practice count it earned. See
 * docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
 */
export default async function LessonItemsPage({
  searchParams,
}: {
  searchParams: Promise<ItemsSearchParams>;
}) {
  const params = await searchParams;
  const ownerId = await getOwnerId();
  const query = parseItemsQuery(params);

  const [items, facets] = ownerId
    ? await Promise.all([listItems(ownerId, query), listItemFacets(ownerId)])
    : [[], []];

  return (
    <>
      <h1>Words &amp; sentences</h1>
      <p className="muted">
        Everything across all your lessons. Removing an item from a lesson doesn&rsquo;t delete it
        — it stays here, keeping the practice it earned.
      </p>

      {ownerId ? (
        <ItemsBrowser
          ownerSub={ownerId}
          items={items}
          facets={facets}
          query={query}
          initialSearch={parseSearchTerm(params)}
        />
      ) : (
        <section className="panel">
          <p className="muted">Log in to see your words.</p>
        </section>
      )}
    </>
  );
}
