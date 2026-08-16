-- 0013_suggest_words_bucket.sql — let one request answer a whole word's worth of typing.
--
-- Phase 4 of docs/2026-08-15-word-autocomplete-suggestions.md. Two changes to `suggest_words`:
-- it returns each row's `key`, and its limit ceiling rises from 25 to 2,000.
--
-- Why: a client that holds every row matching the learner's first TWO characters can narrow that
-- set itself for every character after them, without asking again. Measured over 10,122 prefixes,
-- narrowing a complete 2-character bucket reproduces this function's own top-8 **100% of the time**
-- — it cannot do otherwise, since every row matching `ubiq` also matches `ub` and the ORDER BY is
-- total. So the route goes from one call per keystroke to one call per word, and characters three
-- onward render with no network at all.
--
-- The 25-row ceiling was right when a caller could only ever want a screenful. It is what now has
-- to move, and it is the only reason this is a migration rather than a client change.
--
-- `key` is what makes the narrowing possible: it is `lesson_item_norm_key(text)`, so a client
-- comparing a typed prefix against it is comparing against the same string Postgres matched on,
-- rather than against the display spelling (`Absolute`, `ABS`) which is not case-folded.

-- DROP first, not `create or replace`: adding `key` to the RETURNS TABLE changes the function's
-- return type, and Postgres refuses to replace a function's signature in place. Safe here because
-- nothing holds a reference to it — the only caller is a route that resolves it by name per query.
drop function if exists suggest_words(text, text, int);

create function suggest_words(p_owner_id text, p_prefix text, p_limit int default 8)
returns table (key text, text text, level text, ru text[], owned boolean)
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
    select l.key, l.text, l.level::text, l.ru, (w.id is not null)
      from lexicon l
      left join words w on w.owner_id = p_owner_id and w.norm_key = l.key
     where l.key like pat escape '\'
     -- Unchanged, and now load-bearing twice over: the client re-applies exactly this order when it
     -- narrows a bucket, so any change here without the matching change there would make the two
     -- disagree — visibly, as a list that reshuffles when the cache is bypassed. Single words before
     -- phrases (44% of the corpus is multiword and wordfreq over-rates it), then zipf, then key for
     -- a total order. See §14.
     order by (l.key like '% %'), l.zipf desc, l.key
     -- 2,000, up from 25. Above the largest real bucket (`co`, 1,920 rows) with room to grow; a
     -- client that gets exactly this many must treat its bucket as truncated and stop narrowing.
     limit least(greatest(coalesce(p_limit, 8), 1), 2000);
end $fn$;

revoke all on function suggest_words(text, text, int) from public;
grant execute on function suggest_words(text, text, int) to service_role;
