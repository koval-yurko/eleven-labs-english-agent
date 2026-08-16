import type { ItemsResponse } from "@tutor/shared/api";
import { groupFacets, searchItems, sortChoices } from "@tutor/shared/item-list";
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  type ItemsQuery,
  type SortKey,
} from "@tutor/shared/items-query";
import { buildCreateLessonOp, MAX_ITEMS, MAX_LESSON_TITLE } from "@tutor/shared/sync-ops";
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
import { useAuth0 } from "react-native-auth0";

import { newId } from "@/lib/ids";
import { addWord, fetchItems, setFavorite } from "@/lib/items";
import { fetchSuggestions } from "@/lib/suggestions";
import { postOp } from "@/lib/lessons";
import { useTheme } from "@/theme";
import {
  Autocomplete,
  Body,
  Button,
  ButtonRow,
  Checkbox,
  Chip,
  ChipRow,
  ErrorText,
  H1,
  H2,
  Link,
  Muted,
  Panel,
  RefreshButton,
  Screen,
  Select,
  SortArrowIcon,
  StarIcon,
  TextField,
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
 * The riskiest part is the filters. The web lays out six groups of chips flat because it can; the
 * `BottomSheet` existed precisely because that is a lot of vertical space at phone width (S6 §4.3).
 * The mitigations are that the rows wrap and the whole page scrolls — but this is the one screen
 * to look at on the smallest device before calling the port finished.
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.3, §10.3.
 */
const EMPTY_QUERY: ItemsQuery = {
  levels: [],
  favoritesOnly: false,
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
    (query.favoritesOnly ? 1 : 0) +
    (query.kind ? 1 : 0) +
    (query.unassignedOnly ? 1 : 0) +
    Object.keys(query.categories).length
  );
}

export default function CollectionScreen() {
  const { getCredentials } = useAuth0();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

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
  const [lessonTitle, setLessonTitle] = useState("");

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
    setLessonTitle("");
  }

  /** Optimistic favorite: flip locally, revert if the write is refused. Keyed on `norm_key` (D66). */
  async function toggleFavorite(item: ItemRow) {
    const next = !item.is_favorite;
    setWriteError(null);
    const patch = (on: boolean) =>
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((i) => (i.id === item.id ? { ...i, is_favorite: on } : i)),
            }
          : prev,
      );
    patch(next);
    try {
      await setFavorite(accessToken, item.norm_key, next);
    } catch (e) {
      patch(!next);
      setWriteError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Create a lesson from the ticked words — the one place this screen writes a lesson, and it goes
   * through S5's proven path (`buildCreateLessonOp` + `postOp`) rather than growing a second one.
   */
  async function createFromSelection() {
    const texts = [...selected.values()].slice(0, MAX_ITEMS);
    if (texts.length === 0 || busy) return;
    setBusy(true);
    setWriteError(null);
    const op = buildCreateLessonOp(newId(), lessonTitle, texts, newId);
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

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load(query).finally(() => setRefreshing(false));
      }}
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

      <Panel>
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

          {/* Two independent booleans — a labelled set, not alternatives. */}
          <ChipRow label="Show">
            <Chip
              label="favorites"
              pressed={query.favoritesOnly}
              onPress={() => apply({ favoritesOnly: !query.favoritesOnly })}
            >
              <StarIcon
                size={14}
                state={query.favoritesOnly ? "filled" : "empty"}
                color={query.favoritesOnly ? theme.onAccent : theme.text}
              />
            </Chip>
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
              onToggleFavorite={() => void toggleFavorite(item)}
            />
          ))
        )}
      </Panel>

      {selected.size > 0 ? (
        <Panel style={styles.selection}>
          <Body style={styles.selectionCount}>
            {selected.size} selected
            {selected.size > MAX_ITEMS ? ` (first ${MAX_ITEMS} used)` : ""}
          </Body>
          <TextField
            value={lessonTitle}
            onChangeText={setLessonTitle}
            placeholder="Lesson title (optional)"
            maxLength={MAX_LESSON_TITLE}
            accessibilityLabel="New lesson title"
            style={{ marginTop: space.row }}
          />
          <ButtonRow style={{ marginTop: space.row }}>
            <Button
              label={busy ? "Creating…" : "Create lesson"}
              disabled={busy}
              onPress={() => void createFromSelection()}
            />
            <Chip label="Clear" onPress={clearSelection} />
          </ButtonRow>
        </Panel>
      ) : null}
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
 * duplicate add changes nothing on screen and would otherwise read as a broken button.
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
    async (query: string): Promise<AutocompleteOption[]> => {
      const suggestions = await fetchSuggestions(getToken, query);
      return suggestions.map((s) => ({
        key: s.text,
        label: s.text,
        badge: s.level,
        // Up to three glosses come back; two is what fits at phone width. The full set is on the
        // word detail page, which renders `WordDetails.translations_ru`.
        detail: s.ru.slice(0, 2).join(", "),
        marked: s.owned,
      }));
    },
    [getToken],
  );

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await addWord(getToken, value);
      if (result.status === "added") {
        setFeedback({ tone: "ok", message: `Added “${result.text}”.` });
        setText("");
      } else if (result.status === "already-present") {
        setFeedback({
          tone: "warn",
          message: `“${result.text}” is already in your collection.`,
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
    <Panel title="Add a word">
      <View style={styles.addRow}>
        <Autocomplete
          value={text}
          onChangeText={setText}
          search={search}
          markedLabel="Already in your collection"
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

function ItemLine({
  item,
  selected,
  onToggle,
  onToggleFavorite,
}: {
  item: ItemRow;
  selected: boolean;
  onToggle: () => void;
  onToggleFavorite: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
    item.last_practiced_at
      ? `last practiced ${new Date(item.last_practiced_at).toLocaleDateString()}`
      : null,
  ].filter(Boolean);

  return (
    <View style={styles.itemRow}>
      <Checkbox checked={selected} onChange={onToggle} accessibilityLabel={`Select ${item.text}`} />

      <View style={{ flex: 1, minWidth: 0 }}>
        <Link href={`/lesson-items/${item.id}`} style={styles.itemText}>
          {item.text}
        </Link>
        {/* The lessons this word is in live on its detail page now, not inline here. */}
        <Muted>{stats.join(" · ")}</Muted>
      </View>

      {item.level ? <Muted style={styles.levelPill}>{item.level}</Muted> : null}

      <Button
        variant="icon"
        onPress={onToggleFavorite}
        accessibilityLabel={item.is_favorite ? `Unfavorite ${item.text}` : `Favorite ${item.text}`}
      >
        <StarIcon
          size={18}
          state={item.is_favorite ? "filled" : "empty"}
          color={item.is_favorite ? theme.warn : theme.faint}
        />
      </Button>
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
      alignItems: "center",
      gap: 0.85 * 16,
      paddingVertical: 0.6 * 16,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    itemText: { fontWeight: type.weightSemibold },
    levelPill: {
      ...type.tiny,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.pill,
      paddingHorizontal: 0.5 * 16,
      overflow: "hidden",
    },

    /**
     * The web's selection bar is `position: sticky; bottom: 1rem` with a drop shadow. RN has no
     * sticky, and a floating bar would have to live outside the scroll container — i.e. outside
     * `Screen`. It stays a panel at the end of the page instead: the selection is visible in the
     * rows above it either way, and a bar pinned over the list would cover the very rows being
     * ticked on a phone-height screen.
     */
    selection: { borderColor: t.accent },
    selectionCount: { fontWeight: type.weightBold },
  });
