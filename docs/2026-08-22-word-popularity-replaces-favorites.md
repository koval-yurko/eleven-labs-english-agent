# Popularity replaces favourites

**Status: implemented 2026-08-22.** Migration 0017 is applied (92 words, 0 of them favourited — the
column drop lost nothing). All seven stages below are done; `pnpm typecheck`, `pnpm lint`,
`pnpm check:shared` (5,376 round-trips) and the mobile bundle are green, and `pnpm build` serves
`/api/v2/lesson-items/popularity`. `pnpm --filter mobile check` still fails at `expo-doctor` on six
out-of-date Expo packages — pre-existing dependency drift, untouched by this change.

Research for four changes asked as one:

1. `words.is_favorite` (boolean) becomes `words.popularity` (int).
2. The list/detail rows show the **number**, not a star.
3. The collection can be **sorted by popularity**.
4. Favourites — the flag, the filter, the sort key, the write path, the icon — is **removed entirely**.
5. In the add-word autocomplete, tapping a row marked *“Already in your collection”* **increments that
   word's popularity and opens its word page**, straight from the dropdown.

Points 1–4 are a rename with a wider blast radius than it looks (the flag is in the URL grammar and in
the exhaustive round-trip check). Point 5 is the only genuinely new behaviour, and it needs one thing
the wire does not carry today: **the suggestion row does not know the word's id.**

---

## 1. Everything the star touches today

| Layer | File | What is there |
| --- | --- | --- |
| Schema | `supabase/migrations/0007_words_m2m.sql:67` | `is_favorite boolean not null default false` on `words` |
| Schema | `supabase/migrations/0016_owner_items_more_translations.sql:47` | `w.is_favorite` selected by the `owner_items` view (latest body) |
| Shared | `packages/shared/src/word-types.ts:77` | `ItemRow.is_favorite: boolean` |
| Shared | `packages/shared/src/items-query.ts:31,42,132,163` | sort key `"favorite"`, `ItemsQuery.favoritesOnly`, `?fav=1` decode/encode |
| Shared | `packages/shared/src/item-list.ts:32` | `SORT_LABELS.favorite = "Favorites"` |
| Shared | `packages/shared/src/api.ts:56,507,518` | `itemFavorite` path, `FavoriteRequest`, `FavoriteResponse` |
| Shared | `packages/shared/src/api.ts:527+` | `WordSuggestion.owned: boolean` — **no id** |
| Shared | `packages/shared/check.ts:70` | `favoritesOnly` is one of the 7 round-trip dimensions (10,752 cases) |
| Server | `apps/web/src/lib/lesson-items.ts:33,53,120-135` | `SORT_COLUMNS.favorite`, the `eq("is_favorite", true)` filter, `setItemFavorite` |
| Server | `apps/web/src/app/api/v2/lesson-items/favorite/route.ts` | the collection's only per-word write |
| Server | `apps/web/src/app/lesson-items/actions.ts:22-28` | `setItemFavoriteAction` (web server action twin) |
| Server | `apps/web/src/lib/suggestions.ts` | maps the RPC's `owned` |
| DB fn | `supabase/migrations/0013_suggest_words_bucket.sql` | `suggest_words` already **joins `words w`** and returns `(w.id is not null)` as `owned` |
| Web UI | `apps/web/src/app/lesson-items/FavoriteButton.tsx` | whole file |
| Web UI | `apps/web/src/app/lesson-items/ItemsBrowser.tsx:202-216,384` | “favorites” filter chip + the row's star |
| Web UI | `apps/web/src/app/lesson-items/[id]/page.tsx:49` | the detail page's star |
| Web UI | `apps/web/src/app/icons/index.tsx:42-46` | `StarIcon` |
| Mobile | `apps/mobile/src/lib/items.ts:75-90` | `setFavorite(normKey, isFavorite)` |
| Mobile | `apps/mobile/src/app/lesson-items/index.tsx:101,119,207-228,411-421,760-770` | `EMPTY_QUERY`, `activeFilterCount`, optimistic `toggleFavorite`, the filter chip, the row's star |
| Mobile | `apps/mobile/src/app/lesson-items/[id].tsx:74-82,150-161` | the detail screen's star |
| Mobile | `apps/mobile/src/ui/icons.tsx:54-58` | `StarIcon` |
| Comments | `api.ts:101`, `mobile/index.tsx:71`, `mobile/lib/items.ts:37` | all cite “10,752 cases” — that number changes |

