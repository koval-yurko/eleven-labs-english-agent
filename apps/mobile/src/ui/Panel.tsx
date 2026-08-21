import { useMemo, useState, type ReactNode } from "react";
import { LayoutAnimation, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { ChevronDownIcon } from "./icons";
import { H2, Muted } from "./Text";
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
 *
 * ## Collapsing
 *
 * `collapsible` turns that heading into the panel's own trigger: the title stays, everything under
 * it folds away. It lives here rather than in `Disclosure` because the two answer different asks —
 * a `Disclosure` is a row of content that opens (past conversations, the change log), a collapsed
 * panel is a whole *section* of the page that is out of the way until wanted. Nesting one in the
 * other would draw two chevrons and two paddings for one affordance.
 *
 * Two rules the collapsed state has to keep, both learned from the screens that use it:
 *
 *  - **The children are unmounted, not hidden** — same trade as `Disclosure`, and the same reason:
 *    there is no find-in-page on a phone to serve. A form inside a collapsible panel therefore
 *    LOSES ITS DRAFT when it is folded. That is right for a composer the learner walked away from
 *    and wrong for one mid-typing, so the state lifts to the caller when it matters.
 *  - **A collapsed panel must not hide something that is switched on.** `summary` is for exactly
 *    that: the one line the header shows when there is state underneath worth confessing to (an
 *    active filter, a live search). A panel that quietly filters a list from behind a closed door
 *    is the failure mode this prop exists to prevent.
 */
export function Panel({
  title,
  summary,
  children,
  style,
  tone,
  collapsible = false,
  defaultOpen = true,
}: {
  title?: string;
  /**
   * A quiet second line beside the title — what is active underneath. Rendered whether the panel is
   * open or closed, so the header does not jump as it folds. Ignored without a `title`.
   */
  summary?: string;
  children?: ReactNode;
  style?: ViewStyle;
  /**
   * Recolours the border only, never the fill — the lesson page's paused-session card is a normal
   * panel that has something to say, not a different kind of surface.
   */
  tone?: "warn" | "error";
  /** Make the title a trigger. Requires `title` — there is nothing to press without one. */
  collapsible?: boolean;
  /** Only meaningful with `collapsible`. */
  defaultOpen?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(defaultOpen);

  const collapses = collapsible && title !== undefined;
  const showBody = !collapses || open;

  const heading =
    title === undefined ? null : (
      <View style={styles.heading}>
        {/* The heading's bottom margin is the gap to the BODY, so a closed panel drops it — kept, it
            reads as content that failed to render rather than content that is folded. */}
        <H2 style={[styles.title, showBody ? null : styles.tight]}>{title}</H2>
        {summary ? (
          <Muted style={[styles.summary, showBody ? null : styles.tight]}>{summary}</Muted>
        ) : null}
      </View>
    );

  return (
    <View
      style={[
        styles.panel,
        tone === "warn" ? { borderColor: theme.warn } : null,
        tone === "error" ? { borderColor: theme.error } : null,
        style,
      ]}
    >
      {collapses ? (
        <Pressable
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setOpen((prev) => !prev);
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={title}
          // The header is the whole width of the panel, so a press anywhere along the title line
          // toggles it — a 16pt chevron is not a target on a phone.
          style={({ pressed }) => [styles.trigger, pressed ? styles.triggerPressed : null]}
        >
          <View style={styles.headingSlot}>{heading}</View>
          {/* Collapsed: pointing right, like a details marker — the same rotation `Disclosure` uses,
              so the two affordances read as one idiom. */}
          <View style={open ? undefined : styles.markerCollapsed}>
            <ChevronDownIcon size={16} color={theme.muted} />
          </View>
        </Pressable>
      ) : (
        heading
      )}
      {showBody ? children : null}
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
    heading: { minWidth: 0 },
    summary: { marginTop: -0.5 * space.row, marginBottom: space.row },
    tight: { marginBottom: 0 },
    trigger: { flexDirection: "row", alignItems: "flex-start", gap: 0.4 * 16 },
    triggerPressed: { opacity: 0.6 },
    headingSlot: { flex: 1, minWidth: 0 },
    markerCollapsed: { transform: [{ rotate: "-90deg" }] },
  });
