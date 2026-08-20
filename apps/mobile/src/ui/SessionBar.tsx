import { type Palette } from "@tutor/shared/theme";
import { router, usePathname } from "expo-router";
import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useActiveSession } from "@/lib/tutor-session";
import { useTheme } from "@/theme";
import { control, radius, space, type } from "./tokens";

/**
 * "A lesson is still talking — tap to go back to it."
 *
 * This bar is the price of letting a session survive navigation. The lesson screen used to hang up
 * on unmount, and the argument for that guard was sound: *a live, billed, listening session running
 * with nothing on screen saying so is a bug.* Removing the guard without answering that objection
 * would simply have shipped the bug. So the objection is answered instead — on every screen, in the
 * app, in the one place a thumb can reach.
 *
 * It renders nowhere else's business: it is hidden on the lesson's own screen, which has the real
 * controls a foot above it, and it disappears the moment the session ends. It navigates and does
 * nothing else — pausing, muting and ending are decisions taken where the learner can see what they
 * are deciding about (the lesson screen) or on a surface built for a locked device (the Controls).
 *
 * `useActiveSession` rather than the full session state, deliberately: this is mounted for the whole
 * life of the app and the full state changes on every transcript line. See `lib/tutor-session.tsx`.
 */
export function SessionBar() {
  const active = useActiveSession();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  if (!active) return null;
  // Already there — the screen's own button row says everything this bar could.
  if (pathname === `/lessons/${active.lessonId}`) return null;

  const label = active.held ? "Paused" : "In progress";

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + space.row }]} pointerEvents="box-none">
      <Pressable
        onPress={() => router.push(`/lessons/${active.lessonId}`)}
        accessibilityRole="link"
        accessibilityLabel={`${label}: ${active.title}. Return to the lesson.`}
        style={({ pressed }) => [styles.bar, pressed ? styles.pressed : null]}
      >
        <Text style={[styles.dot, active.held ? styles.dotHeld : styles.dotLive]}>
          {active.held ? "⏸" : "●"}
        </Text>
        <Text style={styles.title} numberOfLines={1}>
          {active.title}
        </Text>
        <Text style={styles.action}>Return →</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    /**
     * Absolutely positioned over the navigator, like `NavProgressBar` and for the same reason: it
     * belongs to the app rather than to any screen, so it must not travel with a screen's scroll.
     * `zIndex` sits just under the progress bar's 100.
     */
    wrap: {
      position: "absolute",
      left: space.row,
      right: space.row,
      zIndex: 90,
      elevation: 90,
      alignItems: "center",
    },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.row,
      minHeight: control.heightSm,
      maxWidth: 520,
      paddingVertical: control.paddingVerticalSm,
      paddingHorizontal: control.paddingHorizontal,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.panel,
      // The bar floats over content, so it needs to read as raised rather than as a stripe painted
      // on the page. Both platforms' vocabulary, because `elevation` is ignored on iOS and
      // `shadow*` on Android.
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    pressed: { backgroundColor: t.sunken },
    dot: { ...type.small },
    dotLive: { color: t.ok },
    dotHeld: { color: t.warn },
    title: { ...type.small, color: t.text, fontWeight: type.weightSemibold, flexShrink: 1 },
    action: { ...type.small, color: t.accent, fontWeight: type.weightSemibold },
  });
