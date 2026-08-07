# Should every basic component move to Base UI? — an audit for cross-browser consistency

**Date:** 2026-08-08
**Status:** **Tiers A and B IMPLEMENTED** (2026-08-08), plus a **Tier C** the audit missed entirely —
every `<button>` was rendering in the UA's default font. `ScrollArea` deliberately skipped. See
"What shipped" at the end. Findings below were measured in Chrome against the running app, not
assumed.
**Related:** [`2026-08-04-add-word-autocomplete.md`](./2026-08-04-add-word-autocomplete.md)

## The ask

Move the remaining basic components to `@base-ui/react` so the UI renders the same across browsers
and operating systems.

## The short answer

**Roughly a third of the app's native controls are worth replacing, and it isn't the third you'd
guess.** "Native element" and "renders differently per OS" are not the same set:

- `<select>` was genuinely un-styleable — the OS draws the popup, and no CSS reaches it. That's why
  it had to go.
- `<input type="text">` and `<textarea>` are the opposite: fully styleable, and already pixel-identical
  across engines because `globals.css` sets font, colour, border and radius explicitly. **Base UI's
  `Input` renders a native `<input>` too** — its docs describe it as "a native input element that
  automatically works with Field". Swapping them changes the DOM and changes nothing on screen.
- In between sit controls that *are* browser-drawn but that nobody notices until you look: the
  checkbox, the search field's clear button, the `<details>` marker, the `title=` tooltip, focus
  rings, and scrollbars.

So the useful framing isn't "replace the basics with Base UI". It's: **replace what the browser
draws; keep what CSS already controls; and adopt Base UI's `Field` for the wiring problem, which is
a correctness issue rather than a visual one.**

## What this app actually uses

Counted across `src/` on 2026-08-08:

| Native thing | Count | Where |
| --- | --- | --- |
| `<button>` | 18 | everywhere; `Chip` in `ItemsBrowser` is a `<button>` used as a toggle. **All of them were rendering in the UA's default font — see Tier C** |
| `<textarea>` | 3 | `AskClaude`, `NewLessonForm`, `LessonItemsView` |
| `<input type="text">` | 4 | `demo/page`, `NewLessonForm`, `AddWordForm`, `ItemsBrowser` (lesson title) |
| `<input type="search">` | 1 | `ItemsBrowser:186` |
| `<input type="checkbox">` | 1 | `ItemsBrowser` `ItemLine` (row selection) |
| `<details>` / `<summary>` | 2 | `lessons/[id]/page.tsx` — "Word changes", session history |
| `title="…"` (native tooltip) | 2 | `LessonsList` trash button, `LessonTutor` keep-awake hint |
| `<select>` | 0 | replaced 2026-08-07 |
| `window.confirm` | 0 | never existed; the delete prompt is now `AlertDialog` |

Notably absent, and worth knowing because they're the *worst* offenders if they ever get added:
`type="date"`, `type="time"`, `type="range"`, `type="number"`, `type="file"`, `<progress>`.

## Measured, not assumed

Probing the live app in Chrome (`getComputedStyle` on each control):

```
search   → appearance: auto,  accentColor: auto
checkbox → appearance: auto,  accentColor: auto
text     → appearance: auto,  accentColor: auto
```

`appearance: auto` means the browser is free to draw its own widget. For the text input that's
harmless — every engine renders a plain box and our CSS wins. For the other two it isn't:

1. **The search field has a browser-drawn clear button.** Typing into it makes a `×` appear at the
   right edge — Chrome/Safari's `::-webkit-search-cancel-button`. Firefox draws nothing there.
   It's unstyled, it ignores the theme, and it's a control the design never specified. *(Screenshotted
   in Chrome; the fix is one line of CSS, see below.)*
2. **The checkbox is drawn by the OS with the user's own accent colour.** `accent-color: auto` means
   the tick is whatever the person set in their system settings — so it differs not just per OS but
   per *user*, and it will never be `--accent`.
