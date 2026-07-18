# The word-details enrichment job — a second background job on the level job's machinery

_Date: 2026-07-18 — research note (no code written yet)._

**Goal:** fill in a rich per-word "details" payload — Russian translations, part of speech, the other
forms the word family takes (with their own Russian translations), and example sentences across those
forms — by asking the LLM, and render it in the `Details` placeholder already sitting on the word
detail page (`src/app/lesson-items/[id]/page.tsx:91`).

Follow-on from two threads that already exist:

- **The level-assignment background job** (`docs/2026-07-16-level-assignment-background-job.md`). This
  new job is the *same machinery a second time* — a work-queue view, an "attempted" flag, an `after()`
  fast path plus a `pnpm` sweep, batched `.withStructuredOutput()` calls, and the transport-vs-semantic
  failure split. Almost every decision that doc settled carries over verbatim; this note is mostly
  about **where the payload's size forces different choices** (batch size, model, per-item parse
  resilience) and the **one new question** (how a nested document is stored and surfaced).
- **The `words-1.2` translations + forms research** (`docs/2026-07-08-words-1.2-russian-translations-and-word-forms.md`).
  That designed the *spoken, live-tutor* version of exactly this content (Russian synonyms, full
  word-family forms). This job is its **§5.3 backlog item** — "curated translations over on-the-fly LLM
  translation … pre-generated once by the LangChain/Claude pipeline" — realized. The two are
  complementary, not redundant: see [Relationship to words-1.2](#relationship-to-words-12).

## TL;DR

- **Copy the level job.** Same queue view, same flag semantics, same `after()` + CLI triggers, same
  two-failure discipline. The level job's review already paid for the subtle bugs (clobbering good data
  on a semantic miss, keying by echoed text, conflating a transport failure with a write failure); reuse
  the shape and inherit the fixes. Don't invent a third job idiom.
- **One new column pair on `words`, mirroring `level`/`level_at`:** `details jsonb` (the payload,
  nullable forever) and `details_at timestamptz` (the **ATTEMPTED** flag — stamped when the job looked,
  not when it succeeded — which is what makes "looked, no usable answer" terminal instead of re-asked on
  every sweep). Plus a small `details_version smallint` for provenance and targeted re-runs after a
  schema/prompt change. `details` is a nested document with no query needs, so jsonb is right (the
  `categories` precedent, `0007:68`).
- **The one real divergence from the level job is batch size.** Level batches 25 items per call because
  each answer is a two-field `{index, level}`. An enrichment answer is a *large* object (several
  translations, a forms table, several example sentences). Batching 25 of those blows the token budget
  and turns truncation into silent data loss. **Batch ≈ 4, `maxTokens: 8192`**, per-item-resilient
  parsing — the identical sequential-batch loop as `levelItems`, just smaller and wider.
- **Model matters more here than for levels.** Levelling is classification where the LLM-vs-lexicon
  spread is a few points, so the level doc calls Opus overkill. This job *generates* translations and
  example sentences whose quality a learner reads directly — a wrong Russian synonym or an unnatural
  sentence is visible in a way a slightly-off CEFR chip is not. Default to a strong model
  (`claude-opus-4-8`, the app default) and let `ANTHROPIC_MODEL` tune down if cost bites; don't cheap
  out by default the way the level sweep can.
- **`kind` stops being a hint and becomes a branch.** "Forms" means one thing for a word
  (*decide → decision → decisive → decisively*) and another for a phrase/sentence (structural / tense /
  register variants). The prompt handles all three kinds, but the branch is real, not cosmetic.
- **The page already has the slot.** `src/app/lesson-items/[id]/page.tsx:91-94` is a literal
  placeholder that names translations / forms / examples. `getItem` reads `owner_items`; the only page
  change is to also fetch `words.details` and render three sub-sections. No list-page change.

---

## What the user asked for, mapped to a payload

Restating the request as the concrete document to store:

