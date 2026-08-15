# Bringing the web app's design to the mobile app

**Date:** 2026-08-15
**Scope:** `apps/mobile` — make its layout, navigation, theme switch, page structure and user flows
match `apps/web`.
**Status:** implemented. See §13 for what shipped, what deviated, and what still needs a device.

---

## 0. The one decision this all hangs off

The mobile app is **not** an un-designed version of the web app. It is a *deliberately different*
design: native iOS idiom, built on `@expo/ui/swift-ui` (SwiftUI `List`, `Menu`, `BottomSheet`,
`Picker`, `SwipeActions`, `ContentUnavailableView`, `Button`) plus a bottom `Tabs` bar, with the
reasoning recorded across `docs/2026-08-13-expo-s4…s7-*.md` (D3, D39, D51, D61, D65, D71–D74).

So "the same design as the web" is a **reversal**, not a gap-fill. It means:

> Retire the SwiftUI surfaces, retire the tab bar, and rebuild every screen out of plain
> React Native primitives styled from one token table — the same token table the web's CSS
> variables come from.

That is a real cost and it undoes decisions that were made for good native reasons. It also buys
something real: one design language across two clients, one place to change a colour, and screens
that can be reasoned about side-by-side. Section 10 states both sides honestly. Everything from
§5 onward assumes the decision is "yes, port the web design".

There is exactly one thing in this document I'd push back on, and it's small — see §10.1
(SF Symbols and the native empty state are the two places where the native version is strictly
better and costs parity almost nothing). Everything else in the web design ports cleanly.

---

## 1. What the web design actually is

### 1.1 The shell (`apps/web/src/app/layout.tsx`, `globals.css`)

```
<body>
  <NavProgressBar/>            fixed, 3px, top: env(safe-area-inset-top), accent sweep
  <main>                       max-width 760px, margin 0 auto, isolation: isolate
    <header>                   flex, space-between, align-center, margin-bottom 1.5rem
      🎧 English Tutor         → /lesson-items   (700, 1.25rem, no underline)
      [ Words | Lessons | ☾ Dark ]                (gap 1rem)
    </header>
    {page}                     a vertical stack of <h1>, <p class="muted">, <section class="panel">
  </main>
</body>
```

`<main>` padding: `calc(2rem + safe-area-top)` / `calc(1.25rem + safe-area-right)` /
`calc(4rem + safe-area-bottom)` / `calc(1.25rem + safe-area-left)` → **32 / 20 / 64 / 20 px** plus
insets. The whole page is one scroll container. There is no bottom bar, no per-page chrome, and no
back chevron — "back" is an in-page link (`← all lessons`, `← words & sentences`).

### 1.2 The geometry, resolved to pixels

| Thing | Value |
| --- | --- |
| Content column | `max-width: 760px`, centred |
| Page padding | 32 top / 20 sides / 64 bottom (+ safe area) |
| `.panel` | bg `--panel`, 1px `--border`, radius **12**, padding **20**, margin **12 0** |
| Body type | `system-ui`, **16px / 1.5** |
| `h1` | UA default → **32px bold**, margin `.67em` (21px) |
| `h2` | UA default → **24px bold**, margin `.83em` (20px) |
| `.muted` | colour `--muted`; callers use `0.9rem` (**14.4px**) or `0.85rem` (**13.6px**) |
| `--control-height` | `2.825rem` = **45.2px** — buttons *and* inputs |
| `--control-height-sm` | `2.25rem` = **36px** — header furniture, chips, Select trigger |
| Input / button radius | **8** |
| Chip radius | **999**, padding `0.2rem 0.7rem`, font `0.9rem`/500 |
| Checkbox | 20×20, radius 5 |
| Focus ring | `2px solid var(--accent)`, offset 1 |

`.btn` reproduces the input's vertical box exactly (1.5 line-height + `0.6rem` padding + 1px
transparent border) so buttons and fields agree at any font size — that is the load-bearing part of
`Button.tsx`'s docblock and it should survive the port as a rule, not as a magic number.

### 1.3 The component kit

Base UI, wrapped in eight local components, all styled from `globals.css`:

`Button` (variants `primary | secondary | quiet | icon | inline` × size `md | sm` × tone `danger`),
`Select`, `Checkbox`, `ConfirmDialog` (AlertDialog), `Disclosure` (Collapsible), `Tooltip`,
`InfoPopover`, `RefreshButton`, plus `NavLink` (drives the progress bar) and eight inline-SVG icons
(`Star`, `SortArrow`, `Sun`, `Moon`, `ChevronDown`, `Check`, `Refresh`, `Trash`).

### 1.4 The theme switch

Two states — light / dark, **dark is the default**. Stored in `localStorage.theme`, applied
pre-paint by a blocking inline script that stamps `data-theme` on `<html>`. The `ThemeToggle` is a
`secondary`/`sm` button in the header showing `☀ Light` or `☾ Dark`, wrapped in a Tooltip that reads
"Switch to … theme". Notably it reads **localStorage, not the DOM attribute** — see
`docs/2026-07-26-light-theme-reverts-to-dark-on-navigation.md`.

There is **no "System" state on the web.**

---

## 2. What the mobile app currently is

### 2.1 Route tree

