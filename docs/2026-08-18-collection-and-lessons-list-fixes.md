# Four fixes on the lessons list and the collection: the missing default title, the tappable row, the pinned selection bar, and deleting a word for good

**Date:** 2026-08-18
**Scope:** `apps/mobile` for all four. Item 1 also touches `apps/web/src/lib/` (a server-side
guard) and item 4 needs new server work: `packages/shared/src/api.ts`, one `apps/web` data-layer
function, one route, and one migration. No `packages/shared/src/sync-ops.ts` change anywhere.
**Status:** **implemented** on branch `worktree-small-ui-fixes`, 2026-08-18 — all four, in the
order §5 recommends. Typecheck, lint, `check:logic`, `check:shared` and the iOS bundle all pass;
`expo-doctor` fails on a pre-existing patch-version drift (5 Expo packages) that predates this work
and that no file here touches. Everything tagged `[unverified]` below is still unverified: none of
it can be checked without a device or a database. §7 records what was decided and what changed
against the plan. Claims are tagged `[code]` (read in this repo), `[design]` (a decision) and
`[unverified]`.

---

## §0 The headline

Three of the four are small and one is not.

| # | Complaint | What it actually is | Size |
|---|-----------|---------------------|------|
| 1 | New lesson has no title | **A real bug**, in one of the app's *two* create-lesson paths. The collection screen never applies the date fallback the lessons screen applies. | ~5 lines + a render guard |
| 2 | Only the title is tappable | A layout decision that was carried over from the web verbatim, where the whole row is not clickable either. | ~15 lines |
| 3 | Selection actions are at the end of the page | A **deliberate, documented** decision (`lesson-items/index.tsx:623-631`) that this document proposes reversing, because the reason given for it has a cheap answer. | ~30 lines, one `Screen` prop |
| 4 | No way to delete a word | A capability that **does not exist on any surface, in any client, or in the API**. The database was built for it (`0007` §4) and nothing else was. | New route + data-layer fn + migration + UI |

Items 1 and 3 interact: if §3 removes the title field from the selection bar (the recommended
variant), the default title becomes the *only* title a lesson created from the collection ever gets
— so §1 stops being a cosmetic bug and becomes load-bearing. Fix §1 first regardless.

Items 3 and 4 interact: "actions" is plural in the complaint, and once §4 exists, *delete the
selected words* is the obvious second action for the bar to hold. §3's bar should be designed for
N actions on day one rather than for one.

---

## §1 The lesson created from the collection has no title

### 1.1 The bug, exactly

There are **two** create-lesson paths in the mobile app and they do not agree.

`apps/mobile/src/app/lessons/index.tsx:131-149` — the composer on the lessons screen — is
correct `[code]`:

```ts
const taken = new Set(lessons.map((l) => l.title));
const op = buildCreateLessonOp(
  newId(),
  title.trim() || nextLessonTitle(taken, new Date()),   // ← the fallback
  texts,
  newId,
);
```

`apps/mobile/src/app/lesson-items/index.tsx:211-227` — *create a lesson from the ticked words* — is
not `[code]`:

```ts
const op = buildCreateLessonOp(newId(), lessonTitle, texts, newId);   // ← no fallback
```

`lessonTitle` is the optional `TextField` at line 404, initialised to `""` and cleared by
`clearSelection()`. When the learner does not type one, `buildCreateLessonOp` runs
`normalizeLessonTitle("")` → `""` (`packages/shared/src/sync-ops.ts:160`) and the op carries an
empty title.

Nothing downstream repairs it:

- `applyOp` in `apps/web/src/lib/sync-flush.ts:35-40` re-runs `normalizeLessonTitle` — trim and cap,
  no default `[code]`.
- `createLesson` in `apps/web/src/lib/lessons.ts:121-135` upserts `title` verbatim `[code]`.
- `lessons.title` is `text not null` with **no default and no non-empty check**
  (`supabase/migrations/0002_lessons.sql:12`), so `''` is a perfectly legal row `[code]`.

The learner then sees an empty `<Link>` in the list row and an empty `<H1>` on the lesson page —
"no title at all", exactly as reported.

### 1.2 Why the web does not have this bug

