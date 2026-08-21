import { type Palette } from "@tutor/shared/theme";
import type { ItemDetail, WordDetails } from "@tutor/shared/word-types";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import { useAccessToken } from "@/lib/auth";
import { deleteWord, fetchItem, setFavorite } from "@/lib/items";
import { useTheme } from "@/theme";
import {
  ActionRow,
  Body,
  Button,
  ButtonRow,
  ConfirmDialog,
  ErrorText,
  H1,
  Link,
  Muted,
  Panel,
  RefreshButton,
  Screen,
  StarIcon,
  TrashIcon,
  radius,
  space,
  type,
  useLoadingIndicator,
} from "@/ui";

/**
 * `/lesson-items/:id` — one word: its attributes, cross-lesson statistics, the enrichment payload,
 * and the lessons it is currently in.
 *
 * The screen closest to parity before the port — it was already plain React Native and already
 * carried the web's content in the web's order. What it gained is the shell: panels instead of bare
 * sections, the `← words & sentences` link the web puts above the title (there is no native back
 * chevron any more), a `RefreshButton` (enrichment lands *after* the write, so asking again is the
 * whole point of this page having one), and the level as a bordered pill.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.4.
 */
export default function WordDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const accessToken = useAccessToken();

  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  useLoadingIndicator(item === null && loadError === null);

  const load = useCallback(async () => {
    try {
      setItem(await fetchItem(accessToken, id));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [accessToken, id]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  /** Optimistic, and keyed on `norm_key` like everywhere else this write appears (D66). */
  async function toggleFavorite() {
    if (!item) return;
    const next = !item.is_favorite;
    setItem({ ...item, is_favorite: next });
    try {
      await setFavorite(accessToken, item.norm_key, next);
    } catch {
      setItem((prev) => (prev ? { ...prev, is_favorite: !next } : prev));
    }
  }

  /**
   * Delete this word, then leave — the screen is about a row that no longer exists.
   *
   * NOT optimistic, unlike the collection list's copy of this: there is nothing to be optimistic
   * about on a page whose only content is the word itself, and `router.back()` on a failed write
   * would drop the learner on the list with the word still in it and no error anywhere.
   */
  async function remove() {
    if (!item) return;
    setWriteError(null);
    try {
      await deleteWord(accessToken, item.id);
      // The collection refetches on mount, so the row is gone by the time it is looked at.
      router.back();
    } catch (e) {
      setWriteError(e instanceof Error ? e.message : String(e));
    }
  }

  const header = (
    <ActionRow>
      <Muted style={{ flex: 1 }}>
        <Link href="/lesson-items">← words &amp; sentences</Link>
      </Muted>
      <RefreshButton label="Refresh word" onRefresh={load} />
    </ActionRow>
  );

  if (loadError) {
    return (
      <Screen>
        {header}
        <Panel tone="error">
          <ErrorText>{loadError}</ErrorText>
          <ButtonRow style={{ marginTop: space.row }}>
            <Button variant="secondary" label="Try again" onPress={() => void load()} />
          </ButtonRow>
        </Panel>
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen>
        {header}
        <ActivityIndicator color={theme.accent} style={{ marginTop: 24 }} />
      </Screen>
    );
  }

  const stats = [
    `${item.practice_count} ${item.practice_count === 1 ? "conversation" : "conversations"}`,
    `${item.lesson_count} ${item.lesson_count === 1 ? "lesson" : "lessons"}`,
    `added ${new Date(item.first_added_at).toLocaleDateString()}`,
    item.last_practiced_at
      ? `last practiced ${new Date(item.last_practiced_at).toLocaleDateString()}`
      : null,
  ].filter(Boolean);

  const categories = Object.entries(item.categories);

  return (
    <Screen>
      {header}

      <View style={styles.titleRow}>
        <Button
          variant="icon"
          onPress={() => void toggleFavorite()}
          accessibilityLabel={item.is_favorite ? `Unfavorite ${item.text}` : `Favorite ${item.text}`}
        >
          <StarIcon
            size={20}
            state={item.is_favorite ? "filled" : "empty"}
            color={item.is_favorite ? theme.warn : theme.faint}
          />
        </Button>
        <H1 style={styles.title}>{item.text}</H1>
        {/* `level` is nullable FOREVER — "unleveled" is a real state, not a pending one, and the
            job is the only thing that ever writes it. */}
        {item.level ? <Muted style={styles.pill}>{item.level}</Muted> : null}
        <Muted>{item.kind}</Muted>
        {/* Last in the row, as it is in every list row: the destructive control is the one the
            thumb should have to travel to, and here it also keeps the level pill and the kind
            beside the word they describe. */}
        <Button
          variant="icon"
          tone="danger"
          onPress={() => setConfirmOpen(true)}
          accessibilityLabel={`Delete ${item.text}`}
        >
          <TrashIcon size={20} color={theme.error} />
        </Button>
      </View>

      <Muted>{stats.join(" · ")}</Muted>

      <DetailsSection details={item.details} attemptedAt={item.details_at} />

      {categories.length > 0 ? (
        <Panel title="Categories">
          {categories.map(([name, value]) => (
            <Body key={name}>
              <Text style={styles.muted}>{name}: </Text>
              {value}
            </Body>
          ))}
        </Panel>
      ) : null}

      {/* Kept at the bottom: the enrichment is what the learner opens this page for; the lesson
          membership is secondary context. */}
      <Panel title="In lessons">
        {item.lessons.length > 0 ? (
          item.lessons.map((lesson) => (
            <View key={lesson.id} style={styles.entry}>
              <Link href={`/lessons/${lesson.id}`}>{lesson.title}</Link>
            </View>
          ))
        ) : (
          // Removing a word from a lesson detaches it; it never deletes it. A real state.
          <Muted>In no lesson right now.</Muted>
        )}
      </Panel>

      {writeError ? (
        <Panel tone="error">
          <ErrorText>{writeError}</ErrorText>
        </Panel>
      ) : null}

      {/* The same warning the collection list gives, because it is the same write. */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete “${item.text}”?`}
        description="It leaves every lesson and loses its practice history and translation. This can’t be undone."
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </Screen>
  );
}

/**
 * The enrichment payload — **three states, and only one of them is loading**.
 *
 * - `details` set → translations, forms, examples.
 * - both null → queued or in flight (the job runs after the write, or on the next sweep).
 * - `details` null but `details_at` set → the model had no usable answer for it (a non-English
 *   token, a made-up word). **Terminal and normal**, not an error and not a spinner.
 *
 * That last case is the one worth being careful about: `details_at` is stamped when the job
 * ATTEMPTED the word, not when it succeeded, so an un-enrichable word is asked about once rather
 * than on every sweep — and a UI that showed "preparing…" for it would say so forever.
 * See docs/2026-07-18-word-details-enrichment-job.md.
 */
function DetailsSection({
  details,
  attemptedAt,
}: {
  details: WordDetails | null;
  attemptedAt: string | null;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  if (!details) {
    return (
      <Panel title="Details">
        <Muted>
          {attemptedAt ? "No extra details for this one." : "Details are being prepared…"}
        </Muted>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="Translation">
        <Body>
          <Text style={styles.muted}>{details.pos}</Text>
          {details.translations_ru.length > 0 ? ` — ${details.translations_ru.join(", ")}` : ""}
        </Body>
      </Panel>

      {details.forms.length > 0 ? (
        <Panel title="Forms">
          {details.forms.map((form) => (
            <View key={`${form.pos}:${form.text}`} style={styles.entry}>
              <Body>
                <Text style={styles.strong}>{form.text}</Text>{" "}
                <Text style={styles.muted}>{form.pos}</Text>
              </Body>
              {form.translations_ru.length > 0 ? (
                <Muted>{form.translations_ru.join(", ")}</Muted>
              ) : null}
            </View>
          ))}
        </Panel>
      ) : null}

      {details.examples.length > 0 ? (
        <Panel title="Examples">
          {details.examples.map((example, i) => (
            <View key={i} style={styles.entry}>
              <Body>
                {example.text}
                {example.form ? <Text style={styles.muted}> · {example.form}</Text> : null}
              </Body>
              {example.translation_ru ? <Muted>{example.translation_ru}</Muted> : null}
            </View>
          ))}
        </Panel>
      ) : null}
    </>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    titleRow: { flexDirection: "row", alignItems: "center", gap: 0.6 * 16, marginTop: space.row },
    title: { flex: 1 },
    /** The web's inline pill: 1px border, fully rounded, `0.1rem 0.6rem`. */
    pill: {
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.pill,
      paddingHorizontal: 0.6 * 16,
      paddingVertical: 0.1 * 16,
      overflow: "hidden", // iOS clips a Text's background to its border radius only with this
    },
    muted: { ...type.small, color: t.muted },
    strong: { fontWeight: type.weightBold },
    entry: { paddingVertical: 0.35 * 16, borderBottomWidth: 1, borderBottomColor: t.border },
  });
