import { Link as RouterLink } from "expo-router";
import { useMemo } from "react";
import { StyleSheet, type TextStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { type } from "./tokens";

/**
 * An in-app link — the web's `a { color: var(--accent) }`, and the closest thing here to `NavLink`.
 *
 * It is NOT a full port of `NavLink`. That component exists to report its pending state to the
 * progress bar, because on the web a navigation is a server round trip you have to wait for. Here a
 * push is instant and the screen fetches after it mounts, so there is nothing to report at the link
 * — the screens drive the bar themselves through `useLoadingIndicator`. See `nav-progress.ts`.
 *
 * `href` is typed by expo-router's `typedRoutes` experiment, so a link to a route that does not
 * exist is a compile error rather than a dead tap.
 */
export function Link({
  href,
  children,
  style,
  numberOfLines,
  variant = "accent",
}: {
  href: React.ComponentProps<typeof RouterLink>["href"];
  children: React.ReactNode;
  style?: TextStyle;
  numberOfLines?: number;
  /**
   * `accent` is a link that looks like a link. `plain` is one that carries its own colour — a
   * lesson title in a list row, which is a link but reads as a heading.
   */
  variant?: "accent" | "plain";
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <RouterLink
      href={href}
      numberOfLines={numberOfLines}
      style={[variant === "accent" ? styles.accent : styles.plain, style]}
    >
      {children}
    </RouterLink>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    accent: { ...type.body, color: t.accent },
    plain: { ...type.body, color: t.text },
  });
