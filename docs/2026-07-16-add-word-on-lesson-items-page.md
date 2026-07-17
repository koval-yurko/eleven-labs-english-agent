# Add a word from `/lesson-items` — and the `words` entity it implies

**Date:** 2026-07-16 (revised 2026-07-17 after the open questions were answered)
**Status:** IMPLEMENTED and APPLIED 2026-07-17 — `supabase/migrations/0007_words_m2m.sql` +
`src/lib/words.ts` + `src/app/lesson-items/AddWordForm.tsx`. Migrated against a container first,
then the live database; `owner_items` came through the reshape with an identical checksum. See
"Verification".
**Related:** [`2026-07-11-lesson-items-page-search-filters-stats-favorites.md`](./2026-07-11-lesson-items-page-search-filters-stats-favorites.md),
[`2026-07-04-offline-support-and-sync.md`](./2026-07-04-offline-support-and-sync.md),
[`2026-07-16-level-assignment-background-job.md`](./2026-07-16-level-assignment-background-job.md)

## The ask

On `/lesson-items`, let the learner add a single word (or phrase/sentence) straight into their
collection without picking a lesson for it.

The three open questions from the first draft are now answered, and they change the shape of the
answer rather than filling in its blanks:

1. **Assign-later** → a real many-to-many via a join table; one word can be in several lessons.
2. **The 50-item cap** → words detach from lessons entirely; the collection is its own thing,
   reviewable separately.
3. **`lessons` UPDATE RLS policy** → add it.

## The headline

**Answer (1) dissolves the problem instead of building on it.** The first draft's recommendation
was to relax `lesson_items.lesson_id` to nullable so a word could exist without a lesson. With a
`words` table, that relaxation is unnecessary and would be actively wrong: the collection stops
being *derived from* lessons and becomes a table of its own, which lessons then *reference*. A word
with no lesson isn't a special case to permit — it's a row in `words` with zero rows pointing at
it. `lesson_count = 0` falls out of a left join. There is no constraint to loosen.

The second consequence is bigger and worth naming explicitly: **`lesson_item_attrs` should fold
into `words` and disappear.** Read its own design note (`0004_lesson_item_attrs.sql:96-126`) — it
is keyed `(owner_id, norm_key)` with deliberately no FK, "sparse … so attrs survive remove→re-add
and span lessons." Every one of those properties is a workaround for the absence of a word entity.
`words` *is* the thing attributes were always trying to hang off. Once it exists, a separate attrs
table is a join for no reason: `level`, `is_favorite`, and `categories` become columns on `words`.

So this is one reshape, not a feature bolted onto the current schema. It's the largest migration in
the repo's history — take a backup first.

## Target schema

```sql
-- The collection. One row per distinct word/phrase/sentence the owner has, INDEPENDENT of any
-- lesson: this is what /lesson-items lists and what the level job reads. Identity is norm_key
-- (trigger-derived); `text` is the most recently typed spelling, kept for display.
create table words (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null,
  text         text not null,
  norm_key     text not null,                              -- lesson_item_norm_key(text), by trigger
  level        cefr_level,
  level_source text check (level_source in ('job','user')),
  level_at     timestamptz,                                -- the job's "attempted" flag
  is_favorite  boolean not null default false,
  categories   jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),         -- = owner_items.first_added_at
  updated_at   timestamptz not null default now(),
  unique (owner_id, norm_key)
);

-- The join. lesson_items keeps its name and its id (the outbox already mints those), loses `text`
-- / `norm_key` to `words`, and gains `word_id`. `position` stays: it orders words WITHIN a lesson,
-- which is exactly the thing that has no meaning outside one.
alter table lesson_items add column word_id uuid references words(id) on delete cascade;
alter table lesson_items drop column text, drop column norm_key;
create unique index lesson_items_lesson_word_active_idx
  on lesson_items (lesson_id, word_id) where removed_at is null;
```

`lesson_items.lesson_id` stays `not null`. A link row with no lesson would be meaningless — that
was only ever a hack to fake a word entity.

**Keep the `lesson_items` name.** Renaming to `lesson_words` means touching every RLS policy, every
index, the whole data layer, and the mirror, to buy a synonym. The reshape is already large enough
to review carefully.

### Why the unique index must be partial

`where removed_at is null`. Remove-then-re-add creates a second row for the same
`(lesson_id, word_id)` and the removed row must survive — `owner_item_practice`'s temporal
predicate reads `created_at`/`removed_at` per link to decide which sessions a word was present for.
A total unique constraint would either block the re-add or force destroying history.

