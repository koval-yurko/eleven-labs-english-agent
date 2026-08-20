import type { ReactNode } from "react";
import Svg, { Circle, Path } from "react-native-svg";

/**
 * The icon set — the same eight glyphs as the web, from the same path data.
 *
 * These replace `expo-symbols`. SF Symbols are, taken on their own, the better icons: correctly
 * weighted for the platform, optically aligned, tinted by the system. But they are Apple's drawings,
 * and no combination of them reproduces the web's star, bin or sun/moon — so the two apps would go
 * on showing different pictures for the same action, which is the thing this port exists to end.
 * The `d=` strings below are copied verbatim from `apps/web/src/app/icons/index.tsx`; if one changes
 * there, change it here.
 *
 * Same contract as the web's: a lucide-style 24×24 stroke drawing, `size` in px (default 18), and
 * colour supplied by the caller. The one difference is that RN has no `currentColor` — there is no
 * cascade to inherit from — so `color` is an explicit prop rather than something the parent sets.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §6, §10.1.
 */
export type IconProps = {
  size?: number;
  /** Required in spirit: RN has no inheritance, so an icon with no colour is invisible, not black. */
  color: string;
};

/** The shared frame: outline style, no fill unless an icon overrides it. */
function Icon({
  size = 18,
  color,
  fill = "none",
  children,
}: IconProps & { fill?: string; children: ReactNode }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </Svg>
  );
}

const STAR_PATH =
  "M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.8l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z";

/**
 * Favourite star in three states:
 *   - `empty`  — outline only (not a favourite)
 *   - `active` — translucent fill (a transient/pending highlight)
 *   - `filled` — solid (a favourite)
 */
export function StarIcon({
  state = "empty",
  ...props
}: IconProps & { state?: "empty" | "active" | "filled" }) {
  return (
    <Icon {...props} fill={state === "empty" ? "none" : props.color}>
      <Path d={STAR_PATH} fillOpacity={state === "active" ? 0.35 : 1} />
    </Icon>
  );
}

/** Sort-direction arrow: `asc` points up, `desc` points down. */
export function SortArrowIcon({ dir, ...props }: IconProps & { dir: "asc" | "desc" }) {
  return dir === "asc" ? (
    <Icon {...props}>
      <Path d="M12 19V5" />
      <Path d="M6 11l6-6 6 6" />
    </Icon>
  ) : (
    <Icon {...props}>
      <Path d="M12 5v14" />
      <Path d="M6 13l6 6 6-6" />
    </Icon>
  );
}

/** Sun — the light-theme glyph. */
export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Circle cx="12" cy="12" r="4" />
      <Path d="M12 2v2" />
      <Path d="M12 20v2" />
      <Path d="M4.93 4.93l1.41 1.41" />
      <Path d="M17.66 17.66l1.41 1.41" />
      <Path d="M2 12h2" />
      <Path d="M20 12h2" />
      <Path d="M6.34 17.66l-1.41 1.41" />
      <Path d="M19.07 4.93l-1.41 1.41" />
    </Icon>
  );
}

/** Moon — the dark-theme glyph. */
export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </Icon>
  );
}

/** Chevron pointing down — the "this opens a popup" affordance on a Select trigger. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

/** Check mark — the selected item in a Select popup, and the Checkbox's tick. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M20 6L9 17l-5-5" />
    </Icon>
  );
}

/** Two arrows chasing each other — re-read what's on screen. */
export function RefreshIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.95-4.8" />
      <Path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.95 4.8" />
      <Path d="M21 3v4.8h-4.8" />
      <Path d="M3 21v-4.8h4.8" />
    </Icon>
  );
}

/**
 * A cross — REMOVE FROM, never delete.
 *
 * Deliberately not `TrashIcon`, and the distinction is the whole reason it exists. The bin means
 * the word is gone from the account: `/lesson-items` and the word page both use it for `deleteWord`,
 * whose own confirm copy warns that the word "leaves every lesson and loses its practice history".
 * This cross removes one `lesson_items` row and keeps everything else — the word, its statistics,
 * its membership in every other lesson, and the removed row itself, which is what feeds the change
 * log. Two opposite blast radii must not share a glyph.
 *
 * The one icon here with no counterpart in `apps/web/src/app/icons/index.tsx`: the web's lesson
 * page still renders a text "remove" button. If that page is ever revived, copy this path there.
 */
export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M18 6L6 18" />
      <Path d="M6 6l12 12" />
    </Icon>
  );
}

/** Trash can — destructive delete. */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <Path d="M3 6h18" />
      <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <Path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <Path d="M10 11v6" />
      <Path d="M14 11v6" />
    </Icon>
  );
}
