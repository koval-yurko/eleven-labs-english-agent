import {
  BottomSheet,
  Button as UIButton,
  ContentUnavailableView,
  Divider,
  Group,
  Host,
  List,
  Menu,
  Section,
  SwipeActions,
  Text as UIText,
  Toggle as UIToggle,
  VStack,
} from "@expo/ui/swift-ui";
import {
  font,
  foregroundColor,
  listStyle,
  onTapGesture,
  refreshable,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { groupFacets, searchItems, sortChoices, SORT_LABELS } from "@tutor/shared/item-list";
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  type ItemsQuery,
  type SortKey,
} from "@tutor/shared/items-query";
import { buildCreateLessonOp, MAX_ITEMS, MAX_LESSON_TITLE } from "@tutor/shared/sync-ops";
import {
  CEFR_LEVELS,
  ITEM_KINDS,
  UNLEVELED,
  type ItemKind,
  type ItemRow,
} from "@tutor/shared/word-types";
import type { ItemsResponse } from "@tutor/shared/api";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { newId } from "@/lib/ids";
import { addWord, fetchItems, setFavorite } from "@/lib/items";
import { postOp } from "@/lib/lessons";

/**
 * The collection — every word the learner has, across every lesson.
 *
 * **The filter grammar has exactly one implementation and this screen does not add a second.**
 * `ItemsQuery` lives in React state instead of in a URL (there is no address bar), but
 * `serializeItemsQuery` — reached through `itemsPath` — still encodes it, and the server still
 * decodes it with `parseItemsQuery`. `pnpm check:shared` proves those two are inverse over 10,752
 * cases, and that property is the entire reason the phone and the web can be trusted to show the
 * same rows for the same filters. See docs/2026-08-13-expo-s6-collection.md D61.
 *
 * **Two mechanisms, deliberately, exactly as on the web.** Filters and sort go to Postgres (the
 * levels, the statistics and the ordering are all computed there); free-text search filters the
 * already-loaded list in memory. `?q=` is not part of `ItemsQuery` and never reaches the wire.
 *
 * D3 gets its real test here: RN owns the outer column and every control above the list, and ONE
 * `Host` owns the SwiftUI `List`. That `Host` is sized with `flex: 1` and **never `matchContents`** —
 * `matchContents` on the same axis as a SwiftUI scroll container resolves to `.fixedSize` and
 * scrolling silently stops, on the longest screen in the project (S0 §2 D3).
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

/** How many filters are on — the number the filter button shows, so an active filter is never hidden. */
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

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  const [query, setQuery] = useState<ItemsQuery>(EMPTY_QUERY);
  const [data, setData] = useState<ItemsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const visibleIds = useMemo(() => new Set(visible.map((i) => i.id)), [visible]);
  const selectionTags = useMemo(() => [...selected.keys()], [selected]);

  /**
   * Merge the list's selection into ours, defensively.
   *
   * Our `selection` array carries ids for rows the current filter does not render, and whether
   * SwiftUI reports those back in `onSelectionChange` is not something this codebase has measured.
   * So: add whatever is newly ticked, and remove **only ids that are currently visible** and no
   * longer ticked. An offscreen id cannot be un-ticked by a tap that never reached it, so it
   * survives either way — which makes the native behaviour irrelevant rather than load-bearing.
   * See S6 §4.2.
   */
  const onSelectionChange = useCallback(
    (tags: (string | number)[]) => {
      const now = new Set(tags.map(String));
      setSelected((prev) => {
        const next = new Map(prev);
        for (const id of now) {
          if (next.has(id)) continue;
          const row = visible.find((i) => i.id === id);
          if (row) next.set(id, row.text);
        }
        const drop = [...next.keys()].filter((id) => visibleIds.has(id) && !now.has(id));
        for (const id of drop) next.delete(id);
        return next;
      });
    },
    [visible, visibleIds],
  );

  /** Optimistic favorite: flip locally, revert if the write is refused. Keyed on `norm_key` (D66). */
  async function toggleFavorite(item: ItemRow) {
    const next = !item.is_favorite;
    setWriteError(null);
    setData((prev) =>
      prev
        ? { ...prev, items: prev.items.map((i) => (i.id === item.id ? { ...i, is_favorite: next } : i)) }
        : prev,
    );
    try {
      await setFavorite(accessToken, item.norm_key, next);
    } catch (e) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((i) =>
                i.id === item.id ? { ...i, is_favorite: !next } : i,
              ),
            }
          : prev,
      );
      setWriteError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Add one word, in no lesson. `Alert.prompt` rather than a form: the ask is a single word, it costs
   * no viewport, and it is the iOS way to ask for one string. (iOS-only, which D2 makes fine.)
   *
   * `already-present` is announced rather than swallowed — the collection groups by `norm_key`, so a
   * duplicate add changes nothing on screen and would read as a broken button.
   */
  function promptAddWord() {
    Alert.prompt(
      "Add a word",
      "It goes straight to your collection — you can put it in a lesson any time.",
      async (text) => {
        if (!text?.trim()) return;
        setBusy(true);
        setWriteError(null);
        try {
          const result = await addWord(accessToken, text);
          if (result.status === "already-present") {
            Alert.alert(`“${result.text}” is already in your collection.`);
          }
          await load(query);
        } catch (e) {
          setWriteError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      },
      "plain-text",
    );
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
      setSelected(new Map());
      setLessonTitle("");
      router.push(`/lessons/${op.lesson.id}`);
    } catch (e) {
      // The selection is deliberately kept: it is what the learner would have to rebuild by hand.
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const filterCount = activeFilterCount(query);

  if (loadError) {
    return (
      <Screen onAdd={promptAddWord}>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.button} onPress={() => void load(query)}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </Screen>
    );
  }

  return (
    <Screen onAdd={promptAddWord}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search your words and sentences…"
        placeholderTextColor="#5A5A5A"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="while-editing"
        accessibilityLabel="Search words and sentences"
      />

      {/* Sort is a Menu and the filters are a sheet: six filter groups as chips would fill the
          screen above the list at phone width, which is the only reason the web can lay them out
          flat. The counts stay visible so a filter is never silently on (S6 §4.3). */}
      <Host style={styles.controls}>
        <Group>
          <Menu label={SORT_LABELS[query.sort]} systemImage="arrow.up.arrow.down">
            {sortChoices().map((choice) => (
              <UIButton
                key={choice.key}
                label={choice.label}
                onPress={() => apply({ sort: choice.key as SortKey })}
              />
            ))}
            <Divider />
            <UIButton
              label={query.dir === "asc" ? "Ascending" : "Descending"}
              systemImage={query.dir === "asc" ? "arrow.up" : "arrow.down"}
              onPress={() => apply({ dir: query.dir === "asc" ? "desc" : "asc" })}
            />
          </Menu>
          <BottomSheet
            isPresented={filtersOpen}
            onIsPresentedChange={setFiltersOpen}
            anchor={
              <UIButton
                label={filterCount > 0 ? `Filters (${filterCount})` : "Filters"}
                systemImage="line.3.horizontal.decrease"
                onPress={() => setFiltersOpen(true)}
              />
            }
          >
            <Group>
              <FilterSheet
                query={query}
                facets={data?.facets ?? []}
                onApply={apply}
                onClear={() => setQuery(EMPTY_QUERY)}
              />
            </Group>
          </BottomSheet>
        </Group>
      </Host>

      <Text style={styles.count}>
        {items === null
          ? " "
          : `${visible.length} of ${items.length} ${items.length === 1 ? "word" : "words"}`}
        {filterCount > 0 ? " · filtered" : ""}
      </Text>

      {writeError ? <Text style={styles.error}>{writeError}</Text> : null}

      {items === null ? (
        <ActivityIndicator color="#7FB2FF" style={{ marginTop: 24 }} />
      ) : (
        /* flex: 1 — NEVER matchContents on this axis (S0 §2 D3). */
        <Host style={styles.list}>
          <List
            selection={selectionTags}
            onSelectionChange={onSelectionChange}
            modifiers={[listStyle("plain"), refreshable(() => load(query))]}
          >
            {visible.length === 0 ? (
              <ContentUnavailableView
                title={items.length === 0 ? "No words yet" : "No match"}
                systemImage={items.length === 0 ? "text.book.closed" : "magnifyingglass"}
                description={
                  items.length === 0
                    ? "Add a word with ＋, or add some to a lesson."
                    : "Nothing here matches that search."
                }
              />
            ) : (
              visible.map((item) => (
                <SwipeActions key={item.id} modifiers={[tag(item.id)]}>
                  <VStack alignment="leading" spacing={2} modifiers={[onTapGesture(() => router.push(`/lesson-items/${item.id}`))]}>
                    <UIText modifiers={[font({ size: 17, weight: "semibold" })]}>
                      {item.is_favorite ? `★ ${item.text}` : item.text}
                    </UIText>
                    <UIText modifiers={[font({ size: 13 }), foregroundColor("#8A8A8A")]}>
                      {statsLine(item)}
                    </UIText>
                  </VStack>
                  <SwipeActions.Actions edge="leading">
                    <UIButton
                      label={item.is_favorite ? "Unfavorite" : "Favorite"}
                      systemImage={item.is_favorite ? "star.slash" : "star"}
                      onPress={() => void toggleFavorite(item)}
                    />
                  </SwipeActions.Actions>
                </SwipeActions>
              ))
            )}
          </List>
        </Host>
      )}

      {selected.size > 0 ? (
        <View style={styles.selectionBar}>
          <Text style={styles.selectionCount}>
            {selected.size} selected{selected.size > MAX_ITEMS ? ` (first ${MAX_ITEMS} used)` : ""}
          </Text>
          <TextInput
            style={styles.titleInput}
            value={lessonTitle}
            onChangeText={setLessonTitle}
            placeholder="Lesson title (optional)"
            placeholderTextColor="#5A5A5A"
            maxLength={MAX_LESSON_TITLE}
            accessibilityLabel="New lesson title"
          />
          <View style={styles.selectionActions}>
            <Pressable
              style={[styles.button, busy ? styles.disabled : null]}
              disabled={busy}
              onPress={() => void createFromSelection()}
            >
              <Text style={styles.buttonLabel}>{busy ? "Creating…" : "Create lesson"}</Text>
            </Pressable>
            <Pressable style={styles.quiet} onPress={() => setSelected(new Map())}>
              <Text style={styles.quietLabel}>Clear</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

/** `3 conversations · 2 lessons · added 12/08/2026` — plus the level, which is nullable forever. */
function statsLine(item: ItemRow): string {
  return [
    item.level ?? "not levelled",
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
  ].join(" · ");
}

/**
 * The filter sheet: one `Section` per group, `Toggle` rows inside.
 *
 * The category rows come from the data itself (`groupFacets` over the `owner_item_facets` view), so
 * a category name added later needs no code here. ⚠️ There are **zero facet rows** today, so this
 * block renders nothing at all — that is expected, not a bug (S6 §3 / D67).
 */
function FilterSheet({
  query,
  facets,
  onApply,
  onClear,
}: {
  query: ItemsQuery;
  facets: ItemsResponse["facets"];
  onApply: (change: Partial<ItemsQuery>) => void;
  onClear: () => void;
}) {
  function toggleLevel(level: string, on: boolean) {
    onApply({
      levels: on ? [...query.levels, level] : query.levels.filter((l) => l !== level),
    });
  }

  return (
    <List modifiers={[listStyle("insetGrouped")]}>
      <Section title="Level">
        {[...CEFR_LEVELS, UNLEVELED].map((level) => (
          <UIToggle
            key={level}
            label={level === UNLEVELED ? "not levelled" : level}
            isOn={query.levels.includes(level)}
            onIsOnChange={(on) => toggleLevel(level, on)}
          />
        ))}
      </Section>

      {/* Single-select: turning one on turns the others off, and turning the on one off clears it. */}
      <Section title="Kind">
        {ITEM_KINDS.map((kind) => (
          <UIToggle
            key={kind}
            label={kind}
            isOn={query.kind === kind}
            onIsOnChange={(on) => onApply({ kind: on ? (kind as ItemKind) : null })}
          />
        ))}
      </Section>

      <Section title="Show">
        <UIToggle
          label="Favorites only"
          isOn={query.favoritesOnly}
          onIsOnChange={(on) => onApply({ favoritesOnly: on })}
        />
        <UIToggle
          label="In no lesson"
          isOn={query.unassignedOnly}
          onIsOnChange={(on) => onApply({ unassignedOnly: on })}
        />
      </Section>

      {groupFacets(facets).map(([name, values]) => (
        <Section key={name} title={name}>
          {values.map((facet) => (
            <UIToggle
              key={facet.value}
              label={`${facet.value} (${facet.item_count})`}
              isOn={query.categories[name] === facet.value}
              onIsOnChange={(on) => {
                const categories = { ...query.categories };
                if (on) categories[name] = facet.value;
                else delete categories[name];
                onApply({ categories });
              }}
            />
          ))}
        </Section>
      ))}

      <Section>
        <UIButton label="Clear all filters" role="destructive" onPress={onClear} />
      </Section>
    </List>
  );
}

function Screen({ onAdd, children }: { onAdd: () => void; children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: "Words",
          headerBackTitle: "Lessons",
          headerRight: () => (
            <Pressable onPress={onAdd} hitSlop={8} accessibilityLabel="Add a word">
              <Text style={styles.headerAdd}>＋</Text>
            </Pressable>
          ),
        }}
      />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  headerAdd: { color: "#7FB2FF", fontSize: 24, fontWeight: "600" },
  search: {
    color: "#E6E6E6",
    fontSize: 16,
    backgroundColor: "#1B1B22",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 8,
  },
  controls: { height: 44, marginTop: 4 },
  count: { color: "#8A8A8A", fontSize: 13 },
  list: { flex: 1, marginTop: 8 },
  error: { color: "#FF7A7A", fontSize: 13, marginTop: 8 },
  button: { backgroundColor: "#2A2A34", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  buttonLabel: { color: "#E6E6E6", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  quiet: { paddingVertical: 10, paddingHorizontal: 6 },
  quietLabel: { color: "#8A8A8A", fontSize: 15 },
  selectionBar: {
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2A2A34",
    backgroundColor: "#1B1B22",
    gap: 8,
  },
  selectionCount: { color: "#E6E6E6", fontSize: 15, fontWeight: "700" },
  titleInput: {
    color: "#E6E6E6",
    fontSize: 15,
    backgroundColor: "#101014",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  selectionActions: { flexDirection: "row", alignItems: "center", gap: 8 },
});