### `is_favorite` and the `not null` trap

`words.text` is `not null` with no default, which quietly breaks the current
upsert-the-attrs-row pattern. PostgREST builds `INSERT … ON CONFLICT` from the union of a batch's
keys, so an upsert of `{owner_id, norm_key, level, …}` has no `text` to insert and fails before the
conflict clause is ever reached. This is not a problem — the word row always exists before anything
attributes it — but it means **`setItemFavorite` and `writeLevels` become UPDATEs, not upserts.**
See the code table below; it's the one place folding costs something.

## Views

All four views are rebuilt. `owner_items` keeps its exact column set (plus `id`), so `/lesson-items`
and `src/lib/lesson-items.ts` need almost no change — only the source of truth underneath moves.

```sql
-- Now keyed on the word, not on a lesson_items row.
create or replace view owner_item_practice with (security_invoker = true) as
select i.owner_id,
       i.word_id,
       count(distinct s.id) as practice_count,
       max(s.created_at)    as last_practiced_at
  from lesson_items i
  join lesson_sessions s
    on s.lesson_id = i.lesson_id
   and s.created_at >= i.created_at
   and (i.removed_at is null or s.created_at < i.removed_at)
 group by i.owner_id, i.word_id;

-- FROM words, LEFT JOIN the links: a word in no lesson is the natural base case, not an exception.
create or replace view owner_items with (security_invoker = true) as
select
  w.id,
  w.owner_id,
  w.norm_key,
  w.text,
  case … end                                                      as kind,   -- unchanged from 0005
  count(distinct i.lesson_id)                                     as lesson_count,
  count(distinct i.lesson_id) filter (where i.removed_at is null) as active_lesson_count,
  w.created_at                                                    as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      filter (where i.removed_at is null and i.lesson_id is not null),
    '[]'::jsonb)                                                  as lessons,
  coalesce(p.practice_count, 0)                                   as practice_count,
  p.last_practiced_at,
  w.level, w.level_source, w.is_favorite, w.categories
from words w
left join lesson_items i on i.word_id = w.id
left join lessons     l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;
```

Three things in there are easy to get wrong:

- **`and i.lesson_id is not null` in the `jsonb_agg` filter is mandatory.** For a word with no
  links, the left join yields an all-nulls row where `i.removed_at is null` is *true*, so the
  existing filter passes and the aggregate emits `{"id":null,"title":null}` — a junk chip on every
  standalone word. This is the same trap as the first draft, and the left join does not remove it.
- **`count(distinct i.lesson_id)` needs no guard**: `count` ignores nulls, so an unlinked word
  reports `0` and the existing `?unassigned=1` filter (`src/lib/lesson-items.ts:92`,
  `active_lesson_count = 0`) picks up directly-added words for free. No filter code changes.
- **`first_added_at` is now `w.created_at`**, not `min(i.created_at)`. Semantically better — when
  the word entered the collection, not when it first got attached to something — and the backfill
  below preserves the current values.

```sql
-- Facets move off the dropped attrs table onto words. Same columns.
create or replace view owner_item_facets with (security_invoker = true) as
select owner_id, kv.key as name, kv.value #>> '{}' as value, count(*) as item_count
  from words, lateral jsonb_each(categories) kv
 group by owner_id, kv.key, kv.value #>> '{}';

-- The level queue no longer needs owner_items at all — it's a scan of the collection.
create or replace view owner_items_pending_level with (security_invoker = true) as
select w.owner_id, w.id as word_id, w.norm_key, w.text,
       case … end as kind, w.created_at as first_added_at
  from words w
 where w.level_at is null;
```

Views must be dropped and recreated in dependency order (`owner_items_pending_level` and
`owner_item_facets` first, then `owner_items`, then `owner_item_practice`) because column sets
change — `create or replace` only tolerates an identical column list.

## Migration `0007_words_m2m.sql`

The backfill is mechanical except for one landmine.

