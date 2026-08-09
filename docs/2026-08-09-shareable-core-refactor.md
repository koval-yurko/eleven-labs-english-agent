# Making the codebase shareable — the pre-monorepo refactor

**Date:** 2026-08-09
**Status:** **COMPLETE — R1–R7 all landed 2026-08-09.** Sequenced before
`docs/2026-08-09-expo-repo-structure-migration.md`, whose step 3 (`packages/shared` extraction) is
now a `git mv` of `src/shared/`.
**Question:** how much of `src/lib` (and the logic currently stuck in components) can be reshaped so
that it is genuinely reusable by both the Next app and a future Expo app — and what does that
reshaping cost?

**Companions:**

- `docs/2026-08-09-expo-repo-structure-migration.md` — where code lives (workspace layout, package
  manager). That note asked "**what can move as-is?**" and answered: very little, 4 of 24 `lib` files.
- This note asks "**what could move after refactoring?**" and answers: a lot more — roughly
  100 → 700 lines — because the blocker is *fusion*, not the nature of the code.

---

## 0. The short version

Only ~100 lines are shareable today, and the reason is not that the rest is inherently server-side. It
is that in most modules the **rules** (validation, normalization, the URL grammar, dedupe, ordering,
op algebra) and the **I/O** (Supabase, LangChain, Dexie, Next) live in the same file, so the rules
inherit the I/O's imports and become unshareable by association.

Split each module into a **functional core** (pure, testable, no imports) and an **imperative shell**
(the Supabase/Dexie/Next call that uses it), and the shareable surface grows by ~7× without moving a
single secret or a single query off the server.

**Three of the six refactors below fix bugs or duplication that exist in the codebase right now** —
including one the code has already been bitten by and left a comment about. That is the real argument:
do these because the web app is better for them, and get Expo-readiness as a side effect.

**Do the whole thing inside the current single package, in a new `src/shared/` folder.** No workspace,
no Expo, no risk. When the monorepo move happens later, `src/shared/` becomes `packages/shared/src/`
with a `git mv` and nothing else. If Expo is never built, you still keep every fix.

---

## 1. The principle: functional core, imperative shell

The test from the migration note was "*could I fix a bug in this by deploying the web app alone?*"
That test is right for **behaviour**, and it is what keeps business logic on the server. But it is the
wrong test for **rules that a client must compute for itself**, because for those the alternative to
sharing is not "keep it on the server" — it is **two hand-written copies that drift**.

So the test refines into two questions, asked in order:

1. **Does the client need to compute this itself?** (To render a URL, to dedupe before a write, to
   work offline, to validate before sending.) If **no** → it stays server-side and the client asks
   over HTTP. This disqualifies almost everything.
2. If yes: **is it pure?** If yes → `shared`. If it is fused with I/O → **that fusion is the bug**;
   extract the pure part.

Concretely, the shape every refactor below produces:

```text
BEFORE                                  AFTER
lib/lesson-items.ts                     shared/items-query.ts     ← pure: parse/serialize/validate
  ├ types                               shared/item-types.ts      ← pure: the DTOs
  ├ SORT_COLUMNS whitelist              lib/lesson-items.ts       ← shell: buildQuery() + supabase
  ├ filter validation
  └ getServiceSupabase() query
```

The shell keeps its name, its exports, and its behaviour. Callers do not change. Only the file's
*internals* split, and a new pure module appears next to it.

### Why this does not contradict the migration note

That note argued to be strict about runtime code in `shared` because mobile ships on a slow release
train, so shared logic can't be hot-fixed. That argument is intact and still governs **behaviour**
(business rules, ownership enforcement, the jobs, agent resolution — all stay server-side, §5).

It does **not** govern **protocol**: a URL grammar, a normalization rule, an outbox op shape. Those
must be identical on both sides *simultaneously* or they are broken — so the slow-release risk exists
whether you share them or copy them, and copying adds silent drift on top. For that class, sharing is
strictly better. §4.2 is the proof: the two halves of one URL grammar already drifted inside a single
codebase.

---

## 2. The fusion, measured

Every `lib` module, with the pure rules it contains and the import that currently makes them
unshareable:

| Module | Pure rules living inside it | Fused with |
| --- | --- | --- |
| `lesson-items.ts` | `CEFR_LEVELS`, `ITEM_KINDS`, `UNLEVELED`, `SORT_COLUMNS` whitelist, `SORT_KEYS`, level-filter validation, all 5 DTOs | `getServiceSupabase()` |
| `lessons.ts` | `Lesson`/`LessonItem`/`LessonSession`/`NewLesson` DTOs, `embeddedTexts` projection, the linkWords dedupe rule | `getServiceSupabase()` |
| `words.ts` | `MAX_WORD_LENGTH`, `wordInputKey()`, `AddWordResult` status algebra | `getServiceSupabase()` |
| `word-details.ts` | `WordDetails`, `CURRENT_DETAILS_VERSION`, batch constants | `@langchain/anthropic`, service-role client, `zod` |
| `tutor-session.ts` | `MAX_LINES`, `MAX_LINE_CHARS`, the transcript sanitizer | `next/cache` |
| `sync/engine.ts` | dedupe rule, position assignment, `defaultLessonTitle` naming, outbox record construction, `MAX_ITEMS` | `dexie` (via `getDb()`), a Next server action |
| `sync/types.ts` | the whole outbox op algebra | *(nothing — already pure)* |
| `app/lesson-items/page.tsx` | `parseQuery()` — the URL grammar decoder | it is a React Server Component |
| `app/lesson-items/ItemsBrowser.tsx` | `hrefWith()` — the URL grammar **encoder**, the search predicate, `groupFacets()` | it is a client component |
| `app/lessons/actions.ts` | `MAX_ITEMS`, `MAX_FLUSH_RECORDS`, title cap, `opLessonId()` | `"use server"` |

