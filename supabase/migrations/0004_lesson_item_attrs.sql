-- 0004_lesson_item_attrs.sql — the vocabulary key, per-item attributes, and the derived
-- cross-lesson item list behind /lesson-items.
--
-- See docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md.
--
-- Three moves:
--   1. Replace lesson_items.normalized_text (a GENERATED column, lower+btrim only) with
--      norm_key, maintained by a trigger. Generated columns force IMMUTABLE and can never be
--      revised without a table rewrite; a trigger-maintained column is revised with
--      CREATE OR REPLACE FUNCTION + one backfill UPDATE. We are changing the rule right now,
--      which is the evidence we will want to change it again.
--   2. lesson_item_attrs — the per-item facts (level, favorite, categories). Keyed on
--      (owner_id, norm_key), NOT on lesson_items.id: an item is the same item in every lesson
--      and survives remove → re-add, so keying on the row would split its attributes across
--      lessons and lose them on re-add.
--   3. Views that derive the item list + its statistics from lesson_items + lesson_sessions.

-- ---------------------------------------------------------------------------------------------
-- 1. The vocabulary key
-- ---------------------------------------------------------------------------------------------

-- unaccent (café → cafe). Usable here precisely because the key is trigger-maintained: unaccent
-- is STABLE, so it could not appear in a generated column / index expression without the
-- well-known "wrap it in a fake IMMUTABLE function" footgun.
create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;

-- What makes two typed strings "the same item".
-- Deliberately NOT stemming, lemmatizing, or dropping articles — "running" and "run", "the ice"
-- and "ice", are different things to practice. This only erases differences a human would call
-- typography. The learner's exact spelling is always kept in lesson_items.text for display.
create or replace function lesson_item_norm_key(raw text)
returns text
language sql
set search_path = public, extensions
as $$
  select nullif(
    btrim(                                            -- 5. wrapping quotes / terminal punctuation
      regexp_replace(                                 -- 4. collapse whitespace runs
        lower(                                        -- 3. case-fold
          extensions.unaccent(                        -- 2b. café → cafe
            translate(                                -- 2a. typography → ASCII
              normalize(raw, NFKC),                   -- 1. canonical Unicode (ﬁ → fi, ／ → /)
              -- ’ ‘ ʼ “ ” – — NBSP   (iOS smart punctuation is ON by default, and this is a
              -- phone-typed PWA: without this line "don’t" and "don't" are two vocabulary items)
              U&'\2019\2018\02BC\201C\201D\2013\2014\00A0',
              -- ' ' ' " " - - space
              U&'\0027\0027\0027\0022\0022\002D\002D\0020'
            )
          )
        ),
        '\s+', ' ', 'g'
      ),
      $trim$ .,;:!?"'`()[]{}…-$trim$                  -- ends only; internal ' and - survive
    ),
  '');                                                -- '"..."' → '' → NULL, not a phantom item
$$;

alter table lesson_items add column norm_key text;

create or replace function lesson_items_set_norm_key() returns trigger
language plpgsql as $$
begin
  -- Fall back to the old rule if normalization leaves nothing (punctuation-only text).
  new.norm_key := coalesce(lesson_item_norm_key(new.text), lower(btrim(new.text)));
  return new;
end $$;

create trigger lesson_items_norm_key
  before insert or update of text on lesson_items
  for each row execute function lesson_items_set_norm_key();

-- Backfill: touching `text` fires the trigger.
update lesson_items set text = text;
alter table lesson_items alter column norm_key set not null;

-- Swap the cross-lesson index onto the new key. normalized_text is referenced by NO application
-- code (only migration 0003), so dropping it now is free — and doing it after attributes exist
-- would mean migrating lesson_item_attrs' primary key too.
create index lesson_items_owner_key_idx on lesson_items (owner_id, norm_key);
drop index lesson_items_owner_norm_idx;
alter table lesson_items drop column normalized_text;

-- ---------------------------------------------------------------------------------------------
-- 2. Per-item attributes
-- ---------------------------------------------------------------------------------------------

-- Ordering is free (A1 < A2 < … < C2), so "sort by level" needs no CASE. A1 is headroom; the UI
-- offers A2–C2.
create type cefr_level as enum ('A1','A2','B1','B2','C1','C2');