```
app/_layout.tsx                 Stack, headerShown:false — Auth0 + Conversation + nav ThemeProvider
app/(tabs)/_layout.tsx          Tabs (bottom bar, 2 tabs, SF Symbol icons)
  (lessons)/_layout.tsx         Stack, headerShown:true, anchor "index"
    index.tsx                   "/"                       Lessons list  ← app home
    lessons/[id]/index.tsx      "/lessons/:id"            Tutor + live transcript
    lessons/[id]/words.tsx      "/lessons/:id/words"      Lesson word editor
  (words)/_layout.tsx           Stack, headerShown:true, anchor "lesson-items/index"
    lesson-items/index.tsx      "/lesson-items"           Collection
    lesson-items/[id].tsx       "/lesson-items/:id"       Word detail
app/auth.tsx                    "/auth"                   Account (mobile-only)
app/probe.tsx                   "/probe"                  Suspension instrument (mobile-only)
```

Every screen is `SafeAreaView { flex: 1, backgroundColor: bg, paddingHorizontal: 16 }` — full-bleed,
no content column, no card. Native `Stack` headers carry the title; `_layout.tsx` feeds them the
palette via expo-router's vendored `ThemeProvider`.

### 2.2 Theme

`src/theme.ts` is genuinely good and most of it survives the port: a module-level store +
`useSyncExternalStore`, a synchronous `expo-sqlite/kv-store` read at module load (the native answer
to the web's pre-paint script), `useScheme()` resolving `system → dark` when the OS is undecided,
and `makeStyles(palette)` memoised per screen.

Two things do not match the web: it is **three-state** (System / Light / Dark) via a chip row
(`components/theme-picker.tsx`) buried in the Lessons list *footer*, and the **dark palette hexes
differ from the web's on every single value**.

### 2.3 Data layer

`src/api.ts` → `apiFetch` → `/api/v2/*` with a per-request Bearer token. Straight through. **No
mirror, no outbox, no optimistic-offline** — the web's `lib/sync/` (Dexie + outbox + service worker)
has no mobile counterpart, and mobile writes are online-only with a manual retry affordance.

---

## 3. Gap analysis

### 3.1 Layout

| | Web | Mobile | Gap |
| --- | --- | --- | --- |
| Content column | 760px centred | full-bleed | **Yes** — matters on iPad, no-op on iPhone |
| Page padding | 32/20/64 | 16 horizontal only | **Yes** |
| Grouping | `.panel` cards (radius 12, bordered) | flat sections, hairline row rules | **Yes** — the single most visible difference |
| Scroll model | one page scroll | per-screen `FlatList`/`Host` with `flex: 1` | **Yes** |
| Type scale | 32 / 24 / 16 / 14.4 / 13.6 | 17 / 16 / 15 / 13 | **Yes** |
| Control height | 45.2 / 36 | ad-hoc (`paddingVertical: 10`) | **Yes** |
| Font | `system-ui` → SF Pro | RN default → SF Pro | ✅ already matches |
| Safe areas | `env(safe-area-inset-*)` | `SafeAreaView edges` | ✅ equivalent |

### 3.2 Navigation

| | Web | Mobile | Gap |
| --- | --- | --- | --- |
| Primary nav | top header, links in `<main>` | bottom `Tabs` bar | **Yes** |
| Per-page chrome | none | native `Stack` header w/ title + back chevron | **Yes** |
| Back affordance | in-page `← all lessons` link | header chevron + `headerBackTitle` | **Yes** |
| Home | `/` → redirect `/lesson-items` | `/` **is** the lessons list | **Yes** |
| Brand mark | `🎧 English Tutor` → `/lesson-items` | absent | **Yes** |
| Back stacks | one | one per tab | **Yes** (parity = collapse to one) |
| Progress bar | `NavProgressBar` on every route change | absent (`ActivityIndicator` per screen) | **Yes** |

### 3.3 Theme

Light is already identical. **Dark is different on every value.**

| Web var | Web dark | Mobile key | Mobile dark | Match? |
| --- | --- | --- | --- | --- |
| `--bg` | `#0f1115` | `bg` | `#101014` | ✗ |
| `--panel` | `#1a1d24` | `surface` | `#1B1B22` | ✗ |
| `--field-bg` | `#0c0e12` | `sunken` | `#16161C` | ✗ |
| `--border` | `#2a2e37` | `border` | `#26262E` | ✗ |
| `--text` | `#e8eaed` | `text` | `#E6E6E6` | ✗ |
| `--muted` | `#9aa0a6` | `muted` | `#8A8A8A` | ✗ |
| `--accent` | `#7c9cff` | `accent` | `#7FB2FF` | ✗ |
| `--error` | `#ff6b6b` | `danger` | `#FF7A7A` | ✗ |
| `--ok` | `#6bd49a` | `success` | `#7DFF9B` | ✗ |
| `--warn` | `#ffb86b` | `warning` | `#FFC46B` | ✗ |
| `--on-accent` | `#0c0e12` | *(missing)* | — | **absent on mobile** |
| *(none)* | — | `control` | `#2A2A34` | **absent on web** |
| *(none)* | — | `faint` | `#5A5A5A` | **absent on web** |

Light-mode values (`#FFFFFF / #F6F7F9 / #F0F2F5 / #D9DCE3 / #1A1D24 / #5F6368 / #4361EE / #C0392B /
#1E7D4F / #B26A00`) are **byte-identical** — `theme.ts` says so in its docblock and it's true.
The dark drift is the accident.

| | Web | Mobile | Gap |
| --- | --- | --- | --- |
| States | 2 (light/dark) | 3 (system/light/dark) | **Yes** |
| Default | dark | system → dark | ~equivalent in effect |
| Placement | header, every page | Lessons footer only | **Yes** |
| Shape | one `secondary`/`sm` button w/ icon + label | three chips | **Yes** |
| Persistence | `localStorage` | `kv-store`, sync read at module load | ✅ equivalent |
| No-flash | pre-paint script | synchronous module-load read | ✅ equivalent |

### 3.4 Page structure

| Route | Web | Mobile | Gap |
| --- | --- | --- | --- |
| `/` | redirect → `/lesson-items` | Lessons list | **Yes** |
| `/lesson-items` | h1 + blurb, Add-word panel, search panel w/ flat chip filters + sort Select + Refresh, checkbox rows, selection panel | search field, Sort `Menu` + Filters `BottomSheet`, SwiftUI `List` w/ swipe-to-favorite, `Alert.prompt` add | **Yes, large** |
| `/lesson-items/:id` | title row (star/level/kind), stats, Details/Translation/Forms/Examples/Categories/In-lessons panels, Refresh | same content, bare sections, no Refresh | **Small** — closest to parity today |
| `/lessons` | h1 + blurb, "New lesson" panel (always open), "Your lessons" panel | collapsed `＋ New lesson`, `FlatList`, footer w/ account + probe + theme | **Yes** |
| `/lessons/:id` | **one page**: title, meta+back link, "Words in this lesson" panel (inline editor), "Practice" panel, "Live transcript" panel, "Word changes" disclosure, "History" panel | **two screens**: tutor + transcript, and `/words` editor. **No history, no word-changes at all.** | **Yes, large** |
| `/lessons/:id/words` | — | editor screen | remove (merge up) |
| `/privacy`, `/support` | present (App Store requires them) | absent | **Yes** |
| `/offline` | offline app shell | n/a (no mirror) | out of scope |
| `/demo` | Claude smoke test | absent | don't port |
| `/auth`, `/probe` | — | present | keep, mobile-only |

**Good news on the history panel:** `LessonDetailResponse` (`packages/shared/src/api.ts:304`)
already returns `sessions: LessonSession[]` *with transcripts* plus `sessionCount`, and the mobile
tutor screen already fetches it — it just renders `sessionCount` and throws the rest away. The
"History" panel needs **zero API work**.

> **Correction, found during implementation.** This section first claimed "Word changes" had no v2
> route. It does: `GET /api/v2/lessons/:id/items` returns every item row *including* removed ones,
> and `lessons/[id]/words.tsx` was already deriving the change log from it exactly as the web
> derives it from `listLessonItemHistory`. Both deferred panels turned out to be pure rendering, so
> both shipped.

### 3.5 User flows

| Flow | Web | Mobile | Gap |
| --- | --- | --- | --- |
| Add one word | inline `.panel` form, single-line field + Add button, `ok`/`warn` feedback line in-page | `Alert.prompt` (iOS modal) | **Yes** |
| Create lesson | always-open panel: title + textarea + Create → optimistic mirror write → navigate | collapsed toggle → same fields → `postOp` → navigate | **Yes** (composer visibility + offline) |
| Create from selection | per-row `Checkbox`, selection panel with title field | SwiftUI `List` selection, bottom bar | **Yes** |
| Delete lesson | `ConfirmDialog` (focus-trapped, styled, `Your words … stay in your collection`) | native `Alert` | **Yes** |
| Favorite | star `icon` button in the row | leading swipe action | **Yes** |
| Filter / sort | flat chip rows (Level/Kind/Show/categories) + sort `Select` + direction chip, all visible | Sort `Menu` + Filters `BottomSheet` w/ count badge | **Yes** |
| Refresh | `RefreshButton` (spins, reports "checked HH:MM", disabled offline) | pull-to-refresh | **Yes** |
| Edit lesson words | inline on the lesson page | separate screen | **Yes** |
| Review past sessions | expandable per-session `Disclosure` w/ transcript | **not implemented** | **Yes** |
| Route feedback | top progress bar | per-screen spinner | **Yes** |
| Offline write | optimistic, queued, survives reload | online-only + Retry | out of scope (§10.2) |

---

## 4. Where the shared package sits in this

`packages/shared` already carries everything *behavioural* that both clients agree on —
`items-query.ts`, `item-list.ts`, `sync-ops.ts`, `word-types.ts`, `api.ts`, `tutor.ts`. The mobile
collection screen already uses `searchItems`, `sortChoices`, `SORT_LABELS`, `CEFR_LEVELS`,
`ITEM_KINDS`, `buildCreateLessonOp`, `MAX_ITEMS`, `MAX_LESSON_TITLE`. **The logic is already
shared. Only the presentation drifted.** That is why this is a UI project and not an architecture
project.

The open question is whether the **palette** may join it. `CLAUDE.md`'s stated test is:

> *if this had a bug, could I fix it by deploying the web app alone?* If yes it belongs on the
> server and the client should call it over HTTP.

A wrong hex on iOS is **not** fixable by deploying the web alone (it ships through TestFlight), so
by the letter of the rule the palette does not qualify. But the rule's *purpose* — one protocol,
one implementation — is exactly what the dark-palette drift in §3.3 violates. See §7 for the three
options and the recommendation.

---

## 5. Target architecture

### 5.1 Route tree after

```
app/_layout.tsx              Stack, headerShown:false   ← unchanged (Auth0 + Conversation + theme)
app/index.tsx                <Redirect href="/lesson-items" />        ← mirrors web page.tsx
app/lesson-items/index.tsx   /lesson-items
app/lesson-items/[id].tsx    /lesson-items/:id
app/lessons/index.tsx        /lessons
app/lessons/[id].tsx         /lessons/:id      ← merged: words + practice + transcript + history
app/auth.tsx                 /auth             ← mobile-only, keeps native chrome
app/probe.tsx                /probe            ← mobile-only instrument
```

Deleted: `app/(tabs)/_layout.tsx`, `(lessons)/_layout.tsx`, `(words)/_layout.tsx`,
`lessons/[id]/words.tsx`. Every URL except `/` and `/lessons/:id/words` is unchanged, which is what
keeps deep links and the shared route constants honest.

`headerShown` stays `false` throughout; the header is drawn *by the app*, inside the content column,
exactly as on the web.

### 5.2 New component layer — `apps/mobile/src/ui/`

The whole port funnels through one directory so no screen invents a colour or a radius again.

| New file | Mirrors | Notes |
| --- | --- | --- |
| `tokens.ts` | `globals.css` `:root` + `--control-height*` | palette + spacing + radii + type scale |
| `Screen.tsx` | `<main>` + `<header>` | `ScrollView`, `maxWidth: 760`, `alignSelf: center`, padding 32/20/64, `SafeAreaView` |
| `AppHeader.tsx` | `layout.tsx` `<header>` | brand → `/lesson-items`, Words, Lessons, `ThemeToggle` |
| `Panel.tsx` | `.panel` | radius 12, 1px border, padding 20, margin 12 vertical |
| `Text.tsx` | `h1/h2/p/.muted/.error/.warn/.ok` | `<H1> <H2> <Body> <Muted> <Small>` — pins the scale |
| `Button.tsx` | `Button.tsx` + `.btn*` | same 5 variants × 2 sizes × `danger` tone, same 45.2/36 heights |
| `TextField.tsx` | `input` / `textarea` rules | `sunken` bg, 1px border, radius 8, height 45.2 |
| `Chip.tsx` | `.chip` | radius 999, `accent`/`onAccent` when pressed |
| `Checkbox.tsx` | `Checkbox.tsx` | 20×20, radius 5, `accent` fill + `onAccent` tick |
| `Select.tsx` | `Select.tsx` | RN `Modal` sheet w/ `.select-item` rows + tick gutter |
| `ConfirmDialog.tsx` | `ConfirmDialog.tsx` | RN `Modal` + 50% scrim, `min(26rem,100%)`, radius 12 |
| `Disclosure.tsx` | `Disclosure.tsx` | `LayoutAnimation`/Reanimated height, rotating ▸ marker |
| `RefreshButton.tsx` | `RefreshButton.tsx` | spinning icon, "checked HH:MM", disabled offline |
| `NavProgressBar.tsx` | `NavProgressBar.tsx` | 3px accent sweep, Reanimated |
| `icons.tsx` | `icons/index.tsx` | needs **`react-native-svg`** (see §6) |
| `InfoPopover.tsx` | `InfoPopover.tsx` | small `Modal` anchored bottom — only used by the tutor hint |

Roughly **16 files, ~900–1100 lines**, most of it mechanical.

### 5.3 What gets deleted

- Every `@expo/ui/swift-ui` import (`List`, `Section`, `Menu`, `BottomSheet`, `SwipeActions`,
  `Picker`, `Button`, `Toggle`, `Group`, `VStack`, `Divider`, `ContentUnavailableView`, `Host`, and
  all of `@expo/ui/swift-ui/modifiers`).
- `components/empty-state.tsx` (or keep — see §10.1).
- `components/theme-picker.tsx` → replaced by `ui/ThemeToggle.tsx`.
- Every `Alert.alert` / `Alert.prompt` used as a *form* (the crash/error ones can stay).
- `expo-router/js-tabs` usage.

`@expo/ui` and `expo-symbols` can then be dropped from `package.json` — *unless* §10.1's exception
is taken.

---

## 6. Dependencies

| Package | Why | Risk |
| --- | --- | --- |
| **`react-native-svg`** | The web's eight icons are inline SVG; SF Symbols cannot reproduce them and the whole point is one icon set. `expo install react-native-svg`. | Low — Expo-supported, in the SDK 57 matrix. **Requires a new dev build** (native module), not just a JS reload. |
| `react-native-reanimated` | already installed (4.5.1) — drives `NavProgressBar` and `Disclosure` | none |
| `react-native-safe-area-context` | already installed | none |

Nothing else. No UI kit, no styling library — the token table plus `StyleSheet.create` is the whole
system, exactly as the web is 677 lines of hand-written CSS.

---

## 7. Unifying the palette — three options

### Option A — hoist tokens into `packages/shared` *(recommended)*

Add `packages/shared/src/theme.ts`: a pure-data module, zero imports, trivially satisfying the
package's `no-restricted-imports` rules and its empty `dependencies`.

```ts
export type Palette = { bg; panel; sunken; border; control; text; muted; faint;
                        accent; onAccent; error; ok; warn };
export const DARK: Palette = { … };   // one set of hexes, decided once
export const LIGHT: Palette = { … };  // already identical on both sides today
export const CONTROL_HEIGHT = 45.2, CONTROL_HEIGHT_SM = 36, PANEL_RADIUS = 12, …;
```

- **Web** stops hard-coding `:root` in `globals.css` and instead emits it from `layout.tsx`:
  a `<style>` block built from the module (`:root[data-theme="dark"]{--bg:…}`), placed *before* the
  existing pre-paint script. Everything downstream in `globals.css` still reads `var(--bg)` — one
  block changes, 650 lines don't.
- **Mobile** imports `DARK`/`LIGHT` directly; `theme.ts` keeps its store, its `kv-store` read and
  its hooks, and loses only the two palette literals.
- Add a `packages/shared/check.ts` case asserting both palettes define every key (cheap, and
  `pnpm check:shared` already exists).

**Cost:** it bends `CLAUDE.md`'s "deploy the web alone" test (§4). **Defence:** the token table is
inert data with no behaviour, no I/O and no npm dependency; it is the same category as
`CEFR_LEVELS`; and the drift it prevents is already measurable in §3.3. If the rule wins, take B.

### Option B — two palettes, one assertion

Leave `globals.css` and `theme.ts` as the two sources, and add a check that parses the CSS
`:root` blocks and compares them to `theme.ts`. Honest about the boundary; costs a brittle
CSS parser in a check script.

### Option C — reconcile by hand once, promise to be careful

What is in place today. It has already failed once (every dark value drifted). Not recommended.

### Which hexes win

Web's, on the grounds that the web app is the design of record and the request is "the same design
we have in Web app". Two additions the web lacks and the port needs:

- `faint` — mobile's tertiary tier (placeholders, timestamps, inactive star, the lesson preview
  line). The web achieves this with `.muted` at `0.85rem`; on mobile it earns its own token.
  Take mobile's `#5A5A5A` / `#767C85`.