Both web paths call `defaultLessonTitle()` explicitly before building the op —
`NewLessonForm.tsx:44` and `ItemsBrowser.tsx:104` `[code]`:

```ts
const title = lessonTitle.trim() || (await defaultLessonTitle());
```

and `defaultLessonTitle` (`apps/web/src/lib/sync/engine.ts:40-43`) reads the taken titles **out of
the IndexedDB mirror**, which every web screen has. The mobile app has no mirror, so the port could
not copy that line — and on the lessons screen it did not need to (the list is already in state),
while on the collection screen it was simply dropped.

**The shared helper is fine.** `nextLessonTitle` (`sync-ops.ts:177-183`) is pure, tested, and
correct; it is just never called from this screen.

### 1.3 Options

| Option | What it means | Verdict |
|---|---|---|
| **A. Fetch the lesson titles at create time** | Inside `createFromSelection`, call `fetchLessons(accessToken)` when the title box is blank, build `taken`, call `nextLessonTitle`. | **Recommended.** One extra request, and only on the path that needs it. |
| B. Fetch the lessons on mount | The collection screen would hold a lessons list it renders nowhere. | No — a payload per screen load to serve a rare branch. |
| C. `nextLessonTitle(new Set(), new Date())` | Always `dd-mm-yyyy`, no de-duplication. | Cheap, but two lessons created from the collection on the same day get identical titles — which is the one thing `nextLessonTitle`'s counter exists to prevent. Acceptable as a fallback if A's fetch fails. |
| D. Default it server-side | `applyOp` fills a blank title from the owner's existing titles. | **Recommended as a second layer**, not as the fix — see 1.5. |

### 1.4 The change (option A)

`apps/mobile/src/app/lesson-items/index.tsx`, in `createFromSelection`:

```ts
// The lessons screen computes this from a list it already has; here there is none, so it is
// fetched — but only when the learner left the box empty, which is the only branch that needs it.
// A failed fetch degrades to the bare date rather than to no title at all.
let title = lessonTitle.trim();
if (!title) {
  const taken = await fetchLessons(accessToken)
    .then((ls) => new Set(ls.map((l) => l.title)))
    .catch(() => new Set<string>());
  title = nextLessonTitle(taken, new Date());
}
const op = buildCreateLessonOp(newId(), title, texts, newId);
```

Imports: add `nextLessonTitle` to the `@tutor/shared/sync-ops` import at line 9, and `fetchLessons`
to the `@/lib/lessons` import at line 26.

### 1.5 The rows that are already broken

Whatever is in the database now stays broken — the fix is a write-path fix. Two cheap guards:

1. **Render fallback**, so an empty title is never invisible. In `lessons/index.tsx:212` and
   `lessons/[id]/index.tsx:1143`, render `lesson.title || "Untitled lesson"`. This is honest (the
   row *has* no title) and costs two expressions.
2. **A server-side default** (option D), in `applyOp`:

   ```ts
   case "createLesson": {
     const title = normalizeLessonTitle(op.lesson.title);
     await createLesson(ownerId, {
       id: op.lesson.id,
       // A blank title reaching here is a client bug, but the row it writes is permanent and
       // invisible, so the server does not store one. Ownership is enforced in code here for the
       // same reason (CLAUDE.md).
       title: title || (await nextOwnerLessonTitle(ownerId)),
       items: op.lesson.items.slice(0, MAX_ITEMS),
     });
     return;
   }
   ```

   with `nextOwnerLessonTitle(ownerId)` = `select title from lessons where owner_id = … and
   deleted_at is null` → `nextLessonTitle(new Set(titles), new Date())`. One indexed query, on the
   blank branch only.

   ⚠️ One caveat worth stating: a create op **queued offline and replayed days later** would get a
   default title stamped with the *replay* date, not the creation date. That is not a regression
   today (mobile has no durable outbox — `postOp` is single-op, in-flight only,
   `apps/mobile/src/lib/lessons.ts`), but it is the reason the client fallback stays the primary
   fix and this stays the net.

3. **Optional one-off repair** for existing rows — the number is `[unverified]` until someone runs
   it:

   ```sql
   select id, created_at from lessons where btrim(title) = '' and deleted_at is null;
   update lessons set title = to_char(created_at, 'DD-MM-YYYY')
    where btrim(title) = '' and deleted_at is null;
   ```

   Not a migration — a data repair, run by hand, after the write path is fixed. (It can produce
   duplicate titles; titles are not unique and nothing depends on their uniqueness.)