| Requested | Field |
| --- | --- |
| translation to Russian (several possible options) | `translations_ru: string[]` |
| word type/form — verb, adverb, noun … | `pos: string` (the item *as listed*) |
| other forms it can take **and their Russian translations** | `forms: { text, pos, translations_ru }[]` |
| example sentences using it **in different forms** | `examples: { text, form?, translation_ru? }[]` |

```ts
/** SERVER + client-readable: the enrichment payload stored in words.details (jsonb). */
export interface WordDetails {
  /** Part of speech of the item exactly as the learner listed it ("verb", "noun", "phrase"). */
  pos: string;
  /** Several Russian options for the item as given, best/most-common first. */
  translations_ru: string[];
  /** The rest of the word family. Empty for many phrases/sentences — a normal state, not a gap. */
  forms: Array<{
    text: string;              // "decision"
    pos: string;               // "noun"
    translations_ru: string[]; // Russian for THIS form
  }>;
  /** A few sentences spread across the forms above; `form` labels which one each demonstrates. */
  examples: Array<{
    text: string;              // English sentence
    form?: string;             // e.g. "decisive" — which form it shows off
    translation_ru?: string;   // optional Russian gloss of the whole sentence
  }>;
}
```

Example — the item `decide` (`kind = 'word'`):

```json
{
  "pos": "verb",
  "translations_ru": ["решать", "принимать решение", "определяться"],
  "forms": [
    { "text": "decision",  "pos": "noun",      "translations_ru": ["решение"] },
    { "text": "decisive",  "pos": "adjective", "translations_ru": ["решительный", "решающий"] },
    { "text": "decisively","pos": "adverb",    "translations_ru": ["решительно"] },
    { "text": "undecided", "pos": "adjective", "translations_ru": ["нерешённый", "колеблющийся"] }
  ],
  "examples": [
    { "text": "We need to decide by Friday.",            "form": "decide",   "translation_ru": "Нам нужно решить до пятницы." },
    { "text": "It was a decisive victory.",              "form": "decisive", "translation_ru": "Это была решающая победа." },
    { "text": "She acted decisively under pressure.",    "form": "decisively" }
  ]
}
```

For a phrase (`put up with`, `kind = 'phrase'`): `pos: "phrasal verb"`, `translations_ru: ["терпеть", "мириться с"]`, `forms` carries tense/inflection variants (`put up with → puts up with → put up with it`), examples show it in a couple of tenses. For a sentence, `forms` is usually empty and examples give one or two natural rephrasings.

---

## What carries over from the level job unchanged

These were settled and reviewed once already; restating them only to say "same here".

- **The flag is a timestamp stamped on _attempt_, not success.** `details_at is null` ⇒ pending;
  `details_at` set with `details` still null ⇒ "the model looked and had nothing usable, never ask
  again" (a non-English token, a made-up word). Identical argument to `level_at`
  (level doc, Decision 1). `details is null` alone cannot be the queue for the same reason `level is
  null` couldn't.
- **Two failures, treated oppositely** (level doc, Decision 3):

  | Failure | `details_at` | Why |
  | --- | --- | --- |
  | **Transport** — call threw (500, timeout, truncated JSON) | **stamp nothing** | nothing learned; next sweep retries |
  | **Semantic** — call returned, but a word got no usable object | **stamp it**, leave `details` null | model looked, had nothing; re-asking buys the same nothing |

  Collapsing these is how the flag gets defeated. This is the only subtle thing in either job.
- **Key results back by index, never by echoed text.** A reordered / re-spelled answer would
  mis-assign a whole batch. Same guard `classifyBatch` uses (`src/lib/levels.ts:138-144`).
