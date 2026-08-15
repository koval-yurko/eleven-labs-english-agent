import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Link } from "./Link";
import { ThemeToggle } from "./ThemeToggle";
import { layout, space, type } from "./tokens";

/**
 * The app's one piece of chrome — `apps/web/src/app/layout.tsx`'s `<header>`.
 *
 * ```
 * 🎧 English Tutor                    Words   Lessons   [☾ Dark]
 * ```
 *
 * **This replaces the bottom tab bar**, which is the single biggest navigational change in the port.
 * The tab bar was the right native answer (S7 D73: "two top-level destinations, which is exactly
 * what a tab bar is for") and it gave each tab its own back stack. The web has one header, one back
 * stack, and a brand mark that doubles as the link home — so that is what this is. There is no
 * native `Stack` header anywhere any more either: "back" is an in-page link, as it is on the web.
 *
 * It lives INSIDE the scrolling content column rather than pinned above it, again matching the web,
 * where `<header>` is the first child of `<main>` and scrolls away with the page.
 *
 * The active destination is not marked. The web doesn't mark it either — the `<h1>` under the header
 * already says which page this is, and a highlighted nav item would be the one piece of visual
 * language the two apps didn't share.
 *
 * **It wraps, and the web's doesn't.** Brand + two links + the toggle come to roughly 400pt, which
 * fits an iPad and does not fit an iPhone. The web has the same arithmetic and simply overflows;
 * here the nav group drops to a second line instead, because the alternative on a phone is
 * ellipsising the app's own name down to "🎧 Engl…".
 */
export function AppHeader() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={styles.header}>
      {/* The brand goes to the collection, not to `/lessons` — `/` redirects there too, because
          the words are what the learner opens the app for. */}
      <Link href="/lesson-items" variant="plain" style={styles.brand} numberOfLines={1}>
        🎧 English Tutor
      </Link>
      <View style={styles.nav}>
        <Link href="/lesson-items">Words</Link>
        <Link href="/lessons">Lessons</Link>
        <ThemeToggle />
      </View>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.row,
      marginBottom: layout.headerGap,
    },
    /** `fontWeight: 700; fontSize: 1.25rem` — the web's inline style on the brand link. */
    brand: { fontSize: 1.25 * 16, fontWeight: type.weightBold, color: t.text, flexShrink: 1 },
    nav: { flexDirection: "row", alignItems: "center", gap: space.navGap, flexShrink: 0 },
  });
