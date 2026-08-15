# S5 — lessons list and lesson detail · research

**Date:** created 2026-08-13 · researched 2026-08-14 · built 2026-08-15 · **Status:** ✅ **GATE PASSED
(2026-08-15)** — create, add, remove and delete all work from the phone and land on the server.

**Parents:** [build plan → S5](./2026-08-12-expo-build-plan.md) ·
[creation doc §3.2, §3.3, §5, §6](./2026-08-12-expo-app-creation.md) ·
[S4 research](./2026-08-13-expo-s4-tutor-screen.md).

**In one line:** S5 is the first stage whose hard part is on the **server**, not the phone. The three
screens are ordinary RN; the thing that decides whether S5 ships something maintainable is that the
one write route reuses the op algebra honestly — including the part where `applied` does not mean
"it worked".

---

## 0. What the research settled

Every question the placeholder asked, answered. Detail follows in the section named.

| #   | Question                                                     | Answer                                                                                                                                                                          | §         |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | `GET /api/v2/lessons` — pagination, and what a row needs     | **No pagination.** `LessonListItem[]` verbatim — it already carries `items` (texts) and `sessionCount`, which is exactly what the web row renders.                              | §5.1, D53 |
| 2   | The `/api/v2/sync/flush` handler                             | **Cannot call `flushOutbox`.** That Server Action re-derives the owner from the **cookie** session, so a Bearer caller gets `{applied: []}` and a silent no-op. Extract `applyOps` to `lib/`. | §5.3, D45 |
| 3   | How a rejected op surfaces in the UI                         | It doesn't, and it must not be made to. **`applied` means "stop retrying", not "it worked"** — the client reconciles by refetching, which is the S4 convention already.          | §3.2, D47 |
| 4   | Optimistic UI without the mirror — what replaces `planNewItems`' guarantee? | **Nothing needs to.** The guarantee was never the mirror: it was *build the view from the op*. React state is a mirror with a shorter lifetime.                    | §3.3, D48 |
| 5   | Item history — a field on `GET /api/v2/lessons/:id` or its own route? | **Its own route**, and not for the reason the placeholder expected: `LessonDetail` **carries no item ids at all**, so the editing screen cannot remove an item without it. | §5.2, D44 |
| 6   | Delete-lesson semantics + the confirm pattern on native      | Soft delete, words survive, already correct in `lib/`. `Alert.alert` with a `destructive` button — first-party, no port of `ConfirmDialog`.                                       | §6.3, D52 |
| 7   | Add-word from a lesson — the `resolve_words` round trip      | **Already solved and already server-side.** `upsertLessonItems` → `linkWords` → `resolveWords`. The client sends texts; `clientDedupeKey` only trims the optimistic view.        | §3.3      |
| 8   | Refetch/invalidation after a write — no `revalidatePath`     | `load()` again, exactly as S4's `persistSession` does. `revalidatePath` stays web-side and costs the native client nothing (both web pages are `force-dynamic`).                 | §5.3      |
| 9   | ⚠️ Not asked, and the thing that will confuse the gate       | **A lesson deleted on the phone does not disappear from an already-open web browser.** `seedLessons` is upsert-only by design. It is a web-side property, not a native bug.      | §8, §9    |
| 10  | ⚠️ Not asked — where do client-minted ids come from?         | `crypto.randomUUID` **does** exist at runtime, but only as a `Math.random()` shim installed as a side effect of LiveKit's `registerGlobals()`. Not something to build primary keys on. | §6.4, D49 |

**One correction to an earlier doc.** The creation doc's §3.3 table gives
`GET /api/v2/lessons/:id` as `getLesson` + `listLessonSessions` + **`listLessonItemHistory`**, all in
one response. S4's D30 split the history out to S5 on the grounds that it is display data for the
editing screen. That reasoning holds, but it undersold the split: the history query is not a nicety,
it is **the only source of item ids in the entire read surface** (§5.2). D44 makes it a route rather
than a field, so the tutor's first paint stays lean and the editing screen gets what it actually needs.

---

## 1. Inputs from S4 — filled in

All six handover items arrived. Nothing here is invented; S5 copies.

| Input                       | What S4 settled                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data fetching               | `Promise.all` of `apiFetch` calls inside one `useCallback` `load()`, re-called after a write. **No query library.** Keep it.                     |
| Auth headers                | `apiFetch(path, accessToken)` where `accessToken` wraps `getCredentials()` **per request** (never cached — that is what renews the token).       |
| Navigation                  | `expo-router`, `typedRoutes` on. `index.tsx` (launcher), `lessons/[id].tsx`, `auth.tsx`, `probe.tsx`.                                            |
| D3 in practice              | RN primitives own layout and scrolling; `@expo/ui/swift-ui` owns discrete controls inside **sized** `Host`s. `matchContents` never on a scroll axis. |
| Error / loading             | One `loadError` string + a retry `Pressable`; `ActivityIndicator` while the payload is null.                                                     |
| Dynamic route pattern       | `withBearer<{ params: Promise<{ id: string }> }>`, 404-for-not-yours, `dynamic = "force-dynamic"`, `OPTIONS = preflight`.                        |

Two carry-forwards, both handled:

- ⚠️ **The hard-coded `DEV_LESSON_ID` in `index.tsx`** — deleted at S5 (D50). It is one `Link`.
- ⚠️ **`sendContextualUpdate` is reported working, not measured.** S5 has no resume path and must not
  grow one to settle it (D54). It stays a named known-unknown.

---

## 2. The port inventory

What S5 replaces, read fresh on 2026-08-14. **~440 lines of web UI → three RN screens**, and the
useful observation is how little of it is about lessons.

