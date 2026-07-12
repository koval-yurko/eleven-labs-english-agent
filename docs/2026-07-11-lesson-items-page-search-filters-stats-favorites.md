# Lesson items page — one vocabulary list with search, filters, practice stats, and favorites

_Date: 2026-07-11 — research note (no code written yet). Revised after review._

**Goal:** a dedicated page at **`/lesson-items`** listing every word / sentence the learner has,
across all lessons, with search, a CEFR **Level** filter (A2–C2), open-ended **category
(name:value)** filters added later, a **statistic of how many conversations I've had with each
item** (sortable, alongside creation date), and **favorite / unfavorite** with its own sort +
filter.

## TL;DR

- The blocker is conceptual, not visual: **an "item" is not an entity in this app yet.** It's a
  `lesson_items` row — one row per (lesson, word), a new row on every re-add, soft-deleted on
  removal. "The word _ubiquitous_" is currently a set of rows sharing a normalized key.
- **Recommendation:** don't normalize `lesson_items` into a `words` FK. Keep `lesson_items` as
  the source of truth for _which items exist_, and add one side table, **`lesson_item_attrs`,
  keyed on `(owner_id, norm_key)`**, holding only the per-item facts: `level`, `is_favorite`,
  `categories jsonb`. The list itself — and every statistic on it — is a **derived aggregate**
  over `lesson_items` + `lesson_sessions`, exposed as a view. This leaves the existing write path
  and the whole offline sync engine untouched.
- **The stats are already sitting in the schema and nobody has cashed them in.** `lesson_items`
  records `created_at` (added) and `removed_at` (removed), and `lesson_sessions` records
  `created_at` per conversation. So "how many lessons have I had with this word" can be answered
  *precisely* — count only the conversations that happened **while the item was actually in the
  lesson**. The 0003 migration comment explicitly anticipated this.
- **Levels are written by a future background job, not by this page.** v1 ships the *schema* plus
  **read + filter + sort** only. No level editor, no LLM call, no backfill action.
- **Favoriting is the page's only mutation.** Everything else is read-only.
- **The item list is complete history:** an item removed from every lesson still appears, with a
  **null lesson reference** ("not in any lesson"). Removal detaches an item from a lesson; it
  never erases the item.
