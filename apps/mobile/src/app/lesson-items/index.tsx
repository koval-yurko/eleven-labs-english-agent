import type { ItemsResponse } from "@tutor/shared/api";
import { groupFacets, searchItems, sortChoices } from "@tutor/shared/item-list";
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  type ItemsQuery,
  type SortKey,
} from "@tutor/shared/items-query";
import {
  buildCreateLessonOp,
  MAX_ITEMS,
  MAX_LESSON_TITLE,
  nextLessonTitle,
} from "@tutor/shared/sync-ops";
import { type Palette } from "@tutor/shared/theme";
import {
  CEFR_LEVELS,
  ITEM_KINDS,
  UNLEVELED,
  type ItemKind,
  type ItemRow,
} from "@tutor/shared/word-types";
import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAccessToken } from "@/lib/auth";
import { newId } from "@/lib/ids";
import { addWord, bumpPopularity, deleteWord, fetchItems } from "@/lib/items";
import { clearSuggestionCache, fetchSuggestions } from "@/lib/suggestions";
import { fetchLessons, postOp } from "@/lib/lessons";
import { useTheme } from "@/theme";
import {
  Autocomplete,
  Body,
  Button,
  ButtonRow,
  Checkbox,
  Chip,
  ChipRow,
  ConfirmDialog,
  ErrorText,
  Faint,
  H1,
  H2,
  Link,
  Muted,
  Panel,
  PromptDialog,
  RefreshButton,
  Screen,
  Select,
  SortArrowIcon,
  TextField,
  TrashIcon,
  radius,
  space,
  type,
  useLoadingIndicator,
  type AutocompleteOption,
  type SelectOption,
} from "@/ui";

/**
 * `/lesson-items` — every word the learner has, across every lesson.
 *
 * **The filter grammar has exactly one implementation and this screen does not add a second.**
 * `ItemsQuery` lives in React state instead of in a URL (there is no address bar), but
 * `serializeItemsQuery` — reached through `itemsPath` — still encodes it and the server still
 * decodes it with `parseItemsQuery`. `pnpm check:shared` proves those two are inverse over 10,752
 * cases, and that property is the entire reason the phone and the web can be trusted to show the
 * same rows for the same filters (S6 D61).
 *
 * **Two mechanisms, deliberately, exactly as on the web.** Filters and sort go to Postgres (the
 * levels, the statistics and the ordering are all computed there); free-text search filters the
 * already-loaded list in memory. `?q=` is not part of `ItemsQuery` and never reaches the wire.
 *
 * ## What the design port changed
 *
 * This screen had the most native machinery in the app and now has none: the SwiftUI `List` with
 * its selection and swipe actions, the sort `Menu`, the filter `BottomSheet`, the
 * `ContentUnavailableView`, and `Alert.prompt` for adding a word are all gone, replaced by the
 * web's layout — an add-word panel, flat chip rows, a `Select`, and checkbox list rows.
 *
 * The riskiest part was the filters. The web lays out six groups of chips flat because it can; the
 * `BottomSheet` existed precisely because that is a lot of vertical space at phone width (S6 §4.3).
 * That risk is now paid off differently from either: the search box and all six chip groups live in
 * ONE collapsible panel, closed by default. It is the sheet's saving without the sheet's machinery,
 * and it keeps the flat layout the port went to for — the groups are still flat, they are just
 * folded. The header states what is active while it is closed, which is the whole obligation a
 * collapsed filter panel takes on.
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.3, §10.3.
 *
 * **Search is typo-tolerant** (`searchItems`, `@tutor/shared/item-list`): it folds the way the
 * add-word autocomplete folds its prefixes, so `cafe` finds `café`, and it allows a bounded number
 * of edits, so `ubiqutous` finds `ubiquitous`. Still in memory, still not on the wire.
 */
const EMPTY_QUERY: ItemsQuery = {
  levels: [],
  kind: null,
  unassignedOnly: false,
  categories: {},
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
};

/** Hoisted out of the render so `<Select>` gets a stable `options` identity. */
const SORT_OPTIONS: SelectOption<SortKey>[] = sortChoices().map(({ key, label }) => ({
  value: key as SortKey,
  label,
}));

