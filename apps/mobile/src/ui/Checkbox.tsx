import { useMemo } from "react";
import { Pressable, StyleSheet } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { CheckIcon } from "./icons";
import { control, radius } from "./tokens";

/**
 * `.checkbox` — 20×20, radius 5, accent fill when checked, with the tick drawn in `onAccent`.
 *
 * The tick is ours rather than the OS's on both platforms, and for the same reason: a system
 * checkbox paints in the *user's* accent colour, which is a per-person setting neither app can
 * match. That is why `onAccent` exists as a role.
 *
 * This replaces the collection screen's SwiftUI `List` selection. Losing that costs the native
 * edit-mode gestures; it buys a selection control that looks identical to the web's and that any
 * row layout can hold.
 */
export function Checkbox({
  checked,
  onChange,
  disabled,
  accessibilityLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      // The box is 20pt, which is under the 44pt touch minimum — the row's own padding does not
      // help a target this small, so it gets its own slop.
      hitSlop={12}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel}
      style={[styles.box, checked ? styles.checked : null, disabled ? styles.disabled : null]}
    >
      {checked ? <CheckIcon size={14} color={theme.onAccent} /> : null}
    </Pressable>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    box: {
      width: control.checkboxSize,
      height: control.checkboxSize,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.sunken,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.checkbox,
    },
    checked: { backgroundColor: t.accent, borderColor: t.accent },
    disabled: { opacity: 0.5 },
  });
