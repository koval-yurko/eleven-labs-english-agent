# S6 — the collection and word detail · research

**Date:** created 2026-08-13 · researched 2026-08-15 · built 2026-08-15 · **Status:** ✅ **GATE
PASSED (2026-08-15)** — the collection filters, searches and sorts on the phone, matching the web.

**Parents:** [build plan → S6](./2026-08-12-expo-build-plan.md) ·
[creation doc §3.3, §5, §6](./2026-08-12-expo-app-creation.md) ·
[S5 research](./2026-08-13-expo-s5-lessons.md) ·
[S0 §2 D3](./2026-08-13-expo-s0-scaffold-testflight.md#2-decisions--settled-2026-08-13).

**In one line:** the placeholder called this "the largest UI item in the project", and it was right
about the web — but two measurements taken for this note (**70 items, 0 category facets**) turn the
hardest question into an easy one, and SwiftUI's `List` turns out to ship the multiselect the web
had to build by hand.

---

## 0. What the research settled

| #   | Question                                                | Answer                                                                                                                                                                          | §         |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | How the serialized query rides the wire                 | **As the actual query string.** `serializeItemsQuery` → `?level=C1&…`, and the route hands `req.nextUrl.searchParams` to `parseItemsQuery`. One grammar, both ends, already checked. | §5.1, D55 |
| 2   | Facets — one response or a second call?                 | **One.** And the reason is a measurement: **there are zero facet rows.** A second round trip to fetch an empty array is the easiest call in the project.                          | §5.1, D56 |
| 3   | List shape — `Host` per row, or one `Host` + `List`?    | **One `Host` + SwiftUI `List`.** The measurement kills the virtualization objection (70 rows ≈ 32 KB), and `List` carries `selection` / `onSelectionChange` natively.            | §4, D58   |
| 4   | Multiselect on touch                                    | **`List`'s own selection**, tagged by item id — the web's hand-built checkbox column does not get ported. ⚠️ One behaviour to verify before committing to it (§4.2).             | §4.2, D58 |
| 5   | List performance at real collection sizes               | **Not a problem, measured rather than assumed** — and the trigger for revisiting is written down instead of guessed at.                                                          | §3, D57   |
| 6   | Native equivalents for the ~2630 LOC of Base UI chrome  | Most of it evaporates: `List` + `SwipeActions` + `Menu` + `ContentUnavailableView` replace `Checkbox`, `Tooltip`, `Select`, the chip rows and the empty states.                  | §6        |
| 7   | Does the URL still hold filter state?                   | **No — React state does.** But `serializeItemsQuery` stays the *only* serialization: it builds the request. The grammar keeps one implementation; it loses only its address bar. | §4.1, D61 |
| 8   | Word detail — rendering `WordDetails` natively          | A plain RN screen. It is typography, not controls; `getItem`'s narrow query is untouched.                                                                                       | §6.3, D64 |
| 9   | ⚠️ Not asked — where is the collection reached FROM?    | S5 deleted the launcher that would have answered this. A header button on the lessons list; **the tab-bar question is S7's**, where navigation lives.                            | D65       |
| 10  | ⚠️ Not asked — who converts `URLSearchParams` to the bag? | Nobody, portably. That step exists **once, inside `check.ts`**, and the route needs the same one. It moves into `items-query.ts`.                                              | §5.1, D55 |

---

## 1. Inputs from S5 — filled in

| Input                        | What S5 settled                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Data fetching                | One `load()` of `apiFetch` calls, re-called after a write. No query library. Unchanged.                                                     |
| Writes                       | `postOp` → `/api/v2/sync/flush` for **lesson** ops. **S6's own writes do not use it** (D62) — but the optimistic *shape* is copied exactly. |
| Optimistic updates           | `write(next, run)`: snapshot → apply → post → re-read; on failure restore the snapshot and keep `{ next, run }` for a retry.                |
| Errors / empty               | One `loadError` + retry, `ActivityIndicator` while null. **S6 gets a native upgrade for the empty case** (`ContentUnavailableView`).        |
| Ids                          | `newId()` from `src/lib/ids.ts` (`expo-crypto`).                                                                                            |
| Confirmations                | `Alert.alert` (S5 D52). Nothing destructive on this screen needs one.                                                                       |
| D3 in practice               | RN owns layout; `@expo/ui/swift-ui` owns discrete controls in sized `Host`s. **S6 is where that boundary gets its real test** (§4).         |
| Two React Compiler rules     | `set-state-in-effect` wants the async-IIFE effect shape; `immutability` forbids a `useCallback` referencing itself. Both will recur here.   |

---

## 2. What ports, and what evaporates

| Web file                              | LOC | Native                                                                                        |
| ------------------------------------- | --- | ----------------------------------------------------------------------------------------------- |
| `ItemsBrowser.tsx`                    | 453 | **~150.** The filter chrome, the checkbox column and the sticky action bar are all replaced.  |
| `lesson-items/[id]/page.tsx`          | 197 | **~150.** Nearly a straight port — it is text, and the three-state `details` logic is a rule. |
| `AddWordForm.tsx`                     |  99 | **~40.** A `TextField` and a button.                                                          |
| `FavoriteButton.tsx`                  |  54 | **~0 as a component** — it becomes a swipe action and a tap target inside the row (D66).      |
| `page.tsx` (server component)         |  57 | Becomes `GET /api/v2/lesson-items`.                                                           |
| `Select`, `Checkbox`, `Tooltip`, `Disclosure`, `InfoPopover` | ~500 | **None ported.** `Menu`, `List` selection, `Section` and swipe actions replace them. |

**Everything under the chrome is already shared and already checked**: `parseItemsQuery` /
`serializeItemsQuery` (10 752 round-trips in `pnpm check:shared`), `searchItems`, `groupFacets`,
`sortChoices` / `SORT_LABELS`, and every DTO in `word-types.ts`. S6 writes **no new logic** — the one
piece of pure code it adds is a URL-bag helper that already exists in a test file (§5.1).

---

## 3. The measurements — taken 2026-08-15, against the real database

Read-only probe of `owner_items` and `owner_item_facets`:

| Quantity                          | Value                                             |
| --------------------------------- | ------------------------------------------------- |
| `owner_items` rows                | **70**                                            |
| One row, serialized               | **~453 bytes**                                    |
| The whole list, therefore         | **~32 KB**                                        |
| `owner_item_facets` rows          | **0**                                             |
| `lessons` rows                    | 15                                                |

Three consequences, and each replaces a paragraph of speculation:

- **The list needs no virtualization.** The web comment estimates "hundreds of rows at the
  50-items-per-lesson cap"; the actual number is 70. One `Host` containing a SwiftUI `List` with 70
  eagerly-created children is not a performance question (D58).
- **The payload needs no pagination.** 32 KB, and it is one request per filter change (D57).
- **The category filter is currently dead UI.** Zero facet rows means the web page renders no
  category rows at all today, and the native one will not either. It still gets built — it is
  ~15 lines over `groupFacets` and the view exists — but **it must not be designed for, and the gate
  cannot test it** (D67).

⚠️ **These are today's numbers, not a law.** The trigger to revisit D57/D58 is the same one D53 named:
a measurement, not a feeling — a payload past ~100 KB (≈220 items) or a visible pause opening the
screen. At that point the answer is `List` with a windowed slice or `FlashList`, plus `?limit=&cursor=`.

---

## 4. The screen — the one part that is not mechanical

### 4.1 Filter state without a URL

On the web, **the URL is the filter state**: shareable, back-button-correct, and no client state
machine. Native has no address bar, so `ItemsQuery` lives in React state.

The trap is concluding that the grammar goes with it. It does not:

```ts
const [query, setQuery] = useState<ItemsQuery>({ levels: [], … sort: DEFAULT_SORT, dir: DEFAULT_DIR });
const qs = serializeItemsQuery(query, "");        // ← the SAME encoder, now building a request
const items = await apiFetch(`${API_V2}/lesson-items${qs ? `?${qs}` : ""}`, accessToken);
```

`serializeItemsQuery` stops encoding an address and starts encoding a request; the server still
decodes it with `parseItemsQuery`, and `pnpm check:shared` still proves the two are inverse. **Writing
a second encoder — a JSON body, a hand-built query string — is the one thing this stage can do that
would be expensive to undo** (D61). The search term is the exception it already was: `?q=` is not in
`ItemsQuery`, and on native it never reaches the wire at all (D60).

### 4.2 Multiselect — SwiftUI has it, with one thing to check

The web builds selection by hand: a `Checkbox` per row, and an `id → text` **Map** that is
deliberately *not* pruned when a filter changes, so a learner can tick words across several filtered
views and create one lesson from the union. `ItemRow.text` only exists for visible rows, which is
exactly why the map stores text rather than ids alone.

`@expo/ui@57.0.10`'s `List` carries this natively:

```ts
export interface ListProps extends CommonViewModifierProps {
  selection?: (string | number)[];
  onSelectionChange?: (selection: (string | number)[]) => void;
}
```

Tag each row with the item id and the selection is the platform's, with the platform's edit-mode
affordances. **The union-across-filters behaviour is what has to be verified before committing**: our
`selection` array will contain ids for rows the current filter does not render, and it is not known
whether `onSelectionChange` then reports them back or silently drops them. Two outcomes:

- **Reported back** → keep the `id → text` Map as the source of truth exactly as the web does, feed
  `selection={[...map.keys()]}`, and merge on change.
- **Dropped** → merge defensively: on every `onSelectionChange`, remove only ids that are *currently
  visible* and unticked, and leave the rest of the map alone. Ten lines, and it makes the native
  behaviour irrelevant.

Build the defensive merge from the start. It is correct under both outcomes, and the alternative is
discovering the difference as "my ticks vanished when I changed the filter" (T4).

### 4.3 Filters belong in a sheet, not in a chip wall

The web lays out six filter groups — level (multi), kind (single), two independent booleans,
categories (dynamic), sort + direction — as wrapped chip rows. That works at 1000 px. At 390 pt it
would fill the screen above a 70-row list.

Native shape:

- **Sort + direction: a `Menu` in the header.** `sortChoices()` already supplies the labels, and
  direction is a second menu item. One tap, no viewport cost.
- **Everything else: a `BottomSheet`**, opened from a header button that shows the count of active
  filters, with one `Section` per group and `Toggle` rows inside.
- **An always-visible summary line** under the header when any filter is on (`B2, favorites · 12 of
  70`), with a clear-all. A filter you cannot see is a filter you will blame the data for.

`BottomSheet`, `Menu`, `Section` and `Toggle` are all in `@expo/ui/swift-ui` at the installed version.

### 4.4 What the modifier set does and does not give us

Read from `@expo/ui@57.0.10`'s `build/swift-ui/modifiers/index.d.ts` rather than from memory:

- ✅ **`refreshable`** — native pull-to-refresh inside the `List`. This replaces S5's `RefreshControl`
  on this screen and matters more here: levels and `details` arrive from background jobs, so "ask
  again" is the whole reason the web grew a `RefreshButton`.
- ✅ `listStyle`, `listRowSeparator`, `listRowBackground`, `badge`, `tint`, `onTapGesture`,
  `onLongPressGesture`, `deleteDisabled` / `moveDisabled`.
- ✅ `SwipeActions` with leading/trailing groups and `allowsFullSwipe` — the favorite star becomes a
  leading swipe, which is the iOS idiom and costs no row width.
- ✅ `ContentUnavailableView` (iOS 17+; the target device is on iOS 26.4) — the native empty state,
  for both "nothing here yet" and "no match for this search", which the web renders as two different
  strings from one branch.
- ❌ **No `searchable`.** There is no SwiftUI search-bar modifier in this build, so the search field
  is ours — an RN `TextInput` above the `Host`, or an Expo UI `TextField`. Either way `searchItems`
  runs unchanged, in memory (D60).

---

## 5. The server

### 5.1 `GET /api/v2/lesson-items?…`

The first v2 route with a query string. It parses with the shared parser and never touches the raw
values:

```ts
export const GET = withBearer(async (req, ownerId) => {
  const query = parseItemsQuery(searchParamsToBag(new URL(req.url).searchParams));
  const [items, facets] = await Promise.all([listItems(ownerId, query), listItemFacets(ownerId)]);
  const body: ItemsResponse = { items, facets };
  return json(body);
});
```

`parseItemsQuery` is the security boundary, not a convenience: `isValidLevel` / `isValidSort` /
`isValidKind` are what keep an arbitrary string out of PostgREST, and `listItems` interpolates the
sort column into an `.order()` and each level into an `.or()` clause. **A route that read
`searchParams.get("sort")` directly would be a PostgREST injection, in the one place this codebase has
already written the whitelist.**

⚠️ **`searchParamsToBag` does not exist yet in shipped code.** `parseItemsQuery` takes
`ItemsSearchParams` — a bag where a repeated key collapses to an array — which is what Next hands a
page. Converting a `URLSearchParams` into that bag is currently implemented **once, as
`toSearchParams` inside `packages/shared/check.ts`**, a test file the app cannot import. It moves into
`items-query.ts` as an exported `searchParamsToBag`, `check.ts` uses the exported one, and the round-trip
suite then covers the exact function the route runs (D55).

### 5.2 `GET /api/v2/lesson-items/:id`

`getItem` verbatim → `ItemDetail`. 404 for missing/not-yours, the same shape as the S5 routes. Its
two-query structure (the `owner_items` row, then the narrow `words.details` read) stays exactly as it
is — a fat jsonb blob has no business in the list payload, which is why it was split in the first
place.

### 5.3 The two writes

Direct routes, **not** `/sync/flush` (D62):

| Route                                | Backed by                       | Notes                                                            |
| ------------------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| `POST /api/v2/lesson-items`          | `addWord` → `AddWordResult`     | `already-present` is a real answer and must reach the UI          |
| `POST /api/v2/lesson-items/favorite` | `setItemFavorite(normKey, bool)`| ⚠️ keyed by **`norm_key`**, not by id                             |

Both duplicate the pattern `addWordAction` already has, and **the add route must call
`scheduleWordJobs(ownerId)`** — the helper S5 extracted (D45) — or a word added from the phone gets no
level and no `details` until the next sweep. This is S5's T8 in a second place, and it fails just as
invisibly.

`/lesson-items` stays **online-only**, deliberately, and that asymmetry is carried over rather than
fixed: `MirrorItem` is keyed on a `lesson_id` a standalone word does not have, so queueing these
offline would durably store an intent no screen could render (creation doc §5).

### 5.4 The contract additions

```ts
API_V2_ROUTES.items          = `${API_V2}/lesson-items`;
API_V2_ROUTES.itemFavorite   = `${API_V2}/lesson-items/favorite`;
export function itemPath(id: string): string;          // built FROM API_V2_ROUTES.items
export function itemsPath(query: ItemsQuery): string;  // built FROM serializeItemsQuery — the ONLY encoder

export interface ItemsResponse { items: ItemRow[]; facets: ItemFacet[] }
export interface ItemDetailResponse { item: ItemDetail }
export interface AddWordRequest { text: string }
export interface FavoriteRequest { normKey: string; isFavorite: boolean }
```

`AddWordResult` is imported from where it lives rather than redeclared. Note it currently sits in
`apps/web/src/lib/words.ts`, which a native client cannot import — **it moves to
`packages/shared/src/word-types.ts`** (a pure three-field interface; the query stays put), the same
move R1 made for every other DTO.

---

## 6. The app

### 6.1 Files

```
apps/mobile/src/
  app/
    lesson-items/
      index.tsx          NEW — the collection
      [id].tsx           NEW — word detail
  lib/
    items.ts             NEW — fetches + the two writes (its own module; does not extend lessons.ts)
```

Plus one line on the lessons screen: a header button to `/lesson-items` (D65).

### 6.2 The collection screen

RN owns the outer column: header, search field, filter summary. One `Host` with `flex: 1` owns the
`List` — **never `matchContents` on the vertical axis**, which is the trap S0 recorded and this is
the longest screen in the project (S0 §2 D3).

A row is: the text, a stats line (`{n} conversations · {n} lessons · added {date}`), a level badge
when `level` is non-null, and a leading swipe action for favorite. Tap opens the detail; selection is
the `List`'s.

When anything is selected, an RN bar sits below the `Host`: `{n} selected`, an optional title field,
and **Create lesson** — which goes through `buildCreateLessonOp` + `postOp`, S5's proven path (D63).
This is the only place the collection writes a lesson, and it must not grow a second way to do it.

### 6.3 The word detail screen

A plain RN `ScrollView`. It is typography, not controls, and the three-state rule is the only logic:

- `details` set → translation, forms, examples;
- `details` null **and** `details_at` null → "Details are being prepared…";
- `details` null **but** `details_at` set → "No extra details for this one." — **terminal and normal**,
  not an error and not a spinner.

That rule is worth stating because it is invisible in the payload and easy to collapse into "loading
forever". Keep the "In lessons" section, and keep "In no lesson right now." as a real state — a word
detached from every lesson is the normal outcome of removing it.

---

## 7. Deliberately not built at S6

| Not built                              | Why                                                                             |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| A tab bar                              | Navigation is S7's stage (D65).                                                 |
| Offline anything on this screen        | Online-only by design, on both clients (creation doc §5).                       |
| Category *editing*                     | Categories are written by nothing yet — zero rows (§3). Rendering only (D67).   |
| Level editing                          | Levels are the job's, never the UI's. `null` is a permanent, real state.        |
| `?q=` in the wire query                | It is in-memory search, and it is not in `ItemsQuery` (D60).                     |
| Reordering / deleting from the list    | `List.ForEach`'s `onDelete`/`onMove` exist, but neither has an op. Not a screen decision — an algebra change. |
| Sharing a filtered view                | The URL was what made that free on web. Not worth inventing a scheme for.       |

---

## 8. Test plan — on the phone

| #  | Test                                                                 | Expected                                                                                     |
| -- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| T1 | Open the collection cold                                             | All 70 items, newest first (`DEFAULT_SORT` = `created`, `DEFAULT_DIR` = `desc`).             |
| T2 | **Same filter + sort on phone and web, side by side**                | **Identical rows in identical order.** The gate.                                              |
| T3 | Search "ubiq"                                                        | Filters in memory, instantly, no request. Clearing it restores the list without a fetch.      |
| T4 | Tick 3 words, change the level filter, tick 2 more, create a lesson  | **5 words in the new lesson.** The union-across-filters behaviour (§4.2).                     |
| T5 | Favorite a word → check the web                                      | Star persists; keyed on `norm_key` (D66).                                                     |
| T6 | Add a word, wait ~30 s, open its detail                              | It has a level and `details`. **`scheduleWordJobs` in the add route** (§5.3) — S5's T8 again. |
| T7 | Add a word that already exists                                       | "…is already in your collection." — not silence, not an error.                                |
| T8 | Sort by "Times practiced", both directions                           | Matches the web. This is the sort the shared-defaults bug used to make unselectable.           |
| T9 | Open a word with no `details` yet, and one the job gave up on        | Two different sentences (§6.3), neither a spinner.                                             |

T2 is the gate and T6 is the one that fails silently.

---

## 9. Gate — **passed 2026-08-15**

- [x] **Filter, search and sort return the same results as the web app for the same query** (T2, T8)

And two the research added:

- [x] **T4** — selection survives a filter change (§4.2), the one behaviour SwiftUI might not give us
- [x] **T6** — a word added from the phone is levelled and enriched (the second `scheduleWordJobs` site)

**Reported green by the tester on 2026-08-15.** The server half of T2/T8 is independently evidenced
(§13's 20-query probe); the device half, and T4's defensive merge, were reported as a whole. ⚠️ **The
SwiftUI `List` is now known to render and scroll** — the single largest unknown this stage carried —
which is what makes D58 a settled decision rather than a bet.

---

## 10. If it fails

| Symptom                                                     | First suspicion                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The list scrolls on web but not on the phone                 | `matchContents` on the vertical axis of the `Host` wrapping the `List` (S0 §2 D3). No error — it just stops. |
| Phone and web disagree on one filter                        | A second encoder crept in. There is exactly one (D61) — check the request URL against `serializeItemsQuery`. |
| 500 on the list route                                       | `searchParams` passed to `parseItemsQuery` without the bag conversion (§5.1).                              |
| Sort silently falls back to "Date added"                    | An invalid `sort` reaching `isValidSort`. That fallback is by design; the bug is upstream.                 |
| Ticks vanish when the filter changes                        | The defensive merge was skipped (§4.2). Do not "fix" it by pruning the map.                                |
| Favorite doesn't stick                                      | Sent the item **id** instead of `norm_key` (D66).                                                          |
| New words never get a level                                 | `scheduleWordJobs` missing from the add route (§5.3).                                                     |
| The category filter never appears                           | Expected — zero facet rows (§3). Not a bug.                                                                |

---

## 11. Build order

1. Move `AddWordResult` to `packages/shared/src/word-types.ts`; add `searchParamsToBag` to
   `items-query.ts` and re-point `check.ts` at it. `pnpm check:shared`.
2. The contract additions (§5.4). `pnpm typecheck`.
3. `GET /api/v2/lesson-items` + `GET /api/v2/lesson-items/:id`. Verify against the web by
   **comparing the two for the same query before any screen exists** — that is the gate, testable
   from `curl`.
4. `POST /api/v2/lesson-items` + `/favorite`, both with `scheduleWordJobs` on add.
5. `src/lib/items.ts`.
6. The collection screen, read-only: `Host` + `List` + rows. Confirm scrolling before adding anything.
7. Search, then the sort `Menu`, then the filter `BottomSheet`.
8. Selection + create-from-selection (§4.2's defensive merge from the start).
9. Favorite (swipe) and add-word.
10. The word detail screen.
11. T1–T9 on the device.

Steps 1–4 are the gate. **They are testable before a single screen exists**, which is unusual for a
UI stage and worth exploiting: if `curl` and the web agree for a dozen queries, everything after it
is chrome.

---

## 12. Is S6 ready to build?

Yes. D3 was decided at S0 and its two traps are recorded; S5 handed over every convention; the logic
is shared and property-checked; and the two questions the placeholder could not answer — list shape
and facets — were answered by measuring rather than arguing (§3).

The one genuine unknown is §4.2, and it has a design that is correct either way.

---

## 13. Implementation — built 2026-08-15, statically verified

Built in §11's order.

### What was built

| Step  | Files                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 1     | `searchParamsToBag` in `items-query.ts` (+ 3 pinned cases); `AddWordResult` → `word-types.ts`                  |
| 2     | `items` / `itemFavorite` paths, `itemPath`, `itemsPath`, `ItemsResponse`, `ItemDetailResponse`, `AddWordRequest`/`Response`, `FavoriteRequest`/`Response` + guards |
| 3–4   | `api/v2/lesson-items/route.ts` (GET list + POST add), `lesson-items/[id]/route.ts`, `lesson-items/favorite/route.ts` |
| 5     | `apps/mobile/src/lib/items.ts`                                                                                 |
| 6–9   | `src/app/lesson-items/index.tsx` — `Host` + SwiftUI `List`, search, sort `Menu`, filter `BottomSheet`, selection, favorite swipe, add-word |
| 10    | `src/app/lesson-items/[id].tsx` — the word detail screen                                                       |
| —     | A `Words` header button on the lessons screen (D65)                                                            |

### ✅ The gate's server half is already verified — against the real database

§11 predicted steps 1–4 would be testable before a screen existed, and they were. A temporary probe
ran the **exact route path** — `searchParamsToBag` → `parseItemsQuery` → `listItems` — over 20 query
strings against the project's Postgres. Every one reached the database cleanly, every one
re-serialized to a stable query, and the result sets differ the way they should:

| Query                                                  | Rows |
| ------------------------------------------------------ | ---- |
| (defaults)                                             | 70   |
| `level=B1`                                             | 9    |
| `level=B1&level=C1`                                    | 37   |
| `level=unleveled`                                      | 2    |
| `level=B2&level=unleveled&sort=text&dir=asc`           | 29   |
| `unassigned=1`                                         | 34   |
| `kind=word` / `kind=phrase` / `kind=sentence`          | 59 / 11 / 0 |
| `fav=1`                                                | 0    |
| `cat.topic=business`                                   | 0    |
| `sort=bogus&dir=sideways&level=Z9` *(all invalid)*     | 70   |

That last row is the one that matters most: every value is garbage, and instead of throwing or
reaching PostgREST it falls back to the defaults. The whitelist works, on the live path.

**Two more empty states, discovered by the probe and not by the research:** there are **zero
favorites** and **zero `sentence`-kind items**. So `fav=1` and `kind=sentence` join the category
filter as controls that are correct but currently show nothing — worth knowing before reading an
empty list as a bug (§3 already says this about categories; it is true of three filters, not one).

### What the checks proved

- `pnpm typecheck`, `pnpm lint` — clean across all three packages.
- `pnpm check:shared` — 10 752 round-trips **now running through the shared `searchParamsToBag`**, so
  the suite exercises the exact function the route runs, plus 3 cases pinning the repeated-key rule.
- `pnpm build` — `/api/v2/lesson-items`, `/api/v2/lesson-items/[id]` and
  `/api/v2/lesson-items/favorite` all registered as dynamic handlers.
- `pnpm --filter mobile bundle` — 1629 modules (1623 before), iOS bundle produced. This is what
  resolves the Expo UI imports (`List`, `SwipeActions`, `BottomSheet`, `Menu`,
  `ContentUnavailableView`) and the two new routes.
- **Live smoke test:** all three routes 401 unauthenticated with CORS headers; `OPTIONS` 204; and
  `GET /api/v2/lesson-items/favorite` answers **405, not 401** — which confirms Next resolved it as
  the literal sibling rather than as `[id]` with `id: "favorite"`, the non-collision the route
  comment claims.

### Two things found while building

- **`searchItems(items ?? [], search)` silently loses every column but `text`.** The empty literal is
  `never[]`, so the union widens the generic to its constraint (`{ text: string }`) and the rows come
  back unusable. It is a typecheck error rather than a runtime one, but the fix is not obvious from
  the message: `items ? searchItems(items, search) : []`.
- **`AddWordResult` had to move before anything could use it.** It lived in `apps/web/src/lib/words.ts`,
  which imports the service-role Supabase client — a native client cannot import it at any price.
  Same move R1 made for every other DTO; the query stayed put.

### One deviation from the plan

§6.2 described add-word as a form. It is **`Alert.prompt`** instead — the ask is a single word, the
iOS way to ask for one string is a prompt, and it costs no viewport on a screen that already carries
a search field, a control row and a selection bar. `Alert.prompt` is iOS-only, which D2 makes fine.
`already-present` is still announced out loud, which was the part that mattered.

### ⚠️ What this does not tell us

- **No authenticated request has been made from a phone.** T1–T9 are all open.
- **The SwiftUI `List` has never rendered.** The bundle proves the imports resolve; it proves nothing
  about layout. **Check scrolling first** (§11 step 6 exists for this): if the `Host` is ever given
  `matchContents` on the vertical axis, the list silently stops scrolling, with no error.
- **Selection, swipe actions and the sheet are all first-use.** §4.2's defensive merge was built as
  specified, so T4 tests the *merge*, not SwiftUI's behaviour — but the merge itself has not run.
- **`refreshable` is wired to `load(query)`** and, like the rest, is unexercised.

---

## 14. What S6 hands to S7

- [x] **D3 is fully exercised.** `Host` + SwiftUI `List` renders and scrolls with `flex: 1`;
      `SwipeActions`, `Menu`, `BottomSheet`, `Section`, `Toggle` and `ContentUnavailableView` all
      work. Expo UI is no longer a risk anyone needs to hedge — S7 can use it without ceremony.
- [x] **The complete screen inventory**, which S7's polish pass has to cover:
      `index` (lessons) · `lessons/[id]/index` (tutor) · `lessons/[id]/words` · `lesson-items/index`
      (collection) · `lesson-items/[id]` (word detail) · `auth` · `probe`. Seven screens.
- [x] **Every screen's loading/error convention is the same three lines** — `loadError` + a retry
      `Pressable`, `ActivityIndicator` while the payload is null. Uniform, and therefore cheap to
      replace wholesale if S7 wants something better.
- [x] **`ContentUnavailableView` is the native empty state**, proven on the collection. The other six
      screens still use plain muted `Text` for their empty cases — that inconsistency is S7's to
      settle, and it is the only empty-state work outstanding.
- [x] **The write patterns are settled and there are exactly two**: outbox ops through `postOp` for
      anything lesson-shaped, direct routes for the collection's own writes. Nothing in S7 should add
      a third.
- [ ] ⚠️ **Every colour in the app is a hard-coded hex in a per-file `StyleSheet`.** There is no
      palette, no token, and no light mode anywhere. This is the largest single item S7 inherits.
- [ ] ⚠️ **Three filters are correct but currently render nothing** — `fav=1` (zero favorites),
      `kind=sentence` (zero rows) and every category (zero facets). Not bugs; a reviewer or a new
      learner will read them as such (§13).
- [ ] ⚠️ **The collection is reached by a header button, and two top-level destinations want a tab
      bar** (D65). Deliberately deferred to S7 because it is a navigation decision.
- [ ] ⚠️ **`sendContextualUpdate` is still reported-working, not measured** (S5 D54) — S7 is where
      that lands, since the tutor screen is touched anyway.
- [ ] ⚠️ **`expo-doctor`: 7 packages out of date.** Pre-existing SDK-57 patch drift. S7 is the stage
      that should either do the upgrade with a device check behind it, or record a decision not to.

---

## Sources

- **Measured 2026-08-15** against the project database (read-only probe, since deleted):
  `owner_items` = **70 rows**, ~453 bytes each; `owner_item_facets` = **0 rows**; `lessons` = 15.
  These are §3, and they decide D56, D57, D58 and D67.
- **Read from installed package source on 2026-08-15:** `@expo/ui@57.0.10` —
  `build/swift-ui/List/index.d.ts` (`selection` + `onSelectionChange`, the finding behind D58),
  `List/ListForEach.d.ts` (`onDelete` / `onMove` — present, and deliberately unused, §7),
  `Host/index.d.ts` (`matchContents`, `useViewportSizeMeasurement`), `SwipeActions/index.d.ts`,
  `Section/index.d.ts`, `TextField/index.d.ts`, `ContentUnavailableView/index.d.ts`, and
  `modifiers/index.d.ts` — **grepped for the full modifier list**: `refreshable`, `listStyle`,
  `listRowSeparator`, `badge`, `deleteDisabled` present; **no `searchable`** (§4.4).
- [Expo SDK 57 — `@expo/ui`](https://docs.expo.dev/versions/v57.0.0/sdk/ui/) — the component
  inventory, cross-checked against the installed build above.
- **In-repo, read fresh on 2026-08-15:** `packages/shared/src/items-query.ts` (the grammar, the
  whitelists, `DEFAULT_SORT`/`DEFAULT_DIR`), `item-list.ts` (`searchItems`' identity return,
  `groupFacets`, `SORT_LABELS`), `word-types.ts` (`ItemRow`, `ItemDetail`, `WordDetails`, `ItemFacet`),
  `check.ts` (**`toSearchParams`, the helper that has to move** — §5.1) ·
  `apps/web/src/lib/lesson-items.ts` (`listItems` and its `SORT_COLUMNS` map, `getItem`'s two
  queries, `listItemFacets`, `setItemFavorite` — **keyed on `norm_key`**), `lib/words.ts`
  (`resolveWords`, `addWord`, `AddWordResult`) · `app/lesson-items/page.tsx`, `ItemsBrowser.tsx`
  (453 lines — the selection Map's rationale, `hrefWith`, the two-mechanism split), `AddWordForm.tsx`,
  `FavoriteButton.tsx`, `[id]/page.tsx` (the three-state `details` rule), `actions.ts` (the `after()`
  fast paths this stage must repeat).
- Prior stages: [creation doc](./2026-08-12-expo-app-creation.md) §3.3 (the routes table and the
  "do not invent a second query format" rule), §5 (the online-only asymmetry), §6 (the UI cost this
  note revises down) · [S0](./2026-08-13-expo-s0-scaffold-testflight.md) §2 D3 (Expo UI, the `Host`
  boundary, the `matchContents` scroll trap) · [S5](./2026-08-13-expo-s5-lessons.md) §3.2 (what
  `applied` means), D45 (`scheduleWordJobs`, reused here), D47, D53 (no pagination, and its trigger),
  §14 (the handover this file consumes) · [build plan](./2026-08-12-expo-build-plan.md) S6.
- Feature history: [`/lesson-items` page](./2026-07-11-lesson-items-page-search-filters-stats-favorites.md)
  (why search is client-side, why levels are read-only),
  [multiselect + word detail](./2026-07-17-lesson-items-multiselect-and-word-detail.md) (the
  selection Map, and which mutation path "create lesson" uses),
  [word details job](./2026-07-18-word-details-enrichment-job.md) (the three-state `details` rule),
  [add word](./2026-07-16-add-word-on-lesson-items-page.md) (`already-present` as a real answer).
