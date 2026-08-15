import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Muted } from "./Text";
import { radius, space, type } from "./tokens";

/**
 * `.chip` — the filter pill.
 *
 * Same pill for two different jobs, exactly as on the web: a toggle inside a filter group (where
 * `pressed` drives the active look), and a plain button that only *looks* like a chip — the sort
 * direction and "Clear".
 */
export function Chip({
  label,
  pressed,
  onPress,
  disabled,
  children,
  accessibilityLabel,
}: {
  label?: string;
  /** Omit entirely for the button-shaped uses; they are never "on". */
  pressed?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  children?: ReactNode;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      // `radio` would be wrong for the multi-select groups and `button` loses the on/off state, so
      // this reports as a toggle and lets `selected` carry the rest.
      accessibilityRole="button"
      accessibilityState={{ selected: !!pressed, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed: down }) => [
        styles.chip,
        pressed ? styles.on : null,
        disabled ? styles.disabled : null,
        down && !disabled ? styles.down : null,
      ]}
    >
      {label ? <Text style={[styles.label, pressed ? styles.labelOn : null]}>{label}</Text> : null}
      {children}
    </Pressable>
  );
}

/**
 * A labelled row of chips — `.filter-row` plus its `.filter-label`.
 *
 * `flexWrap` is load-bearing here and not decoration. This screen's filters are laid out FLAT on
 * the web, and reproducing that on a phone is the riskiest single call in the whole port: six
 * groups of chips is a lot of vertical space at 390pt. Wrapping is what keeps it merely tall
 * instead of clipped, and the page scrolls.
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.3, §10.
 */
export function ChipRow({
  label,
  children,
  style,
}: {
  label?: string;
  children: ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={[styles.group, style]}>
      {label ? <Muted style={styles.groupLabel}>{label}</Muted> : null}
      <View style={styles.row}>{children}</View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.pill,
      paddingVertical: 0.2 * 16, // .chip { padding: 0.2rem 0.7rem }
      paddingHorizontal: 0.7 * 16,
    },
    on: { backgroundColor: t.accent, borderColor: t.accent },
    disabled: { opacity: 0.5 },
    down: { opacity: 0.7 },
    label: { ...type.small, fontWeight: type.weightMedium, color: t.text },
    labelOn: { color: t.onAccent },

    group: { gap: 4 },
    /** `.filter-label` — uppercase, letter-spaced, small. */
    groupLabel: { ...type.tiny, textTransform: "uppercase", letterSpacing: 0.6 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: space.chipGap, alignItems: "center" },
  });