Two things jump out of that table, and they are the two best reasons to do this work:

- **The URL grammar is implemented twice, in two files, in two directions** (`parseQuery` decodes,
  `hrefWith` encodes) — and neither is testable without a React renderer.
- **`MAX_ITEMS = 50` is declared twice** (`sync/engine.ts:15` and `app/lessons/actions.ts:12`), once
  for the client's optimistic write and once for the server's replay cap. Nothing keeps them equal.

---

## 3. Target: `src/shared/` (later `packages/shared/`)

```text
src/shared/
├── index.ts
├── tutor.ts            # MOVED from lib/tutor.ts — the wire contract (already shareable)
├── word-types.ts       # WordDetails, ItemKind, CefrLevel, CEFR_LEVELS, ITEM_KINDS   [R1]
├── lesson-types.ts     # Lesson, LessonItem, LessonSession, NewLesson, ItemRow, …    [R1]
├── items-query.ts      # parse / serialize / validate the /lesson-items URL grammar  [R2]
├── word-key.ts         # MAX_WORD_LENGTH, wordInputKey, dedupeKey                    [R3]
├── item-filter.ts      # search predicate, facet grouping, sort labels               [R4]
├── sync-ops.ts         # MOVED from lib/sync/types.ts + the op builders + limits     [R5]
├── transcript.ts       # MAX_LINES/MAX_LINE_CHARS + sanitizeTranscript               [R6]
└── api.ts              # route paths + response types (+ optional typed fetch)       [R7]
```

Roughly **700 lines, zero runtime dependencies**. The `dependencies: {}` rule from the migration note
still holds and is what keeps this honest: the moment something here needs `zod` or
`@supabase/supabase-js`, server code is sneaking in.

---

## 4. The refactors

Ordered by **value to the web app today**, not by Expo-readiness. Each is independently shippable.

### R1 — Split the types out of the data layer · **DONE 2026-08-09**

**Problem.** Every DTO lives in the module that queries it, so naming a type drags in the
service-role client. Three concrete symptoms in the code today:

- `lib/tutor.ts:6` — the file whose own header says *"client-safe … no server imports here"* — does
  `import type { WordDetails } from "./word-details"`, and `word-details.ts` imports LangChain, the
  service-role Supabase client, and zod. The `import type` erases at build, so nothing leaks at
  runtime, but the *only* client-safe module in `lib` nominally depends on the least client-safe one.
- `levels-prompt.ts` and `word-details-prompt.ts` are pure string builders. Both import
  `lesson-items.ts` — pulling the whole data layer — solely to name `ItemKind` / `CefrLevel`.
- `lessons.ts` imports `word-details.ts` for `WordDetails` alone.

**Done.** `src/shared/` now holds `tutor.ts` (moved from `lib/`), `word-types.ts`,
`lesson-types.ts`, `items-query.ts` and an `index.ts` barrel. `lib/` keeps every query and imports
the shapes.

Two decisions worth recording, both deviations from the sketch above:

- **`lib/tutor.ts` moved too**, rather than staying put. `lesson-types.ts` needs `TranscriptLine`
  and `TutorItem`, so leaving `tutor.ts` in `lib/` would have made `shared/` import from `lib/` on
  day one — violating the folder's own rule before it had one. The move is mechanical (6 importers).
- **No compatibility re-exports; all 14 call sites updated instead.** Re-exporting from `lib/` would
  have kept the diff smaller but left client components importing the module that imports
  `getServiceSupabase` — `ItemsBrowser.tsx` (`"use client"`) pulled `CEFR_LEVELS`/`ITEM_KINDS`/
  `UNLEVELED` as *values* from `lib/lesson-items.ts`, so the service-role data layer sat in a client
  component's import graph. That is half of what R1 exists to remove, so it was worth the extra
  files.

`SORT_KEYS` is now declared directly in `shared/items-query.ts` instead of being derived via
`Object.keys(SORT_COLUMNS)`. `SORT_COLUMNS` stays server-side in `lib/lesson-items.ts`, retyped from
a bare `as const` object to `Record<SortKey, string>` — so adding a sort key to the shared whitelist
without mapping it to a column is now a **type error** instead of an `undefined` reaching PostgREST.