### 1.6 Verification

- Collection → tick two words → leave the title box empty → **Create lesson** → the lesson page
  header reads `18-08-2026`.
- Repeat the same day → the second reads `18-08-2026 1`.
- Airplane mode → the fetch fails → the title is still `18-08-2026` (the `.catch` branch), and the
  create itself then fails with the existing write-error panel.

---

## §2 The whole lesson row should open the lesson

### 2.1 What is there now

`apps/mobile/src/app/lessons/index.tsx:205-228` `[code]`: a `View` per lesson, containing a `<Link>`
around the title only, plus the trash `Button`, plus two `Muted`/`Faint` lines of metadata. Only the
title text is a touch target — and it is `type.body` (16pt) tall, well under the 44pt iOS minimum,
in a row that is ~70pt tall.

The web has the same markup (`apps/web/src/app/LessonsList.tsx:57-84`) and the same limitation. On a
mouse it is a nuisance; on a thumb it is the complaint.

### 2.2 The one real constraint: the trash button is inside the row

Making the row a `Pressable` puts the delete button inside another pressable. React Native's
responder chain gives the touch to the **innermost** view that claims it, so a tap on the trash
still deletes and does not also navigate `[code — the same nesting already works in `ItemLine`,
where a `Checkbox` and a favourite `Button` sit inside a row that is not yet pressable]`. Worth
confirming on device `[unverified]`, because it is the one behaviour that would make the fix worse
than the bug.

### 2.3 Options

| Option | Notes |
|---|---|
| **A. `Pressable` + `router.push`** | `typedRoutes: true` is on (`app.config.ts:195`), so `router.push` is type-checked against real routes exactly as `Link`'s `href` is — the compile-time safety `Link`'s docblock claims is not lost. **Recommended.** |
| B. expo-router `<Link asChild>` around a `Pressable` | Keeps href semantics; needs `asChild` plumbed through `@/ui/Link`, which today accepts neither `asChild` nor children other than text. More code for the same result. |
| C. Leave the `<Link>` and grow its hit area | `hitSlop` on the title only. Does not make the metadata lines tappable, which is most of the row. No. |

### 2.4 The change (option A)

```tsx
<Pressable
  key={lesson.id}
  onPress={() => router.push(`/lessons/${lesson.id}`)}
  accessibilityRole="link"
  accessibilityLabel={`${lesson.title || "Untitled lesson"}, ${lesson.items.length} items`}
  style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
>
  <View style={styles.rowHead}>
    <Body style={styles.rowTitle} numberOfLines={1}>{lesson.title || "Untitled lesson"}</Body>
    <Button variant="icon" tone="danger" hitSlop={8} … />
  </View>
  …
</Pressable>
```

Three details that are not optional:

- **The title stops being a `Link`.** Two nested navigations to the same place is one too many, and
  the accent colour is already `variant="plain"` (i.e. it does not look like a link today anyway).
  It becomes a `Body` with the same `styles.rowTitle`.
- **A pressed state.** The row is now a control and owes the finger feedback `Button` already gives
  (`Button.tsx`: `pressed: { opacity: 0.7 }`). Add `rowPressed: { opacity: 0.6 }` — or a
  `backgroundColor: t.sunken` if a flash reads better `[design]`.
- **`hitSlop` on the trash button.** It is `control.iconSize` = 32pt, under the 44pt minimum, and it
  now sits inside a much larger target where a near-miss navigates instead of doing nothing. `Button`
  does not currently accept `hitSlop` — a two-line addition to `apps/mobile/src/ui/Button.tsx`
  (prop → `Pressable`), which the favourite star in `ItemLine` wants for the same reason.

`accessibilityRole="link"` on the row and `accessibilityLabel` on the trash keep VoiceOver reading
two distinct actions rather than one ambiguous blob.

### 2.5 Should the collection's word rows get the same treatment?