- `control` — mobile's neutral button fill. The web's `secondary` button is transparent + bordered,
  so **parity says drop `control` entirely** and let `Button variant="secondary"` be
  transparent + `border`. Recommend dropping it.

Result: **12 tokens** — `bg, panel, sunken, border, text, muted, faint, accent, onAccent, error,
ok, warn`. `--field-bg` is renamed `sunken` on both sides (or keep `fieldBg`; pick one name and
use it in both places).

---

## 8. Screen-by-screen port

Each entry is: web source → mobile target → what changes.

### 8.1 Shell — `app/_layout.tsx` + `ui/Screen.tsx` + `ui/AppHeader.tsx`

- Keep `Auth0Provider`, `ConversationProvider`, `StatusBar`, and the root `Stack`.
- **Remove** the expo-router `ThemeProvider`/`navTheme` block: with `headerShown: false` everywhere
  the navigator paints nothing but the transition background. Keep only
  `screenOptions={{ contentStyle: { backgroundColor: palette.bg } }}` so pushes don't flash white.
- Mount `<NavProgressBar/>` at the root, above the `Stack`.
- `Screen` renders: `SafeAreaView(edges:['top','bottom'])` → `ScrollView` →
  `View{ width:'100%', maxWidth:760, alignSelf:'center', paddingHorizontal:20, paddingTop:32,
  paddingBottom:64 }` → `<AppHeader/>` → children.
