# The level-assignment background job — LLM-only, `level_at` as the processed flag

_Date: 2026-07-16 — research note (no code written yet). Revised after review._

**Goal:** fill in `lesson_item_attrs.level` (A2–C2) for every item on `/lesson-items`, including the
ones already in the database, by asking the LLM.

Follow-on from `docs/2026-07-11-lesson-items-page-search-filters-stats-favorites.md`, which shipped
the schema and the page but deferred the job (Decision 4 there: _"levels are read-only in v1"_).

## TL;DR

- **Scope is settled by review** (see [Decisions taken](#decisions-taken)): the level comes from the
  LLM and nothing else, sentences get a best-effort guess, the source is never shown, there is no
  manual override, and the job must handle the items already in the database.
- **The "processed" flag already exists: `level_at`.** It's in the schema
  (`supabase/migrations/0004_lesson_item_attrs.sql:101`) and nothing has ever written it. All it
  needs is a slightly wider meaning — stamped when the job **looked**, not when it **succeeded** —
  and it answers every question a `processed` boolean would, plus "when", plus "re-do everything
  classified before date X". No new column.
- **`level is null` is _not_ a usable flag**, which is why the flag is needed at all: an item the
  LLM has no answer for stays null forever and would be re-asked on every sweep, burning money on a
  word that will never resolve. `level_at` separates _"never looked at"_ from _"looked at, no
  answer"_ — states that are identical on the page and opposite to the job.
- **This lands at one small migration**: a new `owner_items_pending_level` view, because
  `owner_items` exposes `level` and `level_source` but **not** `level_at` (`0005:39-41`), so the job
  can't currently see its own flag. Additive — a new view, `owner_items` untouched, zero risk to the
  page.
- **`level_source` needs no change.** With the LLM as the only writer and no override, it is always
  `'job'` — which is exactly what the existing check constraint allows. My previous draft argued for
  widening it to distinguish a lexicon lookup from an LLM guess; **that argument dies with the
  lexicon.** Leave it alone.
- **The whole "second normalization" problem evaporates.** The previous draft's headline was that a
  lexicon needs `running → run`, requiring a stemmer distinct from `norm_key`. An LLM doesn't need
  it — it levels `running` on sight. **Going LLM-only deletes the hardest part of this design**,
  along with the CEFR-J seed, the licensing minefield, and ~8k rows of committed data.
- **What it costs**: ~87% accuracy at the ceiling, a systematic pull toward B2, and noisy sentence
  levels. All acceptable for a filter chip — quantified in [Decision 2](#decision-2--llm-only-and-what-that-costs).
- **Trigger: `after()` on the write path + a `pnpm level:items` CLI.** No scheduler. The CLI is also
  what backfills the existing items and what makes local testing work.

---

## Decisions taken

Answers from review, and what each one removes:

| Question | Answer | Consequence |
| --- | --- | --- |
| Is the app on Vercel? | **Yes** — and local runs must work too | `after()` is available in production ✅. The CLI covers local. Vercel Cron is a real option but [still unnecessary](#decision-4--what-triggers-it) |
| Show the level's source on the chip? | **No** | `level_source` is display-dead. It stays as provenance for the logs, always `'job'` |
| Sentences: null, or a guess? | **Best-effort LLM guess** | No `kind` branching — all three kinds go down one path. `kind` survives only as a prompt hint |
| Manual override? | **No** | `level_source = 'user'` stays reserved and unwritten. The job needs no "don't clobber" predicate |
| How is the level defined? | **Just ask the LLM** | ❌ No `cefr_lexicon`, no CEFR-J seed, no stemmer, no licensing review, no second normalization |
| Items already in the DB? | **Must be processed** | A backfill sweep is required, so the CLI isn't optional — and it needs a flag to be re-runnable |

The through-line: **five of the six answers delete something.** What's left is a lib, a CLI, and one
view.

---

## Where we are today

```text
lesson_item_attrs  (owner_id, norm_key) PK          -- sparse: a row exists only once something touched it
                   level        cefr_level          -- NULL on every row today
                   level_source text check (… in ('job','user'))
                   level_at     timestamptz         -- NULL on every row today  ← the flag
                   is_favorite, categories, created_at, updated_at

owner_items (view) -- norm_key, text, kind ('word'|'phrase'|'sentence'), stats,
                   -- a.level, a.level_source, is_favorite, categories
                   -- ⚠️ no level_at
```

Facts that constrain the design:

| Fact | Consequence |
| --- | --- |
| `level` is nullable forever; the page renders "unleveled" as a first-class state (`src/lib/lesson-items.ts:19`) | The job may be **partial, slow, and fallible** with no UI consequence. There is no correctness deadline — which is what kills the case for a scheduler |
| `setItemFavorite` upserts **only the columns in its payload** (`src/lib/lesson-items.ts:120-123`) | The job's `level`/`level_at` and the button's `is_favorite` can't clobber each other. Both may write the same row concurrently and converge |
| `lesson_item_attrs` is **sparse** — no row until something touches the item | The flag must read correctly through a `LEFT JOIN`: no row ⇒ `level_at is null` ⇒ pending. It does |
| `owner_items` selects `a.level, a.level_source` but **not** `a.level_at` (`0005:39-41`) | The job cannot see its own flag through the view the page uses. This is the one thing forcing a migration |
| `getChatModel()` hardcodes `maxTokens: 1024` and takes no arguments (`src/lib/llm.ts:16-28`) | Caps the batch size — see [Decision 3](#decision-3--batching-and-the-line-between-two-failures) |
| `flushOutbox` replays up to **500** records at once (`src/app/lessons/actions.ts:56,92`) | A naive `after()` per item is 500 concurrent LLM calls after an offline stretch |
| `sync-agents.ts` is a working precedent: `tsx`, argv flags, `--dry-run` prints a plan, persist-after-each-step | Copy it. Don't invent a second job idiom |
| No scheduler, CI, worker, or queue exists (no `vercel.json`, `.github/`, pg_cron) | Whatever triggers this is net-new. Argument for needing as little as possible |
| Scale: hundreds of items per owner | No queue, no rate-limit engineering, no batching infrastructure |

---

## Decision 1 — the flag is `level_at`, and it already exists

The requirement is "a flag for words already processed". The schema has one; it's just been idle.

**Why `level is null` can't be the flag** — the thing that makes the requirement real:

| State | `level` | `level_at` | Page shows | Job should |
| --- | --- | --- | --- | --- |
| Never looked at | null | **null** | unleveled | **process it** |
| Looked at, got B2 | `B2` | set | B2 | skip |
| Looked at, no answer came back | null | **set** | unleveled | **skip — never ask again** |

Rows 1 and 3 are **identical on the page and opposite to the job**. Without a flag they collapse
into one state, and the sweep re-asks the LLM about the same unanswerable item on every run,
forever. That's the whole argument for the flag, and it's correct.

**Why a timestamp rather than a boolean.** A `processed boolean` distinguishes those two rows and
nothing else. `level_at` distinguishes them *and* answers "when", *and* makes re-processing after a
prompt change a `where level_at < '2026-08-01'` instead of a full re-run. It's strictly more
information for the same one column — and the column is already there, nullable, and unwritten, so
this costs nothing to adopt and nothing to abandon.

**The one adjustment: stamp on _attempt_, not on _success_.** Migration `0004:101` comments the
column as _"when the job last classified it"_. The job must instead stamp it whenever it **looked**,
because that's what makes row 3 above terminal. This is a semantic widening, not a schema change,
and the right place to record it is a `comment on column` in the new migration — DB-side, where the
next reader will actually look.

The flag also makes the sweep **naturally incremental and idempotent**: it processes only
`level_at is null`, so it can be interrupted, re-run, or fired concurrently with `after()` without
duplicating work. Same property `sync-agents.ts` has, arrived at the same way. A `--force` flag
re-processes regardless, mirroring `sync-agents.ts:46`.

---

## Decision 2 — LLM-only, and what that costs

Per review, the level comes from the LLM. This is the right call for this app, and it's worth
recording *what* it buys and *what* it gives up, because the giving-up is invisible until someone
squints at the column.

**What it buys** — everything in this list is now deleted work: a `cefr_lexicon` table, a ~8k-row
committed seed, a build script to generate it, a licensing review (CEFR-J is usable; Oxford/EVP/
Cambridge are not, and their GitHub mirrors are unlicensed re-uploads — a genuine trap now avoided),
a stemmer, and a second normalization function distinct from `norm_key`. That was the bulk of the
previous draft. It's gone.

**What it costs**, with numbers, so nobody is surprised later:

1. **~87% is the ceiling.** Per BEA 2025 (arXiv:2506.02758), the best model tested scored **87.0%**
   on word-level CEFR, GPT-4o **83.3%** — against **80.7%** for a dumb part-of-speech baseline. The
   entire spread between "ask an LLM" and "authoritative lexicon" is a few points. **This is the
   evidence the review's call is right**: the sophisticated version wasn't buying much.
2. **~⅓ of items have no correct answer.** 62% of English Vocabulary Profile entries carry more than
   one CEFR level (the verb _aim_ spans A2→C2). With only a bare word and no context, the question
   is under-determined. Measured cost: **92.8%** accuracy on unambiguous words vs **80.5%** on
   ambiguous ones. Mitigation: **tell the prompt to answer for the most common everyday sense** —
   under-leveling reads as a shrug, over-leveling reads as broken.
3. **⚠️ Models over-predict B2.** Benedetto et al. (2025) found LLM CEFR output has a systematic
   pull toward B2, with disagreement concentrated in the intermediate levels — classic central
   tendency. **This is the one failure that hides**: an aggregate accuracy number looks fine while
   the column turns to mush, and B2 is where most vocabulary lands. If this is ever spot-checked,
   check the **distribution across levels**, not a hit rate.
4. **Sentence levels will be noisy.** Google's Ace-CEFR (arXiv:2506.14046) on short passages: a
   small fine-tuned BERT scored **0.37 MSE**, an optimized LLM **0.48**, a **human expert 0.75**.
   So the LLM is *better than a human expert here* — the review's "best-effort guess" is well
   founded. Two notes: it costs nothing extra (same batch, same call), and **don't level a sentence
   by its hardest word** — _"put up with"_ is three A1 words and a B2 construction. Pass `kind` and
   let the prompt say "level the whole thing, not its rarest word".
5. **A wrong level is one row, invisible, and free to fix.** `update lesson_item_attrs set level_at
   = null where norm_key = '…'` and the next sweep redoes it. That's the safety net that makes all
   of the above tolerable.

**Model choice:** given the 87.0 vs 83.3 spread, Opus is overkill. Set `ANTHROPIC_MODEL` to
something small for this job. ⚠️ Pre-existing and unrelated, but worth knowing: `src/lib/llm.ts:10`
defaults to `claude-opus-4-5` while `src/lib/health.ts:60`, `CLAUDE.md`, `README.md`, and
`.env.example` all say `claude-opus-4-8` — the health page reports a model the code doesn't build.

---

## Decision 3 — batching, and the line between two failures

**Batch the items into one call** (`.withStructuredOutput(zodSchema)`, not `askClaude()` — a
free-text level is a parsing problem nobody needs). At this scale a sweep is usually *one* call,
which makes rate limiting, backoff, and concurrency control moot — worth stating because the
codebase has **no retry/backoff logic anywhere** and this job doesn't need to be the first.

**⚠️ Batch size ≈ 25, not 50.** `getChatModel()` hardcodes `maxTokens: 1024` (`src/lib/llm.ts:22`)
and takes no arguments. 50 structured `{index, level}` pairs runs uncomfortably close to that
ceiling, and the failure mode is a **truncated response** — which looks like "the model omitted the
last 15 items", i.e. silent data loss. 25 leaves headroom without touching shared code.

**Key results back by index, not by echoed text.** The model reordering or lightly rewriting a word
would silently mis-assign levels across the batch. An index is checkable; a string match is a
guess.

**Then the important part — two failures that must be treated oppositely:**

| Failure | Example | `level_at` | Why |
| --- | --- | --- | --- |
| **Transport** — the call itself threw | API 500, network, timeout, truncation | **stamp nothing** | Nothing was learned about these items. Retry next sweep |
| **Semantic** — the call succeeded, but an item got no usable answer | model omitted index 7, or returned a level outside A2–C2 | **stamp it**, leave `level` null | The model looked and had nothing. Asking again buys the same nothing |

Collapsing these is how the flag gets defeated: stamp on transport failure and a network blip
permanently un-levels a batch; *don't* stamp on semantic failure and the unanswerable items are
re-asked forever — the exact loop [Decision 1](#decision-1--the-flag-is-level_at-and-it-already-exists)
exists to prevent. **This distinction is the only subtle thing in the job**, and it's the thing to
look at first if the column ever behaves strangely.

**Send `text`, key on `norm_key`.** `owner_items.text` is the learner's most recent spelling — the
natural thing to show a model. `norm_key` is lowercased and unaccented; it's the identity key and
what the upsert targets, but it's not what you ask about.

---

## Decision 4 — what triggers it

Vercel is confirmed, so all options are open. They're still not needed.

| Option | Cost | Latency | Verdict |
| --- | --- | --- | --- |
| **(A) `pnpm level:items` CLI** (`tsx`, like `sync-agents.ts`) | ~nothing; the precedent is reviewed and 256 lines | Manual | ✅ **First.** The **only** thing that can backfill the existing items, and what makes local testing work |
| **(B) `after()` on the item-write path** | A few lines; the primitive is already in production at `elevenlabs-webhook/route.ts:77` | Seconds | ✅ **Second** |
| (C) Vercel Cron | `vercel.json` + `/api/cron/…` route + `CRON_SECRET` | ≤ 1 day | 🔶 Available now that Vercel is confirmed. Buys nothing over (A)+(B). Hobby caps at 2 crons, once daily |
| (D) pg_cron + pg_net | 2 extensions + SQL-side HTTP + secrets in the DB | Minutes | ❌ Most infrastructure, least benefit |

**Recommendation: (A) + (B), no scheduler.**

- **(B) is the fast path.** A new item is leveled within seconds, because the moment of truth is
  `upsertLessonItems` (`src/lib/lessons.ts:156`). It's *additive* — write semantics unchanged, so
  July 11's "don't touch the write path" principle holds — and `after()` runs post-response, so a
  slow LLM call never delays the add.
- **(A) is the correctness guarantee.** `after()` can silently fail: an instance dies, the API 500s,
  the outbox replays a batch that partly errors. The sweep re-queries `level_at is null` and catches
  whatever fell through. **The sweep is what makes the fast path allowed to fail** — which is what
  lets (B) stay a few lines with no retry logic.

No scheduler is needed because `level` is nullable forever: an item unleveled for a day shows
"unleveled" on a page that renders that state deliberately. If this goes multi-user, (C) is a
`vercel.json` invoking the same function.

**⚠️ `after()` on the outbox path needs care.** `flushOutbox` can replay 500 records at once after an
offline stretch. Fire one `after()` per record and that's 500 concurrent LLM calls. **Level once per
flush, over the deduplicated set of new `norm_key`s** — one `after()`, one batch.

**Local runs:** `pnpm level:items` needs only `ANTHROPIC_API_KEY` + `SUPABASE_*` from `.env.local`,
and `after()` works under `next dev` too, so both paths are locally exercisable with no Vercel
involvement. ⚠️ Note the two existing scripts **disagree on dotenv precedence** —
`scripts/migrate.mjs:26` loads `.env.local` then `.env`; `src/agent/sync-agents.ts:32-34` loads
`.env` then `.env.local`. dotenv is first-wins, so these resolve differently. Match `migrate.mjs`
(`.env.local` wins) — that's the documented setup in `README.md:20-25`.

---

## Proposed schema — `supabase/migrations/0006_pending_level_view.sql`

The entire migration. No new table, no new column, no constraint change.

```sql
-- The job's work queue. This exists because owner_items exposes level and level_source but NOT
-- level_at (0005), so the job can't see its own flag through the view the page uses. A separate
-- view keeps owner_items — and therefore `select *` in listItems — completely untouched.
--
-- Pending == level_at is null. NOT `level is null`: an item the LLM had no answer for keeps a null
-- level forever, and re-asking about it on every sweep is a permanent, silent cost. level_at is
-- what separates "never looked at" from "looked at, nothing came back".
--
-- LEFT JOIN, because lesson_item_attrs is sparse: an item nothing has ever touched has no row at
-- all, which reads through the join as level_at is null → pending. Which is correct.
create view owner_items_pending_level with (security_invoker = true) as
select i.owner_id,
       i.norm_key,        -- the upsert key
       i.text,            -- the learner's most recent spelling — what the model is asked about
       i.kind             -- 'word' | 'phrase' | 'sentence' — a prompt hint, not a branch
  from owner_items i
  left join lesson_item_attrs a
         on a.owner_id = i.owner_id and a.norm_key = i.norm_key
 where a.level_at is null;

-- Widen the meaning, not the schema: 0004 called this "when the job last classified it", but the
-- job stamps it whenever it LOOKED. That's what makes "looked, no answer" a terminal state instead
-- of an item re-asked on every sweep.
comment on column lesson_item_attrs.level_at is
  'When the level job last ATTEMPTED this item (not when it succeeded). NULL = never attempted.
   Set even when no level came back, so an unanswerable item is asked about once, not forever.
   Set to NULL to force reprocessing.';

-- Deliberately NOT changed: level_source. With the LLM as the only writer and no manual override,
-- it is always 'job' — exactly what the existing check constraint allows.
```

No index: `level_at is null` over a few hundred rows per owner is a sequential scan on a table this
size, i.e. free. The `(owner_id, norm_key)` PK already covers the join.

---

## Implementation surface

**Status: shipped 2026-07-16.** Built as designed, with the deviations noted below.

| File | Change |
| --- | --- |
| `supabase/migrations/0006_pending_level_view.sql` | **new** — `owner_items_pending_level` + the `level_at` comment. The whole schema change. Applied |
| `src/lib/levels.ts` | **new** — server-only. `levelItems(ownerId, opts)`: query pending → batch 25 → `.withStructuredOutput()` → upsert `{level, level_source, level_at}` onto `lesson_item_attrs`. The whole job as a plain function, called by both triggers |
| `src/lib/levels-prompt.ts` | **new** — the prompt + its `kind` hint. Separate file so a prompt change is a reviewable diff |
| `scripts/level-items.ts` | **new** — the CLI. `tsx`, argv flags, `--dry-run` prints the plan and makes **zero** LLM calls, `--force`, `--owner=`, `--limit=`. Mirrors `src/agent/sync-agents.ts`; dotenv precedence per `migrate.mjs` |
| `tsconfig.json` | `include` += `scripts/**/*.ts` — it was `src/**` only, so anything in `scripts/` shipped **untypechecked**. Pre-existing gap, closed rather than worked around by hiding the CLI in `src/` |
| `package.json` | `level:items` + `level:items:plan`; `zod` moved from a transitive LangChain dep to an explicit `^3.25.76` (pinned to v3 — LangChain 0.3.x is not on zod 4) |
| `src/app/lessons/actions.ts` | `after()` → `levelItems(ownerId, { limit })` on the new-item path |
| `CLAUDE.md` | the two commands + a convention entry for the job |

**No changes to `owner_items`, `/lesson-items`, the page, the sync engine, or any existing write
path.** The page already reads and filters `level` — it just started finding values there.

### Deviations from the design

1. **`level_source` is `null`, not `'job'`, when no level came back.** Writing `'job'` on an
   unanswered item would claim the job sourced a level it never produced — in the one column whose
   only purpose is to say where a level came from.
2. **The batch schema takes `level` as a bare string, not a `z.enum`.** With an enum, one
   out-of-range value ("A1", "B2+") fails the whole structured-output parse and takes the other 24
   items down with it. Validated per item instead, so one bad answer costs one item. `A1` is
   clamped to `A2` rather than discarded (`CEFR_LEVELS` starts at A2, so an A1 row would render a
   chip no filter option can select).
3. **`levelItems` throws if it can't read the queue.** The design said "never throws". A failing
   *batch* is counted and retried next sweep, but a broken *query* is a bug — the CLI should say so
   loudly rather than print "0 items, nothing to do". The `after()` caller swallows it.
4. **`--force` is a reset, not a bypass** — see the review section below.

### What the code review caught

A high-effort multi-agent review of the first implementation found three real defects. All are
fixed; they're recorded because each one is a trap the next person could re-introduce.

1. **`--force` permanently destroyed good levels.** The first cut implemented force as "read
   `owner_items` instead of the queue", so an already-`B2` item got re-asked; when the model omitted
   it — a *normal* semantic miss, and exactly what the prompt's Rule 5 asks for — `writeLevels`
   wrote `level: null` **and** stamped `level_at`, so the B2 was erased and no sweep would ever
   re-derive it. **A prompt improvement would silently eat data.** Two changes fix it: `writeLevels`
   now does **two upserts** (answered rows write `level`; unanswered rows write `level_at` *only*,
   never touching a level they failed to replace), and `--force` is now a **reset** —
   `resetLevelFlags` nulls `level_at`, then an ordinary sweep runs. Bypassing the queue also meant
   force could never *consume* it: `--force --limit=200` re-levelled the same first 200 on every
   run, forever, and an interrupted force run restarted from zero. The reset keeps force
   incremental and resumable like any other sweep.
2. **The `after()` hook levelled the wrong items.** It was capped at 50 and the queue was ordered by
   `norm_key`, so with any backlog it levelled the alphabetically-first 50 — quite possibly not the
   word the learner just typed, which is the hook's entire purpose. The queue is now ordered
   **newest-first** (`first_added_at desc`), which is why that column is in the view. My original
   note here claimed passing no `normKeys` was elegant; it was wrong, and the ordering is what
   actually makes it correct.
3. **One `catch` conflated an LLM failure with a DB failure.** `classifyBatch` and `writeLevels`
   shared a try, so a write failure was reported as "network / API" while silently discarding levels
   already produced and paid for — and the next sweep re-billed for the identical answer. They're
   separate blocks now with distinct messages. The run also carries `errors[]` out to the CLI: the
   first real failure in testing was a `529 Overloaded`, and without the message printed it was
   indistinguishable from a bug.

Also fixed: `listPendingItems` was unbounded, so a backfill past PostgREST's max-rows (1000) would
report "done" having silently skipped the rest — it paginates now. `LEVEL_BATCH_SIZE`'s comment
justified 25 with "getChatModel takes no arguments", which the same change had made false.

⚠️ **Not fixed, accepted:** two concurrent runs (a sweep racing `after()`) both read the queue
before either writes, so both classify the same items — double cost, same result, last write wins.
A claim step (`update … set level_at = now() where level_at is null returning *`) would make the
queue single-consumer; at a few hundred items it isn't worth it. Documented in `levelItems`.

`getChatModel()` auto-traces to LangSmith with no extra wiring (`src/lib/llm.ts:4-6`), so every
classification batch is inspectable for free. Given the B2 bias, that's worth opening once.

### Verified against the real database

All 20 items are levelled — 19 by the model, 1 (`zzz-offline-sync-test`) correctly left alone.

| | A2 | B1 | B2 | C1 | C2 | unleveled |
| --- | --- | --- | --- | --- | --- | --- |
| items | 1 | 3 | 6 | 8 | 2 | 1 |

- **The B2 bias did not materialise** — the distribution is spread across all five levels with no
  clump (prompt rule 4). Worth re-checking whenever the prompt or model changes; it's the one
  failure that hides behind an aggregate number.
- **Compositionality held** (rule 3): _it slipped my mind_ → B2 and _hit the ground running_ → C1,
  neither levelled by its easy constituent words. _serendipity_ → C2, _flood_ → A2.
- **The unanswered item was `zzz-offline-sync-test`** — not English, so the model omitted it per
  rule 5. It is stamped `level_at` with a null level and **will never be asked about again**. The
  semantic-failure path fired on a real item on the first run; this is exactly what `level is null`
  could not have expressed.
- **The clobber fix is verified against the exact failure the review described.** Given an item
  holding `C2` that the model then omitted, the level **survived** and only `level_at` moved. The
  pre-fix code would have nulled it permanently.
- **Re-running is a no-op** ("nothing to do — every item has already been attempted"), zero LLM
  calls.
- **New items enter the queue alone.** Verified in a rolled-back transaction: inserting
  `Don’t  Beat Around The Bush.` produced `norm_key = don't beat around the bush` (iOS curly
  apostrophe, double space, and terminal period all folded by the 0004 trigger) and it was the
  only row in the queue — the 20 attempted items stayed out.

⚠️ **One pre-existing quirk surfaced by that test:** `don't beat around the bush` is classified
`kind = 'sentence'`, because 0005 counts words and >4 means sentence. It's an idiom. The prompt
still says "level the whole thing as a unit", so the guidance is roughly right, but the 4-word
boundary means longer idioms are described to the model as sentences. Not worth changing on one
example — noted in case the level column ever looks off for long idioms.

---

## Deliberately dropped

Recorded so they aren't rediscovered as "missing":

- **`cefr_lexicon` + CEFR-J/Octanove seed** — an authoritative wordlist keyed by lemma. Would raise
  accuracy a few points and cut LLM spend to ~zero per repeated word. Rejected: the review's "just
  ask the LLM" is well-supported (87.0% LLM vs 80.7% for the POS baseline — the lexicon's entire
  edge is small). The door stays open: it'd sit strictly upstream of `lesson_item_attrs` with no
  page changes.
- **The lemma/stemmer normalization** (`ts_lexize('english_stem', …)`, `running → run`) — existed
  only to key into a lexicon. `norm_key` stays exactly as it is: typography-only, no lemmatizing,
  per `0004:27-30`.
- **Global cache of levels across owners** — the level of _ubiquitous_ is a fact about English, not
  about a user, so per-(user, word) LLM calls re-derive a universal fact. With one user that's
  theoretical. Revisit if this goes multi-user.
- **Widening `level_source`** — proposed in the previous draft to distinguish a lexicon lookup from
  an LLM guess. No lexicon, no distinction.
- **Showing the source on the chip**, **manual override UI**, **a fine-tuned sentence classifier**
  (CEFR-SP / Ace-CEFR), **sense-level classification from `lesson_sessions.transcript`** (the
  genuinely better system — the tutor transcripts mean the sense the learner actually practiced is
  recoverable; worth its own note someday), and **tutor-side use of the level** (already ruled out
  by July 11, Decision 4).

## Sources

[Exploiting the EVP for L2 word-level vocabulary assessment with LLMs (BEA 2025, arXiv:2506.02758)](https://arxiv.org/abs/2506.02758)
— the 87.0 / 83.3 / 80.7 accuracy table, the 62% polysemy figure, the ambiguous/non-ambiguous split ·
[Ace-CEFR (Google, arXiv:2506.14046)](https://arxiv.org/html/2506.14046v1) — short-passage MSE, LLM vs human expert ·
[Generative AI and CEFR Levels: Evaluating Accuracy (Benedetto et al. 2025)](https://files.eric.ed.gov/fulltext/EJ1466280.pdf)
— the B2 over-prediction bias

Licensing research is retained for the record even though the lexicon is dropped: **CEFR-J** (free
for commercial use with citation) and **Octanove C1/C2** (CC BY-SA 4.0) are shippable;
**EVP**, **Oxford 3000/5000**, and **Cambridge** are browse-only or need a negotiated license, and
their GitHub mirrors carrying MIT `LICENSE` files are unlicensed re-uploads, not a grant. If a
lexicon is ever revisited, start at [CEFR-J](http://www.cefr-j.org/download_eng) and
[cefrpy](https://github.com/Maximax67/cefrpy) (MIT, pre-packaged with lemma/POS/frequency).
