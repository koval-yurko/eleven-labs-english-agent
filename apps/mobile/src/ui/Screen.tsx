import { Stack } from "expo-router";
import { useMemo, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { AppHeader } from "./AppHeader";
import { layout } from "./tokens";

/**
 * `<main>` — the container every page is rendered into.
 *
 * ```css
 * main { max-width: 760px; margin: 0 auto;
 *        padding: calc(2rem + safe-area-top) calc(1.25rem + safe-area-right)
 *                 calc(4rem + safe-area-bottom) calc(1.25rem + safe-area-left); }
 * ```
 *
 * Three things it fixes about the screens as they were:
 *
 *  1. **A content column.** Every screen was `paddingHorizontal: 16`, full bleed. `maxWidth: 760`
 *     is invisible on a phone and is the whole point on an iPad, where a lesson title otherwise
 *     runs across eleven inches of line length.
 *  2. **One scroll container per page.** The screens each managed their own `FlatList` with
 *     `flex: 1`, which is why the lesson page had to be split in two — a transcript that owns the
 *     viewport cannot share it with an editor. Here the page scrolls and its sections are just
 *     tall, which is what lets `/lessons/:id` be one screen again.
 *  3. **The header, on every page.** It is the app's only navigation now.
 *
 * `Stack.Screen` sets `headerShown: false` here rather than in each layout, so a screen cannot
 * accidentally acquire native chrome by forgetting to opt out. Titles are `<H1>`s in the content.
 */
export function Screen({
  children,
  refreshing,
  onRefresh,
  contentStyle,
  scroll = true,
}: {
  children: ReactNode;
  /** Pull-to-refresh. Kept alongside `RefreshButton` — an iOS learner will reach for both. */
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: ViewStyle;
  /**
   * Escape hatch for a screen that must own its own scrolling (a long virtualised list). Prefer
   * the default: the point of the column is that everything above and below scrolls with it.
   */
  scroll?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const body = (
    <View style={[styles.column, contentStyle]}>
      <AppHeader />
      {children}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom", "left", "right"]}>
      <Stack.Screen options={{ headerShown: false }} />
      {/* Every screen has a text field somewhere — the add-word box, the lesson composer, the
          search field — and none of them is worth losing to the keyboard. `padding` is the iOS
          behaviour; Android handles this itself via windowSoftInputMode. */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {scroll ? (
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={!!refreshing}
                  onRefresh={onRefresh}
                  tintColor={theme.accent}
                />
              ) : undefined
            }
          >
            {body}
          </ScrollView>
        ) : (
          <View style={[styles.content, styles.flex]}>{body}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    flex: { flex: 1 },
    content: {
      paddingTop: layout.pagePaddingTop,
      paddingBottom: layout.pagePaddingBottom,
      paddingHorizontal: layout.pagePaddingHorizontal,
      // `flexGrow` rather than `flex`, so a short page still fills the screen (the background
      // reaches the bottom) while a long one is free to exceed it.
      flexGrow: 1,
    },
    /** `margin: 0 auto` — centred, and capped at the web's column width. */
    column: { width: "100%", maxWidth: layout.contentWidth, alignSelf: "center", flexGrow: 1 },
  });
