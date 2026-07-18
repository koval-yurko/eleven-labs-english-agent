# Delete a lesson — soft-delete it, keep the words (and their practice credit)

**Date:** 2026-07-17
**Status:** IMPLEMENTED 2026-07-17 — `supabase/migrations/0008_soft_delete_lessons.sql` +
`deleteLesson` in `src/lib/lessons.ts` + the `deleteLesson` outbox op (types / engine / mirror /
actions) + a delete control in `src/app/LessonsList.tsx`. `pnpm typecheck` + `pnpm lint` pass. All
eight migrations applied cleanly to a throwaway Postgres and the view divergence was verified on
seeded data: a word whose only lesson was deleted reads as unattached (lesson_count 0, 0 chips) yet
keeps its `practice_count`; a shared word keeps its other lesson; the underlying items/sessions/words
rows are all retained. The migration is **not yet applied to the live database** (no
`SUPABASE_DB_URL` in this environment) — run `pnpm db:migrate` to apply.
**Related:** [`2026-07-16-add-word-on-lesson-items-page.md`](./2026-07-16-add-word-on-lesson-items-page.md),
[`2026-07-04-offline-support-and-sync.md`](./2026-07-04-offline-support-and-sync.md),
[`2026-07-16-level-assignment-background-job.md`](./2026-07-16-level-assignment-background-job.md)

## The ask

Let the learner delete a lesson. The lesson **disappears from the UI** and its words become
**unattached** — a word that was only in the deleted lesson stays in the collection, now in no
lesson. But this is a **soft delete**: the lesson's rows are kept, so the words **retain the practice
credit** they earned there, and a future **Archive page** can list deleted lessons (and, later,
restore or permanently delete them).

Decisions locked in this round:

- **Soft delete, not hard delete.** Conversation history is preserved; practice credit stays on the
  words.
- **Words are untouched by the delete.** A word stays exactly as it is — still in the collection,
  still practiceable in any *other* lesson it belongs to. Deleting a lesson only removes *that*
  lesson's attachment and chip; a word shared with a live lesson keeps that lesson entirely.
- **No bulk delete** for now — one lesson at a time.
- **No undo window** — the Archive page is the safety net instead.

## The headline

Two things make this small, both from the 0007 `words` reshape:

1. **Words already survive.** `words` is its own entity that `lesson_items` *references*
   (`lesson_items.word_id → words.id`); there is no arrow from a lesson to a word. Deleting — or
   soft-deleting — a lesson can never reach the vocabulary. A word in no *visible* lesson is the
   natural base case of the `owner_items` LEFT JOIN (`lesson_count = 0`), not a state to construct.
2. **The soft-delete flag is one column.** Item removal already works this way
   (`lesson_items.removed_at`, `0003`); lessons get the same treatment one level up:
   `lessons.deleted_at`.

**The one genuinely new idea is that the two derived views must now diverge on what a deleted lesson
means:**

| View | Treats a soft-deleted lesson as… | So that… |
|---|---|---|
| `owner_items` (attachment / chips) | **not attached** | the word reads as unattached the moment the lesson is deleted |
| `owner_item_practice` (practice credit) | **still counts** | the word keeps the `practice_count` / `last_practiced_at` it earned there |

That split *is* the feature. Everything else — the flag, the data-layer call, the offline op — is
mechanical.

## Schema — `0008_soft_delete_lessons.sql`

```sql
-- Soft delete for a whole lesson, mirroring lesson_items.removed_at one level up. NULL = active.
-- The rows underneath (lesson_items, lesson_sessions) are deliberately KEPT: that is what preserves
-- each word's practice credit and what the future Archive page reads.
alter table lessons add column deleted_at timestamptz;

-- The active-lessons list is the hot path; keep it a partial index so soft-deleted rows don't
-- widen it. (The existing lessons_owner_created_idx stays for the Archive page's full scan.)
create index lessons_owner_active_idx on lessons (owner_id, created_at desc) where deleted_at is null;
```

Then **rebuild `owner_items` only** — same columns, so `create or replace view` works; the change is
purely adding `l.deleted_at is null` to the three lesson-attachment aggregates. `owner_item_practice`
is **left untouched**, which is exactly what keeps practice credit alive across the delete.

