import type { LessonListItem } from "@tutor/shared/lesson-types";
import {
  buildCreateLessonOp,
  MAX_ITEMS,
  MAX_LESSON_TITLE,
  nextLessonTitle,
} from "@tutor/shared/sync-ops";
import { type Palette } from "@tutor/shared/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth0 } from "react-native-auth0";

import { newId } from "@/lib/ids";
import { fetchLessons, lessonTitleOrFallback, postOp } from "@/lib/lessons";
import { useActiveSession } from "@/lib/tutor-session";
import { useTheme } from "@/theme";
import {
  Body,
  Button,
  ButtonRow,
  ConfirmDialog,
  ErrorText,
  Faint,
  H1,
  LegalLinks,
  Link,
  Muted,
  Panel,
  Screen,
  TextField,
  TrashIcon,
  useLoadingIndicator,
  radius,
  space,
  type,
} from "@/ui";

/**
 * `/lessons` — the learner's word sets.
 *
 * Ported to the web's structure (docs/2026-08-15-web-design-parity-on-mobile.md §8.5). Three
 * changes worth naming, all of them reversals of native-idiom decisions:
 *
 *  - **It is no longer the app's home screen.** `/` redirects to the collection now, as it does on
 *    the web. See `app/index.tsx`.
 *  - **The composer is collapsed.** It went open (to match the web) and is folded again, which is
 *    where it started life as a `＋ New lesson` toggle: the reasoning that a permanently-open
 *    composer costs more viewport than it earns on a phone turned out to be right. What is
 *    different this time is the mechanism — `Panel collapsible` rather than a bespoke toggle, so
 *    the affordance is the same one the words page uses for its filters.
 *
 *    The composer's draft does not survive a fold (`Panel` unmounts its children — see its
 *    docblock). Accepted rather than worked around: the fold is a deliberate press, and a title and
 *    a word list are seconds of typing, not minutes.
 *  - **Delete confirms in our own dialog**, not `Alert.alert`. Same copy, drawn in the app's type
 *    and colours.
 *
 * The write path is untouched: optimistic apply, then re-read, because `postOp` resolving means the
 * server stopped retrying and not that anything changed (S5 §3.2 / D47).
 */
export default function LessonsScreen() {
  const { user, getCredentials } = useAuth0();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  const [lessons, setLessons] = useState<LessonListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<{ id: string; title: string } | null>(null);

  /**
   * Which lesson is talking, if any.
   *
   * A session used to be unable to outlive the screen that started it, so this list could never be
   * looking at one — leaving the lesson ended it. It can now (`lib/tutor-session.tsx`), which makes
   * "no marker" a lie the moment the learner navigates back here mid-conversation.
   *
   * `useActiveSession` and not the full session state, deliberately: the full state changes on
   * every transcript turn, and reading it here would redraw the whole list several times a minute
   * to render one unchanged chip.
   */
  const running = useActiveSession();

  // The top bar reports the first load and every write, which is what it reports on the web too.
  useLoadingIndicator(lessons === null || busy);

  /**
   * What a failed write left behind: the optimistic state it wanted and the op that would produce
   * it. The ARGUMENTS rather than a closure over `write`, because they are exactly what a durable
   * outbox would store when the mirror lands.
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
   * that anything changed, so server truth has to replace the guess. On failure the snapshot goes
   * back — deterministic, and it needs no network, which matters because the usual reason a write
   * failed is that there isn't one.
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

  function onDelete(id: string) {
    if (!lessons) return;
    void write(
      lessons.filter((l) => l.id !== id),
      () => postOp(accessToken, { kind: "deleteLesson", lessonId: id }),
    );
  }

  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()}>
      <H1>Lessons</H1>
      <Muted>
        A lesson is a set of words, phrases, or sentences you&apos;re learning. Open one to talk it
        through with the tutor and revisit past conversations.
      </Muted>

      <Panel title="New lesson" collapsible defaultOpen={false}>
        <NewLessonForm busy={busy} onCreate={(t, x) => void createLesson(t, x)} />
      </Panel>

      {writeError ? (
        <Panel tone="error">
          <ErrorText>{writeError}</ErrorText>
          <ButtonRow style={{ marginTop: space.row }}>
            <Button
              variant="secondary"
              label="Retry"
              disabled={busy}
              onPress={() => {
                const again = retryRef.current;
                if (again) void write(again.next, again.run);
              }}
            />
          </ButtonRow>
        </Panel>
      ) : null}

      <Panel title="Your lessons">
        {loadError ? (
          <>
            <ErrorText>{loadError}</ErrorText>
            <ButtonRow style={{ marginTop: space.row }}>
              <Button variant="secondary" label="Try again" onPress={() => void load()} />
            </ButtonRow>
          </>
        ) : lessons === null ? (
          <ActivityIndicator color={theme.accent} />
        ) : lessons.length === 0 ? (
          <Muted>No lessons yet — create your first one above.</Muted>
        ) : (
          lessons.map((lesson) => {
            const title = lessonTitleOrFallback(lesson.title);
            return (
              <Pressable
                key={lesson.id}
                onPress={() => router.push(`/lessons/${lesson.id}`)}
                accessibilityRole="link"
                accessibilityLabel={`${title}, ${lesson.items.length} ${
                  lesson.items.length === 1 ? "item" : "items"
                }${
                  running?.lessonId === lesson.id
                    ? running.held
                      ? ", paused conversation"
                      : ", conversation in progress"
                    : ""
                }`}
                style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
              >
                <View style={styles.rowHead}>
                  {/* Not a `Link` any more: the whole row navigates, and two nested routes to the
                      same place is one too many. It was already `variant="plain"`, i.e. it never
                      looked like a link — so this is a change of mechanism, not of appearance. */}
                  <Body style={styles.rowTitle} numberOfLines={1}>
                    {title}
                  </Body>
                  {/* The live marker. Two states, not one: a held pause is still a session — it
                      holds the line open and is still billed — and a learner who sees "In progress"
                      on a lesson they paused would reasonably think the pause had not taken. */}
                  {running?.lessonId === lesson.id ? (
                    <Text
                      style={[styles.badge, running.held ? styles.badgeHeld : styles.badgeLive]}
                    >
                      {running.held ? "⏸ Paused" : "● In progress"}
                    </Text>
                  ) : null}
                  <Button
                    variant="icon"
                    tone="danger"
                    disabled={busy}
                    // The bin is 32pt inside a ~70pt target that navigates: without slop a near-miss
                    // opens the lesson the learner was trying to delete.
                    hitSlop={8}
                    onPress={() => setConfirmTarget({ id: lesson.id, title })}
                    accessibilityLabel={`Delete ${title}`}
                  >
                    <TrashIcon size={18} color={theme.error} />
                  </Button>
                </View>
                <Muted>
                  {lesson.items.length} {lesson.items.length === 1 ? "item" : "items"} ·{" "}
                  {lesson.sessionCount}{" "}
                  {lesson.sessionCount === 1 ? "conversation" : "conversations"} ·{" "}
                  {new Date(lesson.created_at).toLocaleDateString()}
                </Muted>
                {lesson.items.length > 0 ? (
                  <Faint numberOfLines={1}>{lesson.items.join(" · ")}</Faint>
                ) : null}
              </Pressable>
            );
          })
        )}
      </Panel>

      {/* The web's footer has no counterpart — Auth0 and the suspension instrument are the phone's
          own concerns — so it stays, as quiet prose rather than a panel. */}
      <View style={styles.footer}>
        <Faint>{user ? `signed in as ${user.email ?? user.sub}` : "signed out"}</Faint>
        <Link href="/auth">Account →</Link>
        {/* The upgrade regression instrument, not a feature (S4 D43). */}
        <Link href="/probe" style={styles.quietLink}>
          Session probe →
        </Link>
        <LegalLinks />
      </View>

      {/* One dialog for the whole list, driven by which row is pending — not one mounted per row. */}
      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
        title={confirmTarget ? `Delete “${confirmTarget.title}”?` : ""}
        // The one place soft delete is ever explained to the learner. Words are owned by the
        // learner, not by a lesson — see docs/2026-07-17-delete-lesson-keep-words.md.
        description="Your words and their practice history stay in your collection."
        confirmLabel="Delete"
        onConfirm={() => {
          if (confirmTarget) onDelete(confirmTarget.id);
        }}
      />
    </Screen>
  );
}