**Boundary enforced, not remembered:** `eslint.config.js` gains a `no-restricted-imports` rule
scoped to `src/shared/**` that rejects `lib/` and `app/` imports. Verified by temporarily adding a
bad import and watching it fail, then reverting.

**Web-app win, realised:** `levels-prompt.ts` and `word-details-prompt.ts` — two pure string
builders — no longer transitively depend on Postgres; they now import one type from
`shared/word-types`. `tutor.ts` no longer nominally depends on LangChain + the service-role client.
`ItemsBrowser.tsx` no longer imports the data layer at all.

**Verified:** `pnpm typecheck`, `pnpm lint` (no issues), `pnpm build` — all green; route table
unchanged.

**Expo win:** every DTO the native screens render, for free.

### R2 — Extract the `/lesson-items` URL grammar · **DONE 2026-08-09**

**Problem — and this one already bit you.** The grammar
(`?level=C1&level=unleveled&fav=1&kind=sentence&unassigned=1&cat.topic=business&sort=practice&dir=desc&q=…`)
has a decoder in `app/lesson-items/page.tsx` (`parseQuery`) and an encoder in
`app/lesson-items/ItemsBrowser.tsx` (`hrefWith`), 400 lines apart, in two files that share no module.
`hrefWith` carries this comment:

> *"Must match the fallback in page.tsx (`"created"`), or the omitted value round-trips as a different
> sort: this said "practice" while the page defaulted to "created", which made "Times practiced"
> silently unselectable."*

That is the exact drift failure mode, already experienced, inside **one** codebase with **one**
release train. Adding a second client that must build the same URLs, on a release train measured in
days, makes it structural.

**Done.** `shared/items-query.ts` is now the whole grammar:

```ts
export const DEFAULT_SORT: SortKey;         // "created"  — read by BOTH directions
export const DEFAULT_DIR: SortDir;          // "desc"     — read by BOTH directions
export function defaultItemsQuery(): ItemsQuery;
export function parseItemsQuery(params: ItemsSearchParams): ItemsQuery;
export function parseSearchTerm(params: ItemsSearchParams): string;
export function serializeItemsQuery(query: ItemsQuery, search?: string): string;  // "" when default
export function isValidLevel(v: string): boolean;          // CEFR ∪ UNLEVELED
export function isValidSort(v: string | undefined): v is SortKey;
export function isValidKind(v: string | undefined): v is ItemKind;
```

`page.tsx` lost `parseQuery` and its `all`/`one` helpers (−36 lines) and now calls
`parseItemsQuery` / `parseSearchTerm`. `ItemsBrowser.hrefWith` went from 17 lines to 2. **The two
defaults are named once and both directions read those names**, which is what makes the drift
unrepresentable rather than merely unlikely.

`q` (free-text search) is deliberately **not** part of `ItemsQuery` — filters and sort go to
Postgres, search filters the loaded list in memory. It gets its own `parseSearchTerm` /
`serializeItemsQuery(query, search)` parameter so the split stays explicit.

**Verified, not asserted.** `pnpm check:items-query` (new; `scripts/check-items-query.ts`, run via
the already-present `tsx`) exhaustively cross-products every field — 4 level sets × fav × 4 kinds ×
unassigned × 3 category sets × 7 sorts × 2 dirs × 4 search terms = **10,752 round-trips**, all exact.
To confirm the check has teeth rather than passing vacuously, the original bug was temporarily
reintroduced (encoder omitting `sort` at `"practice"` instead of `DEFAULT_SORT`): **1,537 failures**,
the first reading `sent sort:"practice" → got sort:"created"` — the historical symptom exactly.

That script is a **stopgap, not a test suite**: the repo has no test runner, and adding one (vitest)
is a separate decision. It needs no new dependency and folds into a real test file the day a runner
lands.

**Web-app win, realised:** the security-relevant whitelists (`isValidLevel` / `isValidSort` /
`isValidKind` — what stops arbitrary strings reaching PostgREST) are no longer inline predicates
inside a page component, and the round-trip is now a checked property.

**Expo win:** the native list screen builds identical URLs without reimplementing the grammar.

### R3 — One word-normalization rule · **DONE 2026-08-09**

**Problem.** There are **three** normalizations of the same concept, and one divergence is documented
as a known hazard:

| Where | Rule |
| --- | --- |
| `lib/words.ts` `wordInputKey()` | `trim()` + cap at `MAX_WORD_LENGTH` |
| `sync/engine.ts` `addItemsLocal()` | `trim().toLowerCase()` |
| Postgres `words_set_norm_key` | unaccent + NFKC (**the real identity**) |

`lib/lessons.ts` `linkWords` spells the consequence out: *"The client can't prevent this for us:
`addItemsLocal` dedupes with `text.trim().toLowerCase()`, so "Don't" and "dont" reach here as two
texts and one word."* The server then has to defend itself against its own client with an
extra `linked` set and a comment explaining why the batch would otherwise be rejected wholesale.