```sql
-- 1. words: one row per distinct (owner_id, norm_key). Newest spelling wins — matching what
--    owner_items.text does today via (array_agg(text order by created_at desc))[1].
create table words (…);
create trigger words_norm_key before insert or update of text on words
  for each row execute function words_set_norm_key();   -- same body as lesson_items_set_norm_key

insert into words (owner_id, text, norm_key, created_at)
select owner_id, (array_agg(text order by created_at desc))[1], norm_key, min(created_at)
  from lesson_items
 group by owner_id, norm_key;

-- 2. fold lesson_item_attrs in
update words w
   set level = a.level, level_source = a.level_source, level_at = a.level_at,
       is_favorite = a.is_favorite, categories = a.categories, updated_at = a.updated_at
  from lesson_item_attrs a
 where a.owner_id = w.owner_id and a.norm_key = w.norm_key;

-- 3. THE LANDMINE — collapse pre-existing same-lesson duplicates before the unique index.
--    addItemsLocal dedupes with text.trim().toLowerCase() (engine.ts:82), which is NOT
--    lesson_item_norm_key: "Ubiquitous." and "ubiquitous" pass that check as distinct and are both
--    active in the same lesson today, but share a norm_key and so will share a word_id. Keep the
--    earliest link, soft-remove the rest.
update lesson_items i set removed_at = now()
 where removed_at is null
   and exists (select 1 from lesson_items j
                where j.lesson_id = i.lesson_id and j.norm_key = i.norm_key
                  and j.removed_at is null and (j.created_at, j.id) < (i.created_at, i.id));

-- 4. link, then lock it down
alter table lesson_items add column word_id uuid references words(id) on delete cascade;
update lesson_items i set word_id = w.id
  from words w where w.owner_id = i.owner_id and w.norm_key = i.norm_key;
alter table lesson_items alter column word_id set not null;
create unique index lesson_items_lesson_word_active_idx
  on lesson_items (lesson_id, word_id) where removed_at is null;

-- 5. drop what words now owns
drop trigger lesson_items_norm_key on lesson_items;
drop index  lesson_items_owner_key_idx;
alter table lesson_items drop column text, drop column norm_key;
drop table  lesson_item_attrs;    -- after the views stop referencing it

-- 6. RLS (Q3) — words gets the standard four; lessons gets the UPDATE policy it never had.
alter table words enable row level security;
create policy "words owner select" on words for select using (owner_id = auth.jwt() ->> 'sub');
create policy "words owner insert" on words for insert with check (owner_id = auth.jwt() ->> 'sub');
create policy "words owner update" on words for update using (owner_id = auth.jwt() ->> 'sub');
create policy "lessons owner update" on lessons for update using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');
```

Step 3 is worth dwelling on: skip it and the `create unique index` in step 4 fails on any account
that ever typed a word twice with different punctuation. It will not show up in a clean dev
database. Run the `exists` query as a `select count(*)` against production data first, so you know
whether it's zero or hundreds before deciding it's safe.

On step 6 — the `lessons` UPDATE gap is real but currently inert: `touchLesson` succeeds only
because every path uses the service-role client, which bypasses RLS entirely
(`src/lib/supabase/server.ts:10`). The policy matters the day the token-scoped client
(`src/lib/supabase/user-client.ts`) is wired up, which is exactly when a missing policy would look
like a mystery bug rather than a missing line.

## The write path

A word must exist before it can be linked, and the client cannot compute `norm_key` (it's a SQL
function). So the server resolves text → word id:

```ts
/** Upsert words by their natural key and hand back their ids. One round trip. */
export async function resolveWords(ownerId: string, texts: string[]): Promise<Map<string, string>> {
  const rows = texts.map((t) => ({ owner_id: ownerId, text: t.trim() })).filter((r) => r.text);
  const { data, error } = await getServiceSupabase()
    .from("words")
    .upsert(rows, { onConflict: "owner_id,norm_key" })   // do update set text = excluded.text
    .select("id, norm_key, text");
  …
}
```

The `on conflict … do update set text = excluded.text` is not incidental — it *is* the current
"most recently typed spelling" rule, moved from an `array_agg` in the view to the write path. The
BEFORE trigger fires ahead of conflict detection, so `(owner_id, norm_key)` is a usable target even
though the client never sends `norm_key`.

**The outbox wire contract does not change.** `AddItemsOp.items: {id, text, position}[]` stays
byte-identical; `id` simply means the *link* id now instead of the lesson_items-as-word id.
`RemoveItemOp {lessonId, itemId}` still targets a link by its client-minted id, so
`removeLessonItem` needs no change at all. `upsertLessonItems` gains one step in the middle:
resolve texts → word ids, then upsert links.

This is a quiet improvement to offline correctness. Today two devices adding "ubiquitous" offline
mint two different uuids for what is one word; on flush the view collapses them by `norm_key`, but
the rows are duplicated forever. With `words` keyed on its natural key, the second device's add
converges onto the same row. Idempotency now rests on a key that is stable *across* clients rather
than on a uuid that is stable only within one.

### Code changes

