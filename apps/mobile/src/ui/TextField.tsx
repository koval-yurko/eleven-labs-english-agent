import { useMemo, useState } from "react";
import { StyleSheet, TextInput, type TextInputProps, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { control, radius, type } from "./tokens";

/**
 * `input` / `textarea` — the web's field rules, which are four lines of CSS and one important idea:
 * the field's vertical box (1.5 line height + 0.6rem padding + 1px border) is the same box `Button`
 * builds, which is why a button standing beside a field lines up with it at any font size.
 *
 * The focus ring is the web's single `:focus-visible` rule — `2px solid var(--accent)` — with one
 * unavoidable difference. An `outline` is painted outside the box and costs no layout; RN has no
 * outline, and thickening the border on focus would grow the box by 1px a side and shove the text
 * the learner is typing. So focus recolours the border and leaves its width alone. This is the one
 * place in the kit where matching the web exactly would be worse than not.
 */
export function TextField({
  multiline,
  style,
  onFocus,
  onBlur,
  ...props
}: TextInputProps & { style?: ViewStyle }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [focused, setFocused] = useState(false);

  return (
    <TextInput
      {...props}
      multiline={multiline}
      // The web sets this on every field via the shared `input` rule; RN needs it per instance.
      placeholderTextColor={theme.faint}
      onFocus={(e) => {
        setFocused(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        onBlur?.(e);
      }}
      style={[
        styles.field,
        multiline ? styles.multiline : null,
        focused ? styles.focused : null,
        style,
      ]}
    />
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    field: {
      width: "100%",
      backgroundColor: t.sunken,
      color: t.text,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.control,
      paddingVertical: control.fieldPaddingVertical,
      paddingHorizontal: control.fieldPaddingHorizontal,
      minHeight: control.height,
      ...type.body,
    },
    /** `textarea { min-height: 90px }`. `textAlignVertical` is Android's; harmless on iOS. */
    multiline: { minHeight: 90, textAlignVertical: "top" },
    /** The app's one focus ring — colour only; see the docblock on why the width can't follow. */
    focused: { borderColor: t.accent },
  });