**Done.** `shared/word-key.ts` owns `MAX_WORD_LENGTH`, `wordInputKey()` and `clientDedupeKey()`.
`lib/words.ts`, `lib/lessons.ts` and `lib/sync/engine.ts` all import it; the raw
`text.trim().toLowerCase()` in `addItemsLocal` is gone.

**The invariant is now written down and, more importantly, checked.** The file states the rule any
future change must satisfy:

```text
clientDedupeKey(a) === clientDedupeKey(b)
    ⟹  norm_key(wordInputKey(a)) === norm_key(wordInputKey(b))
```

— the client may only ever merge **less** aggressively than Postgres, never more. Merging less is
harmless (the server's `linked` guard skips the duplicate, the mirror self-corrects on the next
`seedLessonItems`); merging more would silently drop a word the learner typed, which is not
recoverable. That asymmetry is exactly why the `linked` set in `linkWords` is load-bearing, and
its comment now says so instead of describing the old divergence.

**Verified against the live database, and the check caught a real mistake.** A read-only script
called the actual `lesson_item_norm_key()` on 528 pairs of adversarial samples (smart quotes,
accents, ligatures, edge punctuation, whitespace runs, the 500-char boundary). The first run
reported **1 violation** — `"x"×501` vs `"x"×500+"y"`. The code was fine; the *stated invariant*
was wrong. `resolveWords` sends `texts.map(wordInputKey)` to the RPC, so Postgres never sees raw
text past `MAX_WORD_LENGTH`; the invariant has to be stated over the capped text. Restated and
re-run: **0 violations**, plus 17 cases in the intended safe direction (Postgres merges
`"Don't"`/`"don’t"` and `"café"`/`"cafe"`; the client does not).

**One deliberate behaviour change:** `clientDedupeKey` is built on `wordInputKey`, so it now
includes the 500-char cap the old `trim().toLowerCase()` lacked. Without it, two strings differing
only past character 500 are one word on the server and two in the mirror. `createLessonLocal` also
applies `wordInputKey` now (it previously stored raw keystrokes) and queues the normalized text, so
the mirror and the outbox agree with what the server will store.

**Deliberately NOT done:** making the client key a closer approximation of Postgres (NFKC + smart
punctuation + `NFD`/`\p{Diacritic}` accent stripping). It would remove a real if minor glitch —
typing "Don't" and "dont" into one lesson shows two rows until the next reseed drops one — but the
failure mode of getting it slightly *too* aggressive is silently discarding a word, which is far
worse than the glitch. If it is ever done, the invariant above is the acceptance test and the live
check is the harness.

**Deferred to R5:** `createLessonLocal` still does not dedupe within its batch while `addItemsLocal`
does. Same glitch, and the fix belongs with `buildAddItemsOp` where both paths converge.

**Web-app win, realised:** three normalizations became two, and the remaining divergence is
intentional, documented, and machine-checked rather than an accident waiting to be "cleaned up".

**Expo win:** the native add-word path cannot invent a fourth rule.

### R4 — Lift the list-view logic out of the component · **DONE 2026-08-09**

**Problem.** `ItemsBrowser.tsx` holds pure logic mixed into a 483-line client component: the search
predicate (`text.toLowerCase().includes(needle)`), `groupFacets()`, and the `SORT_LABELS` /
`SORT_OPTIONS` tables. None is testable without a renderer.

**Done**, as `shared/item-list.ts` rather than the sketched `item-filter.ts` — two of its three
exports aren't filtering, so the name would have been wrong on arrival. It holds `searchItems`,
`groupFacets`, `SORT_LABELS` and `sortChoices()`. `ItemsBrowser.tsx` went 483 → 448 lines and its
search collapsed to `useMemo(() => searchItems(items, search), [items, search])`.

`SORT_OPTIONS` now derives from `sortChoices()` (i.e. from `SORT_KEYS`, the whitelist) instead of
`Object.keys(SORT_LABELS)` — the options offered are the keys the parser accepts, by construction
rather than by coincidence.

**On putting `SORT_LABELS` in the pure core:** it is display copy, not a rule, which is a smell.
It earns its place only because it is the single point where a `SortKey` is humanized, and a
per-client copy would drift from the keys exactly as the URL defaults did. The file says so, and
says what happens when localization arrives (the map becomes key→message-id and the strings move
to catalogues).

**The testability win was made real rather than left aspirational.** `pnpm check:items-query`
became **`pnpm check:shared`** (`scripts/check-shared.ts`), now covering the URL round-trip plus
the two `item-list` properties that could plausibly break:

- `searchItems` returns the **input array identity** for an empty/whitespace term. This is load-
  bearing: `visible` feeds a `useMemo` whose referential identity decides whether the list
  re-renders, so a defensive `[...items]` would silently defeat it. Verified by introducing exactly
  that change — 2 failures — then reverting.
- `groupFacets` preserves the server's ordering (`listItemFacets` orders by name, then value).

