import type { ItemDetail, WordDetails } from "@tutor/shared/word-types";
import { Link, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth0 } from "react-native-auth0";

import { fetchItem, setFavorite } from "@/lib/items";

/**
 * One word: its attributes, cross-lesson statistics, the enrichment payload, and the lessons it is
 * currently in.
 *
 * Plain React Native, with no Expo UI at all — this screen is typography, not controls, and the one
 * SwiftUI thing it could borrow (a grouped `Form`) would buy nothing but a `Host` to size.
 */
export default function WordDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { getCredentials } = useAuth0();

  const accessToken = useCallback(async () => {
    const credentials = await getCredentials();
    return credentials?.accessToken ?? null;
  }, [getCredentials]);

  const [item, setItem] = useState<ItemDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  if (loadError) {
    return (
      <Screen title="Word">
        <Text style={styles.error}>{loadError}</Text>
        <Pressable style={styles.button} onPress={() => void load()}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen title="Word">
        <ActivityIndicator color="#7FB2FF" style={{ marginTop: 24 }} />
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
    <Screen title={item.text}>
      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.titleRow}>
          <Pressable
            onPress={() => void toggleFavorite()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ selected: item.is_favorite }}
            accessibilityLabel={item.is_favorite ? `Unfavorite ${item.text}` : `Favorite ${item.text}`}
          >
            <Text style={[styles.star, item.is_favorite ? styles.starOn : null]}>
              {item.is_favorite ? "★" : "☆"}
            </Text>
          </Pressable>
          <Text style={styles.title}>{item.text}</Text>
          {/* `level` is nullable FOREVER — "unleveled" is a real state, not a pending one, and the
              job is the only thing that ever writes it. */}
          <Text style={styles.badge}>{item.level ?? "—"}</Text>
        </View>
        <Text style={styles.muted}>
          {item.kind} · {stats.join(" · ")}
        </Text>

        <DetailsSection details={item.details} attemptedAt={item.details_at} />

        {categories.length > 0 ? (
          <Section title="Categories">
            {categories.map(([name, value]) => (
              <Text key={name} style={styles.row}>
                <Text style={styles.muted}>{name}: </Text>
                {value}
              </Text>
            ))}
          </Section>
        ) : null}

        <Section title="In lessons">
          {item.lessons.length > 0 ? (
            item.lessons.map((lesson) => (
              <Link key={lesson.id} href={`/lessons/${lesson.id}`} style={styles.link}>
                {lesson.title}
              </Link>
            ))
          ) : (
            // Removing a word from a lesson detaches it; it never deletes it. A real state.
            <Text style={styles.muted}>In no lesson right now.</Text>
          )}
        </Section>
      </ScrollView>
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
  if (!details) {
    return (
      <Section title="Details">
        <Text style={styles.muted}>
          {attemptedAt ? "No extra details for this one." : "Details are being prepared…"}
        </Text>
      </Section>
    );
  }

  return (
    <>
      <Section title="Translation">
        <Text style={styles.row}>
          <Text style={styles.muted}>{details.pos}</Text>
          {details.translations_ru.length > 0 ? ` — ${details.translations_ru.join(", ")}` : ""}
        </Text>
      </Section>

      {details.forms.length > 0 ? (
        <Section title="Forms">
          {details.forms.map((form) => (
            <View key={`${form.pos}:${form.text}`} style={styles.entry}>
              <Text style={styles.row}>
                {form.text} <Text style={styles.muted}>{form.pos}</Text>
              </Text>
              {form.translations_ru.length > 0 ? (
                <Text style={styles.muted}>{form.translations_ru.join(", ")}</Text>
              ) : null}
            </View>
          ))}
        </Section>
      ) : null}

      {details.examples.length > 0 ? (
        <Section title="Examples">
          {details.examples.map((example, i) => (
            <View key={i} style={styles.entry}>
              <Text style={styles.row}>
                {example.text}
                {example.form ? <Text style={styles.muted}> · {example.form}</Text> : null}
              </Text>
              {example.translation_ru ? (
                <Text style={styles.muted}>{example.translation_ru}</Text>
              ) : null}
            </View>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Screen({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={["bottom"]}>
      <Stack.Screen options={{ headerShown: true, title, headerBackTitle: "Words" }} />
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101014", paddingHorizontal: 16 },
  body: { paddingTop: 12, paddingBottom: 40 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  star: { color: "#5A5A5A", fontSize: 22 },
  starOn: { color: "#FFC46B" },
  title: { color: "#E6E6E6", fontSize: 26, fontWeight: "700", flexShrink: 1 },
  badge: {
    color: "#8A8A8A",
    fontSize: 13,
    borderWidth: 1,
    borderColor: "#2A2A34",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  muted: { color: "#8A8A8A", fontSize: 13 },
  section: { marginTop: 24 },
  sectionTitle: { color: "#E6E6E6", fontSize: 15, fontWeight: "700", marginBottom: 8 },
  row: { color: "#E6E6E6", fontSize: 15 },
  entry: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#26262E" },
  link: { color: "#7FB2FF", fontSize: 16, paddingVertical: 8 },
  error: { color: "#FF7A7A", fontSize: 13, marginTop: 8 },
  button: { backgroundColor: "#2A2A34", borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignSelf: "flex-start", marginTop: 8 },
  buttonLabel: { color: "#E6E6E6", fontSize: 15, fontWeight: "600" },
});