Two things worth noting up front, because they make this cheaper than the table suggests:

- **`SORT_COLUMNS` and `SORT_LABELS` are total maps over `SortKey`.** Renaming the key in
  `items-query.ts` produces compile errors at exactly the two places that must follow. The type
  system drives most of this change.
- **`suggest_words` already has `w.id` in hand.** `owned` is literally `(w.id is not null)`. Returning
  the id instead of the boolean is a one-column change to a join that already exists — no new query,
  no extra round trip, and no client-side `norm_key` guessing (which `CLAUDE.md` forbids anyway).

And one thing that makes it more expensive than it looks: **`is_favorite` is part of the URL grammar**
(`?fav=1`), which `pnpm check:shared` proves round-trips over 10,752 cases. Removing a dimension is
fine — the check shrinks to 5,376 — but three docblocks quote the old number.

---

## 2. Decisions

### D1 — `popularity int not null default 0` on `words`

Same table, same owner scoping, same RLS. It replaces `is_favorite` rather than joining it.

**Not null with a default 0** so the sort needs no `nullsFirst` handling and the UI never renders a
blank where a number belongs. This is the first column the **UI** writes besides nothing at all —
`level` and `details` are job-owned (`CLAUDE.md`), `is_favorite` was the sole learner-written column,
and `popularity` inherits that role. Worth a line in `CLAUDE.md` when the change lands.

**Backfill: leave every existing word at 0.** A boolean cannot be honestly converted to a count —
mapping `true → 1` would claim a learner met that word once when what they actually said is “this one
matters”. Starting the whole collection at zero makes the first weeks of the counter mean exactly one
thing. (If the favourites are worth preserving as a head start, `update words set popularity = 1 where
is_favorite` inside the same migration is the alternative; it is one line and I would still not do it.)

### D2 — the count takes the star's slot: read-only in the list, tappable on the detail page

**Decided.** In both places the number renders exactly where the star renders today, and **0 is
rendered like any other value** — a column that sometimes has a value and sometimes doesn't is the
alignment problem `levelSlot` exists to solve.

**In the list it is not a control.** A bare integer affords nothing, a mis-tap on a counter is
unrecoverable (there is no decrement), and the increment has a real source of truth now — the learner
meeting the word again in the add-word field. The mobile actions column goes from
`[level pill, star, bin]` to `[level pill, count, bin]`, which keeps the fixed three-slot stack the
layout comment in `index.tsx:685` argues for; nothing about the row's geometry changes.

**On the detail page it IS a control** — a manual `+1`, in the star button's place. The argument
against a tap target does not carry here: it is one word on one screen, deliberately opened, rather
than one of fifty 32pt targets under a scrolling thumb. It shares `bumpPopularity` with the suggestion
tap and renders the returned count, so there is one writer and no optimistic guess to reconcile.

### D3 — re-adding a word through the **Add** button also increments. Yes, and it should stay rare.

Typing a word you already have and pressing **Add** is the same statement as tapping it in the
dropdown. Today it returns `already-present` and does nothing, which is exactly the “reads as a broken
button” problem `addWord`'s docblock is written around; bumping the count gives that path something
true to report (“*ubiquitous* is already in your collection — 4“).

It is deliberately the **fallback**, not the main road: once the dropdown handles an owned word by
bumping and navigating (D7), a learner reaches this branch only by typing a word the suggestion list
never offered — a phrase, a sentence, or a word outside the 53k lexicon. Which is precisely why the
branch still has to do the right thing: it is the path for everything the dictionary does not know.

This is a small addition to `addWord` (`apps/web/src/lib/words.ts:60-72`): on the `already-present`
branch, bump and return the new count in `AddWordResult`.

### D4 — the increment is an RPC, not a read-modify-write

`update ... set popularity = popularity + 1` cannot be expressed through PostgREST/supabase-js. Doing
it in two statements loses concurrent bumps and adds a round trip. A tiny SQL function keeps it atomic
and lets the write return the new value, which is what the UI wants to render:

```sql
create function bump_word_popularity(p_owner_id text, p_id uuid)
returns int language sql as $$
  update words set popularity = popularity + 1, updated_at = now()
   where owner_id = p_owner_id and id = p_id
  returning popularity;
$$;
```

