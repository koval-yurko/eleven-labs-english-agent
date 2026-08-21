-- 0015_owner_items_translations.sql — put the Russian on the list row.
--
-- The words list showed a word and its statistics; a learner scanning it had no way to remember
-- which word was which without opening each one. The translations already exist — the enrichment
-- job (0009) writes `words.details.translations_ru`, best/most-common first — they were simply not
-- reachable from the list.
--
-- ## Why a view column and not a second query
--
-- 0009 deliberately left `owner_items` alone, on the grounds that the list does `select *` and "a
-- fat jsonb blob per row has no business in a payload the list neither needs nor renders". That
-- reasoning still holds and this migration does not overturn it: `details` stays off the view. What
-- goes on is a **derived text[] of at most three glosses** — tens of bytes, not the forms and the
-- example sentences — and the detail page keeps its own narrow read of the full document.
--
-- The alternative was a second round trip from `listItems` joining `words.details` and slicing in
-- TypeScript. Rejected: it puts "how many translations does a row show" in the app rather than in
-- the schema, and it would have to be re-implemented identically the next time something lists
-- words.
--
-- ## The shape
--
-- `text[]`, empty (never null) when the word has not been enriched or the job found nothing usable
-- — so a client renders `translations_ru.length === 0` rather than having to distinguish absent
-- from empty. Three is the ceiling the row can show at phone width; the rest stay on the detail
-- page.
--
-- `create or replace view` can only APPEND columns, which is why `translations_ru` is last rather
-- than beside `text` where it belongs semantically. Nothing reads this view positionally.

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
  --
  -- `w.details` is legal beside `group by w.id` because id is the primary key of `words`; Postgres
  -- resolves the functional dependency, exactly as it already does for `w.text` and `w.level`.
  case
    when jsonb_typeof(w.details -> 'translations_ru') = 'array' then (
      select coalesce(array_agg(t.gloss order by t.idx), '{}'::text[])
        from jsonb_array_elements_text(w.details -> 'translations_ru')
             with ordinality as t(gloss, idx)
       where t.idx <= 3
    )
    else '{}'::text[]
  end                                                                                      as translations_ru
from words w
left join lesson_items i on i.word_id = w.id
left join lessons      l on l.id = i.lesson_id
left join owner_item_practice p on p.owner_id = w.owner_id and p.word_id = w.id
group by w.id, p.practice_count, p.last_practiced_at;

comment on view owner_items is
  'The words collection decorated with cross-lesson statistics. `translations_ru` is the first three '
  'glosses of words.details.translations_ru (0009), derived here so every list of words shows the '
  'same number of them; the full enrichment document stays off this view and is read per-word by '
  'the detail page.';