A third assertion pins a **documented limitation** rather than a guarantee: searching `"cafe"` does
*not* match `"café"`, because search compares raw `text` while Postgres considers them one word
(`norm_key`). Widening it to test `norm_key` too is a one-line change, but it is a behaviour change;
the assertion fails loudly if someone makes it, so it has to be deliberate.

**Web-app win, realised:** the in-memory search is a documented *product* decision (search filters
client-side, filters go through the URL) and is now a named, checked function instead of an inline
`useMemo` predicate.

**Expo win:** identical search behaviour on the native list, which matters because the two surfaces
would otherwise feel subtly different for the same query.

### R5 — A storage-agnostic sync core · **stage 1 DONE 2026-08-09 · stage 2 still deferred**

**Problem.** `sync/engine.ts` is ~90% pure rules wrapped in Dexie transactions: the dedupe, the
position assignment (`pos = max(existing) + 1`), the `defaultLessonTitle` algorithm
(`dd-mm-yyyy`, then ` 1`, ` 2`, … deduped against the mirror), the outbox record construction, the
`seq` monotonicity, the flush concurrency guard, and the "apply optimistically, queue the intent"
invariant. All of it is bound to IndexedDB by `getDb()`, and `engine.ts` additionally imports a Next
server action directly (`../../app/lessons/actions`) — so the *sync layer depends on the app layer*,
backwards from every other dependency in the repo.

**Do — in two stages, and stop after stage 1 unless you actually want native offline.**

*Stage 1 — **DONE**.* `shared/sync-ops.ts` replaced `lib/sync/types.ts` (deleted) and now holds the
op algebra, the limits, and the builders:

```ts
export const MAX_ITEMS = 50;          // was declared TWICE — engine.ts and actions.ts
export const MAX_FLUSH_RECORDS = 500;
export const MAX_LESSON_TITLE = 120;  // the literal 120 appeared in THREE files
export function planNewItems(texts, existing, newId): PlannedItem[];   // the one dedupe+position rule
export function buildAddItemsOp(lessonId, texts, existing, newId): AddItemsOp | null;
export function buildCreateLessonOp(lessonId, title, texts, newId): CreateLessonOp;
export function normalizeLessonTitle(raw): string;
export function nextLessonTitle(taken: ReadonlySet<string>, date: Date): string;
export function opLessonId(op: OutboxOp): string;   // was private in actions.ts
```

**Why the duplication existed, structurally:** `lib/sync/engine.ts` is browser-only — it reaches for
`getDb()` — so a `"use server"` Server Action physically *could not* import `MAX_ITEMS` from it and
had to redeclare it. Moving the constant to a module neither side owns is what actually fixes that,
rather than discipline.

**Both write paths now build their mirror rows FROM the op**, so the optimistic view and the queued
intent cannot disagree about what was written. `addItemsLocal` went from an inline dedupe/position
loop inside a Dexie transaction to `read existing → buildAddItemsOp → write`.

**`newId` is a parameter, not `crypto.randomUUID()`.** Two reasons: React Native has no
`crypto.randomUUID` without a polyfill, so an ambient global would have made the module unportable;
and a test can pass a counter and get deterministic output — which is what let the checks below
assert exact ids. Same reasoning for `nextLessonTitle` taking a `Date` rather than reading the clock.

**The R3-deferred fix landed here:** `createLessonLocal` now dedupes through the same `planNewItems`
rule that `addItemsLocal` uses. Creating a lesson from "novel" and "Novel" used to show two rows
until the next reseed silently dropped one. Its signature changed from `{id, title, items: {id,
text}[]}` to `{id, title, texts: string[]}` — item ids are minted inside the engine now, which also
deleted the duplicated `crypto.randomUUID()`-per-text and `.slice(0, 120)` from both call sites.

**Verified.** `pnpm check:shared` gained the sync-ops properties — normalization, blank-dropping,
in-batch and against-existing dedupe, `null` when nothing survives, title capping, the
`nextLessonTitle` sequence, and `opLessonId` over all four op kinds. The one worth naming: **positions
continue from `max(existing.position) + 1`, not from the row count** — a removed item leaves a gap,
and reusing a position would collide. Confirmed the check catches it by swapping in
`existing.length - 1` (1 failure: expected 6, got 2), then reverting.

One assertion deliberately pins the *asymmetry* rather than a guarantee: "Don't" and "dont" stay two
items here and become one on the server. That is `clientDedupeKey` being weaker than `norm_key` by
design (R3), not a gap in this rule — if it ever becomes one item, the invariant changed.

*Stage 2 — **DONE 2026-08-09**, un-deferred on request.*

**The sketch above was wrong, and finding out why was most of the value.** An ~8-method write-path
interface would have covered about a third of the coupling. Three components
(`LessonsList`, `LessonItemsView`, `OfflineApp`) held **inline Dexie query expressions** behind
`useLiveQuery`, and `session-journal.ts` talked to `getDb()` directly. Shipping the sketch would
have produced an interface that *looks* portable while the UI stayed welded to IndexedDB — worse
than no abstraction, because it advertises a property it doesn't have.

What was actually built:

