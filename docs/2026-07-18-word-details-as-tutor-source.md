# `words.details` as the single source of word enrichment (page + tutor)

_Date: 2026-07-18 — research / pre-implementation. Follows on from
`docs/2026-07-18-word-details-enrichment-job.md` (the enrichment job, now shipped in commit
`75c48a9` + migration `0009`) and `docs/2026-07-08-words-1.2-russian-translations-and-word-forms.md`
§4/§5.3._

**The idea:** the `words.details` payload the enrichment job now produces (Russian translations, part
of speech, word-family forms with their translations, example sentences) is exactly the content the
live `words-1.2` tutor currently **invents on the fly** every session. Feed the curated payload into
the tutor's session kickoff and the tutor *presents* verified facts instead of *inventing* them —
closing `docs/2026-07-08` §5.3's "curated over on-the-fly" loop and removing the on-the-fly
translation-hallucination risk from the live session.

## TL;DR — recommendation

- **Yes, `words.details` should be the single source of truth across both surfaces.** The page already
  reads it; a new tutor version reads the same payload at session kickoff.
- **The injection point is the existing `{{items_list}}` dynamic variable — no new variable, no
  `sync-agents.ts` change.** `items_list` is injected into the **system prompt the LLM reads**, not
  into TTS, so it can carry a richly structured per-item reference block without any speech-shaping
  concern. The "no lists / no markdown" rule governs the tutor's *spoken output*, never the reference
  data handed to it. This is the single most important clarification in this note.
- **This needs a new prompt version, `words-1.3`** — not because of the transport (the client can cram
  details into `items_list` against the *existing* agent with zero agent change), but because the
  words-1.2 prompt *instructs the model to generate* the translation/forms mapping. To make it
  *present curated data and only fall back to inventing when a word has none*, the instructions must
  change, and a prompt change is a new version by this repo's registry rules.
- **Per-item fallback, never session-level gating.** Build `items_list` so each item carries its
  details block when `details` is present and is a plain text item when not. A half-enriched lesson
  just works; the tutor is useful on day one and sharpens as enrichment backfills. The tutor never
  waits for or skips an un-enriched word — it generates that one live, exactly as words-1.2 does today.
- **Keep the payload lean — do _not_ add register notes to it.** The tutor/page contract gap is real
  (below) but the right split is: curated `details` pins the **enumerable facts** (which Russian
  synonyms are valid, which forms actually exist, natural example sentences) — the exact place weak
  on-the-fly generation hallucinates — while the tutor prompt layers the **conversational nuance**
  ("which synonym fits which shade", register asides) live, which is low-risk and genuinely spoken.
  The one payload addition worth considering is a `rarity` hint on forms (a fact, not nuance); see Q4.

---

## Q1 — how `{{items_list}}` is built today, and where curated details slot in

The current path is a plain **text-only** list; nothing about a word beyond its text reaches the tutor.

**Server (`src/lib/lessons.ts`).** `getLesson` selects `lesson_items(position, words(text))` and
reduces it to `lesson.items: string[]` — just the active item **texts** in position order
(`embeddedTexts`, `lessons.ts:40`). The word ids, levels, and `details` are dropped here.

**Page (`src/app/lessons/[id]/page.tsx`).** Passes `items={lesson.items}` (the string array) straight
into `<LessonTutor>`.

**Client (`src/app/lessons/[id]/LessonTutor.tsx:118`).** At `startSession` it formats the variable:

```ts
dynamicVariables: {
  items_list: items.map((it, i) => `${i + 1}. ${it}`).join("; "),
  lesson_id: lessonId,
  app_env: body.appEnv ?? "prod",
}
```

So `items_list` is literally `"1. ephemeral; 2. break the ice; 3. I couldn't agree more"`.

