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
import {
  createLessonLocal,
  defaultLessonTitle,
  flushOutboxNow,
  requestFlush,
  MAX_ITEMS,
} from "../../lib/sync/engine";
import { ensureOwner } from "../../lib/sync/mirror";
import { SortArrowIcon, StarIcon } from "../icons";
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
  ownerSub,
  items,
  facets,
  query,
  initialSearch,
}: {
  ownerSub: string;
  items: ItemRow[];
  facets: ItemFacet[];
  query: ItemsQuery;
  initialSearch: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(initialSearch);

  // Multi-select → "create a lesson from these words". Kept as an id → text map (not just an id set)
  // and NOT pruned when a filter changes, so a learner can tick words across several filtered views
  // and create one lesson from the union — `ItemRow.text` only exists for currently-visible rows, so
  // the map is what lets create stay correct for selected words the active filter has scrolled out.
  // Insertion order = selection order, which is the order they end up in the new lesson.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [lessonTitle, setLessonTitle] = useState("");
  const [creating, setCreating] = useState(false);

  function toggleSelect(id: string, text: string) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, text);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Map());
    setLessonTitle("");
  }

  /** Create a new lesson from the selected words, reusing the offline outbox path (as NewLessonForm
   *  does): mirror + queue the create, then online push to it / offline leave it queued. */
  async function createFromSelection() {
    if (creating) return;
    const texts = [...selected.values()].slice(0, MAX_ITEMS);
    if (texts.length === 0) return;

    const title = (lessonTitle.trim() || (await defaultLessonTitle())).slice(0, 120);
    const id = crypto.randomUUID();

    setCreating(true);
    try {
      await ensureOwner(ownerSub); // guard the shared-device mirror before the first write
      await createLessonLocal({
        id,
        title,
        items: texts.map((text) => ({ id: crypto.randomUUID(), text })),
      });
      clearSelection();
      if (typeof navigator !== "undefined" && navigator.onLine) {
        await flushOutboxNow(); // apply the create so the RSC lesson page can load it
        router.push(`/lessons/${id}`);
      } else {
        requestFlush(); // queued — applies on reconnect; already visible in the lessons list
      }
    } finally {
      setCreating(false);
    }
  }

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
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <StarIcon state={query.favoritesOnly ? "filled" : "empty"} size={14} />
                favorites
              </span>
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <SortArrowIcon dir={query.dir} size={14} />
                {query.dir === "asc" ? "ascending" : "descending"}
              </span>
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
              <ItemLine
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={() => toggleSelect(item.id, item.text)}
              />
            ))}
          </ul>
        )}
      </section>

      {selected.size > 0 ? (
        <div
          style={{
            position: "sticky",
            bottom: "1rem",
            marginTop: "1rem",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.6rem",
            padding: "0.75rem 1rem",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
          }}
        >
          <strong>
            {selected.size} selected
            {selected.size > MAX_ITEMS ? ` (first ${MAX_ITEMS} used)` : ""}
          </strong>
          <input
            value={lessonTitle}
            onChange={(e) => setLessonTitle(e.target.value)}
            placeholder="Lesson title (optional)"
            maxLength={120}
            aria-label="New lesson title"
            style={{
              flex: 1,
              minWidth: "12rem",
              background: "var(--field-bg)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "0.35rem 0.5rem",
            }}
          />
          <button type="button" onClick={createFromSelection} disabled={creating}>
            {creating ? "Creating…" : "Create lesson"}
          </button>
          <Chip active={false} onClick={clearSelection}>
            Clear
          </Chip>
        </div>
      ) : null}
    </>
  );
}

function ItemLine({
  item,
  selected,
  onToggle,
}: {
  item: ItemRow;
  selected: boolean;
  onToggle: () => void;
}) {
  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
    item.last_practiced_at
      ? `last practiced ${new Date(item.last_practiced_at).toLocaleDateString()}`
      : null,
  ].filter(Boolean);

  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.85rem",
        padding: "0.6rem 0",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select ${item.text}`}
        style={{ width: "1.25rem", height: "1.25rem", flexShrink: 0, cursor: "pointer" }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>
          <a href={`/lesson-items/${item.id}`}>{item.text}</a>
        </strong>
        {/* The lessons this word is in live on its detail page now, not inline here. */}
        <div className="muted" style={{ fontSize: "0.9rem" }}>
          {stats.join(" · ")}
        </div>
      </div>

      {item.level ? (
        <span className="muted" style={{ fontSize: "0.85rem", border: "1px solid var(--border)", borderRadius: 999, padding: "0 0.5rem" }}>
          {item.level}
        </span>
      ) : null}
      <FavoriteButton normKey={item.norm_key} text={item.text} initial={item.is_favorite} />
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