/** How many filters are on — so a filter is never silently active with nothing to say so. */
function activeFilterCount(query: ItemsQuery): number {
  return (
    query.levels.length +
    (query.kind ? 1 : 0) +
    (query.unassignedOnly ? 1 : 0) +
    Object.keys(query.categories).length
  );
}

export default function CollectionScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useAccessToken();

  const [query, setQuery] = useState<ItemsQuery>(EMPTY_QUERY);
  const [data, setData] = useState<ItemsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  /**
   * Selected words, `id → text`, and NOT pruned when the filter changes — a learner ticks words
   * across several filtered views and creates one lesson from the union. It holds the text because
   * `ItemRow` only exists for rows the current filter renders, so the map is what keeps a selection
   * usable after its row has scrolled out of the query entirely. Insertion order is selection order,
   * which is the order the words end up in the new lesson.
   */
  const [selected, setSelected] = useState<Map<string, string>>(new Map());

  /**
   * Whether the "name this lesson" prompt is up.
   *
   * The title used to be a `TextField` living in the selection panel. It cannot stay there now that
   * the panel is a bar pinned above the keyboard — so **Create lesson** opens a dialog and the
   * value never lives on this screen at all. See §3.3 of the doc.
   */
  const [titlePromptOpen, setTitlePromptOpen] = useState(false);

  /** Which row's delete is awaiting an answer — one dialog for the whole list, not one per row. */
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; text: string } | null>(null);

  useLoadingIndicator(data === null || busy);

  const load = useCallback(
    async (next: ItemsQuery) => {
      try {
        setData(await fetchItems(accessToken, next));
        setLoadError(null);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    },
    [accessToken],
  );

  useEffect(() => {
    void (async () => {
      await load(query);
    })();
  }, [load, query]);

  /** Every filter/sort change is a server round trip — the level filter and every statistic are Postgres'. */
  const apply = useCallback((change: Partial<ItemsQuery>) => {
    setQuery((prev) => ({ ...prev, ...change }));
  }, []);

  const items = data?.items ?? null;
  // `items ? … : []` rather than `items ?? []`: the empty literal is `never[]`, which widens
  // `searchItems`' generic to its constraint (`{ text: string }`) and loses every other column.
  const visible = useMemo<ItemRow[]>(
    () => (items ? searchItems(items, search) : []),
    [items, search],
  );

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
  }

  /**
   * Delete a word for good — optimistic, with two obligations no other write on this screen has.
   *
   * **The selection is pruned.** `selected` is deliberately not pruned when the FILTER changes (see
   * its declaration), because a word scrolling out of a query is still selected. A word that no
   * longer exists is a different case: left in the map it would be sent to `createFromSelection` as
   * a text with no row behind it, and the new lesson would quietly resurrect it as a fresh word.
   *
   * **The optimistic drop is the whole feedback.** There is no server round trip to wait for and
   * nothing else on the row changes, so a failure has to put the row back where it was — hence the
   * snapshot rather than a refetch, which needs a network the failure suggests is missing.
   */
  async function removeWord(item: { id: string; text: string }) {
    const snapshot = data;
    setWriteError(null);
    setData((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev));
    setSelected((prev) => {
      if (!prev.has(item.id)) return prev;
      const next = new Map(prev);
      next.delete(item.id);
      return next;
    });
    try {
      await deleteWord(accessToken, item.id);
      // ⚠️ Not optional since suggestions started carrying `wordId` (0017). A cached bucket holds
      // the id of the row just destroyed, and tapping it would open a word that no longer exists.
      // Dropping the cache costs a ~7 KB refetch on the next word typed.
      clearSuggestionCache();
    } catch (e) {
      setData(snapshot);
      setWriteError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Create a lesson from the ticked words — the one place this screen writes a lesson, and it goes
   * through S5's proven path (`buildCreateLessonOp` + `postOp`) rather than growing a second one.
   *
   * ⚠️ The **title fallback is not optional**, and its absence here was a real bug: a blank box
   * produced `title: ""`, which nothing downstream repairs (`applyOp` only trims and caps,
   * `lessons.title` is `not null` but has no non-empty check) — so the lesson was written with a
   * permanently invisible title. The lessons screen has always applied it; this screen could not
   * copy the line because it has no lesson list to take `taken` from, so it fetches one — on the
   * blank branch only, which is the only branch that needs it.
   */
  async function createFromSelection(rawTitle: string) {
    const texts = [...selected.values()].slice(0, MAX_ITEMS);
    if (texts.length === 0 || busy) return;
    setBusy(true);
    setWriteError(null);

    let title = rawTitle.trim();
    if (!title) {
      // A failed fetch degrades to the bare date rather than to no title at all: a same-day
      // duplicate is a cosmetic problem, an empty title is an unreachable lesson.
      const taken = await fetchLessons(accessToken)
        .then((lessons) => new Set(lessons.map((l) => l.title)))
        .catch(() => new Set<string>());
      title = nextLessonTitle(taken, new Date());
    }

    const op = buildCreateLessonOp(newId(), title, texts, newId);
    try {
      await postOp(accessToken, op);
      clearSelection();
      router.push(`/lessons/${op.lesson.id}`);
    } catch (e) {
      // The selection is deliberately kept: it is what the learner would have to rebuild by hand.
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filterCount = activeFilterCount(query);
  /** What the collapsed search panel confesses to. `undefined` when nothing is on. */
  const searchSummary =
    [
      search.trim() ? `“${search.trim()}”` : null,
      filterCount > 0 ? `${filterCount} ${filterCount === 1 ? "filter" : "filters"}` : null,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load(query).finally(() => setRefreshing(false));
      }}
      /*
        The actions live outside the scroll container now — the whole point of the change. They
        used to be a panel at the END of the page, which meant ticking a row at the top of a
        70-row list and then scrolling past all of it to act on the tick.

        One row, and it has to stay one row: it sits above the keyboard and it truncates the list
        it acts on. That is what pushed the lesson-title field out into a dialog (§3.3), and it is
        the constraint any further bulk action — deleting the selection, say — has to fit inside.
      */
      footer={
        selected.size > 0 ? (
          <View style={styles.selectionBar}>
            <Body style={styles.selectionCount}>
              {selected.size} selected
              {selected.size > MAX_ITEMS ? ` (first ${MAX_ITEMS})` : ""}
            </Body>
            <Button
              size="sm"
              label={busy ? "Creating…" : "Create lesson"}
              disabled={busy}
              onPress={() => setTitlePromptOpen(true)}
            />
            <Chip label="Clear" onPress={clearSelection} />
          </View>
        ) : null
      }
    >
      <H1>Words &amp; sentences</H1>
      <Muted>
        Everything across all your lessons. Removing an item from a lesson doesn&rsquo;t delete it —
        it stays here, keeping the practice it earned.
      </Muted>

      <AddWordForm
        onAdded={async () => {
          await load(query);
        }}
        getToken={accessToken}
      />

      {/*
        Collapsed by default, and the `summary` is the price of that. A closed panel that is
        silently filtering the list below it is the one failure mode this affordance has — see
        `Panel`'s docblock — so the header states the search term and the filter count whenever
        either is on. The search text itself lives on the screen, not in the `TextField`, so folding
        the panel does not clear it.
      */}
      <Panel
        title="Search & filters"
        summary={searchSummary}
        collapsible
        defaultOpen={false}
      >
        <TextField
          value={search}
          onChangeText={setSearch}
          placeholder="Search your words and sentences…"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          accessibilityLabel="Search words and sentences"
        />

        <View style={styles.filters}>
          <ChipRow label="Level">
            {[...CEFR_LEVELS, UNLEVELED].map((level) => (
              <Chip
                key={level}
                label={level === UNLEVELED ? "not levelled" : level}
                pressed={query.levels.includes(level)}
                onPress={() =>
                  apply({
                    levels: query.levels.includes(level)
                      ? query.levels.filter((l) => l !== level)
                      : [...query.levels, level],
                  })
                }
              />
            ))}
          </ChipRow>

          {/* Single-select: pressing the pressed one clears the filter. */}
          <ChipRow label="Kind">
            {ITEM_KINDS.map((kind) => (
              <Chip
                key={kind}
                label={kind}
                pressed={query.kind === kind}
                onPress={() => apply({ kind: query.kind === kind ? null : (kind as ItemKind) })}
              />
            ))}
          </ChipRow>

          {/* One boolean since the favourites filter went with the flag (0017), and still its own
              labelled row: it is a filter, not an alternative to the level or kind above it. */}
          <ChipRow label="Show">
            <Chip
              label="in no lesson"
              pressed={query.unassignedOnly}
              onPress={() => apply({ unassignedOnly: !query.unassignedOnly })}
            />
          </ChipRow>

          {/* Rendered from the data itself (the owner_item_facets view), so a category name added
              later needs no code change here. ⚠️ There are zero facet rows today, so this block
              renders nothing at all — expected, not a bug (S6 §3 / D67). */}
          {groupFacets(data?.facets ?? []).map(([name, values]) => (
            <ChipRow key={name} label={name}>
              {values.map((facet) => (
                <Chip
                  key={facet.value}
                  label={`${facet.value} ${facet.item_count}`}
                  pressed={query.categories[name] === facet.value}
                  onPress={() => {
                    const categories = { ...query.categories };
                    if (categories[name] === facet.value) delete categories[name];
                    else categories[name] = facet.value;
                    apply({ categories });
                  }}
                />
              ))}
            </ChipRow>
          ))}

          <ChipRow label="Sort by">
            <Select
              label="Sort by"
              value={query.sort}
              onValueChange={(sort) => apply({ sort })}
              options={SORT_OPTIONS}
            />
            {/* Not a toggle: it flips between two named directions rather than being on or off, so
                it stays a plain button and only borrows the chip's look. */}
            <Chip
              label={query.dir === "asc" ? "ascending" : "descending"}
              onPress={() => apply({ dir: query.dir === "asc" ? "desc" : "asc" })}
            >
              <SortArrowIcon dir={query.dir} size={14} color={theme.text} />
            </Chip>
            {filterCount > 0 ? <Chip label="Clear" onPress={() => setQuery(EMPTY_QUERY)} /> : null}
          </ChipRow>
        </View>
      </Panel>

      {writeError ? (
        <Panel tone="error">
          <ErrorText>{writeError}</ErrorText>
        </Panel>
      ) : null}

      <Panel>
        <View style={styles.listHead}>
          <H2 style={{ flex: 1 }}>
            {visible.length} {visible.length === 1 ? "item" : "items"}
          </H2>
          {/* Levels arrive from a background job, so the count and the badges beside it can be
              stale the moment a word is added. Refreshing keeps the search box and the selection. */}
          <RefreshButton label="Refresh list" onRefresh={() => load(query)} />
        </View>

        {loadError ? (
          <>
            <ErrorText>{loadError}</ErrorText>
            <ButtonRow style={{ marginTop: space.row }}>
              <Button variant="secondary" label="Try again" onPress={() => void load(query)} />
            </ButtonRow>
          </>
        ) : items === null ? (
          <ActivityIndicator color={theme.accent} />
        ) : visible.length === 0 ? (
          <Muted>
            {items.length === 0
              ? "Nothing here yet — add a word above, or add some to a lesson."
              : "No match for this search."}
          </Muted>
        ) : (
          visible.map((item) => (
            <ItemLine
              key={item.id}
              item={item}
              selected={selected.has(item.id)}
              onToggle={() => toggleSelect(item.id, item.text)}
              onDelete={() => setConfirmTarget({ id: item.id, text: item.text })}
            />
          ))
        )}
      </Panel>

      {/*
        Naming the lesson. `initialValue=""` on purpose rather than today's date pre-filled: an
        empty box means "use the default", and `createFromSelection` is the one place that decides
        what the default IS (it needs the taken titles to number a same-day duplicate, which this
        dialog has no business fetching).
      */}
      <PromptDialog
        open={titlePromptOpen}
        onOpenChange={setTitlePromptOpen}
        title={`New lesson from ${selected.size} ${selected.size === 1 ? "word" : "words"}`}
        description="Leave it empty and it gets today's date."
        label="New lesson title"
        placeholder="Lesson title (optional)"
        maxLength={MAX_LESSON_TITLE}
        submitLabel="Create lesson"
        onSubmit={(title) => void createFromSelection(title)}
      />

      {/*
        One dialog for the whole list, driven by which row is pending.

        The copy is NOT the lessons list's copy, and the difference is the point. That dialog
        reassures — "Your words and their practice history stay in your collection" — because
        deleting a lesson keeps both. This one has to warn, because deleting a word takes its
        membership in every lesson and the practice statistics derived from those links with it.
        The transcripts survive; the word's credit in them does not.
      */}
      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget ? `Delete “${confirmTarget.text}”?` : ""}
        description="It leaves every lesson and loses its practice history and translation. This can’t be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmTarget) void removeWord(confirmTarget);
        }}
      />
    </Screen>
  );
}