| File | Change |
| --- | --- |
| `src/lib/words.ts` (new) | `resolveWords`, `addWord(ownerId, text)` → `{ status: "added" \| "already-present", id }` |
| `src/lib/lessons.ts` | `createLesson` + `upsertLessonItems`: resolve word ids, insert links. `removeLessonItem` unchanged |
| `src/lib/lesson-items.ts` | `setItemFavorite`: `update words set is_favorite where owner_id and norm_key` — the pre-check against `lesson_items` **deletes** (a 0-row update *is* the ownership gate). `listItems` / `listItemFacets` unchanged |
| `src/lib/levels.ts` | `resetLevelFlags` → `words`. `writeLevels` → UPDATEs (see below). `listPendingItems` unchanged apart from the view's new `word_id` |
| `src/app/lesson-items/actions.ts` | new `addWordAction` |
| `src/app/lesson-items/AddWordForm.tsx` (new) | the form |
| `src/lib/sync/*` | unchanged for lessons; see "Offline" |

**`writeLevels` is the one regression.** Its current two-upserts trick
(`src/lib/levels.ts:156-188`) leans on PostgREST's key-union behaviour, which needs the INSERT path
that `words.text not null` now forecloses. It becomes: group `answered` by `(owner_id, level)` and
issue one `update … in (norm_key…)` per group, plus one for `unanswered`. A 25-item batch means a
handful of statements instead of two. The *reason* for the answered/unanswered split survives
untouched and must be preserved in the rewrite: an unanswered item writes `level_at` and **not**
`level`, so that `--force` over an already-levelled item can't null out a good level while still
stamping it done — which would make it permanently unreachable to every future sweep.

## The level job

Free. `owner_items_pending_level` becomes a scan of `words where level_at is null`, so a directly
added word is queued the instant it's inserted. If the add goes through a direct action rather than
the outbox, copy the fast path from `src/app/lessons/actions.ts:131-139` into it:

```ts
after(async () => {
  try { await levelItems(ownerId, { limit: LEVEL_AFTER_LIMIT }); } catch { /* the sweep is the backstop */ }
});
```

The queue's newest-first order (`first_added_at desc`) is what makes `LEVEL_AFTER_LIMIT = 50` safe,
and `first_added_at` is now `words.created_at` — still newest-first for a word just typed. Intact.

## Offline

The page's only existing write — the favourite star — is deliberately online-only, not an outbox op
(`src/app/lesson-items/actions.ts:12-14`). Adding a word is different in kind: losing a toggle is an
annoyance, losing a word the learner typed is data loss.

But the mirror is lesson-shaped. `MirrorItem` requires `lesson_id` (`src/lib/sync/db.ts:32-37`) and
Dexie indexes on it; **IndexedDB cannot index null**, so a lessonless mirror row would sit in the
table invisible to every lesson-scoped query. And `/lesson-items` is a server component with no
Dexie read island, so a queued op wouldn't render optimistically anyway.

Recommendation: **direct server action for v1**, mirroring `FavoriteButton` (`useTransition`,
optimistic, revert on throw, `revalidatePath("/lesson-items")`), and disable the form when
`navigator.onLine === false` rather than failing silently. Phase 2 is a `words` table in the mirror
+ an `addWords` outbox op + a read island on this page — which answer (2) makes likelier than it
was, since a collection you review separately is a collection you'll want offline. Write that in the
comment so the next reader sees a decision, not an oversight. The level fast path comes free either
way: `flushOutbox` sets `addedItems` for any non-`removeItem` op (`actions.ts:107`).

## UI

A `panel` above the filter chips in `ItemsBrowser`, styled like `NewLessonForm` — plain
`<form onSubmit>`, `busy` guard, `formRef.current?.reset()`. There is no component library: CSS
custom properties from `globals.css` plus inline styles.

```
┌─ Add a word ──────────────────────────────────┐
│ [ ubiquitous                    ] [ Add ]     │
│ Added straight to your collection — assign it │
│ to a lesson any time.                         │
└───────────────────────────────────────────────┘
```

- Single-line input, not the "one per line" textarea. The ask is an *individual* word; a textarea
  invites bulk paste, and bulk paste wants a lesson.
- No kind picker — `kind` is derived by the view.
- **No cap** (answer 2): the 50 is a per-lesson constraint (`MAX_ITEMS`, `engine.ts:15`,
  `actions.ts:17`) and there is no lesson here. Leave the lesson cap exactly where it is.
- The new row appears via `revalidatePath` with `lessons = []`, rendering identically to a word
  removed from every lesson — a state `ItemLine` already handles.