Not in this change `[design]`. `ItemLine` (`lesson-items/index.tsx:541-591`) holds three controls —
a checkbox, a title link, a favourite star — and its dominant gesture is *select*, not *open*. A
whole-row press there has to choose between navigating and ticking, and the answer depends on §3's
outcome. Revisit after §3 ships.

---

## §3 The selection actions belong at the bottom of the screen

### 3.1 What is there now, and why

`lesson-items/index.tsx:398-421`: when `selected.size > 0`, an accent-bordered `Panel` renders at the
**end of the page content** with the count, the title field, **Create lesson** and **Clear**. On a
list of 70 words the learner has to scroll past all of them to reach it.

The decision is documented at `lesson-items/index.tsx:623-631` `[code]`:

> The web's selection bar is `position: sticky; bottom: 1rem` with a drop shadow. RN has no sticky,
> and a floating bar would have to live outside the scroll container — i.e. outside `Screen`. It
> stays a panel at the end of the page instead: […] a bar pinned over the list would cover the very
> rows being ticked on a phone-height screen.

Two claims. The first is true and is the actual obstacle: `Screen` (`apps/mobile/src/ui/Screen.tsx`)
wraps **everything** in one `ScrollView` and offers no slot outside it. The second — that a pinned
bar covers the rows being ticked — is only true of an *overlay*. A bar that takes layout space
cannot cover anything.

### 3.2 The `Screen` change

Add a `footer` slot rendered **outside** the `ScrollView` and **inside** the
`KeyboardAvoidingView` + `SafeAreaView`:

```tsx
export function Screen({ children, footer, … }) {
  …
  <KeyboardAvoidingView style={styles.flex} behavior={…}>
    {scroll ? (
      // `styles.flex` is new and is REQUIRED once there is a sibling: a ScrollView with no flex
      // style sizes to its content and would push the footer off-screen on a long page.
      <ScrollView style={footer ? styles.flex : undefined} contentContainerStyle={styles.content} …>
        {body}
      </ScrollView>
    ) : (…)}
    {footer ? <View style={styles.footerBar}>{footer}</View> : null}
  </KeyboardAvoidingView>
```

```ts
footerBar: {
  borderTopWidth: 1,
  borderTopColor: t.border,
  backgroundColor: t.panel,
  paddingHorizontal: layout.pagePaddingHorizontal,
  paddingVertical: space.panelGap,
},
// and inside it, the same column rule the content uses, so an iPad's bar is not 1024pt wide:
footerColumn: { width: "100%", maxWidth: layout.contentWidth, alignSelf: "center" },
```

Why a **flex sibling** rather than `position: absolute` `[design]`:

- Nothing is covered, so no `onLayout` measurement and no dynamic `paddingBottom` on the scroll
  content. The absolute variant needs both, and gets them wrong every time the bar wraps to two
  lines.
- The scroll container shrinks by exactly the bar's height, so the last row is always reachable.
- The bottom safe-area inset is already handled: `SafeAreaView` has `edges={[…, "bottom", …]}`, so
  the bar clears the home indicator for free.
- The keyboard is handled: the bar is inside the `KeyboardAvoidingView`, whose `behavior="padding"`
  on iOS lifts it with the keyboard. **`[unverified]` — worth checking on device**, since this is the
  first thing in the app to sit below a scroll view inside that KAV.

Cost of the flex variant vs. the web's floating look: no drop shadow, no gap under the bar, and a
hard edge against the list. That is a fair trade and arguably reads better on a phone.

### 3.3 The bar's contents

Today's panel holds a **`TextField`** (lesson title). Keeping a text input in a bar that must stay
short, above a keyboard that will cover the list, is the whole difficulty of this change. Two
variants:

**Variant A — drop the title field (recommended `[design]`).** The bar becomes one row:

```
[ 3 selected ]        [ Create lesson ]  [ Delete ]  [ Clear ]
```

The new lesson gets the default date title from §1, and the learner renames it on the lesson page
they are pushed to immediately afterwards — except **there is no rename UI today**
(`lessons/[id]/index.tsx` renders the title as a plain `H1`, and there is no `renameLesson` op in
`sync-ops.ts`) `[code]`. So variant A either ships with a rename affordance on the lesson page (a new
op, a new server function — real work) or accepts that a lesson created from the collection is named
by date until then.