-- SPARSE: a row appears lazily, the first time the learner favorites an item or the (future)
-- background job levels it. No row = unleveled, not-favorite, untagged.
create table lesson_item_attrs (
  owner_id     text not null,                       -- Auth0 sub
  norm_key     text not null,                       -- matches lesson_items.norm_key
  -- level is written by a FUTURE BACKGROUND JOB, never by the UI. Nullable forever: "unleveled"
  -- is a permanent, first-class state the filter must handle.
  level        cefr_level,
  level_source text check (level_source in ('job','user')),  -- 'user' reserved; nothing writes it
  level_at     timestamptz,
  is_favorite  boolean not null default false,      -- the ONE thing the page writes
  categories   jsonb not null default '{}'::jsonb,  -- open-ended {name: value}, filterable
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, norm_key)
);

-- Filter by a category whose name nobody has thought of yet: categories @> '{"topic":"business"}'
create index lesson_item_attrs_categories_idx
  on lesson_item_attrs using gin (categories jsonb_path_ops);
-- The PK covers the owner scan; favorite/level filters run over one row per *touched* item.

alter table lesson_item_attrs enable row level security;

create policy "lesson_item_attrs owner select"
  on lesson_item_attrs for select
  using (owner_id = auth.jwt() ->> 'sub');

create policy "lesson_item_attrs owner insert"
  on lesson_item_attrs for insert
  with check (owner_id = auth.jwt() ->> 'sub');

create policy "lesson_item_attrs owner update"
  on lesson_item_attrs for update
  using (owner_id = auth.jwt() ->> 'sub');

-- ---------------------------------------------------------------------------------------------
-- 3. The derived list
-- ---------------------------------------------------------------------------------------------
-- security_invoker: the views run with the CALLER's permissions, so the base tables' RLS still
-- applies to them (without it a view would be a hole around RLS for any non-service role).

-- Conversations held on a lesson WHILE the item was in it. The temporal predicate is what makes
-- this honest: without it, an item removed from a busy lesson would still be credited with every
-- conversation that lesson ever had — including ones held before the item was added.
create view owner_item_practice with (security_invoker = true) as
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

-- One row per distinct item the owner has EVER had. lesson_items stays the source of truth for
-- which items exist; lesson_item_attrs only decorates. Removal detaches an item from a LESSON —
-- it never deletes the item, so a dropped word still appears here, with an empty `lessons` array
-- ("not in any lesson") and the practice count it already earned.
create view owner_items with (security_invoker = true) as
select
  i.owner_id,
  i.norm_key,
  -- display form: the most recently typed spelling (keeps the learner's own casing/punctuation)
  (array_agg(i.text order by i.created_at desc))[1]                  as text,
  -- word / phrase / sentence — derived, so no column to store and nothing to drift
  case
    when i.norm_key !~ '\s' then 'word'
    when array_length(regexp_split_to_array(i.norm_key, '\s+'), 1) <= 4 then 'phrase'
    else 'sentence'
  end                                                                as kind,
  count(distinct i.lesson_id)                                        as lesson_count,
  count(distinct i.lesson_id) filter (where i.removed_at is null)    as active_lesson_count,
  min(i.created_at)                                                  as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      filter (where i.removed_at is null),
    '[]'::jsonb)                                                     as lessons,
  coalesce(p.practice_count, 0)                                      as practice_count,
  p.last_practiced_at,
  a.level,
  a.level_source,
  coalesce(a.is_favorite, false)                                     as is_favorite,
  coalesce(a.categories, '{}'::jsonb)                                as categories
from lesson_items i
join lessons l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = i.owner_id and p.norm_key = i.norm_key
left join lesson_item_attrs   a on a.owner_id = i.owner_id and a.norm_key = i.norm_key
group by i.owner_id, i.norm_key, p.practice_count, p.last_practiced_at,
         a.level, a.level_source, a.is_favorite, a.categories;

-- Self-describing filter UI: which categories exist, and how many items carry each value. This is
-- what lets `categories` be jsonb (open-ended, no migration per new name) without the filter
-- controls needing a hard-coded list.
create view owner_item_facets with (security_invoker = true) as
select owner_id,
       kv.key            as name,
       kv.value #>> '{}' as value,
       count(*)          as item_count
  from lesson_item_attrs, lateral jsonb_each(categories) kv
 group by owner_id, kv.key, kv.value #>> '{}';