3. **Focus rings are the browser default** everywhere except `.select-trigger`, which sets
   `outline: 2px solid var(--accent)` explicitly. Chrome, Safari and Firefox each draw a different
   default ring.

## Tier A — replace: the browser is drawing these

| Control | What diverges | Base UI answer | Effort |
| --- | --- | --- | --- |
| Row-selection checkbox | OS glyph, OS accent colour, OS size | `Checkbox` — renders a `<span>` + hidden `<input>`, so the tick is ours. Also gets `indeterminate`, which the "select all" affordance would want | S |
| `<details>` × 2 | Disclosure marker differs (`::-webkit-details-marker` vs `::marker`); open/close only *animates* in Chromium, via `interpolate-size`, which Safari and Firefox still don't support | `Collapsible` (or `Accordion` for the session list) — JS-driven height, so it animates identically everywhere | M |
| `title=` tooltips × 2 | OS-styled, at a delay you can't set, and invisible on touch | `Tooltip` for the trash button; **`Popover` for the keep-awake hint** — see the correction below | S |
| Search clear `×` | Chrome/Safari draw it, Firefox doesn't | Not a Base UI job. One line: `input[type="search"]::-webkit-search-cancel-button { appearance: none }`, then draw your own if you want one | XS |
| Focus rings | Three engines, three rings | Not a Base UI job either — a `:focus-visible` rule in `globals.css` matching `.select-trigger`'s | XS |
| Popup/dialog scrollbars | macOS overlay vs Windows classic; `scrollbar-color` is baseline since Dec 2024 but Safari 26.3's implementation is reported incomplete | `ScrollArea` (Root/Viewport/Scrollbar/Thumb) if it actually bothers you; otherwise `scrollbar-width: thin` and accept it | M |

The two `XS` rows are the best value in this document: they're pure CSS, need no library, and remove
two of the three inconsistencies actually measured above.

### Correction: Base UI's Tooltip doesn't fix touch either

An earlier draft of this table claimed `Tooltip` "works on touch". It does not — Base UI's docs are
explicit that **tooltips are disabled on touch devices**, for the same reason `title` is unusable
there. The library draws the line this way: *if the trigger's purpose is to open the popup, it's a
popover; if the trigger does something else and the popup is a redundant hint, it's a tooltip.*

That splits the two instances rather than treating them alike:

- **Trash button** → `Tooltip`. Its job is deleting; the label is redundant with `aria-label`, so a
  touch user loses nothing by never seeing it. Correct as a tooltip.
- **Keep-awake hint** ("☀ screen stays on") → `Popover` with `openOnHover`. This explains something
  the learner can't infer, and this app is used on a phone — a hover-only hint is one most of its
  users would never see. As a `title` it was already invisible to them; a tooltip would have kept it
  that way. The popover keeps the hover behaviour and adds tap.

## Tier B — don't replace for looks; adopt for wiring

`<input type="text">`, `<textarea>`. *(This section originally listed `<button>` here too. That was
wrong — `globals.css` styled buttons but never set their font, so they were a Tier A problem in
disguise. See Tier C in "What shipped".)*

These already render identically across engines because `globals.css` styles them explicitly.
Swapping them for `Base UI Input` would add a dependency edge and a wrapper per control while
changing zero pixels — that's churn, not consistency.

There is still something real here, but it's a **correctness** problem, not a rendering one:

- **`Field` fixes label/description association.** `AddWordForm`'s helper text ("Goes straight to your
  collection — you can put it in a lesson any time") is a loose `<p>`; nothing connects it to the
  input, so a screen reader never reads it as that field's description. `Field.Root` +
  `Field.Label` / `Field.Description` / `Field.Error` generates the `aria-describedby` wiring and
  exposes `data-invalid` / `data-touched` / `data-dirty` for styling. That's worth doing on the
  three real forms — and it's the one place where wrapping a native input in Base UI earns its keep.
