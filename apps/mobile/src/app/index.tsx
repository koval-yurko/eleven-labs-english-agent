import type { LessonListItem } from "@tutor/shared/lesson-types";
import {
  buildCreateLessonOp,
  MAX_ITEMS,
  MAX_LESSON_TITLE,
  nextLessonTitle,
} from "@tutor/shared/sync-ops";
import { Link, Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { newId } from "@/lib/ids";
import { fetchLessons, postOp } from "@/lib/lessons";

/**
 * The learner's lessons — the app's home screen (D50).
 *
 * It replaces S4's launcher, and with it the one hard-coded `DEV_LESSON_ID`. Home is the list because
 * there is no landing screen worth a tap on a phone; the web's split (`/` smoke test, `/lessons`)
 * exists for a reason with no native counterpart.
 *
 * **Writes are optimistic, and the optimistic row is built FROM THE OP** — `buildCreateLessonOp`
 * normalizes, dedupes and caps exactly once, and both the row shown and the intent sent come out of
 * its result. That is the invariant the browser's mirror gets from writing the row and the outbox
 * record in one transaction; without a mirror, deriving the view from the op is the whole of it.
 * See docs/2026-08-13-expo-s5-lessons.md §3.3 / D48.
 */
export default function LessonsScreen() {
  const { user, getCredentials } = useAuth0();

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  const [lessons, setLessons] = useState<LessonListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  /** The op a failed write left behind. Still valid, still idempotent — so it is offered, not lost. */
  /**
   * What a failed write left behind: the optimistic state it wanted and the op that would produce
   * it. The ARGUMENTS rather than a closure over `write`, so this does not reference the callback
   * from inside its own definition — and because they are exactly what a durable outbox would store
   * when D1's mirror lands.
   */
  const retryRef = useRef<{ next: LessonListItem[]; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    try {
      setLessons(await fetchLessons(accessToken));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /**
   * Apply a write optimistically, then re-read.
   *
   * The re-read is not belt-and-braces: `postOp` resolving means the server stopped retrying, not
   * that anything changed, so server truth has to replace the guess (§3.2). On failure the snapshot
   * goes back — deterministic, and it needs no network, which matters because the usual reason a
   * write failed is that there isn't one.
   */
  const write = useCallback(
    async (next: LessonListItem[], run: () => Promise<void>) => {
      if (busy) return;
      const snapshot = lessons;
      setBusy(true);
      setWriteError(null);
      setLessons(next);
      try {
        await run();
        retryRef.current = null;
        await load();
      } catch (e) {
        setLessons(snapshot);
        retryRef.current = { next, run };
        setWriteError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, lessons, load],
  );

  async function createLesson(title: string, texts: string[]) {
    if (!lessons) return;
    const taken = new Set(lessons.map((l) => l.title));
    const op = buildCreateLessonOp(
      newId(),
      title.trim() || nextLessonTitle(taken, new Date()),
      texts,
      newId,
    );
    if (op.lesson.items.length === 0) return; // every line was blank or a duplicate

    const at = new Date().toISOString();
    const optimistic: LessonListItem = {
      id: op.lesson.id,
      title: op.lesson.title,
      items: op.lesson.items.map((i) => i.text),
      created_at: at,
      updated_at: at,
      sessionCount: 0,
    };
    await write([optimistic, ...lessons], () => postOp(accessToken, op));
  }

  function confirmDelete(lesson: LessonListItem) {
    if (!lessons) return;
    Alert.alert(
      `Delete “${lesson.title}”?`,
      // The one place soft delete is ever explained to the learner. Words are owned by the learner,
      // not by a lesson — see docs/2026-07-17-delete-lesson-keep-words.md.
      "Your words and their practice history stay in your collection.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void write(
              lessons.filter((l) => l.id !== lesson.id),
              () => postOp(accessToken, { kind: "deleteLesson", lessonId: lesson.id }),
            );
          },
        },
      ],
    );
  }

  if (loadError) {
    return (
      <Screen>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.retry} onPress={() => void load()}>
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </Screen>
    );
  }

  if (!lessons) {
    return (
      <Screen>
        <ActivityIndicator color="#7FB2FF" style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={lessons}
        keyExtractor={(l) => l.id}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor="#7FB2FF" />
        }
        ListHeaderComponent={
          <>
            <NewLessonForm busy={busy} onCreate={(t, x) => void createLesson(t, x)} />
            {writeError ? (
              <View style={styles.errorRow}>
                <Text style={styles.error}>{writeError}</Text>
                <Pressable
                  style={styles.retry}
                  disabled={busy}
                  onPress={() => {
                    const again = retryRef.current;
                    if (again) void write(again.next, again.run);
                  }}
                >
                  <Text style={styles.retryLabel}>Retry</Text>
                </Pressable>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => (
          <LessonRow lesson={item} onDelete={() => confirmDelete(item)} disabled={busy} />
        )}
        ListEmptyComponent={<Text style={styles.muted}>No lessons yet — create your first one above.</Text>}
        ListFooterComponent={
          <View style={styles.footer}>
            <Text style={styles.muted}>{user ? `signed in as ${user.email ?? user.sub}` : "signed out"}</Text>
            <Link href="/auth" style={styles.link}>
              Account →
            </Link>
            {/* The upgrade regression instrument, not a feature (S4 D43). */}
            <Link href="/probe" style={styles.linkQuiet}>
              Session probe →
            </Link>
          </View>
        }
      />
    </Screen>
  );
}

function LessonRow({
  lesson,
  onDelete,
  disabled,
}: {
  lesson: LessonListItem;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Link href={`/lessons/${lesson.id}`} style={styles.rowTitle} numberOfLines={1}>
          {lesson.title}
        </Link>
        <Pressable onPress={onDelete} disabled={disabled} hitSlop={8} accessibilityLabel={`Delete ${lesson.title}`}>
          <Text style={styles.delete}>Delete</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>
        {lesson.items.length} {lesson.items.length === 1 ? "word" : "words"} · {lesson.sessionCount}{" "}
        {lesson.sessionCount === 1 ? "conversation" : "conversations"} ·{" "}
        {new Date(lesson.created_at).toLocaleDateString()}
      </Text>
      {lesson.items.length > 0 ? (
        <Text style={styles.preview} numberOfLines={1}>
          {lesson.items.join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}

/** Collapsed by default: on a phone a permanently-open composer costs more viewport than it earns. */
function NewLessonForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (title: string, texts: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const texts = body
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  if (!open) {
    return (
      <Pressable style={styles.newToggle} onPress={() => setOpen(true)}>
        <Text style={styles.newToggleLabel}>＋ New lesson</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={setTitle}
        placeholder="Title (optional — defaults to today's date)"
        placeholderTextColor="#5A5A5A"
        maxLength={MAX_LESSON_TITLE}
        accessibilityLabel="Lesson title (optional)"
      />
      <TextInput
        style={[styles.input, styles.multiline]}
        value={body}
        onChangeText={setBody}
        placeholder={"One word, phrase, or sentence per line"}
        placeholderTextColor="#5A5A5A"
        multiline
        accessibilityLabel="Words, phrases, or sentences — one per line"
      />
      <View style={styles.formActions}>
        <Pressable
          style={[styles.retry, texts.length === 0 || busy ? styles.disabled : null]}
          disabled={texts.length === 0 || busy}
          onPress={() => {
            onCreate(title, texts);
            setTitle("");
            setBody("");
            setOpen(false);
          }}
        >
          <Text style={styles.retryLabel}>{busy ? "Creating…" : "Create lesson"}</Text>
        </Pressable>
        <Pressable
          style={styles.quiet}
          onPress={() => {
            setOpen(false);
            setTitle("");
            setBody("");
          }}
        >
          <Text style={styles.quietLabel}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen options={{ headerShown: true, title: "Lessons" }} />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  muted: { color: "#8A8A8A", fontSize: 13, marginTop: 4 },
  preview: { color: "#6E6E6E", fontSize: 13, marginTop: 2 },
  error: { color: "#FF7A7A", fontSize: 13, marginTop: 8, flexShrink: 1 },
  errorRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 8 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#26262E" },
  rowHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  rowTitle: { color: "#E6E6E6", fontSize: 17, fontWeight: "600", flexShrink: 1 },
  delete: { color: "#FF7A7A", fontSize: 14 },
  newToggle: { paddingVertical: 14 },
  newToggleLabel: { color: "#7FB2FF", fontSize: 16, fontWeight: "600" },
  form: { paddingVertical: 12, gap: 8 },
  input: {
    color: "#E6E6E6",
    fontSize: 16,
    backgroundColor: "#1B1B22",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  formActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  retry: { backgroundColor: "#2A2A34", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  retryLabel: { color: "#E6E6E6", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  quiet: { paddingVertical: 10, paddingHorizontal: 6 },
  quietLabel: { color: "#8A8A8A", fontSize: 15 },
  footer: { marginTop: 24, gap: 4, paddingBottom: 24 },
  link: { color: "#7FB2FF", fontSize: 16, paddingVertical: 10 },
  linkQuiet: { color: "#5A5A5A", fontSize: 15, paddingVertical: 10 },
});
