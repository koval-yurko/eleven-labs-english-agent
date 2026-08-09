"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import {
  CEFR_LEVELS,
  ITEM_KINDS,
  UNLEVELED,
  type ItemFacet,
  type ItemKind,
  type ItemRow,
} from "@tutor/shared/word-types";
import { serializeItemsQuery, type ItemsQuery, type SortKey } from "@tutor/shared/items-query";
import { groupFacets, searchItems, sortChoices } from "@tutor/shared/item-list";
import {
  createLessonLocal,
  defaultLessonTitle,
  flushOutboxNow,
  requestFlush,
} from "../../lib/sync/engine";
import { MAX_ITEMS } from "@tutor/shared/sync-ops";
import { ensureOwner } from "../../lib/sync/mirror";
import { formatDate } from "../../lib/format-date";
import { useNavigationTransition } from "../nav-progress";
import { NavLink } from "../NavLink";
import { SortArrowIcon, StarIcon } from "../icons";
import { Select, type SelectOption } from "../Select";
import { Checkbox } from "../Checkbox";
import { Button } from "../Button";
import { AddWordForm } from "./AddWordForm";
import { FavoriteButton } from "./FavoriteButton";

/** Hoisted out of the render so <Select> gets a stable `options` identity. */
const SORT_OPTIONS: SelectOption<SortKey>[] = sortChoices().map(({ key, label }) => ({
  value: key,
  label,
}));

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
  // Both navigations below are real server round-trips; running them inside this transition is
  // what puts them on the top progress bar. See docs/2026-07-26-navigation-progress-bar.md.
  const startNavigation = useNavigationTransition();
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

    // Title normalization/cap and item id minting both live in `createLessonLocal`.
    const title = lessonTitle.trim() || (await defaultLessonTitle());
    const id = crypto.randomUUID();

    setCreating(true);
    try {
      await ensureOwner(ownerSub); // guard the shared-device mirror before the first write
      await createLessonLocal({ id, title, texts });
      clearSelection();
      if (typeof navigator !== "undefined" && navigator.onLine) {
        await flushOutboxNow(); // apply the create so the RSC lesson page can load it
        startNavigation(() => router.push(`/lessons/${id}`));
      } else {
        requestFlush(); // queued — applies on reconnect; already visible in the lessons list
      }
    } finally {
      setCreating(false);
    }
  }

  /** Rebuild the URL from the current query + one change. Absent/default values drop out.
   *  The grammar itself (which params, which defaults) lives in `shared/items-query.ts`, so this
   *  cannot drift from the parser on the page — which is exactly what it used to do. */
  function hrefWith(change: Partial<ItemsQuery>): string {
    const qs = serializeItemsQuery({ ...query, ...change }, search);
    return qs ? `/lesson-items?${qs}` : "/lesson-items";
  }

  // Every filter/sort chip re-runs the query on the server, so the bar shows here too — it is the
  // only feedback these controls have, and it reflects work that genuinely is happening.
  function apply(change: Partial<ItemsQuery>) {
    startNavigation(() => router.replace(hrefWith(change), { scroll: false }));
  }

  function onSearch(value: string) {
    setSearch(value);
    // Keep the URL shareable without a navigation (and without re-querying) on every keystroke.
    const url = new URL(window.location.href);
    if (value) url.searchParams.set("q", value);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }

  /** `null` clears the filter — the ToggleGroup reports an empty selection when its chip is unpressed. */
  function setCategory(name: string, value: string | null) {
    const categories = { ...query.categories };
    if (value === null) delete categories[name];
    else categories[name] = value;
    apply({ categories });
  }

  const visible = useMemo(() => searchItems(items, search), [items, search]);

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
          <ToggleFilters
            label="Level"
            multiple
            value={query.levels}
            onValueChange={(levels) => apply({ levels })}
          >
            {[...CEFR_LEVELS, UNLEVELED].map((level) => (
              <Chip key={level} value={level}>
                {level === UNLEVELED ? "not levelled" : level}
              </Chip>
            ))}
          </ToggleFilters>

          {/* Single-select: the group unpresses the previous chip, and clicking the pressed one
              clears the filter — the same behaviour the old onClick spelled out by hand. */}
          <ToggleFilters
            label="Kind"
            value={query.kind ? [query.kind] : []}
            onValueChange={([kind]) => apply({ kind: (kind as ItemKind) ?? null })}
          >
            {ITEM_KINDS.map((kind) => (
              <Chip key={kind} value={kind}>
                {kind}
              </Chip>
            ))}
          </ToggleFilters>

          {/* Two independent booleans, so `multiple` — they're a labelled set, not alternatives. */}
          <ToggleFilters
            label="Show"
            multiple
            value={[
              ...(query.favoritesOnly ? ["favorites"] : []),
              ...(query.unassignedOnly ? ["unassigned"] : []),
            ]}
            onValueChange={(shown) =>
              apply({
                favoritesOnly: shown.includes("favorites"),
                unassignedOnly: shown.includes("unassigned"),
              })
            }
          >
            <Chip value="favorites">
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <StarIcon state={query.favoritesOnly ? "filled" : "empty"} size={14} />
                favorites
              </span>
            </Chip>
            <Chip value="unassigned">in no lesson</Chip>
          </ToggleFilters>

          {/* Rendered from the data itself (the owner_item_facets view), so a category name added
              later needs no code change here. */}
          {groupFacets(facets).map(([name, values]) => (
            <ToggleFilters
              key={name}
              label={name}
              value={query.categories[name] ? [query.categories[name]] : []}
              onValueChange={([value]) => setCategory(name, value ?? null)}
            >
              {values.map((f) => (
                <Chip key={f.value} value={f.value}>
                  {f.value} <span className="muted">{f.item_count}</span>
                </Chip>
              ))}
            </ToggleFilters>
          ))}

          <FilterGroup label="Sort by">
            <Select
              label="Sort by"
              value={query.sort}
              onValueChange={(sort) => apply({ sort })}
              options={SORT_OPTIONS}
            />
            {/* Not a toggle: it flips between two named directions rather than being on or off, so
                it stays a plain button and only borrows the chip's look. */}
            <button
              type="button"
              className="chip"
              onClick={() => apply({ dir: query.dir === "asc" ? "desc" : "asc" })}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}>
                <SortArrowIcon dir={query.dir} size={14} />
                {query.dir === "asc" ? "ascending" : "descending"}
              </span>
            </button>
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
          <Button onClick={createFromSelection} disabled={creating}>
            {creating ? "Creating…" : "Create lesson"}
          </Button>
          <button type="button" className="chip" onClick={clearSelection}>
            Clear
          </button>
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
    `added ${formatDate(item.first_added_at)}`,
    item.last_practiced_at ? `last practiced ${formatDate(item.last_practiced_at)}` : null,
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
      <Checkbox checked={selected} onCheckedChange={onToggle} label={`Select ${item.text}`} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <strong>
          <NavLink href={`/lesson-items/${item.id}`}>{item.text}</NavLink>
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