/**
 * Add one word, in no lesson — the web's `AddWordForm`, replacing `Alert.prompt`.
 *
 * Single-line on purpose: the ask is an *individual* word. A textarea would invite bulk paste, and
 * a bulk paste wants a lesson to live in — that flow already exists on the lesson page.
 *
 * `already-present` is announced rather than swallowed: the collection groups by `norm_key`, so a
 * duplicate add changes nothing in the LIST, and the count it bumps is the thing worth saying.
 *
 * Two ways out of this field, and they are not the same. Tapping a suggestion the learner already
 * owns bumps that word and opens it (`openOwned`); pressing **Add** is the fallback for everything
 * the dictionary does not know — phrases, whole sentences, words outside the 53k lexicon — and it
 * bumps too, on the server side of `addWord`.
 */
function AddWordForm({
  getToken,
  onAdded,
}: {
  getToken: () => Promise<string | null>;
  onAdded: () => Promise<void>;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "warn"; message: string } | null>(null);

  // Memoised because `Autocomplete` re-runs its debounce effect whenever `search` changes
  // identity: an inline arrow would restart the timer on every keystroke's render and the request
  // would never fire. Safe to depend on `getToken` — the screen already builds it with
  // `useCallback` (`accessToken`, above), which is the same reason `addWord` can hold it.
  const search = useCallback(
    async (query: string): Promise<AutocompleteOption<string | null>[]> => {
      const suggestions = await fetchSuggestions(getToken, query);
      return suggestions.map((s) => ({
        key: s.text,
        label: s.text,
        badge: s.level,
        // Up to three glosses come back; two is what fits at phone width. The full set is on the
        // word detail page, which renders `WordDetails.translations_ru`.
        detail: s.ru.slice(0, 2).join(", "),
        // `wordId !== null` IS "already in your collection" — one column answers both questions
        // (0017), and the id rides along as the row's payload so the tap can act on it.
        marked: s.wordId !== null,
        data: s.wordId,
      }));
    },
    [getToken],
  );

  /**
   * Tapping a row the learner ALREADY has: +1 its popularity and open the word.
   *
   * The one place this screen departs from `Autocomplete`'s "fill the field, never submit" rule,
   * and it is scoped to exactly the rows the server says are already owned — a mis-tap costs a
   * screen you can come back from and a counter that means "I met this again". An unowned row is
   * untouched: it fills the field and waits for **Add**, as it always did.
   *
   * The bump is AWAITED before navigating. The detail screen fetches on mount, so pushing first
   * would show the pre-bump number and then have to either flicker or lie. A failed bump still
   * navigates: the word exists, the learner asked to see it, and a lost increment is not worth a
   * dead end.
   */
  async function openOwned(wordId: string) {
    setFeedback(null);
    try {
      await bumpPopularity(getToken, wordId);
    } catch {
      // Deliberately silent — see above. The word is still there to open.
    }
    setText("");
    router.push(`/lesson-items/${wordId}`);
  }

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await addWord(getToken, value);
      if (result.status === "added") {
        // The suggestion buckets carry an `owned` flag per row, and one of those rows just became
        // owned. Dropping the cache is cheaper than patching it and cannot be subtly wrong — the
        // next word the learner types refetches ~7 KB. `already-present` needs no clear: the flag
        // was already true.
        clearSuggestionCache();
        setFeedback({ tone: "ok", message: `Added “${result.text}”.` });
        setText("");
      } else if (result.status === "already-present") {
        // The count is the point: the add DID something (0017 bumps an already-owned word), and a
        // message that only said "you already have this" would report a no-op that did not happen.
        // Reached only for words the dropdown could not offer — phrases, sentences, anything
        // outside the lexicon — since a suggested word is opened by `openOwned` instead.
        setFeedback({
          tone: "warn",
          message:
            result.popularity === null
              ? `“${result.text}” is already in your collection.`
              : `“${result.text}” is already in your collection — met ${result.popularity} ${
                  result.popularity === 1 ? "time" : "times"
                }.`,
        });
        setText("");
      } else {
        setFeedback({ tone: "warn", message: "Type a word first." });
      }
      await onAdded();
    } catch {
      setFeedback({ tone: "warn", message: "Couldn’t save that — check your connection." });
    } finally {
      setBusy(false);
    }
  }

  return (
    // The suggestion popup is an absolute overlay that hangs out of this panel's bottom edge, and
    // `zIndex` only orders SIBLINGS — so the panel itself has to outrank the filter panel and the
    // item list that follow it, or the overlay renders behind them. Setting it on the popup alone
    // does nothing across this boundary.
    <Panel title="Add a word" style={{ zIndex: 10 }}>
      <View style={styles.addRow}>
        <Autocomplete
          value={text}
          onChangeText={setText}
          search={search}
          // The row ACTS now, so its accessible name has to say so — a reader that announces only
          // "already in your collection" describes a statement, and this is a door.
          markedLabel="Already in your collection — opens the word"
          onSelect={(option) => {
            if (option.data) void openOwned(option.data);
          }}
          // 7,226 lexicon rows are unlevelled and plenty of real words are outside it altogether,
          // so "no matches" must not read as "that is not a word". The collection also holds
          // phrases and whole sentences, which the dictionary never will.
          emptyLabel="Not in the dictionary — you can still add it."
          placeholder="A word, phrase, or sentence"
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          accessibilityLabel="A word, phrase, or sentence"
          style={{ flex: 1 }}
        />
        <Button label={busy ? "Adding…" : "Add"} disabled={busy} onPress={() => void submit()} />
      </View>
      {feedback ? (
        // The web's `Field.Description` doubles as the live region announcing the submit result.
        <Muted
          accessibilityLiveRegion="polite"
          style={[styles.feedback, feedback.tone === "ok" ? styles.ok : styles.warn]}
        >
          {feedback.message}
        </Muted>
      ) : (
        <Muted style={styles.feedback}>
          It goes straight to your collection — you can put it in a lesson any time.
        </Muted>
      )}
    </Panel>
  );
}

