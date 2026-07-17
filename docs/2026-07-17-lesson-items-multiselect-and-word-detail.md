# Multi-select "create lesson from words" + word detail page

_2026-07-17 — research / design note_

## What we're building

Two additions to the `/lesson-items` surface:

1. **Multi-select → create a lesson.** Let the learner tick several words on `/lesson-items`
   and spin up a new lesson from exactly that selection. Because a word is many-to-many with
   lessons, the same words can seed any number of lessons — "several lessons with the same words"
   is the intended, already-supported outcome, not a special case.
2. **A word detail page** (`/lesson-items/[id]`) showing one word's info and the lessons it
   currently participates in. Content is deliberately thin now — a scaffold with room for details
   we'll add later.

Neither feature needs a database migration. The schema already models everything both need; this
is UI + a thin data-access addition.

---

## Why the data model already supports it

Since migration `0007_words_m2m.sql` the vocabulary is a `words` table and `lesson_items` is a pure
join table (`lesson_id` + `word_id` + `position`, soft-deleted via `removed_at`). A word's identity
is its Postgres-computed `norm_key` (`unique (owner_id, norm_key)`), and text → word id always goes
through the `resolve_words` RPC (`src/lib/words.ts`).

Consequences that make feature 1 almost free:

- **Sharing words across lessons is native.** `resolve_words` upserts by `(owner_id, norm_key)`, so
  the same word text used in two lessons resolves to the *same* `words.id`, linked twice via two
  `lesson_items` rows. Two lessons built from overlapping selections correctly share word rows.
- **`linkWords` already dedupes** within a lesson and against a batch (it must, or it would violate
  the `lesson_items_lesson_word_active_idx` partial-unique index), so a selection containing
  near-duplicates is safe.
- **The list page already has the texts.** Each `ItemRow` carries `text`; creating a lesson only
  needs those texts (the server re-resolves them to word ids).

`owner_items.lessons` is defined as **active** participation only — `jsonb_agg(...) filter (where
i.removed_at is null and i.lesson_id is not null)` — which is exactly "lessons it participates in"
for the detail page. Full historical participation (lessons a word was removed from) would need
`lesson_items` history and is a "later" detail, not part of this pass.

---

## The one real design decision: which mutation path does "create lesson" use?

The two surfaces have **two different mutation models**, and this is the crux of feature 1:

| Surface | Mutations | Path |
|---|---|---|
| `/lesson-items` | favorite, add-word | **plain Server Actions, online-only** — no IndexedDB mirror |
| `/` + `/lessons/[id]` | create lesson, add/remove items | **offline outbox** — Dexie mirror + `flushOutbox` |

Creating a lesson is an operation that already lives in the outbox world (`createLessonLocal` →
`flushOutbox` → `createLesson` → `linkWords`). We have two options:

- **(A — recommended) Reuse the outbox path.** Call the existing `createLessonLocal` from
  `src/lib/sync/engine.ts`, exactly as `NewLessonForm` does. This keeps the home lessons list (which
  reads the Dexie mirror as authoritative) consistent — the new lesson appears there instantly —
  and it's offline-capable for free.
- **(B) A new plain Server Action** `createLessonFromWords`. Simpler to write, but it bypasses the
  mirror, so the home `LessonsList` wouldn't show the new lesson until the mirror is re-seeded (a
  reload). That's an inconsistency users would notice. Rejected.

**Go with (A).** The `AddWordForm`'s "online-only, not an outbox op" reasoning does *not* apply here:
that note is about a *standalone word* whose `MirrorItem` can't be keyed (no `lesson_id`). A created
lesson *has* a `lesson_id`, so `createLessonLocal` mirrors it cleanly. The precedent to copy is
`NewLessonForm.onSubmit` verbatim: mint ids client-side → `createLessonLocal` → online:
`flushOutboxNow()` + `router.push('/lessons/{id}')`; offline: `requestFlush()`.

### One gotcha: the mirror owner guard

