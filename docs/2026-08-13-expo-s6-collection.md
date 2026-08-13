# S6 — the collection and word detail · research

**Date:** created 2026-08-13 · **Status:** 🔲 **placeholder — not researched.**
**Enrich after: S5's gate is green.** (D3 must be settled long before — see below.)

**Parents:** [build plan → S6](./2026-08-12-expo-build-plan.md) ·
[creation doc §6, §9 "Still open"](./2026-08-12-expo-app-creation.md) ·
[S5 research](./2026-08-13-expo-s5-lessons.md).

---

## Why this file is empty

S6 is the largest UI item in the project and **the only stage gated on an open decision** — D3, the
component strategy. Researching the screen before D3 is decided produces a design that gets thrown
away; researching it before S5 has shipped list-and-detail screens means guessing at conventions that
will exist by then. The logic underneath, by contrast, needs no research at all: it is already pure,
shared and property-checked.

> **D3 is decided: Expo UI** (`@expo/ui`), 2026-08-13 — reasoning in [S0 §2](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13). The SwiftUI and
> Jetpack Compose APIs went stable in SDK 56 and the package ships in the default template, so it
> costs nothing alongside D6; the still-experimental part is the web layer behind
> `@expo/ui/universal`, which D2 (iOS only) puts out of scope. Import from `@expo/ui/swift-ui`.
>
> Three facts this screen must be built around, so they are not rediscovered here:
>
> - **`Host` is the boundary** — Yoga outside, SwiftUI layout inside. It behaves like a `View` and
>   needs explicit dimensions (`flex: 1`, a width) or `matchContents`.
> - **Never `matchContents` on the same axis as a SwiftUI scroll container** (`ScrollView`, `List`,
>   `Form`, `LazyVStack`): it resolves to `.fixedSize` and **scrolling silently stops** — no error,
>   on the longest screen in the project.
> - **The open question is list shape**, and it is this file's: one `Host` per row inside a
>   `FlatList` is the naive port of the web list; a single `Host` wrapping a SwiftUI `List` is the
>   likely answer. S0 proves only that the module builds and renders.

## Already decided — do not re-derive

- **The URL grammar has exactly one implementation.** `serializeItemsQuery` / `parseItemsQuery` in
  `packages/shared/src/items-query.ts` own both directions plus the whitelists that keep arbitrary
  strings out of PostgREST; `pnpm check:shared` verifies the round-trip over 10,752 cases.
  **Do not invent a second query format.**
- **`?q=` free-text is deliberately not in `ItemsQuery`.** Filters and sort go to Postgres;
  `searchItems` (`packages/shared/src/item-list.ts`) filters the loaded list in memory and returns the
  input array **identity** for an empty term — a `useMemo` depends on that.
- **What comes free:** `searchItems`, facet grouping, sort labels, `wordInputKey` / `clientDedupeKey`,
  and every DTO. Only the chrome is new.
- **`/lesson-items` is online-only even on web** — favoriting and adding a word are direct writes, not
  outbox ops, because `MirrorItem` is keyed on a `lesson_id` a standalone word does not have. Carry
  that asymmetry over deliberately.
- **CEFR levels and `words.details` are written only by their jobs**, never by the UI. The screen
  renders `null` as a real state ("unleveled", "not enriched") — there is no deadline and no spinner.
- **`resolve_words` is server-only** — text → word id is never a client-side guess.

## Inputs required from S5

- [ ] The data-fetching, error and empty-state conventions actually in use
- [ ] How writes go out (`/api/v2/sync/flush` vs the direct `/api/v2/lesson-items` routes) and what
      S5 learned about optimistic updates without the mirror
- [ ] D3, decided, with its consequences for lists, sheets, popovers and dialogs

## Questions this research must answer

- [ ] `GET /api/v2/lesson-items?…` — how the serialized query rides the wire, and how the route parses
      it back with `parseItemsQuery` before touching Postgres
- [ ] Facets (`listItemFacets`) — one response with the rows, or a second call?
- [ ] Native equivalents for the ~2630 LOC of Base UI chrome that does **not** port: `Select`,
      `Checkbox`, `ConfirmDialog`, `Disclosure`, `InfoPopover`, `Tooltip`, `Button`, `NavLink`,
      `FavoriteButton`, `ItemsBrowser`, `AddWordForm`, `LessonItemsView` (creation doc §6)
- [ ] Multiselect on touch: what replaces the web's interaction model
- [ ] List performance at real collection sizes — `FlatList`/`FlashList`, and where memoisation must go
- [ ] Word detail: rendering `WordDetails` (RU translations, forms, examples) natively; `getItem`'s
      narrow query stays as is
- [ ] Does the URL still hold filter state on native, or does a store? If a store, `ItemsQuery` remains
      the **only** serialization — decide where the boundary sits and write it down.

## Gate

- [ ] Filter, search and sort return the **same results as the web app for the same query**

## Enrichment checklist

1. Record D3 and its reasoning at the top of this file the moment it is decided.
2. Copy in S5's conventions.
3. Re-read `items-query.ts`, `item-list.ts` and the web `ItemsBrowser` for behaviour to match — then
   design only the chrome.
4. Run `pnpm check:shared` after any touch to the query grammar.
5. Flip the status line and update the build plan's Progress table.

## Sources to start from

- creation doc §6 and "Still open" · build plan S6
- In-repo: `packages/shared/src/items-query.ts`, `item-list.ts`, `word-key.ts`,
  `docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md`,
  `docs/2026-07-17-lesson-items-multiselect-and-word-detail.md`,
  `docs/2026-07-18-word-details-enrichment-job.md`
- [`@expo/ui` reference](https://docs.expo.dev/versions/latest/sdk/ui/) and
  [SwiftUI `Host`](https://docs.expo.dev/versions/latest/sdk/ui/swift-ui/host/) — D3's chosen kit