/**
 * One word: what it means and what it has been through, beside a column of three controls.
 *
 * **What the row says, and what it stopped saying.** The line under the word used to be four
 * statistics — conversations, lessons, the date added, the date last practised — and no
 * translation, so a learner scanning fifty rows had to open each one to remember what it meant.
 * The date pair is gone and the Russian is in its place. Nothing is lost: both dates are on the
 * detail page, and `first_added_at` / `last_practiced_at` are still what the sort control orders
 * by, so the information that made them worth showing is now expressed as an ordering rather than
 * as forty characters per row.
 *
 * **Why the controls stack.** Level, popularity and delete used to sit in the row beside the text,
 * which cost the word itself three controls' worth of width — on a phone that is most of it, and
 * it is why a translation could not fit. As a column they cost one control's width and the text
 * gets the rest. The order is fixed and deliberate: the level is a fact and sits at the top out of
 * the thumb's way, and delete is at the bottom — the destructive control is the one the thumb
 * should have to travel to, which is the same rule the lessons list follows left-to-right.
 *
 * **The middle slot is a fact now, not a control** (0017). It used to be the favourite star, the one
 * thing a learner pressed often; it is the popularity count, which is not pressable here. A counter
 * has no undo, and fifty of them under a scrolling thumb is where a mis-tap is likeliest — so the
 * +1 lives on the word's own page, where the learner arrived on purpose. The slot itself stays: it
 * is what keeps the level pill and the bin at the same height from row to row.
 */