/**
 * The composer. Folded away behind its panel title — see the screen's docblock.
 *
 * The submit is disabled until there is at least one non-blank line, which is the mobile
 * equivalent of the web's `required` textarea and its `Add at least one word…` field error.
 */
function NewLessonForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (title: string, texts: string[]) => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  const texts = body
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS);

  return (
    <View style={{ gap: space.row }}>
      <TextField
        value={title}
        onChangeText={setTitle}
        placeholder="Title (optional — defaults to today's date)"
        maxLength={MAX_LESSON_TITLE}
        accessibilityLabel="Lesson title (optional)"
      />
      <TextField
        value={body}
        onChangeText={setBody}
        multiline
        placeholder={
          "One word, phrase, or sentence per line, e.g.\nephemeral\nbreak the ice\nI couldn't agree more"
        }
        accessibilityLabel="Words, phrases, or sentences — one per line"
      />
      <ButtonRow>
        <Button
          label={busy ? "Creating…" : "Create lesson"}
          disabled={texts.length === 0 || busy}
          onPress={() => {
            onCreate(title, texts);
            setTitle("");
            setBody("");
          }}
        />
      </ButtonRow>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    row: { paddingVertical: 0.6 * 16, borderBottomWidth: 1, borderBottomColor: t.border },
    /**
     * The row is a control now and owes the finger what `Button` already gives it. A background
     * flash rather than `Button`'s opacity nudge: a whole row dimming reads as the list going away,
     * where a tint reads as the row being picked.
     */
    rowPressed: { backgroundColor: t.sunken },
    rowHead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 0.75 * 16,
    },
    rowTitle: { ...type.body, fontWeight: type.weightSemibold, flexShrink: 1 },
    /**
     * Deliberately a text badge rather than a `Chip`: a chip is a control, and this is a fact about
     * the row. It sits between the title and the bin, where it also does the useful work of pushing
     * a destructive button away from a lesson that is mid-conversation.
     */
    badge: {
      ...type.small,
      fontWeight: type.weightSemibold,
      borderWidth: 1,
      borderRadius: radius.pill,
      paddingHorizontal: 0.5 * 16,
      paddingVertical: 0.1 * 16,
      overflow: "hidden",
    },
    badgeLive: { color: t.ok, borderColor: t.ok },
    badgeHeld: { color: t.warn, borderColor: t.warn },
    footer: { marginTop: space.panelPadding, gap: 4 },
    quietLink: { color: t.faint },
  });
