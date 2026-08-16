import { useMemo, useState } from "react";
import { StyleSheet, TextInput, type TextInputProps, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { control, radius, type } from "./tokens";

/**
 * `input` / `textarea` — the web's field rules, which are four lines of CSS and one important idea:
 * the field's vertical box (1.5 line height + 0.6rem padding + 1px border) is the same box `Button`
 * builds, which is why a button standing beside a field lines up with it at any font size. The box
 * is built from `minHeight` + padding rather than from the line height, though — on iOS a
 * `lineHeight` inside a text input is what clips the tails off `g`, `p` and `j`, so this is the one
 * style in the kit that takes `type.body` apart. See the two notes in `makeStyles`.
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
      /**
       * `type.body` SPREAD APART, and the one place in the kit where a token is taken in halves.
       *
       * The line height is deliberately not here. On a `TextInput` iOS reads it as the paragraph
       * style's min/max line height and adds the extra leading above the baseline, which drops the
       * glyphs far enough down the 24px content box this field's height contract leaves (45.2 − 2 ×
       * 9.6 padding − 2 × 1 border) that `g`, `p` and `j` are shaved off at the bottom edge — see
       * `control.fieldDescenderSlack`. One line of text has no line spacing to describe, so the
       * declaration bought nothing and cost the descenders. Dropping it does not move the box: the
       * height is `minHeight`, not the line box, so a field still lines up with the button beside it.
       */
      fontSize: type.body.fontSize,
    },
    /**
     * `textarea { min-height: 90px }`. `textAlignVertical` is Android's; harmless on iOS.
     *
     * Here the line height IS wanted — several lines of words need the body's 1.5 spacing between
     * them — so it comes back, and the last line's descenders are paid for with bottom padding
     * instead. Asymmetric on purpose: the slack has to be under the text, and adding it to both
     * edges would push the first line off the top of a textarea that is already vertically top-set.
     */
    multiline: {
      minHeight: 90,
      textAlignVertical: "top",
      lineHeight: type.body.lineHeight,
      paddingBottom: control.fieldPaddingVertical + control.fieldDescenderSlack,
    },
    /** The app's one focus ring — colour only; see the docblock on why the width can't follow. */
    focused: { borderColor: t.accent },
  });
