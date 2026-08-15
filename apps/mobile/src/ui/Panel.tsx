import { useMemo, type ReactNode } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { H2 } from "./Text";
import { radius, space } from "./tokens";

/**
 * `.panel` — the card every section of every page sits in.
 *
 * This is the single most visible difference between the two apps today: the web groups content
 * into bordered, filled, rounded cards with a 20px inset, and the mobile screens were flat, full
 * bleed, separated by hairlines. Nothing else in the kit changes the look of a screen as much as
 * wrapping its sections in one of these.
 *
 * `title` renders the `<h2>` the web puts at the top of most panels — passing it is preferred over
 * hand-rolling an `<H2>` inside, so the spacing between the heading and the body is decided once.
 */
export function Panel({
  title,
  children,
  style,
  tone,
}: {
  title?: string;
  children?: ReactNode;
  style?: ViewStyle;
  /**
   * Recolours the border only, never the fill — the lesson page's paused-session card is a normal
   * panel that has something to say, not a different kind of surface.
   */
  tone?: "warn" | "error";
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View
      style={[
        styles.panel,
        tone === "warn" ? { borderColor: theme.warn } : null,
        tone === "error" ? { borderColor: theme.error } : null,
        style,
      ]}
    >
      {title ? <H2 style={styles.title}>{title}</H2> : null}
      {children}
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    panel: {
      backgroundColor: t.panel,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: radius.panel,
      padding: space.panelPadding,
      marginVertical: space.panelGap,
    },
    // The web gets this from the UA's `h2 { margin: 0.83em 0 }`, halved at the top because the
    // panel's own padding already supplies the space above it.
    title: { marginBottom: space.row },
  });
