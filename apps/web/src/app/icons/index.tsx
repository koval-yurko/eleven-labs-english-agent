/**
 * Shared SVG icon set — one home for the small glyphs the UI reuses, so every button stays visually
 * consistent instead of each island hand-rolling an emoji or inline path (which is what these
 * replaced: ★/☆ in FavoriteButton, ☀️/🌙 in ThemeToggle, ↑/↓ in ItemsBrowser, the trash SVG in
 * LessonsList).
 *
 * Each icon is a lucide-style 24×24 stroke drawing that inherits color via `currentColor` — set
 * `color` on the parent button/span — and takes an optional `size` in px (default 18). They're pure
 * presentational SVG with no client hooks, so they import safely into server *or* client components.
 */
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

/** Shared <svg> frame: outline style, currentColor stroke, no fill unless an icon overrides it. */
function Icon({ size = 18, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

const STAR_PATH =
  "M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.8l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94L12 2.5z";

/**
 * Favorite star in three states:
 *   - `empty`  — outline only (not a favorite)
 *   - `active` — translucent fill (a transient/pending highlight, e.g. hover)
 *   - `filled` — solid (a favorite)
 */
export function StarIcon({
  state = "empty",
  ...props
}: IconProps & { state?: "empty" | "active" | "filled" }) {
  const fill = state === "empty" ? "none" : "currentColor";
  return (
    <Icon fill={fill} {...props}>
      <path d={STAR_PATH} fillOpacity={state === "active" ? 0.35 : 1} />
    </Icon>
  );
}

/** Sort-direction arrow: `asc` points up, `desc` points down. */
export function SortArrowIcon({ dir, ...props }: IconProps & { dir: "asc" | "desc" }) {
  return dir === "asc" ? (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Icon>
  ) : (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Icon>
  );
}

/** Sun — the light-theme glyph. */
export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M6.34 17.66l-1.41 1.41" />
      <path d="M19.07 4.93l-1.41 1.41" />
    </Icon>
  );
}

/** Moon — the dark-theme glyph. */
export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </Icon>
  );
}

/** Chevron pointing down — the "this opens a popup" affordance on a Select trigger. */
export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

/** Check mark — the selected item in a Select popup. */
export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 6L9 17l-5-5" />
    </Icon>
  );
}

/** Trash can — destructive delete. */
export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </Icon>
  );
}
