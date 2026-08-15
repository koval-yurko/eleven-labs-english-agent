-- 0012_suggest_words.sql — the add-word autocomplete's one query.
--
-- Phase 2 of docs/2026-08-15-word-autocomplete-suggestions.md. Prefix-matches the lexicon (0010),
-- joins the learner's own collection so a row can say "you already have this", and returns at most
-- a screenful. Behind `GET /api/v2/lexicon/suggest`.
--
-- A function rather than a PostgREST query for the same reason `resolve_words` is one: the search
-- key is `lesson_item_norm_key`, which only Postgres can compute, and it has to be applied to the
-- learner's raw keystrokes on the way in. A client that normalized the prefix itself would be the
-- client-side identity guess `CLAUDE.md` forbids, and it would silently miss `Ubiqu` and `café`.

create or replace function suggest_words(p_owner_id text, p_prefix text, p_limit int default 8)
returns table (text text, level text, ru text[], owned boolean)
language plpgsql
stable
as $fn$
declare
  k   text := lesson_item_norm_key(p_prefix);
  pat text;
begin
  -- Below two characters there is nothing worth suggesting: a 1-character prefix matches 3,340 of
  -- the 53,538 rows. Returning empty rather than erroring — the client debounces into this state on
  -- every single word it types, and an error would make normal typing look like a fault.
  -- `k is null` is the punctuation-only case, which `lesson_item_norm_key` folds to NULL.
  if k is null or length(k) < 2 then return; end if;

  -- `%` and `_` are LIKE wildcards and this string came from a text field. Unescaped, `%` would
  -- match the entire table and `_` would match every 1-character-then-anything key. The backslash
  -- must be escaped FIRST or it would corrupt the two escapes added after it.
  pat := replace(replace(replace(k, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
    select l.text, l.level::text, l.ru, (w.id is not null)
      from lexicon l
      -- The "already in your collection" flag. Exact because both sides of this join are produced
      -- by lesson_item_norm_key — `lexicon.key` by the 0010 trigger, `words.norm_key` by the 0007
      -- one. It hits words_owner_id_norm_key_key, so it costs one index probe per candidate row.
      left join words w on w.owner_id = p_owner_id and w.norm_key = l.key
     where l.key like pat escape '\'
     -- ── the ranking, and both halves are measured ────────────────────────────────────────────
     --
     -- 1. SINGLE WORDS BEFORE PHRASES. 23,789 of the 53,538 rows are multiword (44%, not the 155
     --    the design doc assumed), and their mean zipf is HIGHER than single words' — 4.07 vs 3.49
     --    — because wordfreq estimates a phrase's frequency from its parts. Ranking by zipf alone
     --    therefore fills the dropdown with phrases built on the word the learner is typing:
     --    `com` returns come, come in, come to, come on, come on to, come at. With this clause it
     --    returns come, company, coming, coming-out, community, common. Phrases are not excluded —
     --    the collection has a `phrase` kind and `put up with` is worth suggesting — they just
     --    stop crowding out words. Once the prefix itself contains a space every match does, and
     --    this clause becomes a no-op that leaves zipf in charge.
     --
     -- 2. NO EXACT-MATCH BOOST, though §5.2 of the doc proposed one. It was measured and it is
     --    strictly harmful: it promotes rare all-caps abbreviations that happen to equal a short
     --    prefix, putting `ABS` above `absolutely` and `CAR` above `care`. The case it was meant to
     --    fix does not exist — zipf already ranks `run` above `run in` and `the` above `they`,
     --    because a base word is more frequent than its derivatives.
     --
     -- `l.key` last so the order is total: two rows with equal zipf must not swap between calls,
     -- or the dropdown reshuffles under the learner's finger as they type.
     order by (l.key like '% %'), l.zipf desc, l.key
     -- Clamped, not trusted. `limit` arrives from a query string; 25 is well past anything a phone
     -- can show and keeps a hostile caller from paging the dictionary 8 rows at a time.
     limit least(greatest(coalesce(p_limit, 8), 1), 25);
end $fn$;

-- Server-only, exactly like resolve_words: every caller is a route handler holding the session's
-- owner id. INVOKER rights (the default) mean `words`' RLS still applies if this is ever reached
-- with a user token, so p_owner_id cannot be used to probe someone else's collection — the worst a
-- forged owner id could do is make `owned` read false, which is not a leak.
revoke all on function suggest_words(text, text, int) from public;
grant execute on function suggest_words(text, text, int) to service_role;

comment on function suggest_words(text, text, int) is
  'Add-word autocomplete: prefix-match the lexicon, flag words the owner already has. The prefix is '
  'normalized here (lesson_item_norm_key) because the client cannot compute that key. Returns empty '
  'below 2 characters. See docs/2026-08-15-word-autocomplete-suggestions.md.';