- **`Chip` doesn't say what it belongs to.** *(Corrected: an earlier draft said the chips had no
  `aria-pressed`. They did.)* What they lacked was grouping — the "LEVEL" caption was a loose
  `<div>`, so a screen reader announced "A2, pressed" with no hint of what it filters. And eleven
  chips were eleven consecutive tab stops. `ToggleGroup` fixes both: `role="group"` +
  `aria-labelledby`, and one tab stop with arrow keys inside it.

## Tier C — the ones that would hurt, if ever added

None of these exist today. Listing them so the decision is made once, not per-feature:

`type="date"` / `type="time"` (iOS wheel vs Chrome dropdown vs Firefox nothing — the single most
divergent control on the platform), `type="range"` (every engine differs; needs vendor pseudo-elements),
`type="number"` (spinner styling is vendor-prefixed, and the control eats non-numeric input
inconsistently — Base UI's `NumberField` is strictly better), `type="file"` (button label is
OS- *and locale*-dependent), `<progress>` / `<meter>` (Base UI has both).

If a date picker ever lands here, do not use `type="date"`. Base UI has no date picker either — it
lists `date-fns` as an optional peer dependency, which is where that work would go.

## Recommended order

1. **Two CSS lines** — kill `::-webkit-search-cancel-button`, add a shared `:focus-visible` rule.
   Removes two measured inconsistencies for nearly nothing.
2. **Checkbox → `Checkbox`.** One instance, and it's the most visible OS artefact left.
3. **`title=` → `Tooltip`.** Small, and it fixes a hint that is currently invisible on the touch
   devices this app is built for.
4. **`Field` on the three forms** + `Chip` → `ToggleGroup`. Accessibility, not pixels — schedule it
   as such.
5. **`<details>` → `Collapsible`.** Most work of the lot; do it when the session history gets
   touched anyway.
6. **`ScrollArea`** — only if Safari's scrollbars actually bother you. Genuine cost: it replaces
   native scrolling behaviour, which is easy to get subtly wrong on iOS momentum scrolling.

Steps 1–3 are perhaps an hour and cover everything measured. Steps 4–6 are worth doing on their own
merits, but they are not what "aligned across browsers" means.

## Costs

- **Bundle.** Base UI is tree-shaken via subpath exports, so this is per-component, not all-or-nothing.
  Adding six more components is not the same as adding the library again.
- **Hidden inputs change form semantics.** `Checkbox` renders a `<span>` plus a hidden `<input>`. Any
  code reading `FormData` or querying `input[type="checkbox"]` needs checking — today nothing does,
  but `LessonItemsView` does use `new FormData(form)`.
- **Base UI is a young 1.x.** Stable, but the surface is still moving; `@base-ui-components/react`
  was renamed to `@base-ui/react` at v1. Keeping each component behind a thin wrapper
  (`Select.tsx`, `ConfirmDialog.tsx`) is the hedge, and should continue.
- **A replaced control is code you now own.** The native checkbox has never had a bug. A custom one
  can.

## What shipped (2026-08-08)

### Tier A

