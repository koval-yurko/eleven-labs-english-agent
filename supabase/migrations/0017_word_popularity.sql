-- 0017_word_popularity.sql — the favourite flag becomes a count.
--
-- See docs/2026-08-22-word-popularity-replaces-favorites.md.
--
-- `words.is_favorite` answered "does this word matter to me", a boolean the learner set by hand.
-- `words.popularity` answers a different and more useful question — "how many times have I met this
-- word again" — and it is written by the ADD PATH rather than by a star: tapping a word the
-- autocomplete marks as already-owned bumps it and opens the word, and re-adding an owned word
-- through the Add button does the same. The favourite flag, its `?fav=1` filter, its sort key and its
-- star are removed outright rather than kept alongside.
--
-- **No backfill: every existing word starts at 0.** A boolean cannot be honestly converted to a
-- count — mapping true → 1 would claim the learner met that word once, when what they actually said
-- is "this one matters". Starting the whole collection at zero makes the counter mean exactly one
-- thing from here on.

-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
-- `owner_items` SELECTS `w.is_favorite`, so the column cannot be dropped while the view stands, and
-- `create or replace view` can only APPEND columns — it cannot remove one (0015's note, in the
-- opposite direction). Hence drop → alter → recreate. Nothing else depends on this view:
-- `owner_items_pending_level` (0007) and `owner_words_pending_details` (0009) read `words` directly,
-- and `owner_item_facets` touches only `categories`.
drop view owner_items;

alter table words drop column is_favorite;

-- NOT NULL with a default, so the sort needs no nullsFirst handling and the UI never renders a blank
-- where a number belongs. 0 is a first-class value the row shows like any other.
alter table words add column popularity int not null default 0;

comment on column words.popularity is
  'How many times the learner has met this word again — bumped when they pick an already-owned word '
  'from the add-word suggestions, or re-add one through the Add button. The ONE column the UI writes: '
  'level and details belong to the background jobs.';

-- ---------------------------------------------------------------------------------------------
-- 2. The view, restated
-- ---------------------------------------------------------------------------------------------
-- 0016's body verbatim, with `w.is_favorite` → `w.popularity`. A `create view` rather than a replace
-- because the drop above left nothing to replace.
create view owner_items with (security_invoker = true) as
select
  w.id,
  w.owner_id,
  w.norm_key,
  w.text,
  lesson_item_kind(w.norm_key)                                                             as kind,
  count(distinct i.lesson_id) filter (where l.deleted_at is null)                          as lesson_count,
  count(distinct i.lesson_id)
    filter (where i.removed_at is null and l.deleted_at is null)                           as active_lesson_count,
  w.created_at                                                                             as first_added_at,
  coalesce(
    jsonb_agg(distinct jsonb_build_object('id', l.id, 'title', l.title))
      -- `i.lesson_id is not null` keeps a word with no links from emitting a phantom {null,null}
      -- chip (0007); `l.deleted_at is null` drops the just-deleted lesson's chip.
      filter (where i.removed_at is null and i.lesson_id is not null and l.deleted_at is null),
    '[]'::jsonb)                                                                           as lessons,
  coalesce(p.practice_count, 0)                                                            as practice_count,
  p.last_practiced_at,
  w.level,
  w.level_source,
  w.popularity,
  w.categories,
  -- The `jsonb_typeof` guard is not defensive noise: `details` is a schemaless jsonb column, and
  -- `jsonb_array_elements_text` on a non-array RAISES — which would take down the whole list page
  -- for every word the owner has, over one malformed row. An unexpected shape degrades to "no
  -- translations" instead.
  case
    when jsonb_typeof(w.details -> 'translations_ru') = 'array' then (
      select coalesce(array_agg(t.gloss order by t.idx), '{}'::text[])
        from jsonb_array_elements_text(w.details -> 'translations_ru')
             with ordinality as t(gloss, idx)
       where t.idx <= 6
    )
    else '{}'::text[]
  end                                                                                      as translations_ru
from words w
left join lesson_items i on i.word_id = w.id
left join lessons      l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;

comment on view owner_items is
  'The words collection decorated with cross-lesson statistics. `translations_ru` is the first six '
  'glosses of words.details.translations_ru (0009) — i.e. all of them, since the enrichment job '
  'stores at most MAX_TRANSLATIONS = 6 — derived here so every list of words shows the same number '
  'of them; the full enrichment document stays off this view and is read per-word by the detail '
  'page.';

-- ---------------------------------------------------------------------------------------------
-- 3. The increment
-- ---------------------------------------------------------------------------------------------
-- An RPC rather than an update from the app, for two reasons. `popularity = popularity + 1` cannot be
-- expressed through PostgREST at all, and the read-modify-write it would otherwise take loses
-- concurrent bumps (two devices, or a tap while an add is in flight) on top of costing a round trip.
--
-- Returns the NEW value, so the client renders truth instead of an optimistic guess — the detail
-- page's +1 control has nothing to reconcile afterwards.
--
-- NULL means no row matched: an id that is not the caller's, or a word already deleted. The
-- `owner_id` filter IS the ownership gate, as everywhere else in this schema.
create function bump_word_popularity(p_owner_id text, p_id uuid)
returns int
language sql
as $fn$
  update words
     set popularity = popularity + 1,
         updated_at = now()
   where owner_id = p_owner_id
     and id = p_id
  returning popularity;
$fn$;

comment on function bump_word_popularity(text, uuid) is
  'Atomically +1 a word''s popularity, returning the new value (NULL when no row matched).';

revoke all on function bump_word_popularity(text, uuid) from public;
grant execute on function bump_word_popularity(text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. suggest_words: `owned boolean` → `word_id uuid`
-- ---------------------------------------------------------------------------------------------
-- The dropdown can now ACT on a row it marks as already-owned: bump the word and open its page. That
-- needs the word's id, and `/lesson-items/:id` is id-addressed — a client may not derive a word's
-- identity from its text (CLAUDE.md: text → word id goes through Postgres, never a client guess).
--
-- This costs nothing: `owned` was already `(w.id is not null)` over a join that has been here since
-- 0013. Returning the id instead of the boolean carries strictly more information from the same
-- query, and `owned` stays derivable as `word_id is not null` — expressed once, at the render site,
-- rather than as two fields that must agree.
--
-- DROP first, as 0013 did: changing the RETURNS TABLE changes the function's return type, which
-- Postgres will not replace in place.
--
-- ⚠️ The ORDER BY below is copied BYTE FOR BYTE from 0013 and must stay that way. The client caches a
-- whole two-character bucket and narrows it locally, re-applying exactly this order; a divergence
-- here would show up as a dropdown that reshuffles whenever the cache is bypassed, and nothing would
-- fail loudly.
drop function if exists suggest_words(text, text, int);

create function suggest_words(p_owner_id text, p_prefix text, p_limit int default 8)
returns table (key text, text text, level text, ru text[], word_id uuid)
language plpgsql
stable
as $fn$
declare
  k   text := lesson_item_norm_key(p_prefix);
  pat text;
begin
  if k is null or length(k) < 2 then return; end if;

  pat := replace(replace(replace(k, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
    select l.key, l.text, l.level::text, l.ru, w.id
      from lexicon l
      left join words w on w.owner_id = p_owner_id and w.norm_key = l.key
     where l.key like pat escape '\'
     order by (l.key like '% %'), l.zipf desc, l.key
     limit least(greatest(coalesce(p_limit, 8), 1), 2000);
end $fn$;

revoke all on function suggest_words(text, text, int) from public;
grant execute on function suggest_words(text, text, int) to service_role;
