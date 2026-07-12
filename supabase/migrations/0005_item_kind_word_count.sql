-- 0005_item_kind_word_count.sql — count WORDS, not whitespace-separated tokens, when classifying
-- an item as word / phrase / sentence.
--
-- 0004 split norm_key on '\s+', so punctuation counted as a word: "despite / in spite of" came
-- out as 5 tokens → 'sentence', when it is plainly a phrase. Strip everything that isn't a letter
-- (keeping the apostrophe and hyphen, so "don't" and "thought-out" stay ONE word) and count what
-- is left.
--
-- Only the `kind` expression changes, so CREATE OR REPLACE VIEW is enough (same columns, order,
-- and types).

create or replace view owner_items with (security_invoker = true) as
select
  i.owner_id,
  i.norm_key,
  (array_agg(i.text order by i.created_at desc))[1]                  as text,
  case
    when array_length(
      regexp_split_to_array(
        btrim(regexp_replace(i.norm_key, $re$[^a-z'-]+$re$, ' ', 'g')),
        '\s+'
      ), 1) <= 1 then 'word'
    when array_length(
      regexp_split_to_array(
        btrim(regexp_replace(i.norm_key, $re$[^a-z'-]+$re$, ' ', 'g')),
        '\s+'
      ), 1) <= 4 then 'phrase'
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