function ItemLine({
  item,
  selected,
  onToggle,
  onDelete,
}: {
  item: ItemRow;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
  ];

  return (
    <View style={styles.itemRow}>
      <Checkbox checked={selected} onChange={onToggle} accessibilityLabel={`Select ${item.text}`} />

      <View style={{ flex: 1, minWidth: 0 }}>
        <Link href={`/lesson-items/${item.id}`} style={styles.itemText}>
          {item.text}
        </Link>
        {/*
          The glosses, joined — the view caps the count (migration 0016), so this renders what it is
          given rather than slicing again. An unenriched word simply has none: the job is a
          background sweep with no deadline, and a placeholder saying so would be a line of apology
          on a row that has a perfectly good word on it.

          `numberOfLines={3}`, not 1. One line was the wrong economy: it bought row-to-row alignment
          of the statistics line and paid for it with the meaning of the word, which is the reason
          the translations were put on the row at all. A learner scanning for "which word was this"
          reads the Russian, and a Russian gloss list that ends in "…" answers the question for the
          first word and not the second. Three is the ceiling rather than none because the point is
          a row that varies a little, not a row that can grow without limit — six long glosses at
          phone width are five lines, and at five lines the list stops being scannable in the
          different direction.
        */}
        {item.translations_ru.length > 0 ? (
          <Muted numberOfLines={3} style={styles.translations}>
            {item.translations_ru.join(", ")}
          </Muted>
        ) : null}
        {/* The lessons this word is in live on its detail page now, not inline here. */}
        <Faint>{stats.join(" · ")}</Faint>
      </View>

      <View style={styles.itemActions}>
        {/*
          The empty slot is not padding. Without it an unlevelled word's star and bin slide up by a
          pill's height, so in a list where most words are levelled and some are not the two
          controls sit at two different heights from row to row — and a control that moves is a
          control the thumb has to look for.
        */}
        {item.level ? (
          <Muted style={styles.levelPill}>{item.level}</Muted>
        ) : (
          <View style={styles.levelSlot} />
        )}

        {/* Text, not a `Button` — see the docblock. 0 renders like any other value: a slot that is
            sometimes empty is what `levelSlot` above exists to prevent. */}
        <Muted
          style={styles.popularity}
          accessibilityLabel={`${item.text}, met ${item.popularity} ${
            item.popularity === 1 ? "time" : "times"
          }`}
        >
          {item.popularity}
        </Muted>

        {/* `hitSlop` is small on purpose: the bin is the only control in this column and the row's
            checkbox sits opposite it, so generous slop would trade a missed delete for an
            accidental one. */}
        <Button
          variant="icon"
          tone="danger"
          hitSlop={4}
          onPress={onDelete}
          accessibilityLabel={`Delete ${item.text}`}
        >
          <TrashIcon size={18} color={theme.error} />
        </Button>
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    addRow: { flexDirection: "row", alignItems: "center", gap: space.row },
    feedback: { marginTop: 0.4 * 16 },
    ok: { color: t.ok },
    warn: { color: t.warn },

    /** `gap: 1.25rem` between the filter groups, as on the web. */
    filters: { marginTop: 0.9 * 16, gap: 1.25 * 16 },

    listHead: { flexDirection: "row", alignItems: "center", gap: space.row },

    itemRow: {
      flexDirection: "row",
      // `flex-start`, not `center`: the actions column is a fixed three-slot stack and the text
      // column is one to three lines, so centring would float the controls against a short row.
      alignItems: "flex-start",
      gap: 0.85 * 16,
      paddingVertical: 0.6 * 16,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    itemText: { fontWeight: type.weightSemibold },
    translations: { color: t.text },
    /** Level, popularity, delete — see `ItemLine` for why the order is what it is. */
    itemActions: { alignItems: "center", gap: 0.25 * 16 },
    /**
     * The count, sized to sit in the 32pt icon column without being mistaken for a button.
     * `tabular-nums` is not available in RN, so the width is held by `minWidth` instead — a 2 and a
     * 10 must not shift the bin under them.
     */
    popularity: { minWidth: 22, textAlign: "center" },
    levelPill: {
      ...type.tiny,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.pill,
      paddingHorizontal: 0.5 * 16,
      overflow: "hidden",
      // The pill is text in a column of 32pt icon buttons; without this it hugs the left edge of
      // the column instead of sitting over them.
      alignSelf: "center",
    },
    /** The unlevelled word's placeholder. Height = the pill's line box, so the stack does not shift. */
    levelSlot: { height: type.tiny.lineHeight },

    /**
     * The pinned selection bar. `Screen`'s `footer` slot is what finally made this possible — see
     * its docblock for why a flex sibling beats the absolute overlay the web's `position: sticky`
     * suggests.
     *
     * `flexWrap` is the honest answer to a long count on a narrow phone: the bar grows to two rows
     * rather than squeezing the buttons, and because it is a sibling of the scroll view rather than
     * an overlay, growing costs the list height instead of covering it.
     */
    selectionBar: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: space.row,
    },
    selectionCount: { flex: 1, minWidth: 0, fontWeight: type.weightBold },
  });