- Screens that need their own scroller (the live transcript) take a `scroll={false}` variant.
  **Prefer not to** — the web puts the transcript in a `.panel` inside the page scroll, and
  `sanitizeTranscript` caps it at 500 lines / 4000 chars, so a plain `.map` is fine.

### 8.2 `ui/ThemeToggle.tsx` — the theme switch

Drop `system` from the mobile app to match the web's two states. Concretely:

- `ThemeChoice` narrows to `"light" | "dark"`, `useScheme()` loses its `useColorScheme()` branch,
  and `readStoredChoice()` returns `"light"` only on an explicit stored `"light"` — the exact rule
  the web's pre-paint script uses.
- The stored key stays `"theme"` and the stored values stay `"light"`/`"dark"`, so an existing
  install with `"system"` parses to `"dark"` — the same default, no migration.
- The control becomes a `secondary`/`sm` `Button` with `<SunIcon size={16}/> Light` or
  `<MoonIcon size={16}/> Dark`, in `AppHeader`, on every screen.
- `components/theme-picker.tsx` and its footer slot are deleted.

> **Worth flagging:** dropping "System" is a genuine regression in iOS terms — following the phone's
> appearance is a platform expectation, and `theme.ts`'s docblock argues the case well. Parity says
> drop it. If you'd rather keep three states, the cheap compromise is to keep the tri-state store
> and give the *web* a System option too — that is a ~20-line change to `ThemeToggle.tsx` and the
> pre-paint script, and it makes the two apps match by levelling up rather than down.