**Sync (`src/agent/sync-agents.ts:38-40, 103-105`).** The agent is created with a
`dynamic_variable_placeholders.items_list` default (`ITEMS_PLACEHOLDER`) used only so the prompt
validates at sync time; the real value is the runtime one above. **Only variables declared here can be
injected** — which is the argument for reusing `items_list` rather than adding a second variable
(that *would* need a `sync-agents.ts` change and hence touch every agent's config hash).

**Where curated details slot in — three coordinated changes, no new dynamic variable:**

1. **`getLesson` carries `details` through.** Extend the select to `words(text, details, details_at)`
   and widen the derived shape from `items: string[]` to a structured
   `items: { text: string; details: WordDetails | null }[]` (or a parallel `itemDetails` array keyed
   by position). This is the only non-trivial server change — `embeddedTexts` becomes
   `embeddedItems`. Keep `lesson.items: string[]` too if other callers (`listLessons`, the lesson
   list card) still want the cheap text-only form; only the tutor path needs the fat shape.
2. **The page passes the structured items to `LessonTutor`.**
3. **`LessonTutor` formats each item into a reference block** inside the *same* `items_list` string
   (format in Q-design below). Items with `details === null` render as today's plain
   `"N. <text>"`.

Net: the transport is unchanged (one dynamic variable), the agent config is unchanged (no new
placeholder), and the only new plumbing is "thread `details` from the DB row to the formatter."

## Q2 — payload shape as a shared contract: what the page needs vs what the tutor wants

The stored `WordDetails` (`src/lib/word-details.ts:60-77`) is:

```ts
{ pos: string;
  translations_ru: string[];
  forms: { text; pos; translations_ru }[];
  examples: { text; form?; translation_ru? }[] }
```

The page renders exactly this. The **tutor (words-1.2 prompt) asks for two things the payload
deliberately dropped:**

| words-1.2 wants (spoken) | In the payload? | Verdict |
| --- | --- | --- |
| Russian synonyms for the item | ✅ `translations_ru` | covered |
| "when each Russian synonym fits" — per-synonym register nuance (§4.2) | ❌ dropped ("Deliberately dropped: free-text register notes") | **let the tutor add it live** |
| the whole word family with each member's POS | ✅ `forms[]` | covered |
| "flag which family members are common, which are rare or don't exist" (§4.3) | ❌ no rarity marker on `forms` | **optional payload add (a fact)** |
| natural example sentences | ✅ `examples[]` | covered |
| stress-shift / pronunciation traps (SOUND thread) | ❌ not in payload | **tutor generates live — pronunciation is a spoken concern, out of a text payload** |
| false-friends-with-Russian trap (USAGE thread) | ❌ not in payload | **tutor generates live** |

**The resolution is the fact/nuance split, not a fatter payload.** The payload's value is pinning the
*enumerable, hallucination-prone facts*: is «эфемерный» actually a valid synonym for *ephemeral*? does
*decide* really have the adverb *decisively*? is this example sentence natural? Those are where a live
model gets lazy or invents. The *nuance* — which synonym carries which shade, register asides,
pronunciation traps — is conversational, low-stakes if imperfect, and is what a tutor is *for*. So the
tutor consumes the facts and speaks the nuance on top. This keeps the page payload lean (its original
design intent) while giving the tutor everything it can't safely invent.

## Q3 — freshness: what the tutor does for an un-enriched word (`details` null)

**Fall back to on-the-fly, per item — never skip, never gate the session.** Three states, mirroring
the page's Decision-2 table, collapse to two behaviors for the tutor:

| `details` | `details_at` | Meaning | Tutor behavior |
| --- | --- | --- | --- |
| set | set | enriched | **present** the curated data |
| null | null | queued / in flight | **generate live** (words-1.2 behavior) |
| null | set | attempted, nothing usable | **generate live** |

Because the enrichment job is deliberately partial and deadline-free (`details` nullable forever), a
lesson will routinely contain a mix — a word added seconds ago (still pending) next to one enriched
last week. The `items_list` formatter handles each item independently: enriched items get a details
block, un-enriched items are plain text, and the prompt is written to do the right thing for both
("reference data is provided for some items; where it's missing, teach from your own knowledge as you
normally would"). No waiting, no session-level "is this lesson fully enriched" check, no new UI state.

This also means **words-1.3 is a strict superset of words-1.2's behavior**: with zero enriched words it
*is* words-1.2 (generate everything live); each enriched word simply swaps invention for presentation.

## Q4 — does this change any decision in the enrichment-job doc?

**Mostly no — with one optional reconsideration.**

- **Register notes per translation** (enrichment doc "Deliberately dropped"): the doc left the door
  open — *"add a `note?` per translation if the page wants it."* This research says **keep it dropped**.
  The tutor is the consumer that wanted register nuance, and the fact/nuance split (Q2) puts that
  nuance in the tutor's live speech, not the payload. Adding free-text notes would bloat every
  enrichment call's tokens (Decision 3's truncation risk is real at `BATCH = 4`) to store something the
  tutor generates better in context. Verdict: the enrichment doc's decision stands.
- **A `rarity` / `common` hint on `forms`** — this is the one addition worth weighing, because
  words-1.2 explicitly wants "flag which forms are common and which are rare or don't exist," and
  *that is a fact, not nuance*. Two ways to honor it:
  - **Don't store it (recommended for now).** The payload already encodes existence by *omission* — a
    word with no adverb simply has no adverb row (the prompt's "do not invent forms" rule guarantees
    this). "Common vs rare among the forms that exist" is a softer signal the tutor can judge live.
    This keeps the schema and `CURRENT_DETAILS_VERSION` untouched.
  - **Store it later if the tutor proves it needs it:** add `rarity?: 'common' | 'rare'` to the
    `forms` element, bump `CURRENT_DETAILS_VERSION`, and re-run only stale rows with
    `pnpm enrich:words --force --stale` (the exact mechanism `details_version` exists for —
    `word-details.ts:26-29`, `resetStaleDetailsFlags`). No full re-bill. This is the schema-evolution
    path the enrichment doc already built for; nothing here needs to change to keep it available.

  Recommendation: ship words-1.3 against the current payload, listen to the live sessions, and add
  `rarity` only if the tutor visibly guesses wrong about form frequency.

So the enrichment job's shipped shape is the right shared contract as-is. This note's job is to prove
that by building the tutor consumer on top of it unchanged.

---

## Design — `words-1.3`

A new version under `src/agent/prompts/`, following the version-registry mechanics in
`docs/2026-06-27-agent-prompt-version-switching.md`. It is words-1.2 plus a curated-data instruction;
everything else (proactivity, interruptions, recycle/recap, controlled code-switching, TTS hygiene,
`eleven_v3_conversational`, `additionalLanguages: ["ru"]`) carries over verbatim.

### The injected `items_list` format

`items_list` goes into the LLM's system prompt, so structured text is fine (not TTS'd). Keep it
compact and unambiguous. One block per item; enriched items carry a `details:` sub-structure, plain
items don't:

