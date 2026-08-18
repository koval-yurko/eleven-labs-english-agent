import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { control, radius, space, type } from "./tokens";

/**
 * The app's button — `apps/web/src/app/Button.tsx` and the `.btn*` rules, in one component.
 *
 * The web's docblock is worth reading for the *why*; the part that has to survive the port is the
 * geometry rule it lands on:
 *
 * > The fix is not a magic height: `.btn` reproduces the field's vertical box exactly — 1.5 line
 * > height, the same 0.6rem padding, the same 1px border (transparent when the variant has no
 * > visible one) — so the two agree at any font size.
 *
 * That is why `paddingVertical` and `borderWidth: 1` are unconditional below and `minHeight` is a
 * floor rather than the definition. A variant with no visible border still draws a transparent one,
 * so `secondary` and `primary` are the same size — half of why buttons and fields line up.
 *
 * Variants are about SHAPE, `tone` only about COLOUR, which keeps "a destructive icon button" and
 * "a destructive solid button" from needing separate variants.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet" | "icon" | "inline";

export function Button({
  variant = "primary",
  size = "md",
  tone,
  onPress,
  disabled,
  children,
  label,
  style,
  hitSlop,
  accessibilityLabel,
}: {
  /**
   * - `primary` — accent fill, the default action
   * - `secondary` — bordered, same box, for a neutral action beside a primary one
   * - `quiet` — no fill or border, still a full-size control
   * - `icon` — square, chrome-free; needs an `accessibilityLabel`
   * - `inline` — no box at all, for a button sitting inside a line of text
   */
  variant?: ButtonVariant;
  /**
   * `md` (default) matches the height of a `TextField`, for anything standing beside one. `sm` is
   * the compact tier for controls among navigation or chips. Ignored by `icon` and `inline`, which
   * size themselves.
   */
  size?: "md" | "sm";
  /** `danger` recolours whichever variant is in use; it never changes the shape. */
  tone?: "danger";
  onPress?: () => void;
  disabled?: boolean;
  /** The text. Prefer this over `children` — it gets the right weight, size and colour. */
  label?: string;
  /** For a glyph, or a glyph *and* a label: `.btn` is a flex row with a 0.4rem gap. */
  children?: ReactNode;
  style?: ViewStyle;
  /**
   * Extra touch area outside the box, in points. Not decoration: `icon` is 32pt square and
   * `inline` has no box at all, both under the 44pt minimum — and an icon button nested inside a
   * pressable ROW (the lessons list since
   * docs/2026-08-18-collection-and-lessons-list-fixes.md §2) turns a near-miss into a navigation
   * rather than into nothing, which is the worse failure.
   */
  hitSlop?: number;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const shape = [
    styles.base,
    size === "sm" ? styles.sm : null,
    variant === "primary" ? styles.primary : null,
    variant === "secondary" ? styles.secondary : null,
    variant === "quiet" ? styles.quiet : null,
    variant === "icon" ? styles.icon : null,
    variant === "inline" ? styles.inline : null,
    // Applied last so it wins over the variant's own background.
    tone === "danger" && variant === "primary" ? styles.dangerFill : null,
    disabled ? styles.disabled : null,
    style,
  ];

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [...shape, pressed && !disabled ? styles.pressed : null]}
    >
      {/* Glyph first, then label — the order the web's call sites use (`<SunIcon/> Light`). */}
      {children}
      {label ? <Text style={labelStyle(styles, variant, tone)}>{label}</Text> : null}
    </Pressable>
  );
}

/**
 * The label's colour is the one thing that can't be folded into the container's style array: RN
 * does not cascade colour to a child `<Text>`, so the variant has to be resolved twice.
 */
function labelStyle(
  styles: ReturnType<typeof makeStyles>,
  variant: ButtonVariant,
  tone: "danger" | undefined,
) {
  if (variant === "primary") return [styles.label, styles.labelOnAccent];
  if (variant === "inline")
    return [styles.labelInline, tone === "danger" ? styles.labelDanger : styles.labelAccent];
  if (tone === "danger") return [styles.label, styles.labelDanger];
  if (variant === "quiet") return [styles.label, styles.labelMuted];
  return [styles.label, styles.labelText];
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    base: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 0.4 * 16,
      minHeight: control.height,
      paddingVertical: control.paddingVertical,
      paddingHorizontal: control.paddingHorizontal,
      // Transparent rather than absent, so variants with a visible border are the same size as
      // those without. See the docblock.
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: radius.control,
    },
    sm: {
      minHeight: control.heightSm,
      paddingVertical: control.paddingVerticalSm,
      paddingHorizontal: control.paddingHorizontalSm,
    },
    primary: { backgroundColor: t.accent },
    secondary: { backgroundColor: "transparent", borderColor: t.border },
    quiet: { backgroundColor: "transparent" },
    /**
     * Square and chrome-free, and deliberately NOT `control.height`. Both icon buttons in this app
     * sit in dense list rows next to a 20px checkbox, where a 45px square would inflate every row.
     */
    icon: {
      minHeight: control.iconSize,
      minWidth: control.iconSize,
      paddingVertical: 0,
      paddingHorizontal: 0,
      backgroundColor: "transparent",
    },
    /** No box at all — for a button inside a sentence, where a control-sized block breaks the line. */
    inline: {
      minHeight: 0,
      paddingVertical: 0,
      paddingHorizontal: 0,
      borderWidth: 0,
      backgroundColor: "transparent",
    },
    dangerFill: { backgroundColor: t.error },
    /** The web's `button:disabled { opacity: 0.5 }`. */
    disabled: { opacity: 0.5 },
    /**
     * RN has no `:hover`, and the web has no press state — this is the one place the two genuinely
     * cannot match, because a touch screen owes the finger feedback that a cursor gets from hover.
     * Kept to an opacity nudge so it reads as the same button.
     */
    pressed: { opacity: 0.7 },

    label: { ...type.body, fontWeight: type.weightSemibold },
    labelOnAccent: { color: t.onAccent },
    labelText: { color: t.text },
    labelMuted: { color: t.muted },
    labelAccent: { color: t.accent },
    labelDanger: { color: t.error },
    /** `.btn--inline` inherits the surrounding type and underlines, so it reads as part of the text. */
    labelInline: { ...type.body, textDecorationLine: "underline" },
  });

/** A plain row of buttons — `.dialog-actions` / the web's recurring `gap: 0.5rem` flex row. */
export function ButtonRow({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: space.row }, style]}>{children}</View>;
}