### 8.3 `/lesson-items` — the collection

`ItemsBrowser.tsx` (453 lines) → `app/lesson-items/index.tsx` (~450). The heaviest screen.

- `<H1>Words & sentences</H1>` + `<Muted>` blurb — currently absent on mobile.
- **Add-word panel** replaces `Alert.prompt`: `Panel` → `<H2>Add a word</H2>` → single-line
  `TextField` + `Button` in a row → feedback line (`ok`/`warn`) below. Same three outcomes
  (`added` / `already-present` / empty).
- **Search + filters panel**: search `TextField`, then the filters **flat, as chip rows** — Level
  (`CEFR_LEVELS` + `UNLEVELED`, multi), Kind (`ITEM_KINDS`, single), Show (favorites / unassigned),
  and one row per facet from `groupFacets`. Delete the `BottomSheet` and the `Menu`.
  - *This is the one place the native design was arguably right*: six chip groups is a lot of
    vertical space at 390pt. Mitigation that keeps parity: the chip rows already `flexWrap`, and
    the whole page scrolls. Measure it on an iPhone SE before deciding it's fine.
- **Sort**: `ui/Select` + a direction `Chip` with `SortArrowIcon`, matching the web row.
- **`RefreshButton`** in the header row; keep `RefreshControl` too — it costs nothing and iOS users
  will reach for it.