```
1. ephemeral
   ru: мимолётный, недолговечный, эфемерный
   pos: adjective
   forms: ephemerality (noun) — мимолётность; ephemerally (adverb) — мимолётно
   examples: "Fame is often ephemeral." (ephemeral); "It faded ephemerally." (ephemerally)
2. break the ice
   ru: растопить лёд, разрядить обстановку
   pos: phrase (idiom)
   forms: broke the ice; breaking the ice
   examples: "A joke broke the ice." (past)
3. I couldn't agree more
```

(Item 3 has no `details` yet → plain text → tutor generates live.) The formatter is a pure function of
`WordDetails`; exact punctuation is cosmetic as long as it's stable and readable to the model. Cyrillic
lives in the reference text and is only *spoken* when the model chooses to voice it — the
`eleven_v3_conversational` TTS + inline code-switching from words-1.2 (§2.2) handles that unchanged.

### Prompt delta against words-1.2 (the whole change)

1. **After the `Items for this session: {{items_list}}` line, add a curated-data clause:**

   > For some items, curated reference data is provided inline — the Russian translations and
   > synonyms (`ru:`), the part of speech (`pos:`), the word-family forms with their Russian (`forms:`),
   > and example sentences (`examples:`). When an item has this data, **present it — read the Russian
   > and the forms from it rather than working them out yourself** — and layer your own teaching on top
   > (which synonym fits which shade, usage traps, pronunciation). When an item has no reference data,
   > teach it from your own knowledge exactly as you normally would. Never contradict the provided
   > Russian or forms; if you think something is off, note it briefly rather than silently replacing it.

2. **Retune the TRANSLATION and FORMS threads** to say "read from the provided `ru:` / `forms:` when
   present, otherwise generate" — a one-clause edit to each, not a rewrite. The nuance sentences
   ("note when each Russian synonym fits", "flag which forms are rare") stay: that is the live layer
   the payload deliberately doesn't carry (Q2).