`null` back means “no row matched” — someone else's id, or a deleted word — which is the same
ownership-gate-by-filter pattern `setItemFavorite` and `deleteWord` already use.

### D5 — keyed by **id**, not `norm_key`

`setItemFavorite` was keyed by `norm_key` and its docblocks call it “the odd one out among this app's
writes” three separate times (`api.ts:507`, `items.ts:75`, `favorite/route.ts:13`). The replacement
should follow `deleteWord` instead: **id-keyed**. The suggestion row is about to carry the id anyway
(D6), the list row has it, and the detail page is addressed by it.

That retires a documented footgun rather than porting it.

### D6 — `suggest_words` returns `word_id` in place of `owned`

`owned` is `(w.id is not null)`; returning `w.id` carries strictly more information at the same cost,
and it is the *only* way the dropdown can navigate — `/lesson-items/[id]` is id-addressed, and the
client is not allowed to derive a word's identity from text (`CLAUDE.md`, `resolve_words`).

Keep the shape as *one* field, not two: `WordSuggestion.wordId: string | null`, with
`owned` derived at the render site as `wordId !== null`. Two fields that must agree is how they stop
agreeing.

⚠️ **The `ORDER BY` in the RPC must not be touched.** `apps/mobile/src/lib/suggestions.ts` narrows a
cached 2-character bucket locally and relies on reproducing that exact total order (§14 of the
autocomplete doc); the migration changes the `RETURNS TABLE` and nothing else. As in 0013, the return
type change forces `drop function` + `create function` rather than `create or replace`.

### D7 — tapping an owned suggestion navigates: a deliberate exception to the autocomplete's D4

`Autocomplete`'s contract is emphatic — *“Fill the field; never submit… a dropdown that submits on tap
makes a mis-tap unrecoverable”* (`apps/mobile/src/ui/Autocomplete.tsx`, decision D4 of the
autocomplete doc). The new behaviour breaks that rule for exactly one row type, and the exception
holds up: an owned row's action is **non-destructive and reversible** (a navigation, plus a counter
that only goes up), whereas the original rule protects against creating a word you did not mean to
create. Unowned rows keep filling the field, unchanged.

The primitive should stay ignorant of words. Two ways to hand the caller the id:

- **(recommended) make the option payload generic** — `AutocompleteOption<T>` gains `data?: T`, and
  `Autocomplete<T>` passes it back through `onSelect`. Typed, ~6 lines, and the component still knows
  nothing about vocabulary.
- keep a `Map<key, wordId>` in a ref inside `AddWordForm`, populated in its `search()` closure. Zero
  change to the primitive, but the lookup is indirect and easy to leave stale.

The row's accessible name must change with its behaviour: `markedLabel` currently reads “Already in
your collection”, which is a *statement*. When the row navigates it needs to say so — “Already in your
collection, opens the word” — or a screen-reader user gets moved somewhere they did not ask to go.

### D8 — bump first, then navigate

Fire the bump, `await` it, then `router.push('/lesson-items/${id}')`. It is a single indexed update;
the perceived cost is a few hundred milliseconds, and it removes a race the alternative cannot avoid —
the detail screen fetches on mount, so navigating first shows the *pre-increment* number and then
either flickers or, worse, doesn't.

If the bump fails, **navigate anyway**: the word exists, the learner asked to see it, and a lost
counter increment is not worth a dead end. Clear the input in the same handler (the fill from
`choose()` runs first, so `setText("")` in `onSelect` wins).

### D9 — the whole `favoritesOnly` filter goes, not just its chip

“Remove Favorites completely” includes `ItemsQuery.favoritesOnly` and the `?fav=1` parameter. That is
the right call — a “popular only” filter has no obvious threshold, and sorting by popularity answers
the same question better.

Consequences: `check.ts` loses a dimension (10,752 → **5,376** round-trips), and the three docblocks
quoting 10,752 need the new number. Old bookmarked web URLs carrying `?fav=1` degrade silently to “no
such filter”, which `parseItemsQuery` already handles by construction (unknown keys are ignored).

### D10 — sort key `favorite` → `popularity`