| Web file                                | LOC | What happens to it                                                                                                     |
| --------------------------------------- | --- | ---------------------------------------------------------------------------------------------------------------------- |
| `app/LessonsList.tsx`                   | 105 | **~35 lines survive** as a `FlatList` + row. The rest is mirror seeding, `ConfirmDialog` orchestration, `Tooltip`.       |
| `app/NewLessonForm.tsx`                 |  98 | **~30 lines survive.** Base UI `Form`/`Field`, the offline branch and `nav-progress` all go.                            |
| `app/lessons/[id]/LessonItemsView.tsx`  | 128 | **~45 lines survive.** Same story: the mirror seeding and `Field` plumbing are the bulk.                                |
| `app/ConfirmDialog.tsx`                 |  73 | **Deleted, not ported** — `Alert.alert` is the platform answer (D52).                                                   |
| `app/lessons/[id]/page.tsx` → `ItemChanges` | ~40 | **Ports nearly verbatim.** It is a pure derivation over `LessonItem[]`; only the JSX changes.                       |
| `app/lessons/page.tsx`                  |  37 | Server component. Becomes `GET /api/v2/lessons` + a screen.                                                            |

**The pattern: the largest single category of code being deleted is mirror seeding**, and the second
largest is Base UI. Neither is lesson logic. The lesson logic — normalize, dedupe, position, title —
is already in `packages/shared/src/sync-ops.ts` (183 lines) and is imported unchanged by both apps.
That is the shareable-core refactor paying out for the first time on a second client.

`ItemChanges` porting verbatim is worth noticing for a different reason: it is the one piece of
display logic here that is *derived* rather than fetched, and it is derived from the same array the
editing list is (§5.2). One route feeds both.

---

## 3. The write path — the one part that is not mechanical

### 3.1 The flush contract, read fresh

`flushOutbox` (`apps/web/src/app/lessons/actions.ts:70`) does five things:

1. `getOwnerId()` — **from the cookie session**;
2. sort by `seq`, cap at `MAX_FLUSH_RECORDS`, apply each op through the private `applyOp`;
3. **break at the first throw** (later ops may depend on earlier ones — add-items after create-lesson);
4. `revalidatePath` for the touched pages;
5. `after()` the level and enrichment fast paths, once per flush rather than once per record.

Steps 2, 3 and 5 are exactly what the native client needs. Step 1 is fatal to it and step 4 is
meaningless to it. That asymmetry is the whole design of §5.3.

### 3.2 What `applied` actually means

This is the finding that changes how the screens are written, so it is worth being exact.

`applyOp` calls the owner-scoped `lib/lessons.ts` functions, and **those functions report "I did
nothing" by returning, not by throwing**:

- `upsertLessonItems` returns `0` for a foreign or missing lesson, and for a batch whose every text
  was already linked (`linkWords`' `linked` guard);
- `removeLessonItem` returns `false` for an item that is not yours or already removed;
- `deleteLesson` returns `false` for a lesson already soft-deleted;
- `createLesson` upserts `ON CONFLICT (id) DO NOTHING` and returns the id regardless.

`applyOp` discards all four return values. So a record lands in `applied` whenever it did not throw —
which includes every one of those no-ops.

**For the outbox this is correct and must not be changed.** `applied` answers exactly one question:
*may the client drop this record?* For a no-op the answer is yes — retrying will never help. Making
it mean anything else would break the idempotent-replay property the whole offline design rests on.

**For an online single-op client it means `applied` is not a success signal**, and a UI that treats it
as one will cheerfully report "3 words added" after adding zero duplicates. The honest reading:

| `applied` for a single-op batch | Means                                            | UI does                                     |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `["<record id>"]`               | the server accepted it; the effect may be a no-op | **refetch** — the server's list is the truth |
| `[]`                            | the op threw (network, Postgres, a real fault)    | keep the op, roll the optimistic view back, offer Retry |

The refetch is not an extra concession; it is S4's convention (`persistSession` ends with
`void load()`). What it buys is that the client never has to model *why* an op was a no-op — a
duplicate word simply fails to appear, which is the correct outcome and needs no copy.

### 3.3 Optimistic state without a mirror

The placeholder asked what stands in for `planNewItems`' guarantee that the optimistic view and the
queued intent cannot disagree. Reading `engine.ts` answers it: **the guarantee was never the mirror.**

```ts
// engine.ts — createLessonLocal
const op = buildCreateLessonOp(input.id, input.title, input.texts, () => crypto.randomUUID());
const items: MirrorItem[] = op.lesson.items.map(/* … built FROM the op … */);
```

The mirror rows are derived from the op. Dexie's role is durability, not consistency. On native, build
the same rows from the same op and hold them in React state:

```ts
const op = buildAddItemsOp(lessonId, texts, existing, newId);
if (!op) return;                       // every text was blank or a duplicate
setItems((prev) => [...prev, ...op.items.map(/* … */)]);   // from the op
await postFlush(op);                                        // the same op
```

Two properties fall out, both worth stating because they will look like bugs otherwise:

- **The client may show fewer words than the learner typed.** `planNewItems` drops blanks and
  `clientDedupeKey` duplicates before the op exists. That is the rule working.
- **The client may show more words than the server keeps.** `clientDedupeKey` is deliberately weaker
  than Postgres' `norm_key` — "Don't" and "dont" survive it as two, and `linkWords` merges them to
  one. The refetch is what corrects the display, and this is precisely why `linked` in `linkWords` is
  load-bearing (CLAUDE.md). **Do not add a stronger client-side dedupe to make the optimistic view
  match**; merging more on the client silently drops a word the learner typed.

Add-word from a lesson therefore needs no new round trip and no client-side `norm_key` guess: texts go
in the op, `linkWords` calls `resolveWords`, and the RPC stays server-only (creation doc §3.5).

