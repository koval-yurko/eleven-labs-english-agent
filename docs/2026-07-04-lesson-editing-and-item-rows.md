# Editable lessons — per-row items, add/remove words, and lesson change history

_Date: 2026-07-04 — research / design note (nothing implemented yet)._

**Goal:** today a lesson's word list is frozen at creation (`lessons.items text[]`, no
edit/delete UI — see the "Not done" list in
`docs/2026-07-03-lessons-page-and-history.md`). We want to:

1. **Create** a lesson with new words (already works) and **update** an existing one —
   add and remove words/sentences.
2. Show those changes in the lesson's **history** ("added _X_ on …", "removed _Y_ on …").
3. Restructure the schema so **each word/sentence is its own row**, so we can later
   extract and analyze everything learned, and recombine words into new lessons or groups.

## TL;DR — recommendation

- Replace the `lessons.items text[]` column with a **`lesson_items` table — one row per
  word/phrase/sentence**, owner-scoped like everything else.
- Use **soft-delete** (`removed_at timestamptz`) instead of `DELETE`. This gives the
  add/remove **history for free** — the item rows _are_ the change log — and keeps every
  word ever studied available for analysis. Re-adding a removed word inserts a **new row**
  (the old one stays as history).
- Add a **`normalized_text` generated column** (`lower(btrim(text))`) now; it costs
  nothing and makes the future "all words I've learned" / dedupe-across-lessons queries
  trivial without committing to a full vocabulary table yet.
- **Don't** build a separate audit/event table or a normalized `words` +
  `lesson_words` join yet — both are easy to layer on later and would be speculative today
  (reasoning below).
- Migrate in one step (backfill from `items`, then drop the column) — single-user app,
  no old-code/new-schema overlap to worry about.

## Current state (what the change touches)

```text
lessons.items  text[]                 -- one word/phrase/sentence per element, set once
```

Everything that reads or writes the list:

| Touch point | File | What it does with `items` |
|---|---|---|
| Create | `src/app/lessons/actions.ts` `createLessonAction` | splits textarea → `text[]` (cap 50) |
| Data access | `src/lib/lessons.ts` | `Lesson.items: string[]` flows through `listLessons` / `getLesson` / `createLesson` |
| Lesson page | `src/app/lessons/[id]/page.tsx` | renders "Words in this lesson" |
| Home list | home page (lessons list) | word preview per lesson |
| Voice tutor | `src/app/lessons/[id]/LessonTutor.tsx` | builds the `{{items_list}}` dynamic variable (`"1. …; 2. …"`) sent to the ElevenLabs agent |

No UI or server path mutates a lesson after creation. Neither `lessons` nor
`lesson_sessions` has an RLS **update** policy — only select/insert — so any edit feature
needs new policies regardless of schema shape.

## Schema options considered

### A. Keep `text[]`, add an edit action + a change-log table

Smallest diff: `update lessons set items = …`, plus a `lesson_changes(lesson_id, action,
item, at)` row per add/remove.

