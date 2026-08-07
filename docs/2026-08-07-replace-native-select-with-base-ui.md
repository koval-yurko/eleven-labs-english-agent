# Replacing the native `<select>` — picking a headless component library

**Date:** 2026-08-07
**Status:** IMPLEMENTED — `@base-ui/react` 1.7.0 added, both native selects replaced, and the lesson
delete confirmation moved to `AlertDialog`.
**Related:** [`2026-08-04-add-word-autocomplete.md`](./2026-08-04-add-word-autocomplete.md),
[`2026-08-07-Expo-migration.md`](./2026-08-07-Expo-migration.md)

## The ask

The native `<select>` renders at a different font size than the rest of the app and its UI breaks
when the option text is long. Replace it with a React alternative, and pick a *universal* library —
one that can supply the other components this app will want next, not a select-only package.

## Why the native element actually breaks

Worth naming precisely, because it explains what the replacement must fix:

1. **The OS draws it, not the page.** `<select>` (and every `<option>`) is rendered by the platform
   widget layer. `font: inherit` — which `globals.css` applies to `input` and `textarea` — has no
   effect on the option list, and on iOS Safari the control opens as a full-screen wheel at the
   system font size. That is the "different font size" symptom: it isn't a missing CSS rule, it's a
   control the page cannot style.
2. **The option list has no box model.** There is no way to cap its height, wrap or truncate a long
   label, or let the list be wider than the control. So a long label — `1.3 · curated details from
   words.details (present, don't invent)` in the tutor-version picker — either stretches the closed
   control past its container or gets clipped. That is the "content too long" symptom.
3. `appearance: none` doesn't help. It strips the trigger's chrome; the popup stays native.

The only real fix is a control built from ordinary DOM the page owns. That means adopting the
accessibility work that comes with it — roving focus, typeahead, `aria-activedescendant`, scroll
locking, viewport collision handling — which is exactly what a headless library sells.

## The options

Constraint that decides most of this: **the app has no Tailwind and no CSS framework.** Styling is
`src/app/globals.css` plus CSS custom properties (`--field-bg`, `--border`, `--accent`, …) and
inline styles. So anything Tailwind-coupled is a bad fit, and anything with an opinionated theme
engine would fight the token set that already exists.

| Library | Universal? | Styling fit here | Verdict |
| --- | --- | --- | --- |
| **Base UI** (`@base-ui/react`) | 35+ components incl. Select, **Combobox/Autocomplete**, Dialog, Popover, Tooltip, Menu, Toast, Tabs, Accordion | Unstyled; plain-CSS classes + data attributes + CSS variables | **Chosen** |
| **Radix Primitives** | ~30 components, but **no combobox/autocomplete** | Same model, works fine without Tailwind | Close second; see below |
| **React Aria Components** (Adobe) | Very broad, strongest a11y in the field | Unstyled, plain CSS fine | Heavier; more API surface than this app needs |
| **Ark UI** (Zag.js) | Broad, framework-agnostic | Unstyled | Fine, but no advantage over Base UI here |
| **Headless UI** (Tailwind Labs) | Small set — no tooltip, no toast, thin select | Written for Tailwind | Too narrow for "we'll need other components" |
| **shadcn/ui** | Not a library — copy-in components | **Requires Tailwind** | Out on the constraint |
| **MUI / Mantine / Chakra** | Broad | Ships its own theme + styling engine | Would duplicate/fight `globals.css` |
| **react-select**, **downshift** | Select/combobox only | — | Fails the "universal" requirement |

### Base UI over Radix

Both would work. Base UI wins on three specifics:

- **It has the combobox.** [`2026-08-04-add-word-autocomplete.md`](./2026-08-04-add-word-autocomplete.md)
  plans a typeahead on the "Add a word" field backed by Datamuse. Base UI ships
  `Combobox`/`Autocomplete`; Radix has never shipped one, so that feature would have meant a second
  library (downshift or hand-rolled listbox a11y). Picking Base UI now means the next component is
  already in the dependency.
- **Maintenance direction.** Radix was acquired by WorkOS and its pace slowed; Base UI is built by
  several of the same engineers plus the MUI and Floating UI teams, reached stable v1.0 in December
  2025, and as of July 2026 is what shadcn/ui defaults to for new projects. Radix is not dead — it's
  the safer choice for an *existing* Radix codebase. This app has neither, so it picks the one under
  active development.
- **Sizing variables are part of the API.** `--available-height` / `--available-width` /
  `--anchor-width` are exposed on the positioner, which is precisely the vocabulary needed for the
  long-content bug (see below). Radix has equivalents; Base UI's are what got used here.

Cost of being wrong is low either way: both are the same shape (Root/Trigger/Portal/Positioner/
Popup/Item), so the wrapper below is a day's work to re-point.

## What was built

**`src/app/Select.tsx`** — one wrapper over Base UI's Select, so call sites stay a one-liner and the
Base UI import lives in exactly one file. Generic over the value type, so `onValueChange` hands back
`SortKey` rather than a `string` every caller has to cast.