| File | Role |
| --- | --- |
| `shared/mirror-store.ts` | The contract: `MirrorOps` (17 operations), `MirrorStore` (adds `transact` + `journal`), and the mirrored shapes (`MirrorLesson`, `MirrorItem`, `SessionJournalEntry`, moved out of `db.ts`). |
| `lib/sync/dexie-store.ts` | The browser implementation. |
| `lib/sync/db.ts` | Dexie schema only. |
| `lib/sync/live.ts` | The three reactive hooks — `useMirrorLessons`, `useMirrorLesson`, `useMirrorItems`. |

**Reactivity is deliberately NOT abstracted.** Dexie's `liveQuery` hooks IndexedDB's own mutation
events; a SQLite adapter needs its own change notification, and there is no honest generic version.
So the subscription model stays per-platform, confined to `live.ts` behind named hooks. **The port
surface is now exactly one `MirrorStore` implementation plus three hooks** — stated in the contract's
header rather than left for someone to discover.

Dexie is now imported in **three files** (`db.ts`, `dexie-store.ts`, `live.ts`). `engine.ts`,
`mirror.ts`, `session-journal.ts` and every component are storage-agnostic.

**Two behaviour changes, both fixes.** `ensureOwner` now wipes and re-stamps the owner in ONE
transaction — previously a failure between the two steps left an emptied mirror still labelled with
the *previous* learner, so the next sign-in would skip the guard entirely (this is the shared-device
protection). That required `clearAll` on `MirrorOps` rather than only on the store.
`removeItemLocal` now checks the item belongs to the lesson it was called for, rather than deleting
by bare id.

**Runtime-verified, not just compiled.** A refactor of the offline write path that only typechecks
is not verified, so it was driven in a real browser against real IndexedDB. With the client pinned
offline (`navigator.onLine` overridden, so `doFlush` no-ops and nothing reached Supabase), creating
a lesson from `"  alpha  " / "" / "Alpha" / "beta"` produced: mirror lesson `["alpha","beta"]`, item
rows at positions 0 and 1, and one outbox `createLesson` record at `seq` 1 carrying exactly the same
items — i.e. `wordInputKey` trimming, `clientDedupeKey` deduping, blank-dropping, positioning,
`transact` atomicity and `appendOutbox` sequencing all confirmed together. The live query rendered a
row injected into IndexedDB from outside React. Probe rows and the queued op were deleted afterwards
and the list confirmed back to its real 11 lessons, no console errors.

**Not exercised:** `addItemsLocal`, `removeItemLocal`, `deleteLessonLocal` and a real server flush —
all of which write to the production Supabase, which is not mine to do unasked. They share the same
`transact`/`appendOutbox` machinery as the verified create path, so the structural risk is covered,
but a click-through of add / remove / delete-lesson / go-offline-and-reconnect is still worth doing
before this ships.

**Web-app win (stage 1), realised:** `MAX_ITEMS` is declared once instead of twice and the literal
`120` is gone from all three files; the naming, dedupe and position algorithms are exercisable
without IndexedDB, a browser, or a server; `opLessonId` is no longer private to a `"use server"`
file; and the create/add paths agree on what they write.

**Expo win:** the migration note explicitly says offline "does not cross the boundary" and the WebView
keeps Dexie — which is correct for the hybrid shell. Stage 2 is what would make a *phase-2* native
list screen possible without rewriting the sync semantics. **Do not do stage 2 speculatively**: an
interface with one implementation is a cost, not an asset. Do it the day a second implementation is
actually being written.

### R6 — Transcript sanitation as a pure function · **DONE 2026-08-09**

**Problem.** `lib/tutor-session.ts` holds `MAX_LINES = 500`, `MAX_LINE_CHARS = 4000`, and the
role/type filter — but the file imports `next/cache`, so the rules can't leave. Three writers already
converge on that row (server action, beacon route, post-call webhook); a fourth (native) is coming.

**Done**, in `shared/tutor.ts` rather than a new `shared/transcript.ts` — that module already owns
`TranscriptLine`, `formatResumeContext` and the hidden-kickoff filter, so a 40-line sibling would
have split one concept across two files. It exports `MAX_TRANSCRIPT_LINES`,
`MAX_TRANSCRIPT_LINE_CHARS` and `sanitizeTranscript(lines: unknown)`.

`sanitizeTranscript` takes `unknown` on purpose: two of its callers are handling a parsed request
body. **The server still validates everything it receives and still re-derives the owner from the
session — sharing the function moved no trust boundary.**

**The extraction exposed a real bug, which is the actual value here.** The doc said "three writers
already converge on that row". Reading them showed only *two* applied the caps: the **post-call
webhook wrote an entirely unbounded transcript** into the same `conversation_id` row that the
server action and the beacon cap at 500 lines / 4000 chars. A long conversation therefore stored a
different amount of text depending on which writer landed last. The webhook now runs its domain
filter (drop empty turns and the hidden kickoff) and then the same `sanitizeTranscript`. Its
`timeInCallSecs` — the one field only it produces — is preserved by the sanitizer rather than
dropped.