- **The list**: `FlatList` (not SwiftUI `List`) of rows = `Checkbox` + text/stats column +
  `FavoriteButton` star. Row = `borderBottomWidth: 1`, `borderBottomColor: border`, `paddingVertical
  ~10`. Tap the text → `/lesson-items/:id`. Swipe-to-favorite goes away.
  - The `selected: Map<id,text>` semantics are already identical on both sides (not pruned on
    filter change, insertion order = lesson order) — keep mobile's, drop `onSelectionChange`.
- **Selection panel**: `Panel` with the count, the title `TextField`, `Create lesson` + `Clear`.
- Empty state: `<Muted>` inside the list area, not `ContentUnavailableView` (but see §10.1).

### 8.4 `/lesson-items/:id` — word detail

Already ~90% there. Wrap each section in `Panel` with an `<H2>`, add the `← words & sentences`
back link + `RefreshButton` row at the top, move the level to a bordered pill
(`border 1px, radius 999, padding 0.1rem 0.6rem`), and render the star via `StarIcon` rather than
`★`/`☆` glyphs. **~1–2 hours.**

### 8.5 `/lessons` — lessons list

- `<H1>Lessons</H1>` + blurb.
- `Panel` "New lesson" with the form **always open** (delete the `＋ New lesson` collapse).
- `Panel` "Your lessons" containing the rows. Row = title link + `TrashIcon` `icon`/`danger` button,
  then two `Muted` lines (counts · date, then the `·`-joined preview).
- Delete → `ui/ConfirmDialog` with the web's exact copy: *"Delete “{title}”?" / "Your words and
  their practice history stay in your collection."* — replacing the native `Alert`.
- The footer (signed-in, Account, Session probe, Appearance) moves: the theme control goes to the
  header; Account and the probe have no web counterpart. Recommend a small `Muted` footer keeping
  `Account →` and `Session probe →`, since the web's equivalents live in Auth0/nowhere.

### 8.6 `/lessons/:id` — the merge

The biggest structural change. Target, in web order:

1. `<H1>{title}</H1>`; `<Muted>Created … · <Link>← all lessons</Link></Muted>`
2. `Panel` **"Words in this lesson"** — the contents of today's `lessons/[id]/words.tsx`, inline:
   the item list with a `remove` inline button per row, plus the add-textarea + `Add words` +
   `{n}/50 items` description. Then delete `words.tsx`.
   - **The caveat that motivated D51 is real and survives**: `items_list` is baked into
     `dynamicVariables` at connect, so an edit made mid-session doesn't affect that session. The web
     has the identical problem and simply doesn't say so. Recommend adding one `Muted` line —
     *"Changes apply to your next conversation."* — to **both** apps.
3. `Panel` **"Practice"** — blurb, tutor-version `Select` (only when >1), Start/End `Button`,
   status line, the `☀ screen stays on` `InfoPopover`, the stalled-audio warning, errors.
4. Pause card — already implemented and already matches (`border: warning`); restyle as a
   `Panel` with `borderColor: warn`.
5. `Panel` **"Live transcript"** — `Teacher:`/`You:` lines, rendered only when non-empty.
6. `Disclosure` **"Word changes"** — *needs a new v2 route* returning `listLessonItemHistory`'s rows
   (`text`, `created_at`, `removed_at`, `position`). Lowest-value item in the whole port; **defer**.
7. `Panel` **"History"** — one `Disclosure` per session: `Conversation — {date} · {agent_version} ·
   {duration} · {n} turns`, expanding to the summary + transcript. **The data is already in
   `LessonDetailResponse.sessions` and already fetched** — this is pure rendering, and it closes the
   single largest functional gap in the mobile app.

### 8.7 `/privacy`, `/support`

**Linked, not ported** — the one place this plan deliberately stops short of a native screen.

The first draft of this section said "straight ports of `apps/web/src/app/{privacy,support}/page.tsx`
into `app/privacy.tsx` / `app/support.tsx`". That is the parity-faithful answer and it is the wrong
one: it puts the app's *policy* in two places, and CLAUDE.md's own test resolves it cleanly — a
wrong sentence in a privacy policy **is** fixable by deploying the web app alone, so it belongs on
the server and the client should reach it over HTTP. The App Store links to the web copy either
way, which makes a native copy the version that quietly goes stale.

`ui/LegalLinks.tsx` opens both in an `SFSafariViewController` via `expo-web-browser` (already a
dependency, for the Auth0 flow), tinted to the app's palette. It sits in the lessons footer beside
`Account →`. If the intent really is two native screens, this is the one decision in the port to
revisit.

---

## 9. Sequencing

Each phase leaves the app shippable.

