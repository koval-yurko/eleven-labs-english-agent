import { toggleScheme, useScheme, useTheme } from "@/theme";
import { Button } from "./Button";
import { MoonIcon, SunIcon } from "./icons";

/**
 * The header's appearance switch — the web's `ThemeToggle`, shape for shape.
 *
 * **Two states, not three.** This replaces `components/theme-picker.tsx`, which offered
 * System / Light / Dark on the argument that "follow the phone" and "always dark" are different
 * wishes a two-way switch cannot express once you have touched it. That argument is correct and it
 * loses anyway: the brief is one design across both clients, the web has a two-state toggle, and a
 * picker with an extra option is not the same control. The reasoning, and the cheaper alternative
 * (give the *web* a System state instead and level up rather than down), is in
 * docs/2026-08-15-web-design-parity-on-mobile.md §8.2.
 *
 * `secondary` at the `sm` tier, because this is header furniture rather than a form control — it
 * must not set the header's height. The label names the CURRENT appearance, as the web's does; the
 * accessible label names the action, because a screen reader needs the verb.
 */
export function ThemeToggle() {
  const theme = useTheme();
  const scheme = useScheme();
  const isLight = scheme === "light";

  return (
    <Button
      variant="secondary"
      size="sm"
      onPress={toggleScheme}
      label={isLight ? "Light" : "Dark"}
      accessibilityLabel={`Switch to ${isLight ? "dark" : "light"} theme`}
    >
      {isLight ? (
        <SunIcon size={16} color={theme.text} />
      ) : (
        <MoonIcon size={16} color={theme.text} />
      )}
    </Button>
  );
}