`SORT_KEYS` keeps 7 entries; `SORT_LABELS.popularity = "Popularity"`; `SORT_COLUMNS.popularity =
"popularity"`. `DEFAULT_SORT`/`DEFAULT_DIR` stay `created`/`desc`, so a learner picking Popularity gets
descending first, which is the useful direction.

No index. `words` is hundreds of rows per owner and every other sort on this list (`practice_count`,
`lesson_count`, `last_practiced_at`) is likewise unindexed — adding one here and nowhere else would be
cargo cult.

---

## 3. Migration 0017 — sketch

`owner_items` selects `w.is_favorite`, so the column cannot be dropped while the view stands, and
`create or replace view` cannot *remove* a column from one. Drop → alter → recreate, in that order.
Nothing else depends on it: `owner_items_pending_level` (0007) and `owner_words_pending_details`
(0009) read `words` directly, and `owner_item_facets` touches only `categories`.

```sql
-- 0017_word_popularity.sql — the favourite flag becomes a count.

drop view owner_items;                       -- selects w.is_favorite (0016 body)

alter table words drop column is_favorite;
alter table words add  column popularity int not null default 0;

-- 0016's body verbatim, with `w.is_favorite` → `w.popularity`.
create view owner_items with (security_invoker = true) as
select ... w.popularity, ... ;

comment on column words.popularity is
  'How many times the learner has met this word again — bumped from the add-word suggestions. '
  'The one column the UI writes; level/details belong to the background jobs.';

-- Atomic, and returns the new value so the client renders truth rather than an optimistic guess.
-- NULL = no row matched (not the caller''s word, or already deleted).
create function bump_word_popularity(p_owner_id text, p_id uuid)
returns int language sql as $$
  update words set popularity = popularity + 1, updated_at = now()
   where owner_id = p_owner_id and id = p_id
  returning popularity;
$$;

revoke all on function bump_word_popularity(text, uuid) from public;
grant execute on function bump_word_popularity(text, uuid) to service_role;

-- suggest_words: `owned boolean` → `word_id uuid`. Return type changes, so drop + create (as 0013).
-- ⚠️ The ORDER BY is copied byte-for-byte: the mobile bucket cache re-applies it locally.
drop function if exists suggest_words(text, text, int);
create function suggest_words(p_owner_id text, p_prefix text, p_limit int default 8)
returns table (key text, text text, level text, ru text[], word_id uuid)
... select l.key, l.text, l.level::text, l.ru, w.id ...
```

Applied with `pnpm db:migrate` (forward-only, tracked in `schema_migrations`).

---

## 4. Plan

**Stage 1 — schema.** Migration 0017 above. `pnpm db:migrate:status` → apply → spot-check
`select popularity from owner_items limit 5`.

**Stage 2 — shared core** (everything downstream then fails to compile, which is the point):
- `word-types.ts`: `is_favorite: boolean` → `popularity: number`.
- `items-query.ts`: `SORT_KEYS` `"favorite"` → `"popularity"`; delete `favoritesOnly` from the
  interface, `parseItemsQuery`, `serializeItemsQuery`.
- `item-list.ts`: `SORT_LABELS`.
- `api.ts`: `itemFavorite` → `itemPopularity` (`/api/v2/lesson-items/popularity`);
  `FavoriteRequest{normKey,isFavorite}` → `PopularityRequest{id}`;
  `FavoriteResponse{ok}` → `PopularityResponse{ok, popularity}`;
  `WordSuggestion.owned` → `wordId: string | null`; fix the 10,752 docblock.
- `check.ts`: drop the `favoritesOnly` loop; new total 5,376.
- `pnpm check:shared`.

**Stage 3 — web backend:**
- `lib/lesson-items.ts`: `SORT_COLUMNS.popularity`, remove the `is_favorite` filter, replace
  `setItemFavorite` with `bumpWordPopularity(ownerId, id)` calling the RPC.
- `lib/suggestions.ts`: map `word_id` through.
- move `api/v2/lesson-items/favorite/route.ts` → `.../popularity/route.ts` (the literal-beats-dynamic
  note in `[id]/route.ts:23` and `delete/route.ts:20` names `favorite` — update both comments).
- `app/lesson-items/actions.ts`: delete `setItemFavoriteAction`.
- `lib/words.ts` (D3): bump on the `already-present` branch; `AddWordResult` gains `popularity`, and
  the “already in your collection” copy on both clients reports it.