- **`writeLevels`' two-write discipline, ported.** Answered words write `details` + `details_at`;
  unanswered words write `details_at` **only**, never nulling a `details` a `--force` re-run might not
  replace. This is the exact clobber bug the level review caught (level doc, "What the code review
  caught", item 1) — inherit the fix, don't re-earn it.
- **Triggers: `after()` + a `pnpm` sweep, no scheduler.** `details` is nullable forever and the page
  renders "coming soon" gracefully, so there's no correctness deadline and no scheduler
  (level doc, Decision 4). One `after()` per write (bounded by an after-limit, mirroring
  `LEVEL_AFTER_LIMIT`), and `pnpm enrich:words` backfills + catches drops.
- **`--force` is a reset, not a bypass.** `resetDetailsFlags` nulls `details_at`, then an ordinary
  sweep runs — resumable and incremental, and it can't clobber via the two-write rule above
  (level doc deviation 4 + review item 1).
- **Queue is newest-first** so the `after()` window contains the word the learner just added
  (`src/lib/levels.ts:92-105`, review item 2).

---

## Decision 1 — storage: one jsonb column on `words`, not a child table

The payload is a nested document, 1:1 with a word, that nothing filters or joins on — you never query
"words whose third example mentions Friday". That is the jsonb case, and `words.categories`
(`0007:68`, `jsonb not null default '{}'`) is the in-repo precedent. A `word_details` child table would
buy referential shape nobody reads and cost a join on the one page that needs it.

So, additive columns on `words` (migration `0009`):

```sql
alter table words
  add column details          jsonb,          -- the WordDetails payload; null = not enriched
  add column details_at       timestamptz,    -- ATTEMPTED flag (see comment); null = never attempted
  add column details_version  smallint;       -- which prompt/schema produced `details` (provenance)

comment on column words.details_at is
  'When the enrichment job last ATTEMPTED this word (not when it succeeded). NULL = never attempted.
   Set even when no payload came back, so an un-enrichable item is asked about once, not forever.
   Set to NULL to force reprocessing.';

-- The job's queue. Mirrors words_owner_pending_idx (0007:128): a partial index on the pending set.
create index words_owner_pending_details_idx
  on words (owner_id, created_at desc) where details_at is null;
```

**`details_version` is the one thing the level job lacked and this one wants.** The level job
re-processes after a prompt change with a blunt `--force` (reset every flag). That's fine for a
two-field answer. Enrichment schemas will evolve (add a field, change the forms shape), and you'll want
to re-run *only the rows produced by an older schema* — `where details_version < CURRENT_DETAILS_VERSION`
— without re-billing rows already on the current schema. Store the constant the code was built with;
keep the default queue simple (`details_at is null`) and let `--force --stale` target the version gap.

**The queue view**, mirroring `owner_items_pending_level` (`0007:283`):

```sql
create view owner_words_pending_details with (security_invoker = true) as
select w.owner_id,
       w.id as word_id,
       w.norm_key,
       w.text,
       lesson_item_kind(w.norm_key) as kind,   -- 'word'|'phrase'|'sentence' — a real branch here
       w.created_at                 as first_added_at
  from words w
 where w.details_at is null;
```

## Decision 2 — surfacing it on the page without bloating the list

The list page (`/lesson-items`) does `select *` from `owner_items` (`src/lib/lesson-items.ts:85`) and
ships the whole filtered set to the browser. **Do not add `details` to `owner_items`** — that would push
a fat jsonb blob per row into a payload the list neither needs nor renders.

Instead, `getItem` (the detail page's single read, `src/lib/lesson-items.ts:118`) gains a second,
targeted read of just the payload:

```ts
// In getItem, after the owner_items row loads — one narrow, owner-scoped read.
const { data: d } = await getServiceSupabase()
  .from("words")
  .select("details, details_at")
  .eq("owner_id", ownerId)
  .eq("id", id)
  .maybeSingle();
```

Return `details` (typed `WordDetails | null`) and `details_at` on the detail row so the page can tell
apart the three states it must render differently:

| `details` | `details_at` | Page shows |
| --- | --- | --- |
| set | set | the full details sections |
| null | null | "Details are being prepared…" (queued / in flight) |
| null | set | "No extra details for this one." (attempted, nothing came back) |

## Decision 3 — batch size, and why it's the one number that changes

This is the whole reason this can't literally be a second call site of `levelItems`.

- The level answer per item is `{index, level}` — a handful of tokens. 25 per call sits safely under a
  4096-token cap (level doc, Decision 3; `src/lib/levels.ts:128`).
- An enrichment answer per item is a `WordDetails` object: 3–4 translations, 3–5 forms each with a POS
  and its own translations, 3–4 example sentences with Russian glosses. Call it ~300–500 output tokens
  **per word**, in Cyrillic-heavy JSON.

Batch 25 of those and you're at 10k+ output tokens, over any sane cap, and **the failure mode is a
truncated response** — which parses as "the model dropped the last N words", i.e. silent loss. That's
the exact trap the level doc flagged for 50-item batches, amplified.

**Recommendation: `BATCH = 4`, `getChatModel({ maxTokens: 8192 })`, per-item-resilient parse.** Same
sequential-batch loop as `levelItems` (`src/lib/levels.ts:219-250`), just smaller batches and a wider
cap. The zod schema is an array of `{ index, details }` where each `details` is validated independently,
so one malformed word is dropped (semantic miss → stamp `details_at`, null payload) rather than failing
the batch's parse — the "bare string not z.enum" lesson (level doc deviation 2), one level up: validate
per word, not the whole array atomically.

A per-word `BATCH = 1` is the *simplest* and deletes the index-keying and one-bad-item concerns entirely;
its only cost is more HTTP calls at a scale (hundreds of items) where that's cheap. **Test both on real
vocabulary and pick by observed truncation** — this is the one number worth measuring rather than
guessing. Everything else copies.

## Decision 4 — model, and why not the cheap default

The level doc argues Opus is overkill because the LLM-vs-authoritative-lexicon accuracy spread is a few
points — for *classification*. This job *generates* content the learner reads verbatim:

- A wrong Russian synonym is a **teaching error**, not a slightly-off filter chip.
- An unnatural example sentence undermines trust in the whole feature.
- Word-family enumeration and register nuance (which Russian synonym fits which shade) is exactly where
  weaker models get lazy or hallucinate a form that doesn't exist.

Default to `claude-opus-4-8` (the app default per `CLAUDE.md`; note `src/lib/llm.ts:10` currently
hardcodes `claude-opus-4-5` as `DEFAULT_MODEL` — a pre-existing drift, out of scope here, but it means
this job inherits opus-4-5 unless `ANTHROPIC_MODEL` is set). Keep `ANTHROPIC_MODEL` as the escape hatch
if cost bites, but don't make thrift the default the way the level sweep sensibly does.

Every call auto-traces to LangSmith with no wiring (`src/lib/llm.ts:4-6`), so the first real batches are
inspectable for translation quality for free — worth opening once, the way the level doc opened the B2
distribution.

## Decision 5 — the prompt (`src/lib/word-details-prompt.ts`)

Its own file so a prompt change is a reviewable diff — same rule as `levels-prompt.ts`. It reuses the
substance already designed in `docs/2026-07-08` §4 (the TRANSLATION and deepened FORMS threads), but
retargeted from *spoken asides* to *a structured JSON document*:

- **Russian, several options, ordered.** Best/most-common sense first, then shades — and one short note
  per synonym is out of scope for the payload (no free-text register notes); if wanted, add a
  `note?` per translation later. For a phrase/sentence, give the natural Russian equivalent, not a
  word-by-word gloss (`docs/2026-07-08` §4.2).
- **POS of the item as listed**, then the **whole word family** with each member's POS
  (`docs/2026-07-08` §4.3: *decide → decision → decisive → decisively → undecided*). **Do not invent
  forms** — if there's no adverb, omit it; a made-up form is worse than a short list. The `kind` branch:
  for a phrase/sentence, `forms` carries structural/tense/register variants, and empty is fine.
- **Examples spread across forms.** At least one per major form named in `forms`, natural and short,
  each optionally with a Russian gloss. Sense discipline carries over from the level prompt (Rule 1):
  the everyday sense, not a rare/technical one.
- **Coverage rule, ported from `levels-prompt.ts` Rule 5:** if the item isn't English or is meaningless,
  return an empty/omitted object for it rather than inventing — recorded as un-enriched, a normal state.
- **JSON, not speech.** The `words-1.2` prompt fought hard to keep output speech-shaped (no lists) for
  TTS. This is the opposite surface: emit clean structured data via `.withStructuredOutput()`, and the
  Cyrillic lives in JSON string values (unicode-safe, no TTS accent-bleed concern — that was a *spoken*
  problem, `docs/2026-07-08` §2.3, and does not apply to a page).

## Rendering — the detail page's `Details` section

`src/app/lesson-items/[id]/page.tsx:91-94` is already the marked slot ("More about this word is coming
soon"). Replace with three sub-sections driven off `item.details`:

1. **Translations** — `pos` as a small label, then `translations_ru` as an inline, comma-separated list.
2. **Forms** — a compact table/list: `text` · `pos` · Russian. Skip the section when `forms` is empty.
3. **Examples** — the sentences, each with its `form` tag and (dimmed) Russian gloss if present.

Plain page UI, so lists and a table are fine — the no-lists constraint was a TTS rule, irrelevant here.
The three empty/pending/attempted states from Decision 2 each get a one-line message.

---

## Implementation surface

Mirrors the level job's surface (level doc, "Implementation surface") almost file-for-file:

| File | Change |
| --- | --- |
| `supabase/migrations/0009_word_details.sql` | **new** — the three `words` columns + partial index + `owner_words_pending_details` view + the `details_at` comment. The whole schema change. Additive; `owner_items` untouched |
| `src/lib/word-details.ts` | **new** — server-only. `enrichWords(ownerId, opts)`: query pending → batch ≈4 → `.withStructuredOutput()` (`maxTokens: 8192`) → two-write (`details`+`details_at` for answered, `details_at` only for unanswered). Plus `listPendingWords`, `resetDetailsFlags`, `DETAILS_BATCH_SIZE`, `DETAILS_AFTER_LIMIT`, `CURRENT_DETAILS_VERSION`. The level job's `levels.ts`, adapted |
| `src/lib/word-details-prompt.ts` | **new** — the prompt + `kind` branch. Separate file for a reviewable diff, like `levels-prompt.ts` |
| `src/lib/word-details.ts` (types) | export `WordDetails` (payload) + a zod `DetailsSchema` validated per-item |
| `scripts/enrich-words.ts` | **new** — the CLI. Copy `scripts/level-items.ts`: `--dry-run` (zero LLM calls), `--force` (reset flags), `--force --stale` (re-run only `details_version < CURRENT`), `--owner=`, `--limit=`. dotenv precedence per `migrate.mjs` |
| `package.json` | `enrich:words` + `enrich:words:plan` |
| `src/lib/lesson-items.ts` | `getItem` gains the targeted `words.details` read; `ItemRow`/a detail type gains `details`/`details_at` |
| `src/app/lesson-items/[id]/page.tsx` | replace the `Details` placeholder with the three sub-sections |
| `src/app/lessons/actions.ts`, `src/app/lesson-items/actions.ts` | add `after(() => enrichWords(ownerId, { limit: DETAILS_AFTER_LIMIT }))` alongside the existing `levelItems` call on the write paths |
| `tsconfig.json` | already includes `scripts/**/*.ts` since the level job — no change |
| `CLAUDE.md` | the two commands + a convention entry, mirroring the level-job entry |

**Level and enrichment are independent and can't clobber each other** — different columns, same
"payload writes only its own columns" property that lets the level job and the favorite button coexist
(level doc, "Where we are today"). Both fire from the same `after()`; both read the same `words` rows.
Running them as **two calls** is deliberate — different batch sizes, different models, different failure
isolation. (You *could* fold levelling into the enrichment call since the model is already reasoning
about the word — noted in [Deliberately dropped](#deliberately-dropped), recommended against.)

## Risks & open questions

- **Batch size vs truncation** (Decision 3) — the one thing to measure, not guess. Start at 4, watch for
  dropped trailing items in LangSmith, fall to 1 if needed.
- **Translation accuracy for rare senses / idiom register** — the durable `docs/2026-07-08` §6 risk,
  same here. Mitigation: strong model (Decision 4), "everyday sense" rule, "don't invent forms". A wrong
  row is one word, invisible-until-opened, and free to fix (`details_at = null`, re-sweep).
- **Payload size** — a very generative word could produce a large `forms`/`examples` set. Cap in the
  prompt ("up to ~5 forms, ~4 examples") to bound both tokens and page length.
- **Schema evolution** — `details_version` is the pressure valve; without it, every schema tweak means a
  full `--force` re-bill of the whole collection.
- **Cost at scale** — hundreds of items × one strong-model call each. Fine now (one user); if this goes
  multi-user, the level doc's "global cache — a word's forms are a fact about English, not about a user"
  note applies even more strongly here, since the payload is larger and more reusable than a single
  level.

## Relationship to words-1.2

`docs/2026-07-08` designed the **spoken** version of this content for the live ElevenLabs tutor
(Russian synonyms and full word-family forms woven into speech). This job is its **§5.3 backlog item**
made real: *curated, pre-generated* translations/forms stored per word. They compose:

- The **detail page** reads `words.details` (this job).
- The **tutor** could later read the same `words.details` to *present* rather than *invent* the
  translation mapping — injected into `{{items_list}}` at session kickoff — closing `docs/2026-07-08`
  §5.3's loop and removing on-the-fly translation-hallucination risk from the live session.

So the payload is worth designing as the single source of truth for word enrichment across both
surfaces, not just the page.

## Deliberately dropped

Recorded so they aren't rediscovered as "missing":

- **Folding levelling into the enrichment call.** One call returning both `level` and `details` saves an
  API round-trip. Rejected: it couples two jobs with different batch sizes (25 vs 4), different model
  economics (cheap vs strong), and different failure isolation, and it would re-bill enrichment every
  time you want to re-level (or vice-versa). Keep them independent, as the level job and the favorite
  button are independent.
- **A `word_details` child table** — Decision 1. jsonb 1:1 with the word, no query needs.
- **Free-text register notes per translation** (the `docs/2026-07-08` §4.2 "when each synonym fits"
  nuance). Out of the first payload to keep the schema tight; add a `note?` per translation if the page
  wants it.
- **Audio for the examples / native-Russian pronunciation** (`docs/2026-07-08` §5.1 multi-voice). A page
  feature, not this job's; the TTS accent-bleed problem is a spoken concern and doesn't touch stored
  JSON.
- **Manual editing of `details` in the UI.** `details_source`/`'user'` is not modelled (the level job's
  `level_source = 'user'` is still reserved-and-unwritten). If curation-by-hand is ever wanted, it's the
  same shape: a `details_source` guard so the sweep doesn't clobber a hand-edited row.

## Sources (in-repo)

- `docs/2026-07-16-level-assignment-background-job.md` — the machinery this copies, and the review that
  hardened it.
- `docs/2026-07-08-words-1.2-russian-translations-and-word-forms.md` — the translations/forms substance
  (§4) and the "curated over on-the-fly" backlog item (§5.3) this realizes.
- `src/lib/levels.ts`, `src/lib/levels-prompt.ts`, `scripts/level-items.ts` — the files to copy.
- `supabase/migrations/0007_words_m2m.sql` — `words` schema, the `categories` jsonb precedent, and the
  `owner_items_pending_level` view to mirror.
- `src/app/lesson-items/[id]/page.tsx:89-94` — the placeholder this fills.