| Change | File | Verified in Chrome |
| --- | --- | --- |
| `::-webkit-search-cancel-button { appearance: none }` | `globals.css` | The `×` no longer appears when typing in the search field |
| Shared `:focus-visible` ring (and `.select-trigger`'s duplicate removed) | `globals.css` | — |
| Row checkbox → `Checkbox` | `Checkbox.tsx`, `ItemsBrowser.tsx` | Checked state is `--accent` with our own tick, not the OS accent colour |
| Trash `title=` → `Tooltip` | `Tooltip.tsx`, `LessonsList.tsx` | Styled hint appears above the button on hover |
| Keep-awake `title=` → `Popover` | `InfoPopover.tsx`, `LessonTutor.tsx` | **Not visually verified** — it only renders mid-session (`connected && keepAwake.method !== "none"`), which needs a live ElevenLabs call |
| `<details>` × 2 → `Collapsible` | `Disclosure.tsx`, `lessons/[id]/page.tsx` | Chevron marker rotates, panel animates open, all three panels carry `hidden="until-found"` |

### Tier B

Nothing here changes a pixel — verified by comparing `/lesson-items` before and after.

| Change | File | Verified in Chrome |
| --- | --- | --- |
| Chips → `Toggle` inside `ToggleGroup`, one group per filter row | `ItemsBrowser.tsx` | Each row is `role="group"` labelled Level/Kind/Show, and **11 chips are now 3 tab stops** with arrow keys inside each group. Multi-select (levels), single-select-with-clear (kind) and the two independent booleans (show) all round-trip through the URL correctly |
| Chip styles moved to a `.chip` class driven by `[data-pressed]` | `globals.css` | — |
| Sort-direction and "Clear" stayed plain `<button>`s | `ItemsBrowser.tsx` | They only borrow the chip's look; neither is on/off, so neither is a toggle |
| `AddWordForm` → `Field.Root` / `Control` / `Description` | `AddWordForm.tsx` | Helper text is now `aria-describedby`-wired, and `role="status"` makes the post-submit result ("Added “x”.") announced rather than silently swapped |
| `LessonItemsView` → `Field`, textarea named | `LessonItemsView.tsx` | "3/50 items" is now the field's description, not loose prose beside it |
| `NewLessonForm` → `Form` + `Field` + `Field.Error` | `NewLessonForm.tsx` | Both controls have accessible names; the empty-submit error is **ours, in the page**, with `aria-invalid` and `aria-describedby` set, and clears on input |
| `demo` ping input given an `aria-label` | `demo/page.tsx` | Field skipped there on purpose — it's a server component driving a server action, and `Form`/`Field` would force a client boundary onto a smoke test |

The `NewLessonForm` change is the one that also belongs to Tier A's theme. Its `required` textarea
used to fail into the **browser's own validation bubble** — drawn differently by Chrome, Safari and
Firefox, and gone a moment later. Base UI's `Form` sets `noValidate` and focuses the first invalid
control itself, so that bubble is replaced by in-page text in `--error`. Same class of problem as
`<select>`: a widget the OS drew and the page couldn't touch.

Two places where the honest answer was *not* to reach for Base UI: the sort-direction and "Clear"
buttons aren't toggles, and `Field` on the demo page would be ceremony. `Base UI Input` was skipped
throughout for the reason at the top — it renders a native `<input>`, so it would change nothing.

### Tier C — the buttons

Not in the original plan. It came out of the same question ("are these aligned across browsers?")
and the answer was worse than the audit assumed, because `globals.css` had been styling every
`<button>` in the app from one rule that never set a font.

Measured in Chrome, before:

| | `input` | `button` |
| --- | --- | --- |
| height | 45.2px | **34.7px** |
| font-size | 16px | **13.3px** |
| font-family | system-ui | **Arial** |

The font is the real finding. `globals.css` set `font: inherit` on `input` and `textarea` but never
on `button`, so every button in the app rendered in the UA's default form-control font — Arial
13.3px here, something else on Windows, something else again on iOS. It's the same class of problem
as the old `<select>`, and it had been sitting in plain sight the whole time.

The height gap followed from it, and was *disguised*: the global rule's `margin-top: 0.6rem` pushed
a too-short button down by roughly the difference, so "Add" next to its input only ever **looked**
aligned.

**`src/app/Button.tsx`** + a `.btn` class fix both:

- `button { font: inherit; cursor: pointer }` is now the entire global rule. It no longer paints
  every button accent-filled, so a button that isn't a primary action stops having to undo it
  inline — and an unstyled `<button>` now looks unstyled, which is the point.
- `.btn` reproduces the field's vertical box rather than hard-coding a height: same 1.5 line-height,
  same `0.6rem` padding, same 1px border (transparent when the variant has none). The two agree at
  45.2px and would still agree if the root font size changed. `--control-height` (2.825rem, the same
  figure) covers content shorter than a line — i.e. icon-only buttons.
- Variants are shape (`primary`, `secondary`, `quiet`, `icon`, `inline`); `tone="danger"` is colour
  only. That keeps "destructive icon button" and "destructive solid button" from being two variants.
- `Button` defaults `type="button"`, since `submit` inside a form is the wrong default for most of
  these and every call site had been repeating `type="button"` by hand.

There are **two** named sizes, not one, because "same height as a field" is only the right rule for
things that stand next to a field:

| token | height | used by |
| --- | --- | --- |
| `--control-height` | 45.2px | `input`, `textarea`, `.btn` — anything in a form |
| `--control-height-sm` | 38.8px | the Select trigger and `.btn--sm` — controls among navigation or chips |

The theme toggle is `secondary` + `sm`: it's header furniture, and at field height it set the
header's height instead of sitting in it. `--control-height-sm` isn't a new number — it's the figure
`.select-trigger` had already picked, now named once and shared, so the compact tier can't drift.

Deliberate exceptions to the height rule, both stated in the CSS:

- **`.btn--icon` is 2rem, not 45px.** The favourite star and the delete bin sit in dense list rows
  next to a 20px checkbox; a 45px square would inflate every row. The height contract is for
  controls standing beside a field, which a glyph inside a row isn't.
- **`.btn--inline` has no box at all** — for "remove" and "restart the session", which live inside
  sentences. These now carry an underline they didn't have, so they read as controls.
- **The two chip-shaped buttons** (sort direction, "Clear") keep `.chip` rather than `.btn`: a pill
  is a different shape. They still benefit from the reset — their font went from Arial to system-ui
  with everything else.

Two leftover `title=` attributes (theme toggle, favourite star) became `Tooltip`s while their
buttons were being replaced, finishing what Tier A started.

### The pre-existing sort bug — fixed

Selecting **"Times practiced"** silently reverted to "Date added". `hrefWith` omitted the `sort`
param when the value was `"practice"`, but `page.tsx:53` defaults a missing param to `"created"` —
so that option could never be applied, and every other filter click carried a redundant
`sort=created`. Fallout from the "chore: update default sorting" commit, which changed the default
without updating the omit-check.

Fixed by matching the omit-check to the page's fallback (`"created"`), with a comment naming the
coupling so the next change to the default doesn't reintroduce it. Verified: `?sort=practice` now
sticks and the list orders by conversation count.

`hiddenUntilFound` is the detail worth remembering: native `<details>` lets browser find-in-page
reach collapsed text and expand to it. A naive Collapsible swap unmounts the panel and silently
loses that — on a page whose whole point is searchable conversation transcripts. `hidden="until-found"`
keeps it.

**`ScrollArea` was skipped deliberately.** It was the one conditional row in the table ("only if
Safari's scrollbars actually bother you"), and it carries the real risk in this tier: it replaces
native scrolling, which is easy to get subtly wrong on iOS momentum scroll — on an app that is
iOS-first. The scrollable surfaces today are the select popup and the dialog viewport, both small.
Revisit if Safari's scrollbars actually prove annoying.

## Sources

- [Base UI — Input](https://base-ui.com/react/components/input), [Checkbox](https://base-ui.com/react/components/checkbox), [Tooltip](https://base-ui.com/react/components/tooltip) (touch behaviour), [Collapsible](https://base-ui.com/react/components/collapsible), [component catalog](https://base-ui.com/)
- The installed package ships its own docs at `node_modules/@base-ui/react/docs/react/components/*.md` — authoritative and offline; prefer it over the website
- [`::-webkit-search-cancel-button` — MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::-webkit-search-cancel-button)
- [Animating `<details>` with `::details-content` and `interpolate-size`](https://modern-css.com/animating-details-without-javascript-height/) — `::details-content` is Baseline since Sept 2025; `interpolate-size` remains Chromium-only
- [Styling scrollbars without WebKit pseudo-elements](https://modern-css.com/scrollbar-styling-without-webkit-pseudo-elements/) and [Safari `scrollbar-color` compat issue #29315](https://github.com/mdn/browser-compat-data/issues/29315)