3. **Header doc-comment** summarizing the delta, matching words-1.2's style.

`words-1.3.ts`:

```ts
const version: PromptVersion = {
  version: "words-1.3",
  label: "1.3 · curated details from words.details (present, don't invent)",
  prompt,
  ttsModelId: "eleven_v3_conversational", // inherited from 1.2 — Russian-capable
  additionalLanguages: ["ru"],
};
```

### Implementation surface

| File | Change |
| --- | --- |
| `src/lib/lessons.ts` | `getLesson`: select `words(text, details, details_at)`; add a structured `items` shape (or a parallel `itemDetails`) carrying `WordDetails \| null` per position. Import `WordDetails` from `word-details.ts`. Keep the string-only `items` for list callers |
| `src/app/lessons/[id]/page.tsx` | pass the structured items to `<LessonTutor>` |
| `src/app/lessons/[id]/LessonTutor.tsx` | a `formatItemsList(items)` helper that builds the per-item block (details when present, plain text when null); use it for the `items_list` dynamic variable |
| `src/agent/prompts/words-1.3.ts` | **new** — the prompt above |
| `src/agent/prompts/index.ts` | register `words13` last (becomes the UI default) |
| `agents.lock.json` | regenerated by `pnpm sync:agents` — **live ElevenLabs API call**, commit the result |

Note the transport requires **no** `sync-agents.ts` change — same single `items_list` variable, same
placeholder. The only external mutation is `pnpm sync:agents` creating the new agent (see below).

## Why not a separate `{{items_details}}` variable

Rejected in favor of folding into `items_list`:

- A new dynamic variable must be declared in `sync-agents.ts` `dynamic_variable_placeholders`
  (`sync-agents.ts:104`), which changes every agent's config hash and forces a re-sync of all versions
  — a blast radius for zero benefit.
- Two parallel variables (`items_list` + `items_details`) reintroduce an **index-alignment** hazard:
  the model has to zip item N's text to detail N. One structure keeps text and details physically
  together, which is also how `WordDetails` is 1:1 with a word.
- `items_list` isn't TTS'd, so there's no size/speech reason to keep it thin.

## Deliberately dropped / deferred

- **Register notes and pronunciation/false-friend data in the payload** — Q2/Q4: the tutor speaks
  these live; the payload stays lean.
- **`rarity` on forms** — deferred behind `details_version` (Q4); add only if live sessions show the
  tutor guessing form frequency wrong.
- **Learner L1 as `{{native_language}}`** (`docs/2026-07-08` §5.2) — orthogonal; words-1.3 stays
  Russian-hardcoded like 1.2. If/when L1 becomes dynamic, `translations_ru` becomes
  `translations_<lang>` and the enrichment job gains a language axis — a much bigger change, out of
  scope.
- **Editing `details` by hand in the UI** — still unmodelled (enrichment doc's `details_source`
  reservation); a curated-by-hand row would flow to the tutor identically once it exists.
- **Actually running `pnpm sync:agents`** — creating the live agent is an external, side-effecting
  step (it provisions a real ElevenLabs agent and rewrites the committed lockfile). This note designs
  words-1.3 to be implementation-ready; provisioning it is the deliberate follow-up, run once the
  server plumbing + prompt are in and reviewed.

## Sources (in-repo)

- `src/app/lessons/[id]/LessonTutor.tsx:114-124` — where `items_list` is built and injected.
- `src/lib/lessons.ts:40-42, 82-99` — `getLesson` / `embeddedTexts`, the text-only derivation to widen.
- `src/agent/sync-agents.ts:38-40, 92-109` — the placeholder + why a new variable would cost a re-sync.
- `src/agent/prompts/words-1.2.ts` — the base prompt (TRANSLATION/FORMS threads) words-1.3 edits.
- `src/lib/word-details.ts:60-77` — the `WordDetails` contract both surfaces share.
- `docs/2026-07-18-word-details-enrichment-job.md` — the job that produces the payload (§Relationship
  to words-1.2, Deliberately dropped: register notes).
- `docs/2026-07-08-words-1.2-russian-translations-and-word-forms.md` §4 (thread substance), §5.3
  (the "curated over on-the-fly" backlog item this closes).