| Phase | Work | Rough size |
| --- | --- | --- |
| **P0** Tokens | `packages/shared/src/theme.ts`; web emits `:root` from it; mobile imports it; drop `control`, add `onAccent`/`faint`; `check:shared` case | ½ day |
| **P1** Kit | `src/ui/*` (§5.2) + `expo install react-native-svg` + port the 8 icons + **new dev build** | 2–3 days |
| **P2** Shell | `Screen`, `AppHeader`, `ThemeToggle`, `NavProgressBar`; collapse the tab/group route tree; `app/index.tsx` redirect | 1 day |
| **P3** Simple screens | `/lessons`, `/lesson-items/:id` onto the kit | 1 day |
| **P4** Collection | `/lesson-items` — chips, Select, checkbox rows, add-word panel, RefreshButton | 1.5–2 days |
| **P5** Lesson page | merge `words.tsx` up; add the **History** panel | 1.5 days |
| **P6** Trim | delete `@expo/ui`/`expo-symbols` (unless §10.1), `theme-picker`, `empty-state`; port `/privacy`, `/support`; screenshot both apps in both themes | ½ day |
| *(deferred)* | "Word changes" route + disclosure | — |

**≈ 8–10 working days.** P1 is the long pole and the only phase with a native rebuild in it.

---

## 10. What this costs, stated plainly

### 10.1 The two things the native version does better

1. **SF Symbols.** `expo-symbols` gives correctly-weighted, correctly-aligned, automatically
   theme-tinted glyphs. Replacing them with eight hand-drawn SVGs is strictly worse *as icons* and
   adds a native dependency. **But** it is the only way both apps show the same star, the same bin,
   the same sun/moon — which is what was asked for. Port them.
2. **`ContentUnavailableView`.** It takes its type scale, icon tint and secondary-label colour from
   the system and is therefore correct in both appearances *without appearing in the token table at
   all* (D74). The web's equivalent is a bare `<p class="muted">No lessons yet…</p>`.
   **This is the one exception I'd actually argue for keeping** — it is a full-screen empty state
   seen rarely, it contains no branded chrome, and keeping it means keeping `@expo/ui` for one
   component. If you want the dependency gone, a `ui/EmptyState.tsx` built from `Panel` + `H2` +
   `Muted` reaches parity for ~20 lines. Either answer is defensible; the SwiftUI one is better
   design, the RN one is better parity.

Beyond those: `Menu` and `BottomSheet` are genuinely better at phone width than six wrapped chip
rows, and `SwipeActions` is a better favorite affordance than a tap target in a dense row. Losing
them is the price of the request, and it's a price worth naming before the work starts rather than
after.

### 10.2 What this project does *not* fix

- **Offline.** The web's `lib/sync/` (Dexie mirror + outbox + service worker) has no mobile
  counterpart, so mobile writes stay online-only. This is a separate, larger project —
  `packages/shared/src/mirror-store.ts` already declares the storage contract precisely so a
  SQLite-backed `MirrorStore` can be dropped in beside `dexie-store.ts`, and the three reactive
  hooks in `live.ts` are the deliberately per-platform part. Out of scope here; the design port
  neither helps nor hurts it.
- **Background audio.** Unchanged and unaffected.
- **The `/demo` page.** A server-side Claude smoke test. Don't port it.

### 10.3 Risks

| Risk | Mitigation |
| --- | --- |
| Six chip groups fill an iPhone SE viewport | measure at P4; if it fails, a `Disclosure` around the filter block keeps parity in shape while collapsing by default |
| `react-native-svg` needs a native rebuild | schedule it at the *start* of P1 so it's absorbed by the phase that already needs a build |
| Reimplementing `Select`/`ConfirmDialog`/`Disclosure` invites accessibility regressions Base UI handled for free | port `accessibilityRole` / `accessibilityState` / `accessibilityLabel` deliberately per component; the existing mobile screens already do this well and should be the reference |
| Losing per-tab back stacks | matches the web, which has one history — accept |
| `760px` column is invisible on a phone | true; it's for iPad and it costs one style rule — keep it |

---

## 11. Verification

- `pnpm typecheck && pnpm lint && pnpm check:shared` at the repo root.
- `pnpm --filter mobile check` (typecheck + lint + expo-doctor + bundle).
- Every screen screenshotted in **both** appearances, both apps, side by side — the ThemeToggle in
  the mobile header is what finally makes this a 30-second check instead of an iOS-Settings round
  trip per screen (the reason `theme-picker` existed in the first place).
- Deep links still resolve: `/lesson-items`, `/lesson-items/:id`, `/lessons`, `/lessons/:id`.
- An existing install with `theme = "system"` in `kv-store` launches **dark** and the toggle works.

---

## 12. Summary

The mobile app already shares all of the *logic* — query grammar, list helpers, op algebra, wire
types — via `@tutor/shared`. What diverged is entirely presentational, and it diverged on purpose.
Closing it is about **8–10 days** of mostly mechanical work in four movements:

1. **One token table** in `packages/shared`, with the web's hexes winning and the web's CSS
   variables generated from it (§7).
2. **One component kit** (`apps/mobile/src/ui/`, ~16 files) reproducing `globals.css` in
   `StyleSheet`, replacing every `@expo/ui/swift-ui` surface (§5.2).
3. **One navigation model** — top header, no tabs, no native stack headers, one back stack, `/`
   redirecting to `/lesson-items` (§5.1).
4. **Two structural page changes** — merge `/lessons/:id/words` into `/lessons/:id`, and render the
   session History that the API already returns and the app already fetches (§8.6).