`createLessonLocal` writes the Dexie mirror but does **not** call `ensureOwner` (mirror.ts). Today
the mirror's `owner` meta row gets set by `LessonsList`/`NewLessonForm` seeding on the home page. A
learner who lands directly on `/lesson-items` and creates a lesson there may never have hit that
path, so the create flow must call `ensureOwner(ownerSub)` **before** `createLessonLocal`. That means:

- `page.tsx` must pass `ownerSub` (the Auth0 `sub`) down into `ItemsBrowser` (it already computes
  `ownerId`), the same way `LessonsList` receives `ownerSub`.
- The create handler calls `await ensureOwner(ownerSub)` first.

Without this, on a shared device a stale mirror owner could mix one learner's optimistic lesson into
another's view. Cheap to get right; easy to miss.

---

## Feature 1 — multi-select UX

All of this lives in `ItemsBrowser.tsx` (already a client component), so no new island wiring beyond
what's above.

**Selection state.** Add `const [selected, setSelected] = useState<Set<string>>(new Set())` keyed by
`item.id`. Selection survives filter/sort changes because those do `router.replace` on the *same*
route — `ItemsBrowser` stays mounted, only its `items` prop changes. **Decided: selection is kept
across filter/sort changes** (not pruned to the visible set), so a learner can narrow to B2 words,
tick a few, switch to "in no lesson", tick a few more, and create one lesson from the union. Ids that
scroll out of the current filter stay selected but aren't visible; the action bar always shows the
full count. Because the detail lookup carries `text`, the action bar can still name/create the lesson
even for selected-but-hidden ids — but `ItemRow.text` only exists for rows currently in `items`, so
**keep a small `Map<string, string>` (id → text) of everything ever selected** alongside the id set,
and build the new lesson's items from that map. This keeps create correct when the current filter no
longer contains some selected words.

**Per-row control.** Add a checkbox to `ItemLine`. Keep it visually distinct from the word text so
the two click targets don't fight: checkbox = select, word text = navigate to detail (feature 2).
`ItemLine` currently takes only `item`; it'll need `selected` + `onToggle` props (or read from a
small context to avoid prop-drilling — prop-drilling is fine at this size).

**Action bar.** When `selected.size > 0`, show a sticky bar (bottom or top of the list panel):

```
[ 3 selected ]   Title: [__________ (optional)]   [ Create lesson ]   [ Clear ]
```

- Title defaults exactly like `NewLessonForm`: `first` text, or `${first} +${n-1} more`, capped 120.
- "Create lesson" collects the selected items' `text` in a stable order (list order), maps to
  `{ id: crypto.randomUUID(), text }`, runs the ensureOwner → createLessonLocal → flush → push flow,
  then clears the selection.
- Respect `MAX_ITEMS = 50` (import from `sync/engine`) — disable/trim if the selection exceeds it and
  tell the user, mirroring the lesson item cap.

**Empty/duplicate handling** is already covered server-side by `linkWords`, and client-side by
`createLessonLocal` (it dedupes texts by `trim().toLowerCase()`). Nothing extra needed.

**Offline.** Because we reuse the outbox, offline create works: the lesson is queued and shows on the
home list; opening it still needs a connection (same limitation as `NewLessonForm` today). Match its
branch: online push to the lesson, offline just `requestFlush()` and maybe a toast.

### Scope note
Feature request is *create* only. "Add selected words to an **existing** lesson" is the obvious
sibling (an `addItems` outbox op against a chosen `lessonId`) and the data layer already supports it
via `upsertLessonItems`/`addItemsLocal` — worth a follow-up, out of scope here.

---

## Feature 2 — word detail page `/lesson-items/[id]`

**Route.** Add `src/app/lesson-items/[id]/page.tsx`. App Router allows the static `/lesson-items`
page and the dynamic `/lesson-items/[id]` to coexist. The `[id]` is the **`words.id` uuid** (not the
`norm_key`) — it's the stable primary key and avoids URL-encoding a normalized string. `owner_items`
exposes `id`, so this is a clean lookup.

