/**
 * The design system — `apps/web/src/app/globals.css` and its eight Base UI wrappers, as React
 * Native components.
 *
 * **Screens import from here and from nowhere else for appearance.** A screen that reaches past
 * this barrel for a size, a radius or a colour is the start of the drift this whole directory
 * exists to end: before it, the mobile app had 116 colour literals across seven files and a type
 * scale (17/16/15/13) that shared no size with the web's.
 *
 * Colours come from `@tutor/shared/theme` via `useTheme()`; geometry from `./tokens`. See
 * docs/2026-08-15-web-design-parity-on-mobile.md.
 */
export { AppHeader } from "./AppHeader";
export { Autocomplete, type AutocompleteOption } from "./Autocomplete";
export { Button, ButtonRow, type ButtonVariant } from "./Button";
export { Checkbox } from "./Checkbox";
export { Chip, ChipRow } from "./Chip";
export { ConfirmDialog } from "./ConfirmDialog";
export { Disclosure } from "./Disclosure";
export { EmptyState } from "./EmptyState";
export { Link } from "./Link";
export { NavProgressBar } from "./NavProgressBar";
export { beginNavigation, useLoadingIndicator, useNavigationPending } from "./nav-progress";
export { ActionRow, RefreshButton } from "./RefreshButton";
export { Panel } from "./Panel";
export { PromptDialog } from "./PromptDialog";
export { Screen } from "./Screen";
export { Select, type SelectOption } from "./Select";
export { SessionBar } from "./SessionBar";
export { Body, ErrorText, Faint, H1, H2, Muted, WarnText } from "./Text";
export { TextField } from "./TextField";
export { ThemeToggle } from "./ThemeToggle";
export * from "./icons";
export { control, layout, overlay, progress, radius, space, type } from "./tokens";
