-- 0007_words_m2m.sql — the vocabulary becomes an entity; lessons reference it many-to-many.
--
-- See docs/2026-07-16-add-word-on-lesson-items-page.md.
--
-- Until now a "word" had no row of its own: it was whatever distinct norm_key the owner_items view
-- happened to find across lesson_items, and its attributes lived in a side table keyed on that
-- string. That is why a word could not exist without a lesson — the only way to say "this word is
-- mine" was to attach it to one.
--
-- Four moves:
--   1. `words` — the collection. One row per distinct (owner_id, norm_key), independent of any
--      lesson. This is what /lesson-items lists and what the level job reads.
--   2. lesson_item_attrs FOLDS IN and is dropped. Its design (sparse, no FK, keyed on norm_key so
--      attrs "survive remove → re-add and span lessons") was a workaround for the absence of this
--      table. Once a word has a row, level/favorite/categories are just its columns.
--   3. lesson_items becomes a pure JOIN table: it keeps its id (the offline outbox mints those) and
--      `position` (which orders words *within* a lesson — the one thing meaningless outside one),
--      loses text/norm_key to `words`, and gains word_id.
--   4. Views rebuilt over words + lesson_items. A word in NO lesson is now the natural base case of
--      a LEFT JOIN rather than a constraint anyone has to relax.
--
-- lesson_items keeps its name: renaming to lesson_words would touch every policy, index, and query
-- to buy a synonym, and this migration is already large enough to review carefully.