**Naming.** The entity is a "word" now, but the page family is `/lesson-items` and the user calls it
"lesson-item detail". Keep the URL under `/lesson-items` for cohesion; call the thing a "word" in the
UI copy, consistent with the "Words" nav label.

**Data access — one new function** in `src/lib/lesson-items.ts`:

```ts
export async function getItem(ownerId: string, id: string): Promise<ItemRow | null> {
  const { data, error } = await getServiceSupabase()
    .from("owner_items").select("*")
    .eq("owner_id", ownerId).eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getItem: ${error.message}`);
  return (data as ItemRow | null) ?? null;
}
```

Reuses the existing `ItemRow` type — the detail page gets text, `kind`, `level`, `is_favorite`,
`categories`, all the stats (`practice_count`, `lesson_count`, `last_practiced_at`, `first_added_at`),
and `lessons: {id,title}[]` (the active participations) in one row. No new query shape.

**Page content (now):**

- Header: the word `text`, favorite star (reuse `FavoriteButton`), level pill, `kind`.
- Stats line: reuse the same `stats` composition as `ItemLine`.
- **"In lessons"**: render `item.lessons` as links to `/lessons/{id}`, or "in no lesson".
- Categories: render the `categories` map (each is a future filter/edit surface).
- Placeholder sections for the "details added later" (translations, word forms, example
  sentences, notes — see the 0.x word-detail docs). Leave clearly-labeled empty regions rather than
  inventing schema now.

**Linking from the list.** In `ItemLine`, make the word text link to `/lesson-items/{item.id}`. This
is the second click target alongside the selection checkbox — keep them visually separate.

**404 / not-yours.** `getItem` returns `null` for a missing id or one owned by someone else (the
`owner_id` filter is the gate); the page should `notFound()` in that case.

### Future detail (flagged, not built)
- **Historical lesson participation** (lessons a word was removed from) needs a `lesson_items`
  history read joined to `lessons` — a small dedicated function, not the `owner_items` view.
- **Editing** categories / favorite already has a write path (`setItemFavorite`); category editing
  would be a new action on `words.categories`.

---

## File-by-file change list

**Feature 1 (multi-select create):**
- `src/app/lesson-items/page.tsx` — pass `ownerSub` into `ItemsBrowser`.
- `src/app/lesson-items/ItemsBrowser.tsx` — selection `Set` state, per-row checkbox, sticky action
  bar, create handler (`ensureOwner` → `createLessonLocal` → `flushOutboxNow`/`requestFlush` →
  `router.push`). Import `createLessonLocal`, `flushOutboxNow`, `requestFlush`, `MAX_ITEMS` from
  `sync/engine`, `ensureOwner` from `sync/mirror`.
- No server action, no data-layer, no migration.

**Feature 2 (detail page):**
- `src/lib/lesson-items.ts` — add `getItem(ownerId, id)`.
- `src/app/lesson-items/[id]/page.tsx` — new server component; `getItem` → render or `notFound()`.
- `src/app/lesson-items/ItemsBrowser.tsx` — link the word text to `/lesson-items/{id}`.
- (Optional) extract a small `WordHeader`/stats helper shared by `ItemLine` and the detail page.

**No changes to:** the schema/migrations, `resolve_words`, `lessons.ts` write paths, the outbox
contract (`sync/types.ts`) — feature 1 reuses the existing `createLesson` op unchanged.

---

## Open questions

1. ~~**Selection persistence across filter changes.**~~ **Decided: keep selected words across
   filter/sort changes** (union selection, not pruned to the visible set). Requires tracking an
   id → text map of selected words, since `ItemRow.text` is only present for currently-visible rows.
2. **Detail-page id** — confirm routing by `words.id` uuid (recommended) vs `norm_key`.
3. **Add-to-existing-lesson** — in scope later? Data layer is ready; it's an `addItems` op + a lesson
   picker in the action bar.
4. **Offline create from `/lesson-items`** — accept the same "queued, opens on reconnect" limitation
   as `NewLessonForm`, or gate the button to online-only here? Recommend matching `NewLessonForm`.