### 3.4 The retry buffer is a mini-outbox, and should look like one

When a flush returns `applied: []`, the op is still valid and still idempotent — it can be posted
again unchanged. Hold it in a `useRef` array and drain it on the next write or on a Retry press.

This is worth naming because it is the same shape the real outbox has, minus durability. When D1's
mirror lands, that ref becomes a SQLite table and nothing above it changes — which is the outcome
creation doc §3.3 wanted from keeping `/sync/flush` in the first place. Do not, however, build a
queue with `seq` ordering and record ids on the client at S5: one op in flight, one op buffered. The
ordering problem does not exist until ops can outlive the screen.

---

## 4. Decisions

Numbering continues from S4's D43.

### D44 — item ids come from `GET /api/v2/lessons/:id/items`, not from a fatter lesson payload ✅

**`LessonDetail` carries no item ids.** Its `items` is `string[]` and its `itemsDetailed` is
`TutorItem[]` = `{ text, details }`. The `removeItem` op needs `itemId`. So the editing screen cannot
be built on the existing route no matter how it is decorated.

The web page already solves this, and its solution is the one to copy:

```ts
// app/lessons/[id]/page.tsx — one query, two consumers
const itemHistory = await listLessonItemHistory(ownerId, lesson.id);
const activeItems = itemHistory.filter((it) => it.removed_at === null).sort(byPosition);
```

`LessonItem` carries `id`, `text`, `position`, `created_at`, `removed_at` — so **one array feeds both
the editable list and the change log**. A new route returning it whole is therefore not "history plus
an extra field"; it is the editing screen's entire payload.

Rejected: growing `LessonDetailResponse` with an `items: LessonItem[]` field. It would ship removed
rows and their timestamps to the tutor screen on every session start, to render neither.

### D45 — `POST /api/v2/sync/flush` calls a new `lib/sync-flush.ts`; it may not call `flushOutbox` ✅

`flushOutbox` opens with `const ownerId = await getOwnerId()` — cookie-only, permanently, by the
design that makes `/api/v2` safe (creation doc §3.1). Called from a Bearer route it returns
`{ applied: [] }` for every request. That failure is silent, looks like a server fault, and would cost
an afternoon.

Apply creation doc §3.2's stated pattern, the one `persistTutorSession` already demonstrates:

```
lib/sync-flush.ts     applyOps(ownerId, records) → { applied, touched, addedItems }   ← the logic
app/lessons/actions.ts  flushOutbox  = getOwnerId + applyOps + revalidatePath + after()
app/api/v2/sync/flush   POST         = withBearer + applyOps +                 after()
```

`applyOp`'s switch moves with it. **The `after()` fast paths must be duplicated into the route**, not
left to the web caller: without them a word added on the phone waits for the next `pnpm level:items`
sweep instead of being levelled in seconds (creation doc §3.2). Same two calls, same limits
(`LEVEL_AFTER_LIMIT = 50`, `DETAILS_AFTER_LIMIT = 20`), same swallowed failures — the sweeps are the
backstop in both.

`revalidatePath` stays in the web caller only. It costs the native client nothing: both web lesson
pages are `export const dynamic = "force-dynamic"`, so there is no server cache to miss, and what the
web browser actually shows comes from its IndexedDB mirror (§8).

### D46 — the batch is validated at the edge, by a guard that lives in `shared` ✅

`applyOp` is a `switch` over `op.kind` with no `default`. TypeScript proves it exhaustive over
`OutboxOp`; at runtime a record with `kind: "nonsense"` matches nothing, falls out of the function,
and is **reported as applied**. Over the Server Action that is only a lie to our own client. Over a
public Bearer route it is a lie to an arbitrary caller, and one an attacker can trigger deliberately.

Add a pure `parseOutboxRecords(unknown): OutboxRecord[] | null` to
`packages/shared/src/sync-ops.ts` — it is the module that owns the algebra, it has no dependencies to
gain, and both sides then narrow through one implementation. The route answers `400 bad_request` for a
malformed batch. `MAX_FLUSH_RECORDS` already caps size; the guard covers shape.

Extend `packages/shared/check.ts`'s sync-ops block with the rejection cases at the same time —
unknown `kind`, missing `lessonId`, non-array `items`. The existing block checks `planNewItems`,
`buildAddItemsOp`, `buildCreateLessonOp` and `nextLessonTitle` by example; this is the same style.

### D47 — `applied` stays "stop retrying"; `FlushResult` does not grow ✅

Per §3.2. The alternative — per-op outcomes on the response — was rejected on three counts: it changes
a type the web outbox also consumes, it introduces a second vocabulary of success beside "may I drop
this record", and every fact it would carry is already derivable from the refetch the client performs
anyway. A cap or an outcome the client cannot verify is a cap that lies (D31's rule, applied to a
different field).

### D48 — the optimistic view is built from the op ✅

Per §3.3. `planNewItems`, `buildAddItemsOp`, `buildCreateLessonOp`, `normalizeLessonTitle` and
`nextLessonTitle` are imported from `@tutor/shared/sync-ops` and called directly. **No native
re-implementation of any of them**, including the "what is the default title" rule — `nextLessonTitle`
takes the set of taken titles, and the fetched list is that set.

### D49 — client ids come from `expo-crypto`, added explicitly ✅

`crypto.randomUUID()` **works today in this app**, which is the trap. `@livekit/react-native`'s
`registerGlobals()` — run as a module-scope side effect of importing `@elevenlabs/react-native` in
`_layout.tsx` — installs it (`lib/module/index.js:91–108`, `shimCryptoUuid`) when the runtime lacks one:

```js
let createRandomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
  const r = Math.random() * 16 | 0;   // ← Math.random, not a CSPRNG
  ...
```

Two reasons not to build primary keys on it. It is **ambient**: the day the tutor import moves or is
lazy-loaded, id minting breaks in a screen that never mentioned LiveKit. And it is **`Math.random()`**,
whose PRNG state is far smaller than the 122 bits a v4 UUID claims. The realistic collision risk at
one learner's scale is negligible — but the failure mode is not: `createLesson` upserts
`ON CONFLICT (id) DO NOTHING`, so a collision with **another owner's** row makes the lesson silently
not exist, with no error anywhere.

`expo-crypto@57.0.1` (SDK 57, first-party) exports `randomUUID()`. Wrap it in `src/lib/ids.ts` and
pass it as the `newId` parameter `sync-ops.ts` already takes for exactly this reason:

> `newId` is a parameter rather than a call to `crypto.randomUUID()` so this stays free of ambient
> globals (React Native has no `crypto.randomUUID` without a polyfill) — `sync-ops.ts`

**It is a native module: adding it is a rebuild, not a JS reload** (same class as D35's `expo-sqlite`).
Add it in the first build step, not once the screens are half-written.

Rejected: importing the hoisted `uuid@7.0.3` visible in `apps/mobile/node_modules`. It is a transitive
dependency of the LiveKit stack, not a declared one; using it works until the day it doesn't.

### D50 — the lessons list becomes `app/index.tsx`; `/auth` and `/probe` stay reachable ✅

Home is the lessons list. There is no separate landing screen to justify on a phone, and the web's
split (`/` demo, `/lessons` list) exists for reasons — the integration smoke test — that have no
native counterpart.

This deletes `DEV_LESSON_ID` and the launcher, which is S4's carry-forward. **Keep the `/auth` and
`/probe` links**: `/probe` is the upgrade regression instrument (D43), and deleting a working
instrument to tidy a screen is the bad trade named there. A quiet footer row on the list screen.

### D51 — words editing is its own screen: `lessons/[id]/words` ✅

The web puts words, tutor and history on one page. On a phone that page is three screens tall, and the
tutor's transcript `FlatList` wants the whole viewport.

The stronger reason is behavioural: `items_list` is baked into `dynamicVariables` **at connect**, so an
edit made during a session has no effect on that session. Inline editing under a live transcript
advertises an immediacy that does not exist. A pushed screen, reached from the word-count line in the
header, does not.

**Mechanically this requires converting `app/lessons/[id].tsx` → `app/lessons/[id]/index.tsx`** before
`words.tsx` can be its sibling. `typedRoutes` turns any missed `Link` into a compile error, so the
conversion is safe; it is listed here only because it is easy to discover the hard way.

The change log (`ItemChanges`) lives on this screen too — it is the history of the events this screen
generates, which is D30's argument arriving at its destination.

### D52 — the delete confirmation is `Alert.alert`, not a ported `ConfirmDialog` ✅

RN's `Alert` is the platform's own alert: focus, dismissal, VoiceOver and the `destructive` button
style come free, and it needs no dependency. `ConfirmDialog`'s 73 lines exist to give the *browser*
what iOS already has — a focus trap, Escape, `role="alertdialog"`, focus restoration.

The one property to preserve is the web's copy: **"Your words and their practice history stay in your
collection."** A learner deleting a lesson has no way to know that words survive
(`docs/2026-07-17-delete-lesson-keep-words.md`), and the sentence is the only thing that tells them.

`Alert` is blocking in the sense `window.confirm` was not — it does not stall the JS event loop, so
the objection recorded in `ConfirmDialog`'s comment does not carry over.

### D53 — no pagination on `GET /api/v2/lessons` ✅

Return `LessonListItem[]` from `listLessons`, whole. The list is bounded by how many lessons one
person makes by hand, each row is a title plus up to `MAX_ITEMS = 50` short texts, and every field the
row needs — `items` for the preview line, `sessionCount`, `created_at` — is already in the DTO.

A cap would need a "showing N of M" affordance (D31's rule) for a limit nobody has reached. The
trigger to revisit is a **measurement**: a payload over ~100 KB or a visible load pause on the device.
The fix then is `?limit=&cursor=`, not a silent slice.

### D54 — `sendContextualUpdate` stays unmeasured at S5, deliberately ✅

S4 handed it over as "reported working, not measured" and noted it is cheap to settle whenever the
resume path is next touched. **S5 does not touch the resume path**, and growing one to close the gap
would put two risks in a stage whose gate measures neither (build plan rule 1).

It carries forward to S7, where the tutor screen is revisited for theming and error states anyway. The
measurement is unchanged and still cheap: two conversation ids, two `lesson_sessions` rows, and the
tutor's first sentence after the reconnect.

---

## 5. The server

Three routes. All three copy `lessons/[id]/route.ts` — `dynamic = "force-dynamic"`,
`export const OPTIONS = preflight`, `withBearer`, body assigned to its declared type before returning.

### 5.1 `GET /api/v2/lessons`

```ts
export const GET = withBearer(async (_req, ownerId) => {
  const body: LessonListResponse = { lessons: await listLessons(ownerId) };
  return json(body);
});
```

Wrapped in an object rather than returned as a bare array — an array response cannot grow a field
later without breaking every installed binary, and this is the route most likely to want one (a
cursor, per D53's trigger).

`listLessons` is already owner-scoped, already excludes soft-deleted lessons, already filters embedded
items to active ones and already orders `created_at` desc / `position` asc. No new query.

### 5.2 `GET /api/v2/lessons/:id/items`

```ts
export const GET = withBearer<{ params: Promise<{ id: string }> }>(async (_req, ownerId, ctx) => {
  const { id } = await ctx.params;
  // Ownership gate FIRST: listLessonItemHistory is owner-scoped, but an empty array cannot
  // distinguish "not yours" from "no items yet", and the screen renders those differently.
  const lesson = await getLesson(ownerId, id);
  if (!lesson) return apiError(404, "not_found", "No such lesson.");
  const body: LessonItemsResponse = { items: await listLessonItemHistory(ownerId, id) };
  return json(body);
});
```

Returns the **full** history including removed rows, per D44: the active list is
`items.filter((i) => i.removed_at === null)` and the change log is the same array flat-mapped. Both
derivations are pure and both already exist in `app/lessons/[id]/page.tsx` — move them to
`packages/shared/src/lesson-items.ts` so the two apps derive identically, or leave them inline in the
screen if that feels premature. **The shared-package test applies**: could a bug in this derivation be
fixed by deploying the web app alone? No — so if it is shared, it belongs in the package.

The extra `getLesson` call is one indexed read for an unambiguous 404. Worth it.

### 5.3 `POST /api/v2/sync/flush`

```ts
export const POST = withBearer(async (req, ownerId) => {
  const records = parseOutboxRecords(await req.json().catch(() => null));   // D46
  if (!records) return apiError(400, "bad_request", "Malformed outbox batch.");

  const { applied, addedItems } = await applyOps(ownerId, records);         // lib/sync-flush.ts

  if (addedItems) {
    after(async () => { try { await levelItems(ownerId, { limit: LEVEL_AFTER_LIMIT }); } catch {} });
    after(async () => { try { await enrichWords(ownerId, { limit: DETAILS_AFTER_LIMIT }); } catch {} });
  }

  const body: FlushResult = { applied };                                    // D47 — unchanged shape
  return json(body);
});
```

No `revalidatePath` (D45). The request body is `OutboxRecord[]` — the same wire shape the browser
sends the Server Action, which is what makes the offline upgrade a purely client-side change
(creation doc §3.3).

### 5.4 The contract additions — `packages/shared/src/api.ts`

```ts
export const API_V2_ROUTES = {
  …,
  lessons: `${API_V2}/lessons`,
  syncFlush: `${API_V2}/sync/flush`,
} as const;

export function lessonItemsPath(id: string): string {
  return `${lessonPath(id)}/items`;          // built FROM lessonPath — one encoding rule, not two
}

export interface LessonListResponse { lessons: LessonListItem[] }
export interface LessonItemsResponse { items: LessonItem[] }
export function isLessonListResponse(body: unknown): body is LessonListResponse { … }
export function isLessonItemsResponse(body: unknown): body is LessonItemsResponse { … }
```

`FlushResult` is imported from `./sync-ops` rather than redeclared — it is already the declared shape
of this response and has been since the outbox existed.

---

## 6. The app

### 6.1 Files

```
apps/mobile/src/
  app/
    index.tsx                 REPLACED — the lessons list (was the launcher; D50)
    lessons/
      [id]/
        index.tsx             MOVED from [id].tsx, otherwise untouched (D51)
        words.tsx             NEW — edit words + the change log
    auth.tsx, probe.tsx       unchanged, still linked from the list footer
  lib/
    ids.ts                    NEW — newId(), wrapping expo-crypto (D49)
    lessons.ts                NEW — the three fetches + postFlush, one place
```

`src/lib/lessons.ts` exists so three screens do not each rebuild "post an op, read `applied`, decide
whether to refetch". It is thin — it holds no state and owns no cache.

### 6.2 The three screens

**`index.tsx` — the list.** `FlatList` over `LessonListResponse.lessons`, a row of title +
`{n} words · {n} conversations · {date}` + the preview line, `RefreshControl` for pull-to-refresh (the
native answer to the web's `RefreshButton`, and the natural gesture for "did my phone-side write
land"), an `Alert.alert` delete (D52), and a create form. `Link href={/lessons/${l.id}}` — typed.

Create: title (optional, defaults to `nextLessonTitle(taken, new Date())`) + a multiline field, one
word per line, capped at `MAX_ITEMS`. On submit: build the op, prepend the optimistic row, post,
refetch, navigate to the lesson. The web navigates only after a successful flush because its RSC page
cannot load a lesson the server has not got yet; the same holds here for `GET /api/v2/lessons/:id`, so
**navigate on `applied.length === 1`, not before**.

**`lessons/[id]/index.tsx` — the tutor.** Unchanged from S4 except its path and a header link to
`./words` on the word-count line.

**`lessons/[id]/words.tsx` — editing.** `GET …/items` once; active rows in a `FlatList` with a remove
affordance; an add field with the same `MAX_ITEMS` room calculation the web does
(`Math.max(0, MAX_ITEMS - items.length)`); the change log below, ported from `ItemChanges`. Every
mutation: op → optimistic state → post → refetch (§3.2).

### 6.3 Copy that has to survive the port

- The delete confirmation's second sentence (D52) — it is the only place soft-delete is explained.
- `{n}/50 items` and `Lesson is full (50 items).` — a disabled field with no reason is a broken field.
- The empty states: `No lessons yet — create your first one above.` / `No words yet — add some below.`

### 6.4 Ids

One module, one export, used by every op:

```ts
// src/lib/ids.ts
import { randomUUID } from "expo-crypto";
export const newId = (): string => randomUUID();   // D49 — never the ambient crypto.randomUUID
```

---

## 7. Deliberately not built at S5

| Not built                        | Why                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The SQLite mirror / offline queue | D1. §3.4's `useRef` buffer is the seam it lands in.                                                  |
| A durable outbox with `seq`      | One op in flight, one buffered. Ordering is not a problem until ops outlive the screen (§3.4).        |
| Per-op outcomes on `FlushResult` | D47.                                                                                                  |
| Reordering items                 | No op for it. `position` is append-only by design; adding a `moveItem` op is an algebra change.       |
| Editing a lesson title           | Same — no op. Not in the web app either.                                                              |
| The collection screen / add-word from `/lesson-items` | S6. That path is `addWord`, not the op algebra, and is online-only even on web (creation doc §5). |
| Theming, dark/light, empty-state polish | S7. S5 keeps S4's inline `StyleSheet` palette.                                                  |
| Settling `sendContextualUpdate`  | D54.                                                                                                  |

---

## 8. Test plan — on the phone

⚠️ **Read this before verifying anything on the web app.**

The web's lessons list renders from its **IndexedDB mirror**, not from the server payload, and
`seedLessons` is deliberately upsert-only:

> Upsert-only for existing lessons (no stale-deletion, which would clobber a lesson created
> optimistically offline but not yet pulled back) — `lib/sync/mirror.ts`

So of the four gate operations, three cross over cleanly and one does not:

| Done on the phone | Seen in an already-open web browser?                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------- |
| Create a lesson   | ✅ the server payload lists it, `seedLessons` upserts it                                          |
| Add items         | ✅ `seedLessonItems` reconciles per lesson (it *does* drop rows the server no longer lists)        |
| Remove an item    | ✅ same                                                                                            |
| **Delete a lesson** | ❌ **it stays in the list.** Nothing removes a mirrored lesson except a *local* delete op.        |

This is a pre-existing property of the web app protecting unsynced offline creates. **It is not an S5
bug and must not be "fixed" as part of S5** — doing so would risk the offline path S5 does not touch.
Verify a phone-side delete in a **fresh browser profile** (empty IndexedDB, so the mirror seeds from
scratch) or by reading `lessons.deleted_at` in Supabase.

| #  | Test                                    | Expected                                                                                                       |
| -- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| T1 | Cold launch → list                      | The learner's real lessons, newest first, with word counts and conversation counts matching the web.            |
| T2 | Create a lesson, blank title            | Title = today as `dd-mm-yyyy`; a second one the same day gets ` 1`. Lands on the lesson screen.                 |
| T3 | Create with duplicates: `novel`, `Novel`, blank line | **One** item. `planNewItems` working, not a bug (§3.3).                                             |
| T4 | Add `Don't` and `dont` to a lesson      | **Two shown optimistically, one after the refetch.** The `norm_key` asymmetry, visible and correct (§3.3).      |
| T5 | Remove an item → reopen the screen      | Gone. The change log shows `－ removed` with a timestamp.                                                        |
| T6 | Delete a lesson → confirm               | Alert names that words survive; the lesson leaves the list; **verify server-side per the note above**.          |
| T7 | Add a word, then start a session        | The new word is in what the tutor discusses — proves the op reached `words` and `formatItemsList` saw it.       |
| T8 | Add a word, wait ~30 s, open it on web  | It has a CEFR level and `details`. **This is the `after()` duplication (D45).** Without it, nothing until the sweep. |
| T9 | Airplane mode → add a word              | An error and a Retry that works when the connection returns. Not a lost word, not a silent success (§3.4).      |

T8 is the one that fails silently if forgotten, and it is the reason it has its own row.

---

## 9. Gate — **passed 2026-08-15**

The build plan's criterion, made checkable:

- [x] **Create a lesson, add items, remove an item, delete a lesson — all reflected on the web app**
      (T2, T4, T5, T6), with **the delete verified in a fresh browser profile or in Supabase** (§8)

And three the research added:

- [x] **T8** — a word added from the phone is levelled and enriched within a minute (D45's `after()`)
- [x] **T4** — the dedupe asymmetry behaves as designed rather than being "fixed" client-side
- [x] **T9** — a failed write is retryable and loses nothing (§3.4)

**Reported green by the tester on 2026-08-15.** ⚠️ **The individual tests were not separately
recorded**, and this file says so rather than inventing detail — the same discipline S1 §12 and S4 §9
used for their uncaptured runs. What that costs is named in §14.

---

## 10. If it fails

| Symptom                                                       | First suspicion                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Every write returns `{applied: []}`, no error                 | The route called `flushOutbox` instead of `applyOps` — cookie owner, no Bearer (D45). The single most likely S5 bug.      |
| Writes succeed; nothing changes in the database               | The op reached `applyOp` with a `kind` nothing matches, and was reported applied (D46). Check `parseOutboxRecords` is wired. |
| Remove does nothing                                           | The screen is using texts, not ids. `LessonDetail` has no ids; the items route is what carries them (D44).                |
| New words never get a level or `details`                      | The `after()` block was left in the Server Action only (D45 / T8).                                                        |
| Crash on first create, `randomUUID is not a function`         | `expo-crypto` added without a native rebuild (D49) — `pnpm native`, rebuild. Same class as D35.                          |
| Lesson created on the phone 404s when opened                  | Navigated before the flush was accepted (§6.2). Navigate on `applied.length === 1`.                                       |
| A deleted lesson still on the web                             | Expected (§8). Verify in a fresh profile before debugging anything.                                                       |
| `Link` to `./words` will not compile                          | `[id].tsx` not yet converted to `[id]/index.tsx` (D51). `typedRoutes` is telling the truth.                              |
| Duplicate words appear and then vanish on refetch             | Correct behaviour (§3.3). Do not strengthen `clientDedupeKey`.                                                            |

---

## 11. Build order

Server first: every screen is testable from `curl` before a phone is involved.

1. **`expo-crypto` + `src/lib/ids.ts`, and rebuild** (D49). First, because it is the only native change.
2. `parseOutboxRecords` in `sync-ops.ts` + its `check.ts` cases (D46). `pnpm check:shared`.
3. Extract `lib/sync-flush.ts`; re-point `flushOutbox` at it. **The web app must still pass its own
   create/add/remove/delete before anything native is written** — this is the one step that can
   regress a working app.
4. The contract additions in `packages/shared/src/api.ts` (§5.4). `pnpm typecheck`.
5. The three routes (§5). Verify each with a Bearer token from the device, `/api/v2/me` first.
6. `app/index.tsx` — the list, read-only. Delete the launcher.
7. Create + delete on the list.
8. `[id].tsx` → `[id]/index.tsx`; add `words.tsx` read-only.
9. Add + remove on the words screen; the change log.
10. T1–T9 on the device.

Steps 1–5 are ~1.5 days, 6–9 ~2 days, and the ratio is the point: this stage is a server stage wearing
three screens.

---

## 12. Is S5 ready to build?

Yes. Every input S4 owed arrived (§1), every question the placeholder asked has an answer with a
reason (§0), and the two things the placeholder did not know to ask — that `LessonDetail` carries no
item ids (D44) and that `flushOutbox` is cookie-bound (D45) — are the two that would each have cost a
day mid-build.

The one thing S5 cannot prove is `sendContextualUpdate` (D54), and it is explicitly not S5's job.

---

## 13. Implementation — built 2026-08-15, statically verified

Built in §11's order. Everything below compiles, lints and bundles; **nothing below has run on a
phone**, which is what §9's gate is for.

### What was built

| Step | Files                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------ |
| 1    | `expo-crypto@~57.0.1` + `apps/mobile/src/lib/ids.ts` (D49)                                       |
| 2    | `parseOutboxRecords` in `packages/shared/src/sync-ops.ts` + 14 cases in `check.ts` (D46)          |
| 3    | `apps/web/src/lib/sync-flush.ts` — `applyOps` + `scheduleWordJobs`; `flushOutbox` re-pointed (D45) |
| 4    | `LessonListResponse`, `LessonItemsResponse`, `lessonItemsPath`, two guards, two paths (§5.4)      |
| 5    | `api/v2/lessons/route.ts`, `api/v2/lessons/[id]/items/route.ts`, `api/v2/sync/flush/route.ts`     |
| 6    | `apps/mobile/src/lib/lessons.ts`, `src/app/index.tsx` — the list (D50)                            |
| 7    | `src/app/lessons/[id].tsx` → `[id]/index.tsx`; new `[id]/words.tsx` (D51)                         |

### One deviation from the plan, and it is an improvement

§5.3 said to **duplicate** the `after()` fast paths into the v2 route, following creation doc §3.2's
wording. They are **shared** instead, as `scheduleWordJobs(ownerId)` in `lib/sync-flush.ts`.

The reason the doc gave for duplicating was that the route must not be forgotten — but duplicated
code is precisely how one of two callers quietly loses a best-effort background job, and neither a
typecheck nor a test would notice. One exported function, called by both, cannot drift. The
observable behaviour is identical.

### What the checks proved

- `pnpm typecheck` — clean across all three packages.
- `pnpm lint` — clean. **Four real errors on the way there**, both new screens hitting the same two
  React Compiler rules: `set-state-in-effect` (fixed by matching S4's async-IIFE effect shape) and
  `immutability` — `retryRef` held a closure over `write` created *inside* `write`. It now holds the
  arguments (`{ next, run }`), which is both legal and closer to what a durable outbox would store.
- `pnpm check:shared` — 10 752 round-trips plus the new guard cases, all holding.
- `pnpm build` — the route table lists `/api/v2/lessons`, `/api/v2/lessons/[id]/items` and
  `/api/v2/sync/flush` as dynamic handlers, and every pre-existing route is unchanged.
- `pnpm --filter mobile bundle` — 1623 modules, iOS bundle produced. This is what actually resolves
  `expo-crypto` and the `[id]/index.tsx` + `[id]/words.tsx` route pair.
- **Live smoke test** against `pnpm dev`: all three routes answer **401 with the CORS headers** with
  no token, and `OPTIONS` answers **204**. The wrapper is applied and fails closed on each.

### What this does not tell us

- **No authenticated call has been made** — every runtime check above is the unauthenticated path.
  T1–T9 are all still open.
- **The web app's own create/add/remove/delete has not been exercised in a browser** since the D45
  extraction. It is a pure move (same functions, same order, same `revalidatePath`) and it builds,
  but *the browser is where that gets confirmed*, and it is the one change here that can regress
  something already working.
- `expo-doctor` reports **7 packages out of date** — `expo-dev-client`, `expo-image`, `expo-linking`,
  `expo-router` among them. **Pre-existing SDK-57 patch drift, not caused by this stage**:
  `expo-crypto` is not among them, and the only `package.json` change is its one line. Upgrading
  seven Expo packages is a separate risk and does not belong in S5 (build plan rule 1).

---

## 14. Result — and what S5 hands to S6

**Gate reported green on 2026-08-15**, one day after the research was written. The four operations
work from the phone and land on the server.

### ⚠️ What is not in the record

The tests were reported as a whole rather than one by one, so **T8 is the one worth re-checking
casually** the next time a word is added from the phone: it is the only criterion whose failure is
invisible at the time (a word with no CEFR level and no `details` looks exactly like a word the jobs
have not reached yet), and it is the reason the `after()` duplication got its own row in §8. The
others announce themselves — a failed create, remove or delete is visible immediately.

This is a known-unknown carried forward, not a reason to reopen S5.

### What S5 hands to S6

- [x] **The write path, proven.** `postOp` → `POST /api/v2/sync/flush` with a single-op batch,
      `applied` read as "stop retrying" and the screen re-reading afterwards. **S6's writes do NOT
      use it** — add-word and favorite are direct routes (`/lesson-items` is online-only even on web,
      creation doc §5) — but the *shape* is the one to copy: optimistic from the source of truth,
      re-read after, snapshot rollback with the arguments kept for a retry.
- [x] **The optimistic-write pattern, in code:** `write(next, run)` in both new screens — snapshot,
      apply, post, re-read; on failure restore the snapshot and keep `{ next, run }` in a ref.
      Lift it into a hook when S6 makes it the third copy, not before.
- [x] **`src/lib/ids.ts` → `newId()`**, backed by `expo-crypto`. Any client-minted id uses it.
- [x] **`src/lib/lessons.ts`** — the "one module owns the fetches for a domain" convention. S6 gets
      its own (`src/lib/items.ts`); it does not extend this one.
- [x] **Two React Compiler rules that will bite again**, both hit on first contact (§13):
      `set-state-in-effect` wants S4's async-IIFE effect shape, and `immutability` forbids a `useCallback`
      referencing itself — store the arguments, not a closure.
- [x] **The navigation shape:** `index.tsx` (lessons), `lessons/[id]/index.tsx` (tutor),
      `lessons/[id]/words.tsx` (editing), `auth.tsx`, `probe.tsx`. **S6 adds the first screen that is
      not reached from a lesson**, so it also decides where the collection is reached FROM — the
      launcher that used to answer that question is gone (D50).
- [x] **`Alert.alert` is the confirmation pattern** (D52). No dialog component was built or needed.
- [x] **The v2 route pattern for a query-bearing GET is still unproven** — every route so far takes
      either nothing or a path id. `GET /api/v2/lesson-items?…` is the first with a query string, and
      it is S6's first server question.
- [ ] ⚠️ **`sendContextualUpdate` remains reported-working, not measured** (D54), carried to S7.
- [ ] ⚠️ **`expo-doctor`: 7 packages out of date** — pre-existing SDK-57 patch drift, not from S5
      (§13). It will keep being reported at every stage until someone decides to do the upgrade;
      that decision belongs to S7, with a rebuild and a device check behind it.

---

## Sources

- **In-repo, read fresh on 2026-08-14:** `packages/shared/src/sync-ops.ts` (the op algebra, the
  `newId` parameter and its stated reason), `lesson-types.ts` (**`LessonDetail` has no item ids** —
  D44), `api.ts`, `check.ts` (the sync-ops block D46 extends) · `apps/web/src/lib/lessons.ts`
  (`listLessons`, `getLesson`, `linkWords` and its load-bearing `linked` set, `upsertLessonItems`,
  `removeLessonItem`, `deleteLesson`, `listLessonItemHistory`), `lib/sync/engine.ts` (the
  build-from-the-op rule), `lib/sync/mirror.ts` (**`seedLessons` is upsert-only** — §8),
  `lib/http.ts`, `lib/auth/bearer.ts`, `lib/levels.ts:20`, `lib/word-details.ts:48` ·
  `apps/web/src/app/lessons/actions.ts` (`flushOutbox`, **`getOwnerId()` at line 71** — D45; the
  `applyOp` switch with no default — D46), `app/lessons/page.tsx`, `app/lessons/[id]/page.tsx`
  (the one-query-two-consumers pattern D44 copies), `LessonsList.tsx`, `NewLessonForm.tsx`,
  `LessonItemsView.tsx`, `ConfirmDialog.tsx`, `RefreshButton.tsx` (**`/lesson-items` only**) ·
  `apps/web/src/app/api/v2/**` (all five existing routes) · `apps/mobile/src/api.ts`,
  `app/lessons/[id].tsx`, `app/index.tsx`, `app/_layout.tsx`, `src/env.ts`, `package.json`.
- **Read from installed package source on 2026-08-14:** `@livekit/react-native@2.9.8`
  `lib/module/index.js:91–108` — `shimCryptoUuid`, the `Math.random()` `crypto.randomUUID` polyfill
  installed by `registerGlobals()` (D49). `apps/mobile/node_modules/uuid@7.0.3` — present, transitive,
  not a declared dependency.
- `npm view expo-crypto version` → **57.0.1** (SDK 57 aligned) — D49.
- Prior stages: [creation doc](./2026-08-12-expo-app-creation.md) §3.2 (the lib/-first pattern), §3.3
  (single-op batches, and the routes table this file corrects), §3.5 (what stays server-only), §5
  (D1 and the deferred mirror's file map), §6 (the screens and the UI cost) ·
  [S3](./2026-08-13-expo-s3-conversation-token.md) §6.2 (`apiFetch`), D25 (CORS) ·
  [S4](./2026-08-13-expo-s4-tutor-screen.md) D30 (history split out — completed here), D31 (a cap the
  client cannot see is a cap that lies), D32 (`withBearer` with a route context), D35 (a native module
  is a rebuild), D39 (Expo UI's boundary), D42/D43 (the launcher and the probe), §14 (the handover) ·
  [offline support](./2026-07-04-offline-support-and-sync.md) (the outbox's idempotence),
  [delete lesson, keep words](./2026-07-17-delete-lesson-keep-words.md) (the copy D52 preserves),
  [shareable core](./2026-08-09-shareable-core-refactor.md) (R5, R7) ·
  [build plan](./2026-08-12-expo-build-plan.md) S5.
- Repo conventions: `CLAUDE.md` — `clientDedupeKey` may merge less than `norm_key`, never more (§3.3);
  the "could I fix it by deploying the web app alone?" test, applied in §5.2.
