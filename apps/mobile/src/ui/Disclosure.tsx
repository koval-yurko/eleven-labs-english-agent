import { useMemo, useState, type ReactNode } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { ChevronDownIcon } from "./icons";
import { space } from "./tokens";

/**
 * An expandable section — the web's `Disclosure`, which is where the lesson page keeps its past
 * conversations and its word-change log.
 *
 * The web's version exists to fix `<details>`; there is no `<details>` here, so what carries over is
 * only the *look and the behaviour*: a chevron that points right when collapsed and down when open,
 * and a panel that animates rather than snapping.
 *
 * `LayoutAnimation` rather than Reanimated, deliberately. The app has Reanimated installed (as a
 * transitive dependency) but has never configured or used it, and the animation wanted here is the
 * one `LayoutAnimation` does natively and for free: the next layout pass eases instead of jumping.
 * Bringing a worklet runtime online for a 150ms height change would be the expensive answer to the
 * cheap question.
 *
 * The panel is **unmounted** when collapsed, unlike the web's `hiddenUntilFound`. That is a real
 * loss — the web keeps collapsed transcripts reachable by find-in-page, which is exactly the sort of
 * thing you Cmd+F for — but there is no find-in-page on a phone to serve, so keeping every session's
 * transcript mounted would cost memory for a feature that does not exist.
 */
export function Disclosure({
  summary,
  children,
  style,
  defaultOpen = false,
}: {
  /** Rendered inside the trigger row, to the right of the marker. */
  summary: ReactNode;
  children: ReactNode;
  style?: ViewStyle;
  defaultOpen?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(), []);
  const [open, setOpen] = useState(defaultOpen);

  return (
    <View style={style}>
      <Pressable
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setOpen((prev) => !prev);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.trigger}
      >
        {/* Collapsed: pointing right, like a details marker. */}
        <View style={open ? undefined : styles.markerCollapsed}>
          <ChevronDownIcon size={16} color={theme.muted} />
        </View>
        <View style={styles.summary}>{summary}</View>
      </Pressable>
      {open ? <View style={styles.panel}>{children}</View> : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    trigger: {
      flexDirection: "row",
      alignItems: "center",
      gap: 0.4 * 16,
      paddingVertical: space.row,
    },
    markerCollapsed: { transform: [{ rotate: "-90deg" }] },
    summary: { flex: 1, minWidth: 0 },
    panel: { paddingBottom: space.row },
  });
