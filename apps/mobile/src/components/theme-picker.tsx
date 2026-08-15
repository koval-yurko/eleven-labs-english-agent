import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { setThemeChoice, useTheme, useThemeChoice, type Palette, type ThemeChoice } from "@/theme";

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * The three-state appearance control — System / Light / Dark, defaulting to System.
 *
 * Three states rather than a toggle is the web's decision (docs/2026-07-03-light-dark-theme-support.md
 * §3c) and it holds here for the same reason: "follow the phone" and "always dark" are different
 * wishes, and a two-way switch cannot express the first once you have touched it.
 *
 * It is also what makes the appearance testable. Checking every screen in both appearances is on
 * S7's gate; without this the only way to flip is iOS Settings, twice per screen.
 */
export function ThemePicker() {
  const theme = useTheme();
  const choice = useThemeChoice();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={styles.row} accessibilityRole="radiogroup" accessibilityLabel="Appearance">
      {CHOICES.map(({ value, label }) => {
        const on = choice === value;
        return (
          <Pressable
            key={value}
            style={[styles.chip, on ? styles.chipOn : null]}
            onPress={() => setThemeChoice(value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
          >
            <Text style={[styles.label, on ? styles.labelOn : null]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", gap: 8, marginTop: 8 },
    chip: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: t.control,
    },
    chipOn: { backgroundColor: t.control },
    label: { color: t.muted, fontSize: 13 },
    labelOn: { color: t.text, fontWeight: "600" },
  });