**Stage 4 — web UI** (deprecated, must keep compiling): delete `FavoriteButton.tsx`; remove the
favourites chip and `StarIcon` import from `ItemsBrowser.tsx` and render `item.popularity` where the
star was; on `[id]/page.tsx` the star becomes a `+1` client island over the same count (the page stays
a server component, exactly as its comment at `:37` describes the star being); delete `StarIcon` from
`app/icons/index.tsx`.

**Stage 5 — mobile, the collection:**
- `lib/items.ts`: `setFavorite(normKey, isFavorite)` → `bumpPopularity(id): Promise<number>`.
- `lesson-items/index.tsx`: `EMPTY_QUERY` / `activeFilterCount` lose `favoritesOnly`; the “favorites”
  chip goes (the `Show` row keeps only “in no lesson”); `toggleFavorite` goes; `ItemLine` renders the
  count — including 0 — in the star's slot, as plain text rather than a `Button`.
- `lesson-items/[id].tsx`: the star `Button` becomes the `+1` control in the same position, rendering
  the count returned by `bumpPopularity` (D2).
- `ui/icons.tsx` + `ui/index.ts`: drop `StarIcon`; tidy the two stale comments
  (`ui/tokens.ts:76`, `shared/theme.ts:61`).

**Stage 6 — the suggestion tap (the actual feature):**
- `ui/Autocomplete.tsx`: generic `data` payload (D7); `markedLabel` copy that says the row opens.
- `lesson-items/index.tsx` → `AddWordForm`: `search()` carries `wordId`; `onSelect` branches — owned →
  `await bumpPopularity(id)`, `setText("")`, `router.push('/lesson-items/' + id)`; unowned → today's
  fill.
- **Call `clearSuggestionCache()` after a delete too** — see the risk below.

**Stage 7:** `pnpm typecheck && pnpm lint && pnpm --filter mobile check`.

---

## 5. Risks and gotchas

- **Stale `wordId` in the bucket cache after a delete.** `suggestions.ts` caches up to 12 buckets in
  memory and clears them only when a word is *added* (`index.tsx:611`). Once buckets carry ids,
  deleting a word leaves a suggestion row that navigates to a 404 word page. `clearSuggestionCache()`
  in `removeWord` (and in the detail screen's `remove`) is the fix, and it is cheap — a ~7 KB refetch.
  This is the one place where the change introduces a *new* bug rather than moving an old one.
- **The three “10,752” docblocks** are load-bearing prose about a proof; leaving them stale is exactly
  the drift `items-query.ts` was written to prevent.
- **`suggest_words`' `ORDER BY` must be copied verbatim.** The client re-applies it; any divergence
  shows up as a dropdown that reshuffles when the cache is bypassed, and nothing will fail loudly.
- **PostgREST schema cache.** Supabase reloads on DDL via event trigger, but if the new RPC 404s right
  after the migration, that is why — not the SQL.
- **Route rename ordering.** `/api/v2/lesson-items/popularity` is a literal sibling of the `[id]`
  dynamic segment; Next matches literals first, so it is safe for the same reason `favorite` and
  `delete` were. The comments naming `favorite` in both those files should be updated, or the next
  reader learns a rule from a path that no longer exists.
- **Old mobile builds** call `/lesson-items/favorite` with `{normKey, isFavorite}`. If any build is in
  a tester's hands, the route disappearing means a failed write with a visible error. Not a concern
  for a dev-only install; worth a beat of thought before shipping.

## 6. Questions, answered

Settled on 2026-08-22; folded into the decisions above rather than left open.

1. **Does the dropdown row show the count? No.** The RPC returns `word_id` and nothing else new —
   `w.popularity` stays off the suggestion payload. The dropdown's job is “did I spell the word I
   meant”, and a counter there is a second number competing with the CEFR badge for the same strip of
   row. The count lives where the word lives.
2. **Is 0 rendered, or blank? Rendered**, in the star's exact position — see D2.
3. **Does the detail page get a manual `+1`? Yes**, in the star's exact position — see D2. This is the
   one place the number is a control.
4. **Bump on duplicate Add? Yes** — and it is the fallback path, not the main one, since an owned word
   found in the dropdown never reaches it. See D3.
