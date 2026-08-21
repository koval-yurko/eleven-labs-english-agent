-- 0016_owner_items_more_translations.sql — let a list row show more than three glosses.
--
-- 0015 put the Russian on the words list and capped it at three, with the reasoning that "three is
-- the ceiling the row can show at phone width". That was true of the row 0015 was written against,
-- which rendered the glosses on ONE line with `numberOfLines={1}`: past three the line ellipsised,
-- so a fourth gloss would have crossed the wire only to be clipped in the layout.
--
-- The row now wraps to three lines. The constraint that produced the number is gone, so the number
-- moves with it — and it moves to SIX, which is not an arbitrary bump: `MAX_TRANSLATIONS` in
-- `apps/web/src/lib/word-details.ts` is 6, so six is every gloss the enrichment job will ever store
-- for a word. The view stops being a second, tighter cap and becomes a pass-through of the head of
-- the document, which is one fewer number that has to agree with anything.
--
-- **No backfill, no re-enrichment.** The glosses this exposes were written by 0009's job and have
-- been sitting in `words.details.translations_ru` all along; only the view was hiding them. Every
-- already-enriched word gains its fourth-to-sixth gloss the moment this is applied.
--
-- **Still derived here rather than in the client.** 0015's argument holds unchanged: "how many
-- translations does a list row show" belongs in the schema, so that every list of words agrees on
-- it without re-implementing the slice. This migration changes the answer, not the place.
--
-- Body copied from 0015 with `t.idx <= 3` → `t.idx <= 6`; `create or replace view` needs the whole
-- select restated, and the column list is unchanged (same names, same order, same types), so this
-- is a legal replace rather than a drop.

create or replace view owner_items with (security_invoker = true) as
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
  w.is_favorite,
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