```sql
-- owner_item_practice: UNCHANGED. It counts sessions held while the word was linked, regardless of
-- whether the lesson was later soft-deleted — so a deleted lesson still credits its words.

-- owner_items: the ONLY change is `l.deleted_at is null` on each attachment aggregate, so a
-- soft-deleted lesson stops counting toward the word's attachment and stops appearing as a chip.
create or replace view owner_items with (security_invoker = true) as
select
  w.id, w.owner_id, w.norm_key, w.text,
  lesson_item_kind(w.norm_key) as kind,
  -- was: count(distinct i.lesson_id)
  count(distinct i.lesson_id) filter (where l.deleted_at is null)                        as lesson_count,
  count(distinct i.lesson_id) filter (where i.removed_at is null and l.deleted_at is null) as active_lesson_count,
  w.created_at as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      filter (where i.removed_at is null and i.lesson_id is not null and l.deleted_at is null),
    '[]'::jsonb)                                                                          as lessons,
  coalesce(p.practice_count, 0) as practice_count,   -- from the UNCHANGED practice view → credit kept
  p.last_practiced_at,
  w.level, w.level_source, w.is_favorite, w.categories
from words w
left join lesson_items i on i.word_id = w.id
left join lessons      l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;
```

Why the filters and not a join condition: the aggregates count `i.lesson_id` (from `lesson_items`),
which is non-null even when the word's only lesson is deleted. Filtering each aggregate on
`l.deleted_at is null` is what actually drops the deleted lesson from the count and the chip list.
For a word with no links at all, the LEFT JOIN yields `l` null → `l.deleted_at is null` is NULL →
the filter excludes it → `lesson_count = 0`, unchanged from today.

**Net effect on a word whose only lesson was just deleted:** `lesson_count` and `active_lesson_count`
→ 0, `lessons` chips → `[]`, but `practice_count` / `last_practiced_at` stay exactly as they were.
Unattached, but with its history intact — precisely the ask.

## Server data layer

Soft delete is an **UPDATE**, not a DELETE — so `deleteLesson` in `src/lib/lessons.ts` looks like
`removeLessonItem` (`lessons.ts:241`), one level up:

```ts
/**
 * Soft-delete a lesson: set deleted_at so it drops out of the UI and its words read as unattached,
 * while its lesson_items / lesson_sessions rows stay — preserving each word's practice credit and
 * the row the Archive page will show. Owner-scoped and idempotent: a foreign, missing, or
 * already-deleted lesson matches nothing and is a no-op. Returns whether a row changed.
 */
export async function deleteLesson(ownerId: string, lessonId: string): Promise<boolean> {
  const { data, error } = await getServiceSupabase()
    .from("lessons")
    .update({ deleted_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("id", lessonId)
    .is("deleted_at", null)
    .select("id");
  if (error) throw new Error(`deleteLesson: ${error.message}`);
  return ((data as { id: string }[] | null) ?? []).length > 0;
}
```

The `.is("deleted_at", null)` guard both makes re-delete a no-op and keeps `deleted_at` stable at the
*first* deletion time across offline replays (a second replay matches zero rows rather than bumping
the timestamp).

**Queries that must now exclude deleted lessons** (add `.is("deleted_at", null)`):

- `listLessons` (`lessons.ts:55`) — the home/lessons list.
- `getLesson` (`lessons.ts:79`) — so the tutor page and detail page 404 on a deleted lesson, and so
  `saveLessonSessionAction`'s ownership gate rejects a session for one.

**Deliberately left unfiltered:** `getLessonById` (`lessons.ts:99`), the webhook lookup. A late
post-call webhook for a since-deleted lesson should still upsert its session — that session is part
of the practice credit we're preserving. Worth a one-line comment there so it doesn't read as an
oversight.