**Variant B — keep the field, reveal it on demand.** The bar stays one row; **Create lesson** opens a
small prompt (the existing `ConfirmDialog` pattern with a `TextField`, or a second dialog component)
pre-filled with the default title. The keyboard then sits over a dialog, not over the list, which is
the right place for it. Slightly more code than A, no dependency on a rename feature.

**Variant C — keep the field in the bar.** The bar is ~120pt tall whenever anything is selected, and
the field is what §3.2's keyboard note has to be right about. Not recommended.

Recommendation: **B now** (it is self-contained and loses nothing), **A later** once the lesson page
can rename. Either way §1 must land first, because both make the default title the common case.

### 3.4 Which screens get a footer

Only `/lesson-items`, now. The prop is optional and every other `Screen` call site is untouched.

### 3.5 Verification

- Tick a word with the list scrolled to the top → the bar appears at the bottom of the *viewport*,
  the list shrinks, the last row is still reachable by scrolling.
- Tick 40 words → the bar does not grow; the count reads `40 selected`.
- iPad → the bar's contents stay inside the 760pt column.
- iPhone with a home indicator → the bar sits above it, not under it.
- Focus a text field elsewhere on the page → the bar rides the keyboard rather than being covered
  `[unverified]`.

---

## §4 Deleting a word for good

### 4.1 What exists today: nothing, on any layer

| Layer | State |
|---|---|
| UI (mobile) | No delete. `lesson-items/index.tsx` has favourite + select; `lesson-items/[id].tsx` has favourite. |
| UI (web) | No delete either — grep for it returns only `Map.delete` and `searchParams.delete` `[code]`. |
| HTTP | `packages/shared/src/api.ts` declares `items`, `itemFavorite`, `itemPath` — no delete path. |
| Server | `apps/web/src/lib/words.ts` has `resolveWords` + `addWord`; `lesson-items.ts` has three reads and `setItemFavorite`. No delete. |
| Database | `lesson_items.word_id references words(id) **on delete cascade**` — and the migration's own comment says *"deleting a word (nothing does yet) unlinks it from every lesson"* (`0007_words_m2m.sql:176`) `[code]`. |

So the schema was built in anticipation of exactly this feature and the rest of the stack was not.
This is the largest of the four items, and the only one that needs a migration.

### 4.2 The semantic decision: hard delete or soft delete?

The app has a soft-delete precedent — `lessons.deleted_at` (`0008`) — but it exists for a reason that
**does not transfer**: deleting a lesson must *not* destroy the learner's words or the practice they
earned (`docs/2026-07-17-delete-lesson-keep-words.md`). Deleting a word is the opposite request.

What a **hard** delete destroys, precisely `[code]`:

- The `words` row: text, `norm_key`, `level`, `is_favorite`, `categories`, and the LLM-generated
  `details` payload (the enrichment job's output).
- Every `lesson_items` row referencing it, via the FK cascade — including *removed* ones. That is
  the word's membership history in every lesson, so the lesson's change log
  (`listLessonItemHistory`) loses its "added"/"removed" entries for that word.
- Its practice statistics: `owner_item_practice` is a view over `lesson_items`, so `practice_count`
  and `last_practiced_at` go with the links.

What it does **not** touch: `lesson_sessions` rows (transcripts, summaries, durations) are keyed on
`lesson_id`, never on a word — they survive intact. And the `lexicon` tables are shared reference
data, not owner rows, so a delete cannot reach them.

Why **soft delete is more work than it looks**, if anyone proposes it: `words` has
`unique (owner_id, norm_key)`, and `resolve_words` upserts on that constraint
(`0007_words_m2m.sql:100-118`). A soft-deleted row would still win the conflict, so re-adding the
word would `do update set text = …` on the *deleted* row and leave `deleted_at` set — the add would
report `already-present` and nothing would appear. Making it correct means changing
`resolve_words` (a `SECURITY`-sensitive RPC), plus adding a `deleted_at is null` filter to
`owner_items`, `owner_items_pending_level`, `owner_words_pending_details` and `owner_item_facets`.
Four views and the one RPC the whole identity model rests on.

**Recommendation: hard delete `[design]`**, with confirmation copy that says what is lost. It is what
the FK was written for, it needs no view changes, and re-adding the word afterwards is a clean new
row (which does re-trigger the level + details jobs — one LLM call each, the same as any new word).

### 4.3 The migration

Only RLS, and only as defense-in-depth — every write goes through the service-role client, which
bypasses RLS (`CLAUDE.md`; the same reason `0007` added the inert `lessons owner update` policy):

```sql
-- 0014_delete_word.sql
create policy "words owner delete"
  on words for delete
  using (owner_id = auth.jwt() ->> 'sub');
```

Note that the `lesson_items` cascade runs as the referencing table's owner and is not itself subject
to that table's RLS, so no second policy is needed for the cascade to complete `[unverified — worth a
one-line check against a token-scoped client if `user-client.ts` is ever wired up]`.

### 4.4 The data-layer function

`apps/web/src/lib/words.ts`, beside `addWord`:

```ts
/**
 * Delete one word outright — the only destructive write in the collection.
 *
 * `owner_id` in the filter IS the ownership gate: an id that is not the caller's deletes zero rows
 * and reports false, which is also what a second delete of the same id reports (idempotent).
 *
 * The `lesson_items` rows go with it, by the FK cascade `0007` declared for this exact purpose —
 * including the soft-removed ones, which is why this destroys the word's practice statistics
 * (`owner_item_practice` is a view over those links) while leaving every `lesson_sessions`
 * transcript untouched.
 */