-- ---------------------------------------------------------------------------------------------
-- 0. `kind` becomes a function
-- ---------------------------------------------------------------------------------------------
-- 0005 revised this expression once already, in a view. It is about to be needed in two views, so
-- centralize it now rather than let two copies drift apart.
create or replace function lesson_item_kind(norm_key text)
returns text
language sql
immutable
as $fn$
  select case
    when array_length(
      regexp_split_to_array(
        -- strip everything that isn't a letter, keeping ' and - so "don't" and "thought-out"
        -- stay ONE word (0005)
        btrim(regexp_replace(norm_key, $re$[^a-z'-]+$re$, ' ', 'g')), '\s+'
      ), 1) <= 1 then 'word'
    when array_length(
      regexp_split_to_array(
        btrim(regexp_replace(norm_key, $re$[^a-z'-]+$re$, ' ', 'g')), '\s+'
      ), 1) <= 4 then 'phrase'
    else 'sentence'
  end;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- 1. The collection
-- ---------------------------------------------------------------------------------------------

create table words (
  id           uuid primary key default gen_random_uuid(),
  owner_id     text not null,                                -- Auth0 sub
  -- The learner's own spelling, most recently typed. `resolveWords` keeps this current via
  -- ON CONFLICT DO UPDATE — the rule owner_items used to apply with array_agg(order by created_at),
  -- moved to the write path now that there is a row to hold it.
  text         text not null,
  norm_key     text not null,                                -- lesson_item_norm_key(text), by trigger
  -- Written by the level job (src/lib/levels.ts), never by the UI. Nullable forever: "unleveled" is
  -- a permanent, first-class state. `level_at` is the ATTEMPTED flag, not the succeeded flag.
  level        cefr_level,
  level_source text check (level_source in ('job','user')),  -- 'user' reserved; nothing writes it
  level_at     timestamptz,
  is_favorite  boolean not null default false,
  categories   jsonb not null default '{}'::jsonb,           -- open-ended {name: value}, filterable
  created_at   timestamptz not null default now(),           -- = owner_items.first_added_at
  updated_at   timestamptz not null default now(),
  -- The natural key, and the whole point: it is stable ACROSS clients, where a uuid is stable only
  -- within one. Two devices adding "ubiquitous" offline now converge on this row instead of
  -- inserting two of them.
  unique (owner_id, norm_key)
);

create or replace function words_set_norm_key() returns trigger
language plpgsql as $$
begin
  -- Same fallback as lesson_items had: punctuation-only text normalizes to NULL.
  new.norm_key := coalesce(lesson_item_norm_key(new.text), lower(btrim(new.text)));
  return new;
end $$;

-- BEFORE INSERT, so norm_key exists by the time ON CONFLICT (owner_id, norm_key) is evaluated —
-- that is what lets the client upsert a word while knowing only its text.
create trigger words_norm_key
  before insert or update of text on words
  for each row execute function words_set_norm_key();

-- Text → word, the only way in. `norm_key` needs unaccent + NFKC, so the browser cannot compute it
-- and cannot know whether the word it is adding already exists; resolution has to happen here.
--
-- Why a loop of single-row upserts rather than one multi-row statement: two inputs in the same
-- batch can normalize to the SAME norm_key ("Ubiquitous." and "ubiquitous"), and Postgres raises
-- "ON CONFLICT DO UPDATE command cannot affect row a second time" when one statement's rows collide
-- on the arbiter. One statement per input sidesteps that and stays race-safe (the upsert, not a
-- select-then-insert, is what makes concurrent adds converge).
--
-- `xmax = 0` distinguishes inserted from updated — that's how addWord can honestly say
-- "already in your collection" instead of silently no-op'ing.
create or replace function resolve_words(p_owner_id text, p_texts text[])
returns table (input_text text, word_id uuid, was_created boolean)
language plpgsql
as $$
declare
  t text;
begin
  foreach t in array p_texts loop
    t := btrim(t);
    continue when t = '';
    return query
      insert into words (owner_id, text) values (p_owner_id, t)
      on conflict (owner_id, norm_key)
        do update set text = excluded.text, updated_at = now()
      returning t, words.id, (words.xmax = 0);
  end loop;
end $$;

-- Server-only: every caller is a Server Action holding the session's owner id. INVOKER rights (the
-- default) mean words' RLS still applies if it is ever reached with a user token, so p_owner_id
-- cannot be used to write into someone else's collection.
revoke all on function resolve_words(text, text[]) from public;
grant execute on function resolve_words(text, text[]) to service_role;

create index words_categories_idx on words using gin (categories jsonb_path_ops);
-- The level job's queue: `where level_at is null`, newest first.
create index words_owner_pending_idx on words (owner_id, created_at desc) where level_at is null;

-- One word per distinct (owner_id, norm_key). Newest spelling wins and created_at is the earliest
-- link's — preserving exactly what owner_items.text and .first_added_at report today.
insert into words (owner_id, text, norm_key, created_at)
select owner_id, (array_agg(text order by created_at desc))[1], norm_key, min(created_at)
  from lesson_items
 group by owner_id, norm_key;

-- ---------------------------------------------------------------------------------------------
-- 2. Fold the attributes in
-- ---------------------------------------------------------------------------------------------
-- lesson_item_attrs is sparse, so this touches only words that were ever favorited or levelled.
update words w
   set level        = a.level,
       level_source = a.level_source,
       level_at     = a.level_at,
       is_favorite  = a.is_favorite,
       categories   = a.categories,
       updated_at   = a.updated_at
  from lesson_item_attrs a
 where a.owner_id = w.owner_id and a.norm_key = w.norm_key;

-- ---------------------------------------------------------------------------------------------
-- 3. Collapse duplicate links BEFORE the unique index can see them
-- ---------------------------------------------------------------------------------------------
-- The client dedupes an add with text.trim().toLowerCase() (src/lib/sync/engine.ts), which is NOT
-- lesson_item_norm_key: "Ubiquitous." and "ubiquitous" pass that check as distinct and can both be
-- active in one lesson today. They share a norm_key, so they are about to share a word_id, and the
-- partial unique index below would fail on them.
--
-- Keep the earliest link, soft-remove the rest — the same "removal detaches, never deletes"
-- semantics the app already has, so no history and no practice credit is lost.
update lesson_items i
   set removed_at = now()
 where i.removed_at is null
   and exists (
     select 1 from lesson_items j
      where j.lesson_id = i.lesson_id
        and j.norm_key  = i.norm_key
        and j.removed_at is null
        and (j.created_at, j.id) < (i.created_at, i.id)
   );

-- ---------------------------------------------------------------------------------------------
-- 4. lesson_items → join table
-- ---------------------------------------------------------------------------------------------
-- on delete cascade: deleting a word (nothing does yet) unlinks it from every lesson.
alter table lesson_items add column word_id uuid references words(id) on delete cascade;

update lesson_items i
   set word_id = w.id
  from words w
 where w.owner_id = i.owner_id and w.norm_key = i.norm_key;

alter table lesson_items alter column word_id set not null;

-- PARTIAL on purpose. Remove-then-re-add must create a second row for the same (lesson_id, word_id)
-- while the removed one survives: owner_item_practice reads each link's created_at/removed_at to
-- decide which sessions the word was actually present for. A total constraint would either block
-- the re-add or force destroying that history.
create unique index lesson_items_lesson_word_active_idx
  on lesson_items (lesson_id, word_id) where removed_at is null;

create index lesson_items_word_idx on lesson_items (word_id);

-- ---------------------------------------------------------------------------------------------
-- 5. Drop the old derived layer (before the columns it reads disappear)
-- ---------------------------------------------------------------------------------------------
drop view owner_items_pending_level;   -- depends on owner_items
drop view owner_item_facets;           -- depends on lesson_item_attrs
drop view owner_items;                 -- depends on owner_item_practice + lesson_item_attrs
drop view owner_item_practice;

drop trigger lesson_items_norm_key on lesson_items;
drop function lesson_items_set_norm_key();
drop index lesson_items_owner_key_idx;
alter table lesson_items drop column text, drop column norm_key;

drop table lesson_item_attrs;

-- lesson_items.owner_id is now derivable from BOTH lessons and words. It stays: it is what every
-- RLS policy and every query filters on, and re-deriving it per query costs a join. Denormalized
-- deliberately — createLesson/upsertLessonItems stamp it from the session, same as before.

-- ---------------------------------------------------------------------------------------------
-- 6. The derived layer, rebuilt over `words`
-- ---------------------------------------------------------------------------------------------
-- security_invoker: the views run with the CALLER's permissions, so the base tables' RLS still
-- applies (without it a view would be a hole around RLS for any non-service role).

-- Conversations held on a lesson WHILE the word was linked to it. The temporal predicate is what
-- makes this honest: without it, a word removed from a busy lesson would still be credited with
-- every conversation that lesson ever had — including ones held before it was added.
create view owner_item_practice with (security_invoker = true) as
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

-- One row per word the owner has. Same columns as before (plus `id`), so /lesson-items and
-- src/lib/lesson-items.ts read it unchanged — only the source of truth underneath moved.
--
-- FROM words LEFT JOIN the links: a word in no lesson is the base case, not an exception. It
-- reports lesson_count 0 (count() ignores nulls), which is what the existing `?unassigned=1` filter
-- already selects on — so a word added directly from /lesson-items and a word removed from every
-- lesson are the same state, as they should be.
create view owner_items with (security_invoker = true) as
select
  w.id,
  w.owner_id,
  w.norm_key,
  w.text,
  lesson_item_kind(w.norm_key)                                    as kind,
  count(distinct i.lesson_id)                                     as lesson_count,
  count(distinct i.lesson_id) filter (where i.removed_at is null) as active_lesson_count,
  w.created_at                                                    as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      -- `i.lesson_id is not null` is NOT redundant: for a word with no links the LEFT JOIN yields
      -- an all-nulls row, for which `i.removed_at is null` is TRUE — the filter would pass and the
      -- aggregate would emit {"id": null, "title": null} as a phantom lesson chip.
      filter (where i.removed_at is null and i.lesson_id is not null),
    '[]'::jsonb)                                                  as lessons,
  coalesce(p.practice_count, 0)                                   as practice_count,
  p.last_practiced_at,
  w.level,
  w.level_source,
  w.is_favorite,
  w.categories
from words w
left join lesson_items i on i.word_id = w.id
left join lessons      l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;

-- Self-describing filter UI: which categories exist, and how many words carry each value. This is
-- what lets `categories` be jsonb (open-ended, no migration per new name) without the filter
-- controls needing a hard-coded list.
create view owner_item_facets with (security_invoker = true) as
select owner_id,
       kv.key            as name,
       kv.value #>> '{}' as value,
       count(*)          as item_count
  from words, lateral jsonb_each(categories) kv
 group by owner_id, kv.key, kv.value #>> '{}';

-- The level job's queue. No longer needs owner_items at all — pending is a property of the word, so
-- this is a straight scan of the collection (see words_owner_pending_idx).
create view owner_items_pending_level with (security_invoker = true) as
select w.owner_id,
       w.id as word_id,
       w.norm_key,
       w.text,
       lesson_item_kind(w.norm_key) as kind,
       w.created_at                 as first_added_at
  from words w
 where w.level_at is null;

-- ---------------------------------------------------------------------------------------------
-- 7. RLS
-- ---------------------------------------------------------------------------------------------
alter table words enable row level security;

create policy "words owner select"
  on words for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "words owner insert"
  on words for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "words owner update"
  on words for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');

-- lessons has had an UPDATE path since 0003 (touchLesson bumps updated_at) but never an UPDATE
-- policy. Inert today — every write goes through the service-role client, which bypasses RLS — but
-- the day the token-scoped client (src/lib/supabase/user-client.ts) is wired up, the gap would look
-- like a mystery bug rather than a missing line.
create policy "lessons owner update"
  on lessons for update
  using (owner_id = auth.jwt() ->> 'sub')
  with check (owner_id = auth.jwt() ->> 'sub');