Restore/permanent-delete for the Archive page are future work (see [Open questions](#open-questions));
`deleteLesson` is the only new function this feature needs.

## Offline sync — the real integration work

Create/add/remove all flow through the offline outbox (`docs/2026-07-04-offline-support-and-sync.md`)
and delete must too — the UI writes the IndexedDB mirror optimistically and queues an op.

**1. New op** (`src/lib/sync/types.ts`):

```ts
/** Soft-delete a lesson (server keeps its rows; the word set just leaves the active list). */
export interface DeleteLessonOp {
  kind: "deleteLesson";
  lessonId: string;
}
export type OutboxOp = CreateLessonOp | AddItemsOp | RemoveItemOp | DeleteLessonOp;
```

**2. Optimistic local delete** (`src/lib/sync/engine.ts`). The mirror only ever holds *active*
lessons (it's the list surface), so locally the soft delete looks like a removal — drop the lesson
and its mirrored items, queue the op:

```ts
export async function deleteLessonLocal(lessonId: string): Promise<void> {
  const db = getDb();
  await db.transaction("rw", db.lessons, db.items, db.outbox, async () => {
    await db.lessons.delete(lessonId);
    const itemIds = await db.items.where("lesson_id").equals(lessonId).primaryKeys();
    if (itemIds.length > 0) await db.items.bulkDelete(itemIds);
    await appendOutbox(db, { kind: "deleteLesson", lessonId });
  });
}
```

**3. Replay** (`src/app/lessons/actions.ts`, `applyOp`): a `deleteLesson` case calling
`deleteLesson(ownerId, op.lessonId)`. `opLessonId` already returns `op.lessonId` for non-create ops,
so revalidation of `/lessons/[id]` works unchanged — **also revalidate `/lesson-items`** (a word's
attachment just changed) and `/` if the home surfaces lessons.

**4. Reseed guard.** `mirror.ts:30` currently notes, on `seedLessons`, *"Upsert-only (no
stale-deletion): lesson deletion isn't a feature yet."* This feature is what it was waiting for.
Once the delete has synced, the server's `listLessons` no longer returns the lesson, so nothing
resurrects it. The gap is the window **before** the op flushes: a server payload fetched earlier
still lists the lesson, and `seedLessons` would put it back. Mirror the existing `pendingItemState`
pattern — collect `deleteLesson` `lessonId`s into a pending-delete set and have `seedLessons`
(and `seedLessonItems`) skip them until the op drains.

**Create-then-delete offline** (a lesson made and deleted before either synced): the outbox holds
`createLesson` then `deleteLesson` for the same id; `seq` order replays create → soft-delete, a
correct if slightly wasteful no-op. Optionally, if `deleteLessonLocal` finds an unsynced
`createLesson` for this id still queued, drop both ops instead of appending. Not required for
correctness (replay converges), just tidy.

Idempotency falls out as everywhere else: the guarded UPDATE of an already-deleted (or missing)
lesson matches zero rows without erroring, so a half-applied or double-flushed batch converges.
`flushOutbox` applies in `seq` order and stops at the first failure, so a `deleteLesson` always lands
after the ops that created/populated that lesson.

## RLS — nothing new needed

Because soft delete is an **UPDATE on `lessons`**, the `"lessons owner update"` policy that 0007
added proactively (`0007_words_m2m.sql:311`) already covers it — no new policy in this migration.
`lesson_items` / `lesson_sessions` aren't touched at all. DELETE policies on the three tables only
become necessary when the **Archive page implements permanent deletion**; defer them to that
migration, alongside the hard-delete cascade they'd protect.

## UI

- A **Delete** control per row in `LessonsList` (`src/app/LessonsList.tsx`) and/or on the lesson
  detail page (`src/app/lessons/[id]/page.tsx`).
- Because it's a soft delete with an Archive, the copy can be reassuring rather than dire:
  *"Delete this lesson? Your words and their practice history stay in your collection — you can find
  the lesson in Archive later."* No dire "history will be lost" warning, because nothing is.
- **Avoid `window.confirm`** — a native modal blocks the event loop and sits awkwardly with the
  optimistic offline write. Use an inline confirm / small dialog, then call `deleteLessonLocal`
  + `requestFlush`.

## Verification plan

Following 0007's practice, exercise the SQL in a container before the app:

1. **View divergence — the core claim.** Seed a word whose *only* lesson is L, with a session on L
   (so it has practice credit). Soft-delete L. Assert on `owner_items` for that word:
   `lesson_count = 0`, `active_lesson_count = 0`, `lessons = []`, **and** `practice_count` unchanged,
   `last_practiced_at` unchanged. A word shared with another live lesson keeps that lesson's chip and
   its `active_lesson_count` drops by exactly one.
2. **List filtering.** `listLessons` and `getLesson` no longer return L; `getLessonById(L)` still
   does (webhook path).
3. **Owner gate + idempotency.** `deleteLesson(otherOwner, L)` → false, no change. `deleteLesson`
   twice → second returns false, `deleted_at` unchanged from the first call.
4. **Offline round-trip.** Delete offline → gone from the list immediately, op queued; reconnect →
   `deleted_at` set server-side, outbox drained; a stale `seedLessons` payload does **not** resurrect
   it (pending-delete guard).
5. **Create-then-delete offline** → flush leaves a soft-deleted lesson server-side (or none, if the
   ops were collapsed) and an empty outbox.
6. `pnpm typecheck` + `pnpm lint`.

## Open questions

1. **Archive page scope (next).** Not built here, but this migration should leave the door open. It
   needs: a `listLessonsArchived(ownerId)` (the `deleted_at is not null` counterpart of
   `listLessons`, which the retained `lessons_owner_created_idx` covers), a **restore**
   (`update … set deleted_at = null`, covered by the existing update policy), and eventually a
   **permanent delete** (the hard `DELETE … on delete cascade` from this doc's earlier draft — the
   point at which the deferred DELETE RLS policies and the practice-credit trade-off come back). All
   future work; flagged so nothing here blocks it.
2. **Bulk delete / undo** — explicitly out of scope this round (Archive replaces undo). A future
   multi-select on `/lessons` would just be N `deleteLesson` ops, mirroring the `/lesson-items`
   multi-select from `2026-07-17-lesson-items-multiselect-and-word-detail.md`.
