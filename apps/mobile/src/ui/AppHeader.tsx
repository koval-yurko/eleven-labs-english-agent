import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { useSession } from "@/lib/auth";
import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Link } from "./Link";
import { Faint } from "./Text";
import { ThemeToggle } from "./ThemeToggle";
import { layout, space, type } from "./tokens";

/**
 * The app's one piece of chrome — `apps/web/src/app/layout.tsx`'s `<header>`.
 *
 * ```
 * 🎧 English Tutor    signed in as you@example.com
 *                            Words   Lessons   [☾ Dark]
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
 * **It is two lines, and the web's is one.** Brand + identity + two links + the toggle come to
 * roughly 400pt, which fits an iPad and does not fit an iPhone. The web has the same arithmetic and
 * simply overflows; here it breaks in a fixed place — brand and identity share the top line, the
 * nav gets the second — because the alternative on a phone is ellipsising the app's own name down
 * to "🎧 Engl…".
 *
 * The break is written into the tree, not left to `flexWrap`. Wrapping moved the identity and the
 * nav together as one block, so on a phone the identity landed on its own second line and the nav
 * on a third: a three-line header whose top line was a bare logo with the whole right half empty.
 *
 * ## Who is signed in
 *
 * The identity line used to be prose at the foot of `/lessons`, next to an `Account →` link — which
 * put it on exactly one screen of five, and put it below the fold of the one screen that has it.
 * It belongs in the chrome, because it is a fact about the session and not about the lesson list.
 *
 * The email IS the link to the account screen: two affordances ("signed in as x", "Account →")
 * pointing at one destination is one too many, and the email is the thing a learner scans for when
 * they want to know which account this is. Hence the colour split — grey label, accent address —
 * which is the only way a run of text reads as tappable without a chevron hanging off it.
 */
export function AppHeader() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={styles.header}>
      <View style={styles.identityRow}>
        {/* The brand goes to the collection, not to `/lessons` — `/` redirects there too, because
            the words are what the learner opens the app for. */}
        <Link href="/lesson-items" variant="plain" style={styles.brand} numberOfLines={1}>
          🎧 English Tutor
        </Link>
        <SignedInAs />
      </View>
      <View style={styles.nav}>
        <Link href="/lesson-items">Words</Link>
        <Link href="/lessons">Lessons</Link>
        <ThemeToggle />
      </View>
    </View>
  );
}

/**
 * `signed in as you@example.com`, the address linking to the account screen.
 *
 * The STATUS decides whether this says signed in, and the label only names who: `label` comes from
 * the id token, which a launch that could not reach Auth0 never parsed. With no address there is
 * nothing to hang the link on, so that case is plain text — the account screen is still reachable
 * from the sign-in flow, and a bare "Account" link here would earn its place on no other screen.
 *
 * In practice `AuthGate` means every screen drawing this header is signed in; the other two states
 * are what the header shows in the frame before that is settled, rather than dead branches.
 */
function SignedInAs() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { status, label } = useSession();

  if (status !== "signed-in") return <Faint style={styles.signedIn}>signed out</Faint>;
  if (!label) return <Faint style={styles.signedIn}>signed in</Faint>;

  return (
    <View style={styles.identity}>
      <Faint style={styles.signedIn}>signed in as </Faint>
      <Link href="/auth" style={styles.account} numberOfLines={1}>
        {label}
      </Link>
    </View>
  );
}

const makeStyles = (t: Palette) =>
  StyleSheet.create({
    header: { gap: 2, marginBottom: layout.headerGap },
    /**
     * Brand left, identity hard right, on ONE line — never two.
     *
     * The row this replaced was `brand | (identity above nav)` with `flexWrap`, and the wrap is what
     * it actually did on a phone: the whole right-hand column dropped below the brand, so "signed
     * in as …" read as a second header line and the nav as a third. Two rows was always the answer
     * at phone width — the mistake was letting flexbox choose WHICH two.
     *
     * So the split is explicit: identity keeps the brand's line (it is one short grey line and
     * there is room for it beside a two-word app name), and the nav gets its own. No `flexWrap`
     * anywhere — a wrap here can only reintroduce the layout this fixes.
     */
    identityRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: space.row,
    },
    /** `fontWeight: 700; fontSize: 1.25rem` — the web's inline style on the brand link. */
    brand: { fontSize: 1.25 * 16, fontWeight: type.weightBold, color: t.text, flexShrink: 0 },
    /**
     * The identity takes the leftover width and gives it back: `flexShrink` plus `minWidth: 0` are
     * what let a long address ellipsise instead of shoving the brand off the left edge.
     */
    identity: { flexDirection: "row", alignItems: "baseline", flexShrink: 1, minWidth: 0 },
    signedIn: { flexShrink: 0 },
    /**
     * `Link`'s own size is `type.body` — the size of prose, not of a meta line. Overridden to
     * `type.tiny` so it sits level with the grey half, and left shrinkable so a long address
     * ellipsises instead of pushing the nav row off the right edge.
     */
    account: { ...type.tiny, flexShrink: 1, minWidth: 0 },
    /** Its own line, right-aligned under the identity it follows. */
    nav: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-end",
      gap: space.navGap,
    },
  });