- On `already-present`, say so and clear the input — `owner_items` groups by `norm_key`, so a silent
  duplicate add would look like a no-op bug. `addWord` should return the discriminated status
  rather than letting the UI guess. (`resolveWords`' upsert makes this cheap: compare the returned
  row's `created_at` to now, or do a `select` first — the `select` is honest and this is one word.)

## Verification

Migrations 0001–0007 were applied in order to a throwaway `postgres:16` container (with a shim for
the Supabase-only bits: `auth.jwt()`, the `service_role` role), seeded with two lessons, three
conversations, sparse attrs, a second owner, and — deliberately — the duplicate landmine. Results:

- **`owner_items` is byte-identical across the reshape.** Same `kind`, `lesson_count`,
  `practice_count`, `level`, `is_favorite`, `categories` before and after 0007, including
  `obsolete`'s practice count of 1 (credited for the conversation held while it was still in the
  lesson, not the one after its removal — the temporal predicate survived the rewrite to `word_id`).
- **The landmine is real, not theoretical.** Re-activating the duplicate link and re-running just
  the index creation fails with `duplicate key value violates unique constraint
  "lesson_items_lesson_word_active_idx"`. Step 3 of the migration is what makes step 4 possible.
- **The partial index behaves.** A second *active* link for one `(lesson_id, word_id)` is rejected;
  a *removed* one inserts fine, so re-add-after-remove still works.
- **`resolve_words` handles the intra-batch collision.** `['Ubiquitous.', 'ubiquitous', '  ',
  'café', 'cafe']` → two words, no `ON CONFLICT DO UPDATE command cannot affect row a second time`,
  blanks skipped, `was_created` true exactly once per new word.
- **A standalone word looks right**: `lessons = []` (no phantom `{"id":null}` chip),
  `lesson_count = 0`, `practice_count = 0` — indistinguishable from `obsolete`, the word removed
  from every lesson, which is the intent.
- **The level queue is correct**: only the three words with `level_at is null` appear; the two the
  fold gave a `level_at` do not.

### On the live database (applied 2026-07-17)

Scale at migration time: 7 lessons, 22 lesson_items, 20 distinct words, 20 attrs rows, 6 sessions,
1 owner. A `pg_dump` was taken first (pg_dump **17** — the server is 17.6, so the 16 client refuses).

- **Zero duplicate active links existed**, so step 3 was a no-op here. It stays in the migration:
  it cost nothing and the container proved it is the difference between a clean apply and a hard
  failure on any account that ever typed one word two ways.
- **`owner_items` md5 digest is identical before and after** (`8013627679b0f16a719ff4c5c8e0d357`,
  over owner/norm_key/kind/lesson_count/practice_count/level/is_favorite for all 20 rows). 20 words,
  22 links, 0 orphans, 19 levelled, 1 unassigned — all preserved.
- `lesson_item_attrs` dropped, no stale `text`/`norm_key` columns, `lessons` UPDATE policy present,
  3 `words` policies present, no phantom lesson chips.

### Through PostgREST (the part the container couldn't reach)

- **`words(text)` embeds as an OBJECT, not an array** — `{"words":{"text":"conversely"},...}` — so
  `embeddedTexts`' `i.words?.text` is right and the `as unknown as` casts in `lessons.ts` are
  widening to the true runtime shape. All 7 lessons return their items; this was the one assumption
  that would have silently emptied the lesson list.
- `owner_items` reads fine with the new `id`; the `?unassigned=1` filter matches its 1 row;
  `resolve_words` is callable via `.rpc()` (PostgREST picked the new function up immediately) and
  returns `was_created` correctly. The probe word was deleted afterwards.

`pnpm typecheck`, `pnpm lint`, and `pnpm build` pass. Not exercised: the browser UI itself
(`AddWordForm` behind Auth0).

## What's still open

1. **Assigning a word to a lesson from `/lesson-items`.** The schema supports it — insert a link —
   but there's no UI and no outbox op for it. Deliberately not built here: it needs its own op and
   its own picker, and bundling it would have doubled an already-large migration.
2. **"Reviewed separately" (answer 2) implies word-level sessions.** `practice_count` is derived
   purely from `lesson_sessions` joined on `lesson_id`, so a word reviewed outside a lesson would
   show `practice_count = 0` — the stat quietly stops meaning "how much I've practised this". That
   needs a `word_sessions` (or a nullable `lesson_sessions.lesson_id`) when review lands. Not now,
   but it's the next thing this design will run into.
3. **`lesson_items.owner_id` is now doubly redundant** (derivable from both `lessons` and `words`).
   Keep it — it's what the RLS policies and every query filter on — but it's now a denormalisation
   worth a comment rather than an obvious column.
