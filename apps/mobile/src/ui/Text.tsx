import { useMemo } from "react";
import { StyleSheet, Text as RNText, type TextProps as RNTextProps } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { type } from "./tokens";

/**
 * The type scale, as components.
 *
 * On the web these are `<h1>`, `<h2>`, `<p>` and `.muted` — three of which the app never styles,
 * because the browser's own stylesheet already gives headings a size and a weight. React Native has
 * no such stylesheet: an unstyled `<Text>` is 14px, regular, and *black*, which is how the mobile
 * app ended up on a 17/16/15/13 scale that shares no size with the web at all.
 *
 * So every one of these exists to stop a screen writing `fontSize` inline. If a screen needs a size
 * that is not here, the honest move is to add it here and to `tokens.ts` — the alternative is the
 * drift that produced a thirteenth grey last time.
 *
 * `H1`/`H2` set `accessibilityRole="header"` so VoiceOver's heading rotor works the way the web's
 * does for free.
 */
type TextProps = RNTextProps & { children: React.ReactNode };

/** `<h1>` — 32/bold. One per screen, naming the screen. */
export function H1({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText accessibilityRole="header" {...props} style={[styles.h1, style]} />;
}

/** `<h2>` — 24/bold. The title of a `Panel`. */
export function H2({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText accessibilityRole="header" {...props} style={[styles.h2, style]} />;
}

/** `<p>` — 16/1.5 in `text`. The default for prose. */
export function Body({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText {...props} style={[styles.body, style]} />;
}

/** `.muted` at `0.9rem` — counts, dates, blurbs, helper copy. The workhorse. */
export function Muted({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText {...props} style={[styles.muted, style]} />;
}

/**
 * The tertiary tier at `0.85rem` in `faint` — placeholders, timestamps, a lesson row's preview line.
 * The web reaches this by shrinking `.muted`; on mobile it has its own colour role (see
 * `Palette.faint`), because a `StyleSheet` cannot shrink a colour.
 */
export function Faint({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText {...props} style={[styles.faint, style]} />;
}

/** `.error` — a failed write, a refused request. */
export function ErrorText({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText accessibilityRole="alert" {...props} style={[styles.error, style]} />;
}

/** `.warn` — attention without alarm: a degraded wake lock, a stalled audio graph. */
export function WarnText({ style, ...props }: TextProps) {
  const styles = useStyles();
  return <RNText {...props} style={[styles.warn, style]} />;
}

function useStyles() {
  const theme = useTheme();
  return useMemo(() => makeStyles(theme), [theme]);
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    h1: { ...type.h1, color: t.text },
    h2: { ...type.h2, color: t.text },
    body: { ...type.body, color: t.text },
    muted: { ...type.small, color: t.muted },
    faint: { ...type.tiny, color: t.faint },
    error: { ...type.small, color: t.error },
    warn: { ...type.small, color: t.warn },
  });