/**
 * A labelled row of filter chips, backed by a `ToggleGroup`.
 *
 * The chips always exposed `aria-pressed` — what they never exposed was that they belong together.
 * The "LEVEL" caption was a loose `<div>`, so a screen reader announced "A2, pressed" with no hint
 * of what it filters. `aria-labelledby` on the group is what ties the caption to its chips.
 *
 * The other half is focus: twelve chips were twelve consecutive tab stops. A ToggleGroup is one
 * tab stop with arrow keys inside it, which is the standard behaviour for a set of related toggles.
 *
 * Values are plain strings so one component serves every filter row — CEFR levels, kinds, and the
 * category facets that are generated from the data.
 */
function ToggleFilters({
  label,
  value,
  onValueChange,
  multiple,
  children,
}: {
  label: string;
  value: string[];
  onValueChange: (value: string[]) => void;
  /** `false` (the default) makes the chips mutually exclusive, and clicking the pressed one clears it. */
  multiple?: boolean;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div>
      <div className="muted filter-label" id={labelId}>
        {label}
      </div>
      <ToggleGroup
        aria-labelledby={labelId}
        value={value}
        onValueChange={onValueChange}
        multiple={multiple}
        className="filter-row"
      >
        {children}
      </ToggleGroup>
    </div>
  );
}

/** The same caption + row, for the one group whose contents aren't toggles (a Select and a button). */
function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="muted filter-label">{label}</div>
      <div className="filter-row">{children}</div>
    </div>
  );
}

/** A chip inside a ToggleFilters row. Pressed state comes from the group, not a prop. */
function Chip({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Toggle value={value} className="chip">
      {children}
    </Toggle>
  );
}