- ✅ No backfill, no read-path changes.
- ❌ Words stay opaque inside an array — the stated analysis goal ("extract and analyze
  all words we learned", recombine into new lessons/groups) stays a `unnest()` away at
  best, and there's no stable per-word identity (no timestamps, no cross-lesson linking).
- ❌ Two sources of truth (array + log) that can drift.

Rejected: it defers exactly the restructuring the user asked for.

### B. `lesson_items` table with soft-delete — **recommended**

One row per item; removal sets `removed_at` instead of deleting. The lesson's current
word list = active rows ordered by `position`; the lesson's change history = all rows
ordered by `created_at` / `removed_at`.

- ✅ Per-word identity, timestamps, owner scoping — the analysis substrate the user wants.
- ✅ History is **derived, not duplicated**: an item row with `created_at` is an "added"
  event; one with `removed_at` is also a "removed" event. No separate log to keep in sync.
- ✅ "All words ever studied" survives removals (nothing is deleted).
- ✅ Reconstructing "what was in the lesson during session S" works from timestamps:
  `created_at <= s.created_at and (removed_at is null or removed_at > s.created_at)`.
- ❌ Slightly heavier reads (a join/embed instead of one column) — negligible at this
  scale, and Supabase's resource embedding keeps it one query.

### C. Normalized vocabulary: `words` table + `lesson_words` join

The "textbook" design: a canonical word row shared across lessons, lessons reference it.

- ✅ Perfect dedupe; groups/decks/SRS attach naturally to the word row.
- ❌ Premature: items here are free-form words **and phrases and sentences**; canonical
  identity is murky ("go over" vs "go over sth"), and every create/add needs
  find-or-create logic. The immediate goals (edit + history + analysis) don't need it.
- The `normalized_text` column in option B is the bridge: when a real vocabulary/SRS
  feature arrives, `select distinct normalized_text …` seeds the `words` table and a
  backfill migration links existing `lesson_items` to it. Nothing done now blocks that.

### History mechanism within option B

Two sub-options for recording changes:

1. **Soft-delete only (recommended).** `created_at`/`removed_at` on the item rows are the
   events. Covers add + remove completely. What it does _not_ cover: title renames or
   in-place text edits. Model a text edit as **remove + add** (two rows) — which is
   honest for a learning app: "colour" → "color" really is a different item, and the
   history should show both.
2. **Explicit `lesson_events` audit table** (or a Postgres trigger writing to one).
   Needed only if we want history for non-item mutations (title renames) or arbitrary
   metadata per event. Verdict: defer; add it when title editing ships, if we care about
   its history at all.

## Proposed schema — migration `0003_lesson_items.sql`

```sql
-- lesson_items — one row per word/phrase/sentence in a lesson.
-- Soft-delete: removing a word sets removed_at (rows are never deleted), so the
-- add/remove history of a lesson is derivable from these rows alone, and every
-- word ever studied stays available for analysis. Re-adding after removal
-- inserts a NEW row.
create table lesson_items (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references lessons(id) on delete cascade,
  owner_id text not null,                       -- Auth0 sub (copied from the lesson)
  text text not null,
  -- lower/trimmed form for cross-lesson analysis ("all words I've learned", dedupe).
  normalized_text text generated always as (lower(btrim(text))) stored,
  position integer not null,                    -- display order among ACTIVE items
  created_at timestamptz not null default now(),-- = "added at"
  removed_at timestamptz                        -- null = active
);

create index lesson_items_lesson_idx on lesson_items (lesson_id, position)
  where removed_at is null;                     -- the hot path: active items in order
create index lesson_items_owner_norm_idx on lesson_items (owner_id, normalized_text);

alter table lesson_items enable row level security;
create policy "lesson_items owner select" on lesson_items for select
  using (owner_id = auth.jwt() ->> 'sub');
create policy "lesson_items owner insert" on lesson_items for insert
  with check (owner_id = auth.jwt() ->> 'sub');
create policy "lesson_items owner update" on lesson_items for update
  using (owner_id = auth.jwt() ->> 'sub');     -- soft-delete = update, not delete

-- Backfill from the array column, preserving order; stamp the lesson's created_at
-- so history doesn't claim every word was "added" at migration time.
insert into lesson_items (lesson_id, owner_id, text, position, created_at)
select l.id, l.owner_id, t.item, t.ord::int - 1, l.created_at
from lessons l, unnest(l.items) with ordinality as t(item, ord);

alter table lessons drop column items;
alter table lessons add column updated_at timestamptz not null default now();
```

Notes on the choices:

- **`position integer` with append-at-max.** New items get `max(position)+1`; removals
  leave gaps (fine — order matters, density doesn't). No reorder UI is planned; if one
  arrives, renumbering the handful of active rows in one statement is trivial.
- **Partial index on active items** matches the only frequent query (render lesson, build
  `items_list`). The history view reads all rows but is rare.
- **No unique constraint on `(lesson_id, normalized_text) where removed_at is null`** —
  tempting for dedupe, but sentences make near-duplicates legitimate. Enforce "don't add
  an exact active duplicate" in the server action instead, where it can be a friendly
  no-op rather than a DB error.
- **Dropping `items` immediately** is safe here because code and schema deploy together
  for a single-user app. (In a multi-instance rollout you'd split it: 0003 adds+backfills,
  code switches over, 0004 drops.)
- `lessons` gets `updated_at` so the home list can surface recently-edited lessons; bump
  it in every item mutation.

## Application changes

**`src/lib/lessons.ts`** — the data layer absorbs most of it:

- New `LessonItem { id, text, position, created_at, removed_at }`.
- `getLesson` / `listLessons`: embed items (`lessons.select("…, lesson_items(…)")`),
  filter `removed_at is null` and order by `position` for the active list. `Lesson.items:
  string[]` can survive as a derived convenience so the tutor/preview code barely changes.
- `createLesson`: insert the lesson, then bulk-insert its item rows.
- New mutations, all owner-scoped and bumping `lessons.updated_at`:
  - `addLessonItems(ownerId, lessonId, texts[])` — append after current max position,
    skipping exact active duplicates (case-insensitive via `normalized_text`).
  - `removeLessonItem(ownerId, lessonId, itemId)` — `set removed_at = now()` (no delete).
- New `listLessonItemHistory(ownerId, lessonId)` — all rows including removed, for the
  history section.

**`src/app/lessons/actions.ts`** — `addLessonItemsAction` (textarea → lines, same
trim/cap discipline as `createLessonAction`; enforce `MAX_ITEMS` against the **active**
count) and `removeLessonItemAction` (takes the item **uuid**, never free text — same
"never trust ids from the browser" posture: verify the item's lesson belongs to the
caller before writing). Both `revalidatePath` the lesson page and `/`.

**`src/app/lessons/[id]/page.tsx`** — "Words in this lesson" becomes editable: a remove
button (form + server action) per item, a small "add words" textarea below. The
**History** section grows a "Changes" strand alongside conversations: render item events
(added/removed with timestamps) — either as a separate list or interleaved with sessions
by timestamp. Simplest first cut: a `<details>Word changes</details>` block above the
conversation list; interleaving is a cosmetic follow-up.

**`LessonTutor.tsx`** — unchanged in shape: it already receives `items: string[]` from
the server page; that array is now "active items in position order". One subtlety: the
props are captured at page render, so words added mid-session don't reach the running
agent — acceptable, and true today too.

**Session ↔ item-set fidelity** — the History section shows each conversation; with
timestamps we can reconstruct which words were active during any past session (query
above). If we ever want it exact even against mid-session edits, add an
`items_snapshot text[]` to `lesson_sessions` stamped at `startSession`; deferred — the
timestamp reconstruction is enough for now.

## The analysis payoff (why per-row is worth it)

Once items are rows, the future features the user named become plain SQL:

```sql
-- Every word/sentence I've ever studied, with when and where:
select text, lesson_id, created_at, removed_at
from lesson_items where owner_id = :me order by created_at;

-- Distinct vocabulary across all lessons (dedupe by normalized form):
select normalized_text, min(created_at) first_seen, count(distinct lesson_id) lessons
from lesson_items where owner_id = :me group by normalized_text;

-- Seed a new "review" lesson from words studied 30+ days ago:
insert into lesson_items (lesson_id, owner_id, text, position, …)
select :new_lesson, :me, distinct-on-normalized text, row_number() …
```

Joining to `lesson_sessions.transcript` (jsonb) even allows "which studied words actually
came up in conversation" later. **Groups/tags** would be a `lesson_groups` +
`lesson_group_members` pair over lessons, or tags directly on `lesson_items` — orthogonal
to this migration, nothing here constrains it.

## Suggested implementation order

1. Migration `0003_lesson_items.sql` (table + RLS + backfill + drop column +
   `lessons.updated_at`) — `pnpm db:migrate`.
2. `src/lib/lessons.ts`: types, embedded reads, `createLesson` two-step, new mutations.
3. Server actions + lesson-page UI for add/remove.
4. "Changes" history block on the lesson page.
5. Verify per the usual bar: typecheck/lint/build, then live-DB pass (create → add →
   remove → re-add same word → history shows all four events → tutor still receives the
   active list → owner-scoping rejection for a foreign owner).

## Open questions (defaults chosen, flag if wrong)

- **Delete a whole lesson?** Still out of scope, as before (destructive; cascade already
  wired at the DB). Soft-deleting lessons (`removed_at` on `lessons`) would be consistent
  with this design if/when it ships.
- **Edit an item's text in place?** Modeled as remove + add. If in-place editing (typo
  fixes that _shouldn't_ appear as history events) turns out to matter, that's the point
  to introduce an explicit event table.
- **Kind column (`word` / `phrase` / `sentence`)?** Skipped — derivable heuristically
  (word count) when analysis needs it, and asking the user to classify at entry adds
  friction. Cheap to add later.
