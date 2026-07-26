/**
 * Date formatting that is identical on the server and in the browser.
 *
 * Bare `new Date(x).toLocaleDateString()` inherits BOTH the timezone and the locale from
 * whichever runtime evaluates it. In a client component that means the SSR pass (Vercel: UTC,
 * `en-US`) and hydration (the user's zone and `navigator.languages`) can produce different text
 * for the same timestamp — a timezone shift flips the day for timestamps near the UTC midnight
 * boundary, and a locale difference changes every date. React treats that as a hydration text
 * mismatch (error #418), discards the server HTML, and re-renders the whole root, which strips
 * the `data-theme` attribute the pre-paint script in `layout.tsx` put on `<html>`.
 * See `docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md`.
 *
 * Pinning both inputs makes the output a pure function of the timestamp. These are "added" /
 * "last practiced" audit dates, so rendering them in UTC rather than the reader's zone is
 * invisible in practice — and worth far more than the edge-case precision it gives up.
 */
const FORMAT: Intl.DateTimeFormatOptions = { timeZone: "UTC" };

/** Stable `M/D/YYYY` for a timestamp — same string on the server and after hydration. */
export function formatDate(value: string | number | Date): string {
  return new Date(value).toLocaleDateString("en-US", FORMAT);
}