- The normalization key gets **rebuilt properly** (see [Normalization](#normalization--the-key-the-whole-page-rests-on)) — and, critically, moved off a
  generated column onto a **trigger-maintained column**, so the rule can evolve later with a
  one-line backfill instead of a table rewrite. It is referenced by **no application code today**
  (only migration 0003), so this is free right now and expensive in three months.
- `/words` is a leftover `redirect("/")` stub from the pre-lessons era — **delete it.**

---

## Where we are today

```text
lessons        id, owner_id, title, created_at, updated_at
lesson_items   id, lesson_id, owner_id, text,
               normalized_text  (GENERATED: lower(btrim(text)))   ← the de-facto item key
               position, created_at, removed_at (null = active)
lesson_sessions id, lesson_id, owner_id, conversation_id, agent_version,
               transcript, summary, duration_secs, created_at
```

Facts that constrain the design:

| Fact | Consequence |
| --- | --- |
| The same word in two lessons is **two rows**; re-adding after removal is a **third** | The list must `group by` the normalized key, and per-item attributes cannot live on `lesson_items` (they'd be copied to every row and drift) |
| `lesson_items_owner_norm_idx (owner_id, normalized_text)` already exists | The grouping key is already indexed — the aggregate is cheap today |
| Items are **never edited**, only added / soft-removed (`src/lib/lessons.ts`) | The key is **stable**. No rename → no key-drift → attributes keyed by text never orphan. (This is why open question 3 — read-only — matters structurally, not just for scope.) |
| Every mutation is an **idempotent, client-minted-id outbox op** (`src/lib/sync/*`) | The one new mutation (toggle favorite) must be idempotent and replayable, or deliberately excluded from offline |
| Scale is small: 50 items/lesson cap × tens of lessons | Hundreds of rows. **No pagination, no search index, no caching in v1.** `ILIKE '%q%'` over a few hundred rows is microseconds |
| Owner scoping is enforced **in code**, RLS is defense-in-depth | New tables/views repeat the pattern: filter+stamp `owner_id`, plus an RLS policy |
| `normalized_text` appears **nowhere in `src/`** — only in migration 0003 | Replacing the key today costs one migration and zero code changes |

---

## Decision 1 — how an item becomes addressable

Three options; the third is the recommendation.

**(A) Derive everything, store nothing.** A view grouping `lesson_items` by the normalized key.
Zero migration — but there is nowhere to put `level` / `is_favorite` / `categories`; a view isn't
writable. **Rejected: doesn't meet the requirement.**

**(B) Full normalization — a `words` table with `lesson_items.word_id` FK.** The textbook model.
But it forces a get-or-create onto the hot write path, and that path is `upsertLessonItems`,
which is deliberately **id-driven and idempotent** because the client mints ids offline and
replays them (`docs/2026-07-04-offline-support-and-sync.md`). A word row can't be client-minted
(its identity is `owner + text`; two devices adding "ubiquitous" offline would mint two uuids for
one word), so it needs a server-side upsert on a unique key — fine in isolation, but it means a
backfill migration, a rewrite of the create/add path, and a new failure mode in the sync replay,
all for a `word_id` column **nothing in the UI needs**. **Rejected: cost lands on the riskiest
code in the repo, buys nothing here.**

**(C) ✅ Recommended — derived list + a sparse attributes table keyed by the natural key.**

```text
lesson_items      ──(group by owner_id, norm_key)──►  item list + all statistics   [derived]
lesson_item_attrs ──(owner_id, norm_key) PK       ──►  level, is_favorite, categories [stored]
                                                       LEFT JOINed onto the derived list
```

`lesson_item_attrs` is **sparse**: a row appears lazily the first time the learner favorites the
item, or the level job classifies it. An item with no row is simply un-leveled / not-favorite /
untagged.

> **On the name.** The table is called `lesson_item_attrs` (per review) but its primary key is
> `(owner_id, norm_key)` — **not** `lesson_items.id`. That's deliberate and it's the crux of
> Decision 1: keying on the row id would split a word's level and favorite flag across every
> lesson it appears in, and lose them the moment it's removed and re-added. Read the name as
> "attributes of a lesson item, identified by its normalized text".

Three properties fall out for free:

1. **The existing write path and the entire offline engine are untouched.** Adding a word to a
   lesson still just inserts a `lesson_items` row; it appears on the page automatically.
2. **Attributes follow the item, not the row.** A level assigned to _ubiquitous_ is still there
   when it's added to a second lesson, and survives remove → re-add.
3. **Orphans are harmless.** An attrs row for an item no longer in any lesson stays invisible
   until the item is re-added — but see open question 2: the *item* is still listed either way,
   because the list is history, not just the active set.

---

## Decision 2 — what "number of lessons I had with these words" means

Two readings, both one `count(distinct …)` away, so **ship both** and let sort order choose:

| Metric | Definition | Reads as |
| --- | --- | --- |
| `lesson_count` | distinct lessons whose items include it (ever) | "how widely is this spread across my sets" |
| **`practice_count`** | **conversations (`lesson_sessions`) held on a lesson _while the item was in it_** | **"how many times have I actually practiced this out loud"** — the metric the request is asking for |
| `last_practiced_at` | `max()` of those conversations' `created_at` | the field that makes the page actionable ("what haven't I touched in a month") |
| `first_added_at` | `min(lesson_items.created_at)` | the requested "creation date" sort |

The temporal predicate is what makes `practice_count` honest, and the schema already supports it:

```sql
join lesson_sessions s
  on s.lesson_id = i.lesson_id
 and s.created_at >= i.created_at
 and (i.removed_at is null or s.created_at < i.removed_at)
```

Without it, an item removed from a busy lesson would still be credited with every conversation
that lesson ever had — including ones held before it was ever added. With it, the number is
exactly "sessions where the tutor could have covered this item".

It says the item was *in the room*, not that it was *taught*. That's the honest ceiling of this
metric and it's fine — the transcripts are stored if that ever needs tightening.

---

## Normalization — the key the whole page rests on

Today's key is `lower(btrim(text))`: case and outer whitespace, nothing else. As a *vocabulary*
key that's too weak — these all become distinct entries with split statistics:

| Typed | Typed again | Today |
| --- | --- | --- |
| `Break the ice.` | `break the ice` | 2 items |
| `don’t give up` (curly ’, from iOS) | `don't give up` (straight ') | 2 items |
| `take  it  easy` (double space) | `take it easy` | 2 items |
| `"hit the sack"` (quoted) | `hit the sack` | 2 items |
| `café` | `cafe` | 2 items |

The curly-apostrophe one is not hypothetical: **iOS smart punctuation is on by default**, and this
is an installed PWA whose input is largely a phone keyboard. Roughly half the idioms a learner
types will contain an apostrophe.

### The structural fix comes first: stop using a generated column

`normalized_text` is `GENERATED ALWAYS … STORED`, which forces the expression to be `IMMUTABLE`
and — the real problem — means **the rule can never be revised without a table rewrite**, and if
you revise it via `CREATE OR REPLACE FUNCTION`, Postgres silently leaves the stored values stale.
We are changing this rule *right now*, which is the evidence that we will want to change it
again.

**Replace it with a plain column maintained by a `BEFORE INSERT OR UPDATE` trigger.** Then
evolving the rule is `CREATE OR REPLACE FUNCTION` + one `UPDATE lesson_items SET text = text`
backfill. As a bonus, the trigger path **doesn't require `IMMUTABLE`**, which is what makes
`unaccent()` usable below (it's `STABLE`, and the usual workaround — wrapping it in a fake
`IMMUTABLE` function to satisfy an index or generated column — is a well-known footgun).

### The rule

Order matters; each step is one thing.

```sql
create extension if not exists unaccent;

-- The vocabulary key: what makes two typed strings "the same item".
-- Deliberately NOT stemming/lemmatizing and NOT dropping stop-words — "the ice" and "ice" are
-- different items to learn. This only erases differences a human would call typography.
create or replace function lesson_item_norm_key(raw text)
returns text
language sql
as $$
  select nullif(
    btrim(                                        -- 5. strip wrapping/terminal punctuation
      regexp_replace(                             -- 4. collapse whitespace runs to one space
        lower(                                    -- 3. case-fold
          unaccent(                               -- 2b. café → cafe
            translate(                            -- 2a. typography → ASCII
              normalize(raw, NFKC),               -- 1. Unicode canonical form (ﬁ → fi, full-width → ASCII)
              E'’‘ʼ“”–— ',  -- ’ ‘ ʼ “ ” – — NBSP
              E'\'\'\'""--'' '                    -- → ' ' ' " " - -  (space)
            )
          )
        ),
        '\s+', ' ', 'g'
      ),
      ' .,;:!?"''`()[]{}…-'                       -- both ends only; internals untouched
    ),
  '');
$$;
```

What each step buys, and what it deliberately leaves alone:

1. **`normalize(…, NFKC)`** (Postgres 13+) — canonical Unicode: ligatures, full-width characters,
   compatibility forms collapse to their plain equivalents.
2. **`translate(…)`** — the typography fix, and the highest-value line here: curly quotes and
   apostrophes (iOS), en/em dashes, and non-breaking spaces become their ASCII forms. Then
   **`unaccent`** folds `café → cafe`, `naïve → naive` — safe because it only ever affects the
   *key*; `lesson_items.text` keeps the learner's exact spelling for display.
3. **`lower()`** — case-fold. (Locale-dependent in principle; irrelevant for English.)
4. **`regexp_replace('\s+', ' ')`** — collapses double spaces, tabs, and stray newlines (the add
   form is a `<textarea>` split on newlines, so these do occur).
5. **`btrim(…, ' .,;:!?"''`()[]{}…-')`** — strips wrapping quotes/brackets and terminal
   punctuation **from the ends only**. `Break the ice.` → `break the ice`; `don't` keeps its
   apostrophe, `well-being` keeps its hyphen.
6. **`nullif(…, '')`** — an input of `"..."` normalizes to empty; make that `NULL` rather than a
   phantom item that swallows every other punctuation-only entry into one bucket.

**What it does not do, on purpose:** no stemming (`running` ≠ `run` — they're different things to
practice), no lemmatization, no stop-word removal, no article stripping. Over-normalizing a
*learning* vocabulary destroys real distinctions; the goal is only to erase differences the
learner would never consider meaningful.

### Migration shape

```sql
-- 1. new key column + trigger (replaces the generated normalized_text)
alter table lesson_items add column norm_key text;

create or replace function lesson_items_set_norm_key() returns trigger
language plpgsql as $$
begin
  new.norm_key := coalesce(lesson_item_norm_key(new.text), lower(btrim(new.text)));
  return new;
end $$;

create trigger lesson_items_norm_key
  before insert or update of text on lesson_items
  for each row execute function lesson_items_set_norm_key();

-- 2. backfill (touching `text` fires the trigger), then enforce
update lesson_items set text = text;
alter table lesson_items alter column norm_key set not null;

-- 3. swap the index and drop the old column (referenced by no application code — grep confirms
--    it appears only in migration 0003)
create index lesson_items_owner_key_idx on lesson_items (owner_id, norm_key);
drop index lesson_items_owner_norm_idx;
alter table lesson_items drop column normalized_text;
```

Do this **in the same migration** that creates `lesson_item_attrs`, before any attributes exist —
changing the key later means migrating the attrs table's primary key too. Cheap now, annoying in
three months.

> **One behavioural consequence, worth a moment's thought.** `addItemsLocal` in
> `src/lib/sync/engine.ts` dedupes within a lesson using the *client's* rule
> (`text.trim().toLowerCase()`), which is the old weak one. After this change, the server's notion
> of "same item" is broader than the client's, so `Break the ice.` and `break the ice` can still
> coexist as two rows *in one lesson* while collapsing to one row *on the items page*. That is
> tolerable (the page is the aggregate view; the lesson is a list of what you typed), but if it
> grates, port the same rule to the client in a shared TS helper. Not v1.

---

## Schema — proposed `supabase/migrations/0004_lesson_items_attrs.sql`

```sql
-- CEFR as an enum: ordering is free (A1 < A2 < … < C2), so "sort by level" needs no CASE.
-- A1 included for headroom even though the UI offers A2–C2.
create type cefr_level as enum ('A1','A2','B1','B2','C1','C2');

-- Per-item attributes, keyed on the natural key (owner + normalized text) rather than on a
-- lesson_items row: an item is the same item in every lesson, and survives remove → re-add.
-- SPARSE — a row exists only once something has been set on this item.
create table lesson_item_attrs (
  owner_id     text not null,                     -- Auth0 sub
  norm_key     text not null,                     -- matches lesson_items.norm_key
  -- Level is WRITTEN BY A FUTURE BACKGROUND JOB, never by the UI (see below). Nullable forever:
  -- "unleveled" is a permanent, first-class state the filter must handle.
  level        cefr_level,
  level_source text check (level_source in ('job','user')),  -- 'user' reserved; nothing writes it yet
  level_at     timestamptz,                       -- when the job last classified it
  is_favorite  boolean not null default false,    -- the ONE thing the page writes
  categories   jsonb not null default '{}'::jsonb,-- open-ended {name: value}, filterable
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, norm_key)
);

-- Filter by any category without knowing its name in advance: categories @> '{"topic":"business"}'
create index lesson_item_attrs_categories_idx
  on lesson_item_attrs using gin (categories jsonb_path_ops);
-- The PK covers the owner scan; favorites/level filters run over one row per *touched* item.
-- No further indexes until proven necessary.

alter table lesson_item_attrs enable row level security;
create policy "lesson_item_attrs owner select" on lesson_item_attrs for select
  using (owner_id = auth.jwt() ->> 'sub');
create policy "lesson_item_attrs owner insert" on lesson_item_attrs for insert
  with check (owner_id = auth.jwt() ->> 'sub');
create policy "lesson_item_attrs owner update" on lesson_item_attrs for update
  using (owner_id = auth.jwt() ->> 'sub');
```

### The derived list

Two small views compose more clearly than one clever one.

```sql
-- Conversations held on a lesson WHILE the item was in it (the temporal predicate from Decision 2).
create view owner_item_practice as
select i.owner_id,
       i.norm_key,
       count(distinct s.id) as practice_count,
       max(s.created_at)    as last_practiced_at
  from lesson_items i
  join lesson_sessions s
    on s.lesson_id = i.lesson_id
   and s.created_at >= i.created_at
   and (i.removed_at is null or s.created_at < i.removed_at)
 group by i.owner_id, i.norm_key;

-- One row per distinct item the owner has EVER had. Source of truth stays lesson_items;
-- lesson_item_attrs only decorates. An item with no active lesson still appears (see OQ2) —
-- `lessons` is then an empty array, i.e. "not in any lesson".
create view owner_items as
select
  i.owner_id,
  i.norm_key,
  -- display form: the most recently typed spelling (keeps the learner's own casing/punctuation)
  (array_agg(i.text order by i.created_at desc))[1]                as text,
  -- word / phrase / sentence, derived — a useful facet, no column and no drift
  case when i.norm_key !~ '\s'                     then 'word'
       when array_length(regexp_split_to_array(i.norm_key, '\s+'), 1) <= 4 then 'phrase'
       else 'sentence' end                                         as kind,
  count(distinct i.lesson_id)                                      as lesson_count,
  count(distinct i.lesson_id) filter (where i.removed_at is null)  as active_lesson_count,
  min(i.created_at)                                                as first_added_at,
  -- the lesson reference the page shows; empty when the item is in no lesson (OQ2)
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      filter (where i.removed_at is null),
    '[]'::jsonb)                                                   as lessons,
  coalesce(p.practice_count, 0)                                    as practice_count,
  p.last_practiced_at,
  a.level, a.level_source,
  coalesce(a.is_favorite, false)                                   as is_favorite,
  coalesce(a.categories, '{}'::jsonb)                              as categories
from lesson_items i
join lessons l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = i.owner_id and p.norm_key = i.norm_key
left join lesson_item_attrs  a on a.owner_id = i.owner_id and a.norm_key = i.norm_key
group by i.owner_id, i.norm_key, p.practice_count, p.last_practiced_at,
         a.level, a.level_source, a.is_favorite, a.categories;

-- Self-describing filter UI: what categories exist, and how many items carry each value.
create view owner_item_facets as
select owner_id, kv.key as name, kv.value #>> '{}' as value, count(*) as item_count
  from lesson_item_attrs, lateral jsonb_each(categories) kv
 group by owner_id, kv.key, kv.value #>> '{}';
```

`kind` (word / phrase / sentence) is derived in the view rather than stored — the page is
"Words/Sentences", and filtering to just sentences is a genuinely useful drill. Zero write cost,
zero drift.

---

## Decision 3 — categories as `jsonb`, not an EAV table

The requirement is "categories (name:value) **might be added later**, so I can filter by them" —
i.e. the schema must absorb a category name nobody has thought of yet, without a migration.

- **`jsonb` column** (recommended). A new category is a write to an existing row; filtering is
  `categories @> '{"topic":"business"}'::jsonb`, index-backed by the GIN index above. Nothing to
  migrate when a new name appears — which is the entire point of the requirement.
- **`lesson_item_tags(owner_id, norm_key, name, value)` EAV table.** More relational, and makes
  "list all values of category `topic`" a trivial `select distinct`. But every filter becomes a
  join or an `EXISTS` per active filter, and it's a whole table + RLS + sync surface for something
  with **no consumer at all yet**.

`jsonb`'s one weakness — "what categories exist?", for the filter dropdowns — is answered by the
`owner_item_facets` view above, cheap at this scale. So the filter UI renders itself from the
data, with no hard-coded category list anywhere.

**Level stays a real typed column, not a category:** it's known, closed, ordered, and needs
sorting.

---

## Decision 4 — levels are read-only in v1

Per review: **a separate background job will assign levels later.** v1 therefore ships:

- the **schema** (`level`, `level_source`, `level_at` above) so the job has somewhere to write;
- **read** — show the level as a chip on each row;
- **filter** — `?level=B2`, multi-select, plus an explicit **`unleveled`** option;
- **sort** — free, thanks to the enum's natural ordering.

And ships **no** level editor, **no** LLM classification action, **no** backfill. The job, when it
arrives, is a plain owner-scoped upsert into `lesson_item_attrs` on `(owner_id, norm_key)` — the
table is designed for exactly that and nothing on the page conflicts with it.

Two consequences to design for now, because they're free now and awkward later:

1. **Every item is unleveled on day one, and many will stay that way.** The level filter must treat
   `NULL` as a filterable value, not a rendering afterthought — and the page must be useful with
   the entire level column empty (which is why search / favorites / practice-count sorting carry
   v1, not levels).
2. **`level_source` distinguishes `'job'` from `'user'`.** Nothing writes `'user'` yet; the column
   exists so that when a manual override is added, the job can be taught not to clobber it. One
   `text` column now, versus a migration and a re-think later.

---

## Decision 5 — where the query runs (and the offline question)

The page needs cross-lesson **aggregates + attributes**; the IndexedDB mirror holds only lessons
and *active* items (`src/lib/sync/db.ts`), and no session data at all. So:

**Phase 1 — server-rendered, URL-driven, online-only.** `/lesson-items` is a server component
reading `searchParams`; all state lives in the URL:

```text
/lesson-items?q=ubiq&level=C1&level=unleveled&fav=1&kind=sentence&cat.topic=business&sort=practice&dir=desc
```

Postgres does search (`ilike '%' || q || '%'` on `norm_key`), filtering, and sorting; the page
renders rows. Shareable, back-button-correct, no client state machine, and it matches how the rest
of the app renders (server component + small client islands). Search needs **no index** at this
scale — a sequential scan over a few hundred rows is free; `pg_trgm` is a one-line upgrade if that
ever changes.

**What breaks offline:** `src/app/OfflineApp.tsx` matches `/` and `/lessons/[id]` and falls
through to a generic "You're offline" notice for anything else — so `/lesson-items` degrades to
that notice. Acceptable for v1, but it must be a **deliberate call**, since the app otherwise works
fully offline.

**Phase 2 — mirror it.** Two additions: a `items`-aggregate object store in the Dexie mirror
(`db.version(2)`), seeded from the server payload like `seedLessons` does; and a **new outbox op**
so favoriting works offline:

```ts
/** Toggle an item's favorite flag. Last-write-wins by `at`. */
export interface SetItemFavoriteOp {
  kind: "setItemFavorite";
  normKey: string;
  isFavorite: boolean;
  at: string;              // client timestamp — the LWW tiebreak
}
```

Idempotency here is **last-write-wins, not upsert-by-id**: replaying "favorite = true" twice is
naturally a no-op, and the server applies it only if `at >= lesson_item_attrs.updated_at`. That's
a different convergence rule from the three existing ops, and it's the only genuinely new concept
in the whole feature — worth flagging in review.

**Suggested v1 split:** URL-driven server rendering for filters / sort / stats, plus client-side
filtering of the already-loaded result set for the **search box** (a round-trip per keystroke is
the wrong interaction, and the full list is a few hundred rows — just ship it to the client and
filter in memory). Best of both, with no new sync surface.

---

## Implementation surface

| File | Change |
| --- | --- |
| `supabase/migrations/0004_lesson_items_attrs.sql` | **new** — `lesson_item_norm_key()` + trigger + backfill + index swap (drops `normalized_text`); `cefr_level` enum; `lesson_item_attrs` + RLS; `owner_items` / `owner_item_practice` / `owner_item_facets` views |
| `src/lib/lesson-items.ts` | **new** — server-only data access mirroring `src/lib/lessons.ts` exactly (service client, explicit `owner_id` filter/stamp): `listItems(ownerId, query)`, `setItemFavorite(ownerId, normKey, isFavorite)`, `listFacets(ownerId)` |
| `src/app/lesson-items/page.tsx` | **new** — server component reading `searchParams`, rendering filters + list |
| `src/app/lesson-items/ItemsFilters.tsx` | **new** client island — search box (in-memory), level multi-select (incl. "unleveled"), favorites toggle, kind + category chips; pushes to the URL via `useRouter().replace` |
| `src/app/lesson-items/FavoriteButton.tsx` | **new** client island — the page's only mutation, optimistic |
| `src/app/lesson-items/actions.ts` | **new** — `setItemFavoriteAction`, re-deriving `ownerId` from the session (never trusting the payload) |
| `src/app/words/page.tsx` | **delete** — dead `redirect("/")` stub from the pre-lessons era |
| `src/app/page.tsx` / layout nav | link to `/lesson-items` |
| `src/lib/sync/{db,types,engine,mirror}.ts`, `src/app/OfflineApp.tsx` | **phase 2 only** — mirror store, `SetItemFavoriteOp`, LWW apply, `/lesson-items` offline branch |

**Phase 1 is one migration + one lib + one page + two islands.** No changes to any existing write
path, no touching the sync engine — the payoff of Decision 1(C).

---

## Resolved questions (from review)

1. **Favorites are on items, not lessons.** ✅ `is_favorite` on `lesson_item_attrs`; sortable and
   filterable. It is the page's only write.
2. **Removed items still appear — removal detaches from a *lesson*, it doesn't delete the item.**
   ✅ The list is every item ever added. Each row shows the lesson(s) it currently belongs to; when
   it belongs to none, the reference is **empty/null** and the row renders as *"not in any
   lesson"*. This is what the `lessons` jsonb aggregate in `owner_items` is for, and it's why the
   view groups over **all** `lesson_items` rows rather than active ones. Suggested affordance: an
   "in no lesson" filter, since that set is precisely "words I've dropped" — a useful review pile.
   Note the statistics still count the item's whole history (a dropped word keeps the practice
   count it earned), which is the right behaviour and worth stating in the UI copy.
3. **The list is read-only** (apart from favoriting). ✅ Also load-bearing: a rename would mutate
   `norm_key` and orphan the attrs row, so read-only isn't just scope-trimming — it's what keeps
   the text key safe.
4. **The tutor does not read the level.** ✅ Out of scope. Level is display + filter only.

## Explicitly out of scope for v1

Dropped per review — recorded only so they aren't rediscovered as "missing":
transcript-accurate practice counts, `pg_trgm` fuzzy search, bulk actions (select N items → new
lesson), and any level-authoring UI or LLM classification.