**The beacon now trims before sending** (the stated Expo win, and it pays off on web too):
`sendBeacon` has a payload ceiling and fires during page teardown on a possibly-cellular link, so
shipping lines the server would only discard risked losing the *whole* beacon.

**Verified.** `pnpm check:shared` gained the transcript properties: non-array input, malformed-turn
rejection (unknown role, non-string text, `null`), `timeInCallSecs` preservation, the per-line
character cap, and the line-count cap. One assertion pins a **documented ordering quirk rather than
a guarantee** — the count cap applies *before* the validity filter, so malformed entries inside the
first 500 consume budget. That is the original behaviour, preserved deliberately; the assertion
makes changing it a decision rather than a tidy-up. Confirmed the checks bite by removing the cap
(2 failures: `line count not capped (525)`), then reverting.

**Web-app win, realised:** the caps are named once and checked, and the third writer stopped
bypassing them.

### R7 — Name the API contract · **DONE 2026-08-09**

**Problem.** Route paths and response shapes are implicit. Mobile will hard-code
`/api/words-agent/signed-url` and re-type `{ signedUrl, version, appEnv }` by hand.

**Done.** `shared/api.ts` holds `API_ROUTES`, `signedUrlPath(version?)`, the response types
(`SignedUrlResponse`, `LessonSessionResponse`, `HealthResponse`, `HealthCheck`), the `ApiErrorBody`
envelope, and two guards (`isApiError`, `isSignedUrlResponse`).

**Both ends now reference the declaration rather than describing it.** `lib/http.ts` builds its
envelope through `ApiErrorBody`; all three routes assign their body to the declared type before
returning it, so a drifted field is a typecheck failure at the route. On the client, `LessonTutor`
had the signed-URL response **re-declared inline** (`{ signedUrl?, appEnv?, error? }`) — it now
imports the type and narrows with the guard, and `session-journal.ts` takes its beacon path from
`API_ROUTES` instead of a string literal.

**One behaviour change, and it is a real fix.** The client read `body.appEnv ?? "prod"`. `app_env`
is the dynamic variable the **post-call webhook routes on**, so a response missing it would have
silently filed a *dev* session under **prod**. `isSignedUrlResponse` now requires `appEnv`, and the
fallback is gone: a malformed response surfaces as an error instead of quietly mis-routing. The
check suite pins this — `{ signedUrl, version }` without `appEnv` must be rejected.

**Verified.** `pnpm check:shared` gained the api properties: `signedUrlPath` with and without a
version (including URI-encoding), `isApiError` against seven non-envelopes, and
`isSignedUrlResponse` against five malformed bodies. Confirmed they bite by dropping the `appEnv`
requirement — 1 failure, exactly the mis-routing case — then reverting. Also smoke-tested the live
routes: `/api/health` returns the `HealthResponse` shape and an unknown tutor version returns the
`ApiErrorBody` envelope, both matching the declared types.

**Web-app win, realised:** the inline re-declaration is gone, route renames are typecheck failures,
and the `app_env` mis-routing hazard is closed.

**Expo win:** a native `api.ts` shrinks to a base URL plus a Bearer header.

---

## 5. What stays server-side — permanently

Unchanged from the migration note's §3.3, and none of it is affected by the extractions above:

- **Secrets and everything that touches them** — `supabase/server.ts` (service-role),
  `llm.ts` + `ANTHROPIC_API_KEY`, `config.ts` (ElevenLabs key, webhook secret), `langsmith-trace.ts`.
- **Ownership enforcement** — every `owner_id` filter/stamp. The standing convention is "ownership is
  enforced in code; RLS is defense-in-depth". Moving enforcement into a binary you can't hot-fix
  silently makes RLS your only line. R1–R7 extract *rules*, never *gates*.
- **The jobs** — `levels.ts`, `word-details.ts`. LLM calls with a key.
- **Framework plumbing** — `http.ts` (`next/server`), the `revalidatePath` in `tutor-session.ts`,
  `proxy.ts`, `auth0.ts`.
- **Agent resolution** — `agent-registry.ts` reads `agents.lock.json`. Serve it over HTTP
  (`/api/agent-versions`); never compile agent ids into an app binary.
- **All Supabase query construction** — the extractions leave `listItems`, `getLesson`, `linkWords`
  etc. exactly where they are. Only the whitelists and DTOs they *use* move.