export async function deleteWord(ownerId: string, wordId: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("words")
    .delete()
    .eq("owner_id", ownerId)
    .eq("id", wordId)
    .select("id");
  if (error) throw new Error(`deleteWord: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length > 0;
}
```

### 4.5 The route — and a CORS trap

This is a **direct route, not an outbox op** `[design]`. That preserves the asymmetry both clients
already have and that `apps/mobile/src/lib/items.ts` documents: collection writes bypass the outbox
because `MirrorItem` is keyed on a `lesson_id` a standalone word does not have. Adding a
`deleteWord` op to `sync-ops.ts` would durably store an intent no mirror could render.

⚠️ **`access-control-allow-methods` is `"GET,POST,OPTIONS"`** (`apps/web/src/lib/http.ts`) `[code]`.
A `DELETE` verb would pass on the iOS client (React Native `fetch` sends no `Origin` and applies no
same-origin policy) and **fail the preflight under `expo start --web`**, which is a real surface —
the CORS block exists precisely because `react-native-web` is in the dependency set. Two ways out:

| Option | Change |
|---|---|
| **A. `POST /api/v2/lesson-items/delete`** | Mirrors the existing `POST …/favorite` sibling exactly. Zero CORS change. Least surprising in this codebase. |
| **B. `DELETE /api/v2/lesson-items/:id`** | More RESTful; requires adding `DELETE` to `CORS_HEADERS["access-control-allow-methods"]` — one word, but it widens the namespace's advertised verb set. |

Recommendation: **A** `[design]`. It sits next to the write it most resembles, and the delete
identifier can then be the **word id** (which every row carries) rather than the `norm_key` the
favourite route awkwardly uses.

Contract additions in `packages/shared/src/api.ts`:

```ts
// in API_V2_ROUTES
/** Delete one word outright — it leaves every lesson and loses its practice statistics. */
itemDelete: `${API_V2}/lesson-items/delete`,

export interface DeleteWordRequest { id: string }
/** `POST /api/v2/lesson-items/delete` — 200. */
export interface DeleteWordResponse {
  /** False when no row matched — an id that is not the caller's, or already deleted. */
  ok: boolean;
}
```

Route (`apps/web/src/app/api/v2/lesson-items/delete/route.ts`), modelled line-for-line on
`favorite/route.ts`: `export const dynamic = "force-dynamic"`, `export const OPTIONS = preflight`,
`export const POST = withBearer(…)`, 400 on a missing id, `json({ ok })`.

`delete` is a **literal** sibling of the `[id]` dynamic segment; Next matches literals first, so it
never resolves to a word whose id is `"delete"` — the same non-collision `favorite` and
`/lessons/session` already rely on, and worth repeating in the route's docblock.

Client (`apps/mobile/src/lib/items.ts`), beside `setFavorite`:

```ts
/** Delete one word outright. Keyed by **id**, unlike `setFavorite` — see D66's warning. */
export async function deleteWord(getToken: TokenSource, id: string): Promise<void> {
  const body = await apiFetch<DeleteWordResponse>(API_V2_ROUTES.itemDelete, getToken, {
    method: "POST",
    body: JSON.stringify({ id } satisfies DeleteWordRequest),
  });
  if (!body.ok) throw new Error("That word could not be deleted.");
}
```

### 4.6 The UI

**Where the trash icon goes.** `ItemLine` (`lesson-items/index.tsx:541-591`) gains a third control,
matching the lessons list exactly — `variant="icon" tone="danger"` + `<TrashIcon size={18}
color={theme.error} />` + `accessibilityLabel={`Delete ${item.text}`}`. The row is already
checkbox / text+stats / level pill / star; the bin goes last, after the star.

At phone width that is five things in one row. Measure it `[unverified]`; if it is tight, the level
pill is the element to drop (it is repeated in the word's detail page and is the least actionable).

**The confirm.** One `ConfirmDialog` for the whole list, driven by a `confirmTarget` state, exactly
as `lessons/index.tsx:252-268` does it. **The copy must not be the lesson dialog's copy** — that one
reassures ("Your words and their practice history stay in your collection"); this one has to warn:

```
title:        Delete “ubiquitous”?
description:  It leaves every lesson and loses its practice history and translation.
              This can't be undone.
confirmLabel: Delete
```

**The write.** Optimistic, like `toggleFavorite` above it: drop the row from `data.items`, call
`deleteWord`, restore the snapshot and set `writeError` on failure. Two things `toggleFavorite` does
not have to do:

- **Prune the selection.** `selected` is a `Map` deliberately not pruned when the filter changes
  (`lesson-items/index.tsx:128-135`), so a deleted word would otherwise stay ticked and be sent to
  `createFromSelection` as a text that no longer exists. `setSelected(prev => { const n = new
  Map(prev); n.delete(id); return n; })` on success.
- **Say the counts are now stale.** `lesson_count` on other rows does not change (a delete touches
  one word), so no refetch is needed — but the *lessons* screen's item counts and previews do
  change, and it refetches on focus/pull already. No action; noted so nobody adds a global
  invalidation that is not needed.

**The word detail page** (`lesson-items/[id].tsx`) should get the same button — the header's
`ActionRow` beside `RefreshButton` is the natural slot — with `router.back()` after a successful
delete, since the screen it is on ceases to exist. Same dialog, same copy.

**Bulk delete** (`Delete` in §3's selection bar) is the natural companion and needs no new server
work if it loops `deleteWord` over the selection — but a partial failure mid-loop is a state the
error panel has no vocabulary for. Recommendation: ship the per-row delete first, and only add the
bulk action once the single one is proven `[design]`. If it is added, the confirm must say how many:
*Delete 12 words?*

### 4.7 What must be checked before this is called done

- A word in **two** lessons: deleting it removes it from both, and neither lesson page 500s
  (`getLesson` embeds `words(text)` — the link row is gone, so there is nothing to embed
  `[unverified]`).
- A word deleted **while a tutor session is live on a lesson containing it**: the session holds its
  own copy of the word list from conversation start, so the conversation is unaffected; the
  transcript still saves (keyed on `lesson_id`) `[unverified]`.
- Deleting a word then re-adding the same text: it comes back as a new row, unlevelled and
  un-enriched, and the background jobs pick it up on the write path (`scheduleWordJobs` runs on
  `status === "added"`, `apps/web/src/app/api/v2/lesson-items/route.ts`) `[code]`.
- Deleting the same id twice: second call reports `ok: false`, the UI shows the existing write-error
  panel rather than crashing.
- Another owner's id: `ok: false`, no row touched — the `owner_id` filter is the gate.

---

## §5 Suggested order

1. **§1** — the smallest, and a genuine data bug that is writing permanent, invisible rows right
   now. Ship the client fix + the render fallback together; the server guard and the SQL repair can
   follow.
2. **§2** — self-contained, one screen, needs the `hitSlop` prop on `Button`.
3. **§4** — the largest, and independent of §3. Migration → data layer → contract → route → client →
   per-row UI, in that order, so nothing is ever half-wired.
4. **§3** — last, because its bar wants §4's *Delete* action and its recommended variant depends on
   §1's default title being reliable.

`pnpm --filter mobile check` (typecheck → lint → expo-doctor → bundle) before pushing any of it, per
`CLAUDE.md`; `pnpm typecheck` at the root for §1's shared-import change and §4's `api.ts` addition;
`pnpm db:migrate` for §4's policy.

## §6 Open questions for the product owner

1. **§3, variant A vs B** — is the learner allowed to name a lesson at creation time from the
   collection (B: a prompt dialog), or is naming pushed onto the lesson page (A: which needs a
   rename feature that does not exist)?
2. **§4, bulk delete** — wanted in the first cut, or after?
3. **§4, the level pill** — if `ItemLine` is too tight with five controls, may it go?
4. **§1, the repair** — should existing blank-titled lessons be back-filled with their creation date,
   or left for the learner to rename?

---

## §7 What was built, and where it departs from the plan

Implemented in the order §5 gives. The four open questions in §6 were answered by taking this
document's own recommendations; each is recorded below rather than left hanging.

### §1 — the default title

- `createFromSelection` now takes the title as an argument and applies the fallback on the blank
  branch, fetching the taken titles only then (option A). `[code]`
- `lessonTitleOrFallback` in `apps/mobile/src/lib/lessons.ts` renders `Untitled lesson` for a row
  that already has none — used by the lessons list and the lesson page.
- The server guard went **into `createLesson` itself** rather than into `applyOp` as §1.5 sketched.
  `lessonTitleOrDefault` runs the extra query on the blank branch only, so no caller of the data
  layer can write a blank title — a stronger place for it than the one op that happens to call it.
- The one-off SQL repair (§1.5 item 3) was **not** run. It is a data edit against production and
  belongs to whoever owns that database, not to this branch — question 4, answered by not answering
  it in code.

### §2 — the tappable row

As designed: `Pressable` + `router.push`, the title demoted from `Link` to `Body`, a `sunken`
pressed tint, and `hitSlop` added to `Button` (a new prop) so the bin inside the row is not hit by
a near-miss. The nested-pressable behaviour is still `[unverified]` — it needs a thumb.

### §3 — the pinned bar

Variant **B**: the bar is one row (`N selected` · **Create lesson** · **Clear**) and the lesson
title moved into a new `PromptDialog`, so the keyboard opens over a dialog instead of over the list
still being chosen from — question 1, answered. Variant A stays out of reach until the lesson page
can rename, exactly as §3.3 said.

`Screen` gained the `footer` slot as a flex sibling of the `ScrollView`. One detail the plan did not
mention and the code needs: the `ScrollView` gets `style={styles.flex}` **only when a footer is
present**, because a `ScrollView` with no flex style sizes to its content and a long page would push
the bar off the bottom.

`PromptDialog` resets its field with React's "adjust state when a prop changes" pattern rather than
an effect — `react-hooks/set-state-in-effect` rejects the effect version, and an effect would flash
the previous draft for one frame before blanking it.

### §4 — deleting a word

Hard delete, as recommended. Migration `0014_delete_word.sql` (an RLS policy and the reasoning),
`deleteWord` in `lib/words.ts`, `POST /api/v2/lesson-items/delete` (option A — the CORS verb list
made `DELETE` the wrong choice), `deleteWord` in the mobile items client, a bin per row in
`ItemLine`, and the same bin on the word detail page.

- The list's delete is **optimistic and prunes the selection**; the detail page's is **not
  optimistic**, because `router.back()` on a failed write would drop the learner on the list with
  the word still in it and no error anywhere.
- **Bulk delete was not built** — question 2, answered as §4.6 recommended: the per-row delete
  ships first. The bar has room for it.
- **The level pill stayed** — question 3. `ItemLine` is now checkbox / text+stats / level pill /
  star / bin, which is five controls in a row and the thing to look at on the smallest device
  before this is called finished `[unverified]`.

### Still to do before this is merged

1. Run `pnpm db:migrate` — `0014` is written but not applied.
2. Everything in §1.6, §2.2, §3.5 and §4.7 that is marked `[unverified]`: they all need a device.
3. Decide the §1.5 SQL repair for lessons already written with a blank title.