Two calls worth making consciously before starting: dropping the **"System" theme state** (§8.2 —
or add it to the web instead), and giving up **`ContentUnavailableView`** and the native
`Menu`/`BottomSheet`/`SwipeActions` affordances (§10.1).

---

## 13. What shipped

Implemented in this repo on 2026-08-15. `pnpm typecheck`, `pnpm lint`, `pnpm check:shared`,
`pnpm build` (web) and `pnpm --filter mobile check` (typecheck + lint + expo-doctor + iOS bundle)
all pass.

### 13.1 The four movements

**P0 — one token table.** `packages/shared/src/theme.ts` holds twelve colour roles × two palettes,
`parseScheme`, `paletteFor`, `THEME_STORAGE_KEY` and `CSS_VARIABLES`. The web's hexes won.
`globals.css` no longer declares `:root` at all — `apps/web/src/lib/theme-css.ts` emits both blocks
(plus `color-scheme`) and `RootLayout` inlines them into `<head>`, so there is exactly one
definition of each variable and no specificity race with the stylesheet Next injects.
`viewport.themeColor` now reads `DARK.bg`/`LIGHT.bg` instead of a `#0b0b12` that matched neither
palette. Four new property checks in `packages/shared/check.ts` pin: every role is a 6-digit hex in
both palettes, roles map 1:1 onto distinct custom properties, `parseScheme` resolves everything but
the literal `"light"` to dark, and the two palettes are not identical.

**P1 — the kit.** `apps/mobile/src/ui/` — 18 modules, one barrel. `tokens.ts` (geometry, each value
carrying the `rem` it came from), `Screen`, `AppHeader`, `Panel`, `Text` (H1/H2/Body/Muted/Faint/
ErrorText/WarnText), `Button`, `TextField`, `Chip`/`ChipRow`, `Checkbox`, `Select`, `ConfirmDialog`,
`Disclosure`, `RefreshButton`, `NavProgressBar` + `nav-progress`, `Link`, `ThemeToggle`,
`EmptyState`, `LegalLinks`, and the eight icons on `react-native-svg` (the one new dependency).

**P2 — navigation.** The tab bar and all three group layouts are gone; the tree is flat
(`/`→redirect, `/lesson-items`, `/lesson-items/[id]`, `/lessons`, `/lessons/[id]`, `/auth`,
`/probe`). `headerShown: false` everywhere; the header is drawn inside the content column by
`Screen`. Root `_layout.tsx` dropped `navTheme`/`ThemeProvider` (nothing left to colour) and gained
`NavProgressBar` plus `contentStyle` so a push doesn't flash white.

**P3–P5 — the screens.** All five ported. `/lessons/:id/words` was folded into `/lessons/:id`, and
the lesson page gained the **History** panel and the **Word changes** disclosure — both pure
rendering over data the app already fetched.

### 13.2 Beyond the plan

- **`Appearance.setColorScheme(scheme)`** in the root layout. `app.config.ts` declares
  `userInterfaceStyle: "automatic"`, which iOS resolves against the *system* setting — so a phone in
  light mode with the app toggled to dark would draw a light keyboard, light native alerts and a
  light share sheet. Not in the plan; found while wiring the toggle.
- **`@expo/ui` and `expo-symbols` removed.** iOS bundle 5.2 MB → 4.9 MB, 1768 → 1641 modules.
- `apps/mobile/src/app/auth.tsx`'s back link was labelled `← S1 suspension probe` and went to `/`.
  Now `← home`, matching `probe.tsx`.

### 13.3 Deliberate deviations

| | What | Why |
| --- | --- | --- |
| `/privacy`, `/support` | Opened in `SFSafariViewController`, not ported as screens | §8.7 — one copy of the policy, on the side that can be redeployed alone |
| Selection bar | A panel at the end of the page, not `position: sticky` | RN has no sticky; a floating bar would cover the rows being ticked at phone height |
| `TextField` focus | Border **colour** changes, width does not | An `outline` costs no layout; thickening a border shoves the text being typed |
| `Disclosure` | Unmounts its panel (web keeps it findable via `hidden="until-found"`) | No find-in-page on a phone to serve |
| `Button` press | Opacity nudge, which the web has no counterpart for | A touch screen owes the finger the feedback a cursor gets from hover |
| `AppHeader` | Wraps to two lines when it must | Brand + 2 links + toggle ≈ 400pt; the web overflows at the same width |
| `auth.tsx`, `probe.tsx` | Left on their own layout | Mobile-only instruments with no web counterpart; both already have in-page back links |

### 13.4 Still needs a device

Everything below typechecks, lints and bundles, but none of it has been run on hardware:

1. **The filter block on the smallest screen.** Six wrapped chip groups is the one call in this port
   that could turn out wrong — the `BottomSheet` existed precisely because of it. If it fails, wrap
   the block in a `Disclosure`, which keeps the shape and collapses by default.
2. **`Select` and `ConfirmDialog` as `Modal`s** over a screen that already has a `KeyboardAvoidingView`.
3. **`NavProgressBar`** — the sweep interpolation and the reveal/fade handoff.
4. **Every screen in both appearances.** Now a two-tap check from the header rather than a trip
   through iOS Settings per screen, which is what `theme-picker` existed to avoid.
5. **A new dev build is required** — `react-native-svg` is a native module, so a JS reload will not
   pick it up.

### 13.5 Not addressed

Offline (`lib/sync/` still has no mobile counterpart — see §10.2), and the `/demo` page, which was
never in scope.