- **`format-date.ts`** — it exists to fix a hydration mismatch (React #418) that has no RN analogue;
  sharing it would export a UTC-pinned `en-US` format to a platform where the user's locale is the
  right answer.
- **`asset-version.ts`** — service-worker cache busting; no meaning natively.

---

## 6. Sequencing — why this goes first, and how it stays zero-risk

**Do all of it in the current repo, in the current single package, in `src/shared/`.**

- No workspace, no Metro, no package manager change, no Expo, no deploy change. Just files moving
  inside `src/`, with re-exports so no call site breaks.
- Each refactor is one small PR with a mechanical diff and a clear web-app justification.
- When the monorepo move happens, step 3 of the migration note becomes
  `git mv src/shared packages/shared/src` — the extraction work is already done and already verified
  in production.
- **If the Expo plan is dropped** (decision #4 of `docs/2026-08-07-Expo-migration.md` — telephony
  might be enough), you keep every fix: one URL grammar, one `MAX_ITEMS`, one word-key rule,
  testable prompt builders, a testable sync core. Nothing is wasted.

One convention to adopt with the folder, or it will not hold: **`src/shared/` may not import from
`src/lib/`, `src/app/`, or any package.** Dependencies point inward only. That single rule is what
keeps the folder liftable later; it is worth an ESLint `no-restricted-imports` rule on the path so it
is enforced rather than remembered.

| # | Refactor | Effort | Fixes something today? | Blocking for Expo? |
| --- | --- | --- | --- | --- |
| ~~R1~~ | ~~Types out of the data layer~~ | **done** | **yes** — prompt builders stop depending on Postgres | yes |
| ~~R2~~ | ~~URL grammar (`items-query.ts`)~~ | **done** | **yes** — a drift bug already hit | for the list screen |
| ~~R3~~ | ~~One word-key rule~~ | **done** | **yes** — 3 normalizations, 1 documented divergence | for the add-word path |
| ~~R4~~ | ~~List logic out of the component~~ | **done** | partly — testability | for the list screen |
| ~~R5~~ | ~~Sync core, stage 1~~ | **done** | **yes** — `MAX_ITEMS` declared twice | no |
| ~~R5~~ | ~~Sync core, stage 2 (`MirrorStore`)~~ | **done** | yes — `ensureOwner` atomicity | only for native offline |
| ~~R6~~ | ~~`sanitizeTranscript`~~ | **done** | **yes** — the webhook was writing uncapped | yes (4th writer) |
| ~~R7~~ | ~~API contract types~~ | **done** | **yes** — `app_env` could mis-route | yes |
| | **All seven complete, 2026-08-09** | | | |

Suggested order: **R1 → R6 → R3 → R2 → R4 → R7 → R5 stage 1**, deferring R5 stage 2 indefinitely.
R1 first because it unblocks the others; R6 and R3 next because they are small and each removes a
real hazard; R2 is the largest single win and wants the types already in place.

Against the migration note's plan, this inserts ~4 days before "Step 2 — workspace restructure", and
takes ~1 day back out of it (step 3, `packages/shared` extraction, is already done). **Net ~+3 days,
spent entirely on changes that stand on their own.**

---

## 7. Anti-patterns to avoid on the way

- **Do not build a shared UI layer.** `Button` / `Select` / `Tooltip` / `Checkbox` are
  `@base-ui/react` DOM components. A "cross-platform component library" is a project, not a refactor,
  and the migration note's whole premise is a WebView shell — the native app needs *one* screen.
- **Do not share zod schemas casually.** Tempting for the API envelope, but it puts a runtime
  dependency in a package whose emptiness is the review rule. If you want runtime response validation
  on mobile, make it a deliberate, argued `peerDependency` — not a drift.
- **Do not extract an interface with one implementation.** This was the stated reason to defer R5
  stage 2. It was built anyway, on request — and the experience refined the rule rather than
  refuting it: the *cost* was real (a 17-method contract with one implementation), but the exercise
  of writing the contract is what exposed that the UI itself was welded to Dexie, and it caught the
  `ensureOwner` atomicity bug. The sharper rule: **an interface with one implementation is a cost;
  the act of trying to state the interface is often worth it anyway** — just be ready to discover
  that the real coupling is somewhere other than where you planned to abstract.
- **Do not move the gates.** The extractions move whitelists, DTOs, formatters and dedupe rules. Every
  `owner_id` filter, every "the lesson must belong to the caller" check, and every re-derivation of
  the owner from the session stays exactly where it is. If a diff in this series moves a check, it is
  the wrong diff.
- **Do not let `shared` grow by default.** The two-question test in §1 is the gate. "It's pure, so it
  might as well go in shared" is how a shared package becomes a second app.

---

## Sources

- The codebase itself — `src/lib/*`, `src/app/lesson-items/{page.tsx,ItemsBrowser.tsx}`,
  `src/app/lessons/actions.ts`, `src/lib/sync/*`. Every duplication and divergence cited above is
  quoted from a comment or a declaration in the tree as of 2026-08-09.
- `docs/2026-08-09-expo-repo-structure-migration.md` — the workspace layout this feeds into, and the
  sharing test this note refines.
- `docs/2026-08-07-Expo-migration.md` — the native plan; decision #4 (telephony) is the reason this
  note is written to be worth doing on its own.
- `docs/2026-07-04-offline-support-and-sync.md` — the outbox/mirror design R5 must preserve.
- `docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md` — the URL-as-filter-state
  design R2 formalizes.
- `docs/2026-07-16-add-word-on-lesson-items-page.md` — why `norm_key` identity is Postgres's, which
  is what R3 must not obscure.
