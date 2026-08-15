import type { LessonItem } from "@tutor/shared/lesson-types";
import { buildAddItemsOp, MAX_ITEMS } from "@tutor/shared/sync-ops";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { EmptyState } from "@/components/empty-state";
import { newId } from "@/lib/ids";
import { fetchLessonItems, postOp } from "@/lib/lessons";
import { useTheme, type Palette } from "@/theme";

/**
 * The words in one lesson: add, remove, and the log of both (D51).
 *
 * **One fetch feeds both halves.** `GET /api/v2/lessons/:id/items` returns every item row including
 * removed ones, so the editable list is `removed_at === null` and the change log is the same array
 * flat-mapped into events — which is exactly how `app/lessons/[id]/page.tsx` derives them from its
 * one `listLessonItemHistory` query. It is also the only route that carries item **ids**, and
 * `removeItem` needs one: `LessonDetail.items` is `string[]`. See D44.
 */
type ItemEvent = { at: string; kind: "added" | "removed"; text: string };

export default function LessonWordsScreen() {
  const { id: lessonId } = useLocalSearchParams<{ id: string }>();
  const { getCredentials } = useAuth0();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  const [items, setItems] = useState<LessonItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /**
   * What a failed write left behind: the optimistic state it wanted and the op that would produce
   * it. The ARGUMENTS rather than a closure over `write`, so this does not reference the callback
   * from inside its own definition — and because they are exactly what a durable outbox would store
   * when D1's mirror lands.
   */
  const retryRef = useRef<{ next: LessonItem[]; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await fetchLessonItems(accessToken, lessonId));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, lessonId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  /** Active rows in display order — what the learner edits, and what the tutor will be given. */
  const active = useMemo(
    () =>
      (items ?? []).filter((i) => i.removed_at === null).sort((a, b) => a.position - b.position),
    [items],
  );

  /** Each row is an "added" event, and a removed one is also a "removed" event. Newest first. */
  const events = useMemo<ItemEvent[]>(
    () =>
      (items ?? [])
        .flatMap((it) => {
          const evs: ItemEvent[] = [{ at: it.created_at, kind: "added", text: it.text }];
          if (it.removed_at) evs.push({ at: it.removed_at, kind: "removed", text: it.text });
          return evs;
        })
        .sort((a, b) => (a.at < b.at ? 1 : -1)),
    [items],
  );

  /** Optimistic apply, then re-read; snapshot back on failure and keep the op for a retry (§3.2). */
  const write = useCallback(
    async (next: LessonItem[], run: () => Promise<void>) => {
      if (busy) return;
      const snapshot = items;
      setBusy(true);
      setWriteError(null);
      setItems(next);
      try {
        await run();
        retryRef.current = null;
        await load();
      } catch (e) {
        setItems(snapshot);
        retryRef.current = { next, run };
        setWriteError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, items, load],
  );

  const room = Math.max(0, MAX_ITEMS - active.length);
  const atCap = room === 0;

  async function add() {
    if (!items) return;
    const texts = draft
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, room);
    // `buildAddItemsOp` owns the whole rule: normalize, drop blanks, drop anything already active or
    // repeated in the batch, and number what survives from `max(position) + 1` — a removed item
    // leaves a gap and reusing its position would collide.
    const op = buildAddItemsOp(lessonId, texts, active, newId);
    if (!op) {
      // Every line was blank or already here. Clearing the box IS the feedback; inventing an error
      // for "you already have that word" would be noise.
      setDraft("");
      return;
    }

    const at = new Date().toISOString();
    const optimistic: LessonItem[] = op.items.map((it) => ({
      id: it.id,
      text: it.text,
      position: it.position,
      created_at: at,
      removed_at: null,
    }));
    setDraft("");
    await write([...items, ...optimistic], () => postOp(accessToken, op));
  }

  async function remove(item: LessonItem) {
    if (!items) return;
    const at = new Date().toISOString();
    // Marked removed rather than dropped: the row IS the history, so the change log updates with it.
    const next = items.map((i) => (i.id === item.id ? { ...i, removed_at: at } : i));
    await write(next, () => postOp(accessToken, { kind: "removeItem", lessonId, itemId: item.id }));
  }

  if (loadError) {
    return (
      <Screen>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.button} onPress={() => void load()}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </Screen>
    );
  }

  if (!items) {
    return (
      <Screen>
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={active}
        keyExtractor={(i) => i.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.word}>{item.text}</Text>
            <Pressable
              onPress={() => void remove(item)}
              disabled={busy}
              hitSlop={8}
              accessibilityLabel={`Remove ${item.text}`}
            >
              <Text style={styles.remove}>remove</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <EmptyState
            title="No words yet"
            systemImage="text.book.closed"
            description="Add words or sentences below — one per line."
            height={200}
          />
        }
        ListFooterComponent={
          <View style={styles.footer}>
            <TextInput
              style={[styles.input, atCap ? styles.disabled : null]}
              value={draft}
              onChangeText={setDraft}
              placeholder="Add words or sentences — one per line"
              placeholderTextColor={theme.faint}
              multiline
              editable={!atCap}
              accessibilityLabel="Words or sentences to add — one per line"
            />
            <View style={styles.actions}>
              <Pressable
                style={[styles.button, atCap || busy ? styles.disabled : null]}
                disabled={atCap || busy}
                onPress={() => void add()}
              >
                <Text style={styles.buttonLabel}>Add words</Text>
              </Pressable>
              <Text style={styles.muted}>
                {atCap
                  ? `Lesson is full (${MAX_ITEMS} items).`
                  : `${active.length}/${MAX_ITEMS} items`}
              </Text>
            </View>

            {writeError ? (
              <View style={styles.errorRow}>
                <Text style={styles.error}>{writeError}</Text>
                <Pressable
                  style={styles.button}
                  disabled={busy}
                  onPress={() => {
                    const again = retryRef.current;
                    if (again) void write(again.next, again.run);
                  }}
                >
                  <Text style={styles.buttonLabel}>Retry</Text>
                </Pressable>
              </View>
            ) : null}

            {events.length > 0 ? (
              <View style={styles.log}>
                <Text style={styles.logTitle}>
                  Word changes{" "}
                  <Text style={styles.muted}>
                    — {events.length} {events.length === 1 ? "event" : "events"}
                  </Text>
                </Text>
                {events.map((e, i) => (
                  <Text key={i} style={styles.logLine}>
                    <Text style={e.kind === "added" ? styles.added : styles.removed}>
                      {e.kind === "added" ? "＋ added" : "－ removed"}
                    </Text>{" "}
                    <Text style={styles.word}>{e.text}</Text>{" "}
                    <Text style={styles.muted}>— {new Date(e.at).toLocaleString()}</Text>
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
        }
      />
    </Screen>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen options={{ headerShown: true, title: "Words", headerBackTitle: "Lesson" }} />
      {children}
    </SafeAreaView>
  );
}

/** Per-scheme styles (D71) — see the note in app/(tabs)/(lessons)/index.tsx. */
const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    muted: { color: t.muted, fontSize: 13 },
    error: { color: t.danger, fontSize: 13, flexShrink: 1 },
    errorRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12 },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
    },
    word: { color: t.text, fontSize: 16, flexShrink: 1 },
    remove: { color: t.danger, fontSize: 14 },
    footer: { marginTop: 16, gap: 8, paddingBottom: 32 },
    input: {
      color: t.text,
      fontSize: 16,
      backgroundColor: t.surface,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      minHeight: 84,
      textAlignVertical: "top",
    },
    actions: { flexDirection: "row", alignItems: "center", gap: 12 },
    button: {
      backgroundColor: t.control,
      borderRadius: 8,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    buttonLabel: { color: t.text, fontSize: 15, fontWeight: "600" },
    disabled: { opacity: 0.4 },
    log: { marginTop: 24, borderTopWidth: 1, borderTopColor: t.border, paddingTop: 12 },
    logTitle: { color: t.text, fontSize: 15, fontWeight: "700", marginBottom: 8 },
    logLine: { fontSize: 13, marginBottom: 6 },
    added: { color: t.success },
    removed: { color: t.danger },
  });