```tsx
<Select label="Sort by" value={query.sort} onValueChange={(sort) => apply({ sort })} options={SORT_OPTIONS} />
```

Three settings do the real work, and they map one-to-one onto the two symptoms:

| Setting | Fixes |
| --- | --- |
| `.select-trigger { font: inherit }` + the field tokens | Symptom 1 — the trigger is now the same typeface, size, radius and colour as the text inputs beside it, in both themes |
| `max-height: var(--available-height)` on the popup | Symptom 2 — a long list scrolls inside the popup instead of running off-screen |
| `min-width: var(--anchor-width)` (not `width`) | Symptom 2 — the popup is at least trigger-wide but *grows* for a long label instead of clipping it |
| `min-width: 0` on trigger and value + `text-overflow: ellipsis` | Symptom 2 on narrow screens — the closed control shrinks and ellipsises inside the panel rather than pushing past it |
| `alignItemWithTrigger={false}` | Base UI defaults to the macOS behaviour of overlapping the trigger, which needs room above *and* below. `false` gives the ordinary drop-below placement that flips up only when it must |

Two setup lines from Base UI's guide went into `globals.css`: `isolation: isolate` on `main` (popups
portal to `<body>`, so `main` getting its own stacking context keeps them on top without a z-index
auction) and `position: relative` on `body` (iOS 26+ backdrop positioning).

`CheckIcon` and `ChevronDownIcon` were added to `src/app/icons/`, following the existing rule that
glyphs live there rather than being hand-rolled per island.

### Replaced

- `src/app/lesson-items/ItemsBrowser.tsx` — the "Sort by" picker.
- `src/app/lessons/[id]/LessonTutor.tsx` — the tutor-version picker. This was the visibly broken one
  (labels up to ~55 characters). Its row also got `flexWrap` so the label and control stack on a
  phone instead of squeezing.

The `select { min-height: 30px }` rule is gone — there is no native `<select>` left in the app.

### Verified

`pnpm typecheck`, `pnpm lint` and `pnpm build` clean. In the browser: trigger typography matches the
surrounding fields; selecting an option drives the real state (`?sort=text` re-sorted the list); the
popup flips above the trigger when there's no room below; long labels render in full in the popup
while the closed trigger ellipsises; both light and dark themes follow the existing tokens.

## Second component: the delete confirmation

The app never had a `window.confirm` — `LessonsList` already confirmed inline, with a comment
explaining that a blocking prompt would stall the optimistic offline write. That reasoning still
holds and isn't what changed: `AlertDialog` is React state too, not a blocking call.

What it adds over the inline row is what inline can't do: a focus trap, `role="alertdialog"` with the
title and description wired as its accessible name and description, initial focus on **Cancel** (the
safe option), Escape to back out, and focus returning to the trash button afterwards. `AlertDialog`
rather than `Dialog` also means a stray backdrop click *doesn't* dismiss it — a destructive action
should need an actual answer. Verified in the browser: backdrop click ignored, Escape closes, focus
ring lands back on the trigger.

**`src/app/ConfirmDialog.tsx`** is the wrapper, same shape as `Select.tsx`. One non-obvious bit is in
the caller: `LessonsList` holds the pending row as `{id, title}` in state rather than looking it up
by id, and clears it on `onOpenChangeComplete` rather than `onOpenChange`. Both exist for the same
reason — a confirmed delete removes the lesson from the list immediately, so an id lookup would come
back empty and the dialog's title would blank out mid-fade.

The `remove` button on lesson words deliberately stays unconfirmed: removing a word from a lesson
doesn't delete it (`words` outlives `lesson_items` — see CLAUDE.md), so there's nothing destructive
to confirm.

## What this buys next

The dependency now covers, unstyled and accessible, the components this app is heading toward:
**Combobox/Autocomplete** (the Datamuse typeahead), **Toast** (sync/offline feedback), **Tooltip**,
**Menu**, **Tabs**, **Accordion**. Each is `@base-ui/react` plus CSS in `globals.css`; the pattern is
set by `Select.tsx` and `ConfirmDialog.tsx`.

Not free: it's the app's first UI dependency (7 packages), and Base UI is a young 1.x — the API is
stable but the surface is still growing. The wrapper is the hedge.

## Sources

- [Base UI — Select](https://base-ui.com/react/components/select), [Alert Dialog](https://base-ui.com/react/components/alert-dialog), [Quick start](https://base-ui.com/react/overview/quick-start), [Styling](https://base-ui.com/react/handbook/styling)
- [Radix vs Base UI in 2026 — ShadcnDeck](https://www.shadcndeck.com/blog/radix-vs-base-ui)
- [Headless UI alternatives: Radix vs React Aria vs Ark UI vs Base UI — LogRocket](https://blog.logrocket.com/headless-ui-alternatives/)
- [Radix Primitives releases](https://www.radix-ui.com/primitives/docs/overview/releases)
