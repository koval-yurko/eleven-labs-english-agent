"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CEFR_LEVELS,
  ITEM_KINDS,
  UNLEVELED,
  type ItemFacet,
  type ItemRow,
  type ItemsQuery,
  type SortKey,
} from "../../lib/lesson-items";
import { AddWordForm } from "./AddWordForm";
import { FavoriteButton } from "./FavoriteButton";

const SORT_LABELS: Record<SortKey, string> = {
  practice: "Times practiced",
  lessons: "Lessons",
  created: "Date added",
  practiced: "Last practiced",
  favorite: "Favorites",
  level: "Level",
  text: "Alphabetical",
};

/**
 * The whole `/lesson-items` surface: search box, filters, and the list.
 *
 * Two different mechanisms on purpose:
 *  - **Filters and sort go through the URL** (server round-trip). They need Postgres — the level
 *    filter and every statistic are computed there — and the URL keeps the view shareable and
 *    back-button-correct.
 *  - **Search filters in memory.** The filtered list is small (hundreds of rows at the
 *    50-items-per-lesson cap), so it is already here; a round-trip per keystroke would be the
 *    wrong interaction. `?q=` is kept in the URL via replaceState so a reload/share keeps it,
 *    without re-rendering the page on every character.
 */
export function ItemsBrowser({
  items,
  facets,
  query,
  initialSearch,
}: {
  items: ItemRow[];
  facets: ItemFacet[];
  query: ItemsQuery;
  initialSearch: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);

  /** Rebuild the URL from the current query + one change. Absent/false values drop out. */
  function hrefWith(change: Partial<ItemsQuery>): string {
    const next = { ...query, ...change };
    const params = new URLSearchParams();
    for (const level of next.levels) params.append("level", level);
    if (next.favoritesOnly) params.set("fav", "1");
    if (next.kind) params.set("kind", next.kind);
    if (next.unassignedOnly) params.set("unassigned", "1");
    for (const [name, value] of Object.entries(next.categories)) params.set(`cat.${name}`, value);
    if (next.sort !== "practice") params.set("sort", next.sort);
    if (next.dir !== "desc") params.set("dir", next.dir);
    if (search) params.set("q", search);
    const qs = params.toString();
    return qs ? `/lesson-items?${qs}` : "/lesson-items";
  }

  function apply(change: Partial<ItemsQuery>) {
    router.replace(hrefWith(change), { scroll: false });
  }

  function onSearch(value: string) {
    setSearch(value);
    // Keep the URL shareable without a navigation (and without re-querying) on every keystroke.
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }

  function toggleLevel(level: string) {
    const levels = query.levels.includes(level)
      ? query.levels.filter((l) => l !== level)
      : [...query.levels, level];
    apply({ levels });
  }

  function toggleCategory(name: string, value: string) {
    const categories = { ...query.categories };
    if (categories[name] === value) delete categories[name];
    else categories[name] = value;
    apply({ categories });
  }

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () => (needle ? items.filter((i) => i.text.toLowerCase().includes(needle)) : items),
    [items, needle],
  );

  return (
    <>
      <AddWordForm />

      <section className="panel">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Search your words and sentences…"
          aria-label="Search words and sentences"
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: "1.25rem", marginTop: "0.9rem" }}>
          <FilterGroup label="Level">
            {[...CEFR_LEVELS, UNLEVELED].map((level) => (
              <Chip
                key={level}
                active={query.levels.includes(level)}
                onClick={() => toggleLevel(level)}
              >
                {level === UNLEVELED ? "not levelled" : level}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Kind">
            {ITEM_KINDS.map((kind) => (
              <Chip
                key={kind}
                active={query.kind === kind}
                onClick={() => apply({ kind: query.kind === kind ? null : kind })}
              >
                {kind}
              </Chip>
            ))}
          </FilterGroup>

          <FilterGroup label="Show">
            <Chip
              active={query.favoritesOnly}
              onClick={() => apply({ favoritesOnly: !query.favoritesOnly })}
            >
              ★ favorites
            </Chip>
            <Chip
              active={query.unassignedOnly}
              onClick={() => apply({ unassignedOnly: !query.unassignedOnly })}
            >
              in no lesson
            </Chip>
          </FilterGroup>

          {/* Rendered from the data itself (the owner_item_facets view), so a category name added
              later needs no code change here. */}
          {groupFacets(facets).map(([name, values]) => (
            <FilterGroup key={name} label={name}>
              {values.map((f) => (
                <Chip
                  key={f.value}
                  active={query.categories[name] === f.value}
                  onClick={() => toggleCategory(name, f.value)}
                >
                  {f.value} <span className="muted">{f.item_count}</span>
                </Chip>
              ))}
            </FilterGroup>
          ))}

          <FilterGroup label="Sort by">
            <select
              value={query.sort}
              onChange={(e) => apply({ sort: e.target.value as SortKey })}
              style={{ background: "var(--field-bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, padding: "0.3rem 0.4rem" }}
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key]}
                </option>
              ))}
            </select>
            <Chip active={false} onClick={() => apply({ dir: query.dir === "asc" ? "desc" : "asc" })}>
              {query.dir === "asc" ? "↑ ascending" : "↓ descending"}
            </Chip>
          </FilterGroup>
        </div>
      </section>

      <section className="panel">
        <h2>
          {visible.length} {visible.length === 1 ? "item" : "items"}
        </h2>
        {visible.length === 0 ? (
          <p className="muted">
            {items.length === 0
              ? "Nothing here yet — add a word above, or add some to a lesson."
              : "No match for this search."}
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {visible.map((item) => (
              <ItemLine key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ItemLine({ item }: { item: ItemRow }) {
  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
    item.last_practiced_at
      ? `last practiced ${new Date(item.last_practiced_at).toLocaleDateString()}`
      : null,
  ].filter(Boolean);

  return (
    <li style={{ padding: "0.6rem 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
        <FavoriteButton normKey={item.norm_key} text={item.text} initial={item.is_favorite} />
        <strong style={{ flex: 1 }}>{item.text}</strong>
        {item.level ? (
          <span className="muted" style={{ fontSize: "0.85rem", border: "1px solid var(--border)", borderRadius: 999, padding: "0 0.5rem" }}>
            {item.level}
          </span>
        ) : null}
      </div>

      <div className="muted" style={{ fontSize: "0.9rem" }}>
        {stats.join(" · ")}
      </div>

      <div className="muted" style={{ fontSize: "0.9rem" }}>
        {item.lessons.length > 0 ? (
          item.lessons.map((l, i) => (
            <span key={l.id}>
              {i > 0 ? " · " : ""}
              <a href={`/lessons/${l.id}`}>{l.title}</a>
            </span>
          ))
        ) : (
          // Removal detaches an item from a lesson; it never deletes it.
          <em>in no lesson</em>
        )}
      </div>
    </li>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", alignItems: "center", marginTop: "0.25rem" }}>
        {children}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--on-accent)" : "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "0.2rem 0.7rem",
        margin: 0,
        fontWeight: 500,
        fontSize: "0.9rem",
      }}
    >
      {children}
    </button>
  );
}

/** `[{name: "topic", value: "business"}, …]` → `[["topic", [{…}]], …]`, one filter row per name. */
function groupFacets(facets: ItemFacet[]): [string, ItemFacet[]][] {
  const byName = new Map<string, ItemFacet[]>();
  for (const facet of facets) {
    const list = byName.get(facet.name) ?? [];
    list.push(facet);
    byName.set(facet.name, list);
  }
  return [...byName.entries()];
}
