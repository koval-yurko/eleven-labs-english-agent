# Word autocomplete on the add-word input — suggestions with RU translation and CEFR level

**Date:** 2026-08-15
**Scope:** the add-word field on the **mobile** `/lesson-items` screen (`AddWordForm` in
`apps/mobile/src/app/lesson-items/index.tsx`). `apps/web` is in scope **as the backend only** —
the migration, the `lexicon` table, the build job, and the new route all live there.
**Status:** **architecture approved 2026-08-15** (D1–D2 below). **Phase 0 built and loaded** — the
`lexicon` table holds 53,538 rows on the live database and every probe in §5.1 answers in under a
millisecond (§12). Phases 1–3 are unstarted. Every number in this document was measured on this
machine against the real datasets; the scripts are reproduced inline so they can be re-run.

> **Web UI is deprecated.** Feature work happens on mobile only from here. `apps/web` remains the
> **backend** — `/api/v2/*`, Supabase, and the background jobs — and this feature adds to it. The
> web `AddWordForm.tsx` gets no autocomplete; it keeps working as the plain field it is today.
> This is why the design below is **server-side**: there is a backend, it is staying, and the
> alternative (a lexicon bundled into the app binary) would tie dictionary updates to App Store
> releases for no gain. See §5.3.

## The ask

Typing into the add-word field should open a dropdown of matching words below it. The learner can
scroll it and pick one, **or** keep typing and add whatever they typed. Each row shows the English
word, its **Russian translations**, and its **CEFR level (A1–C2)** — so the learner can tell before
committing whether they spelled the word they meant.

## The headline

Three separate problems wear one coat here, and only the third is hard:

1. **The widget.** ~150 lines of React Native. There is no dropdown primitive in the mobile `@/ui`
   kit and no Base UI on this side of the workspace, so it is hand-rolled — a positioned `View`
   with a `FlatList` under the existing `TextField`. Not difficult, but it is real work with two
   specific RN hazards (§7).
2. **The matching.** Solved by a prefix index. Prefix fan-out is small at realistic lengths
   (measured below), and ranking by word frequency puts the intended word in the top five.
3. **The corpus.** This is the real work, and the decisive measurement is this: **"ubiquitous" — the
   placeholder text in your own add-word form** — is **not in any open CEFR-graded word list.**
   The CEFR lists are learner-syllabus lists of ~8,600 words; a learner using this app is adding
   precisely the words that fall outside a syllabus. So the suggestion corpus cannot be a CEFR list,
   and the level has to be an _annotation on_ a bigger corpus rather than the thing that defines it.

The recommendation is therefore: **build the lexicon from three sources joined at build time**
(Wiktionary→RU for the headwords and translations, frequency for inclusion and ranking, CEFR where
known), load it into a Postgres table in the existing backend, serve prefix queries from one new
`/api/v2` route, and treat `level: null` as a first-class state — which the codebase already does
everywhere else.

---

## §0 The approved architecture

**No third-party service sits in the request path.** The word list, the Russian translations, and
the CEFR levels are all open datasets downloaded once, joined by a build script, and loaded into
**your own Supabase Postgres**. At runtime the only thing the app talks to is the backend it already
talks to. The Anthropic call (D2) happens at build time and produces a column; a learner typing
`ubi` never triggers an LLM call.

### Build time — one-off, offline, in `apps/web/scripts/`

```
WikDict en-ru.sqlite3  (20 MB, CC BY-SA)     ─┐
CEFR-J 1.5 + Octanove C1/C2  (CSV)           ─┼─→ build-lexicon.ts
wordfreq Zipf frequencies  (Python)          ─┘         │
                                                        ▼
                                       lexicon.jsonl.gz  — 53,616 rows
                                       (committed; 1.1 MB gzipped)
                                                        │
                                    pnpm lexicon:load   ▼
                                       Postgres `lexicon` table  — 53,538 rows, 11 MB with indexes
                                                        │
                                    pnpm level:lexicon  ▼   Batches API, ≈$2–10 once
                                       `level` filled where the CEFR lists had no answer
```

The 21 MB of source downloads never leave the build machine — they are neither committed nor
deployed. What ships is the 1.1 MB derived artifact and the table it loads into. The artifact has
53,616 rows and the table 53,538: Postgres's `lesson_item_norm_key` merges 78 spellings the build
script's Python fold kept apart, which is the intended direction (§12).

### Request time — one new route, existing write path untouched

```
 mobile AddWordForm
   │ types "ubi"        ≥2 chars · 150 ms debounce · sequence guard
   ▼
 GET /api/v2/lexicon/suggest?q=ubi&limit=8          withBearer → ownerId from token
   ▼
 suggest_words(owner_id, prefix, limit)   [RPC, beside resolve_words]
   ├─ lexicon WHERE key LIKE 'ubi%' ORDER BY zipf DESC LIMIT 8    (text_pattern_ops index)
   └─ LEFT JOIN words ON (owner_id, norm_key)  →  owned
   ▼
 { suggestions: [{ text, level, ru[], owned }] }
   ▼
 dropdown  ──tap──▶  fills the input       ← never submits (§8)
   ▼
 unchanged: addWord → POST /api/v2/lesson-items → resolve_words → words row
                                                       └─ after() → scheduleWordJobs
```

### Decisions

| #      | Decision                                                                                                   | Rationale                                                                                                                                                                                                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **Server lexicon.** Postgres table + one `/api/v2` route. Not bundled into the app binary.                 | `apps/mobile` has no `expo-updates`, so a bundled lexicon would gate every dictionary fix behind an App Store release. A table is one `pnpm db:migrate` from current for everyone. `owned` also needs real `norm_key`, which only Postgres can compute. §5.3                                         |
| **D2** | **Fill the level with a one-off LLM batch pass** over the lexicon, not frequency inference and not lazily. | The open CEFR lists cover only ~15% of a real corpus. Frequency-derived levels scored 39% exact / 83% within one level — fine for sorting, not for printing a badge. The batch pass is ≈$2 (Haiku 4.5) to ≈$10 (Opus 5), once, and the 8,301 human-graded rows are a free eval set to gate it on. §4 |
| **D3** | `lexicon` is **not owner-scoped** — the first such table in the schema.                                    | Shared reference data. Read-only RLS instead of the owner-id policy, stated explicitly in `supabase/README.md` rather than left to inference. §5.2                                                                                                                                                   |
| **D4** | Selecting a suggestion **fills the input, it does not submit**.                                            | Mis-taps must stay recoverable, and it keeps the write path byte-identical — the server never learns whether the learner picked or typed. §8                                                                                                                                                         |
| **D5** | **No fuzzy matching in v1.** Prefix only, minimum 2 characters, `LIMIT 8`.                                 | "Did I spell it right" is answered by showing the translation, which is the actual ask. Typo recovery is a separate feature with a threshold to tune and a real risk of burying exact matches. §9                                                                                                    |

Rejected alternatives are kept in §2 (corpus), §4.1–4.2 (level), and §5.3 (delivery) with the
measurements that killed them, so the reasoning survives the decision.

---

## §1 What exists today

The mobile add-word form (`apps/mobile/src/app/lesson-items/index.tsx`, the `AddWordForm` function)
is a single-line `TextField`, a `Button`, and a feedback line — the shape the design port landed on
when it replaced `Alert.prompt`:

```tsx
const result = await addWord(getToken, value);
if (result.status === "added")               setFeedback({ tone: "ok",   … });
else if (result.status === "already-present") setFeedback({ tone: "warn", … });
```

`addWord` (`apps/mobile/src/lib/items.ts`) posts to `POST /api/v2/lesson-items`, which calls
`addWord` in `apps/web/src/lib/words.ts` → the `resolve_words` RPC. The response is `AddWordResult`
(`added` / `already-present` / `empty`). **This write path does not change** — the dropdown fills
the input, it does not submit (§8).

The screen already holds the learner's whole collection in state (`data.items`, an `ItemRow[]`
fetched through `fetchItems`), which matters for the `owned` flag in §6.

Two existing conventions constrain the design and should not be broken:

- **`words.level` is written only by the level job**, never by the UI
  (`apps/web/src/lib/levels.ts`). `level` is nullable _forever_ — "unleveled" is a real state.
- **`words.details` (which holds `translations_ru`) is written only by the enrichment job**
  (`apps/web/src/lib/word-details.ts`). Also nullable forever.

The suggestion dropdown wants exactly those two fields — for words the learner **has not added
yet**, and therefore for words that have no row in `words` at all. That is the gap this feature
fills, and it is why it needs its own corpus rather than a query against `words`.

---

## §2 Where the suggestions come from

Four candidate sources, measured.

### 2.1 The learner's own collection — necessary, not sufficient

Querying `words` for the prefix is cheap and worth doing, but it answers a different question: it
tells the learner _"you already have this"_. That is genuinely useful (it prevents the confusing
`already-present` outcome, see §8), but it can never suggest a word the learner has not met. Keep it
as a **section** of the dropdown, not as the dropdown.

### 2.2 An open CEFR word list — too small, and demonstrably so

`openlanguageprofiles/olp-en-cefrj` is the standard open pairing:

| Dataset                               | Rows                           | Levels                                    | Licence                                                                     |
| ------------------------------------- | ------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------- |
| CEFR-J Vocabulary Profile 1.5         | 7,798 (6,867 unique headwords) | A1 1,164 · A2 1,411 · B1 2,446 · B2 2,778 | Tono Laboratory, TUFS — research **and commercial** use free, with citation |
| Octanove Vocabulary Profile C1/C2 1.0 | 2,136                          | C1 1,111 · C2 1,025                       | CC BY-SA 4.0                                                                |

Joined and split on `/` variants: **8,845 headwords**, 155 of them multiword. That is a complete
A1–C2 ladder and it is 152 KB gzipped with translations attached — very attractive, right up until
you test it:

```
prefix 'ubi': 0 matches
prefix 'serend': 0 matches
```

Neither `ubiquitous` nor `serendipity` is in it. A CEFR profile is a list of what a learner at each
level is _expected to know_ — it is a syllabus, not a dictionary. The words a motivated learner
types into a vocabulary app skew hard toward the tail this list excludes by construction. **Rejected
as the corpus; adopted as the level annotation.**

### 2.3 An external dictionary API per keystroke — rejected

Datamuse, Free Dictionary API, Yandex Dictionary: a network round trip per keystroke, no Russian in
the free English ones, no CEFR anywhere, no offline story, and a third-party dependency in the
app's most latency-sensitive interaction. A typeahead needs to feel instant; a 150 ms cross-origin
hop does not. Rejected.

### 2.4 The LLM — rejected for suggestion, kept for enrichment

Asking Claude to complete a prefix is slow (hundreds of ms minimum), costs money per keystroke, and
is non-deterministic — the same prefix would produce different suggestions on two devices. It is
also unnecessary: prefix matching over a fixed list is a solved problem. **But the LLM is exactly
right for building the list offline** (§4.3) — it is the same machinery `levels.ts` already runs,
moved from request time to build time.

---

## §3 Building the lexicon (measured)

Three sources, joined once at build time, committed as a generated artifact.

### 3.1 Headwords + Russian translations — WikDict

[WikDict](https://www.wikdict.com/page/download) publishes bilingual SQLite databases derived from
Wiktionary via DBnary, CC BY-SA. `en-ru.sqlite3` is **20 MB**:

```
$ sqlite3 en-ru.sqlite3 "select count(*) from translation;"
126267
$ sqlite3 en-ru.sqlite3 "select count(distinct written_rep) from simple_translation;"
96101
```

`simple_translation` is the table to use: `written_rep` (the English headword), `trans_list`
(pipe-separated Russian, best first), `max_score`, `rel_importance`.

```
abandon | бесшаба́шность | бро́сить | броса́ть | …
run     | бе́гать | бег | бежа́ть | …
```

Coverage against the CEFR list is excellent: **8,204 of 8,647 CEFR headwords (94.9%)** have a
Russian translation. The misses are almost entirely derived forms and contractions —
`acoustically`, `adversely`, `appallingly`, `'m`, `'re` — i.e. `-ly` adverbs Wiktionary treats as
transparent.

### 3.2 Inclusion and ranking — frequency, not WikDict's own score

`rel_importance` looks like a ranking signal and is not one. It is Wiktionary-internal (roughly
translation-count / link-density), and the top 40 by importance is:

```
right, water, work, as, lead, woman, head, bar, fire, you, light, wind, port, man,
love, be, break, time, one, dog, sun, order, bear, set, language, fish, good, take, …
```

`the` ranks **976th**. Use it as a junk filter, never as an ordering.

Real frequency comes from [`wordfreq`](https://pypi.org/project/wordfreq/) (Zipf scale, blended
across subtitles, Wikipedia, news, books, and web):

```
the 7.73 · run 5.49 · beautiful 5.22 · ubiquitous 3.42 · serendipity 2.74 · quokka 1.50
```

Prefer it over the OpenSubtitles-only list (`hermitdave/FrequencyWords`), which is spoken-register
skewed — it ranks `ubiquitous` 42,859th, far too low for a word a B2 learner meets constantly in
writing.

### 3.3 The level — joined where known, `null` where not

The CEFR join covers a minority of a real corpus, and that is fine:

```
zipf>=2.0:  62,902 rows   8,176 leveled (13%)   gzip 1,124 KB
zipf>=2.5:  53,145 rows   7,910 leveled (15%)   gzip   969 KB
zipf>=3.0:  41,760 rows   7,196 leveled (17%)   gzip   772 KB
zipf>=3.5:  30,631 rows   5,905 leveled (19%)   gzip   570 KB
```

**Recommended cut: `zipf >= 2.5` OR present in the CEFR list → 53,536 rows, ~976 KB gzipped.** It
contains `ubiquitous`, `serendipity`, `procrastinate`, `gaslight`, `ephemeral`; it drops `quokka`
and the long tail of proper nouns and Wiktionary artifacts.

Build script (the whole thing):

```python
import sqlite3, re, csv, json
from wordfreq import zipf_frequency

ok = re.compile(r"^[a-z][a-z' \-]{1,30}$")
order = ["A1","A2","B1","B2","C1","C2"]

def clean(tl):                                   # strip wiki markup + stress marks
    out = []
    for t in tl.split('|'):
        t = re.sub(r'\[\[|\]\]|\{\{[^}]*\}\}', '', t).replace('́', '').strip()
        if t and not re.search(r'[<>#=]', t): out.append(t)
    return out[:3]

lv = {}
for fn in ('cefrj-vocabulary-profile-1.5.csv', 'octanove-vocabulary-profile-c1c2-1.0.csv'):
    for r in csv.DictReader(open(fn)):
        for w in r['headword'].split('/'):
            w = w.strip().lower()
            if w and (w not in lv or order.index(r['CEFR']) < order.index(lv[w])):
                lv[w] = r['CEFR']                # lowest (easiest) level wins

con = sqlite3.connect('en-ru.sqlite3')
rows = []
for w, tl, _imp in con.execute(
        "select written_rep, trans_list, rel_importance from simple_translation"):
    w = w.lower()
    if not ok.match(w): continue
    ru = clean(tl)
    if not ru: continue
    z = zipf_frequency(w, 'en')
    if z < 2.5 and w not in lv: continue
    rows.append({"w": w, "z": round(z, 2), "ru": ru, **({"lv": lv[w]} if w in lv else {})})
```

### 3.4 Data-quality traps, all measured

| Trap                                                                      | Scale                          | Fix                                                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combining acute accents (U+0301) marking Russian stress                   | **7,336 of 8,308** joined rows | Strip for the identity/search key. _Keep them for display_ — stress marks are genuinely useful to a learner. Store both, or strip at compare time. |
| Raw wiki markup leaking into `trans_list` (`по [[желание`, `{{...}}`)     | 621 rows                       | The regex above; drop residue containing `<>#=`                                                                                                    |
| Rows with no usable RU after cleaning                                     | 537 (6.1% of the CEFR slice)   | Ship the row with `ru: []` — English + level is still a useful suggestion                                                                          |
| Junk headwords (`"Kozhevatov"`, `#перенаправление another`, `# dispense`) | ~18k of 96k                    | The `^[a-z][a-z' -]{1,30}$` filter plus the zipf floor removes them                                                                                |
| Slash variants in CEFR headwords (`a.m./A.M./am/AM`)                      | 8,647 → 8,845 after splitting  | Split on `/`, keep the lowest level                                                                                                                |

---

## §4 The level column is the weak spot — and it is cheap to fix

At the recommended cut only **~15% of rows carry a CEFR level**. `ubiquitous` — the word most likely
to be typed into a field whose placeholder is `ubiquitous` — has none. Three options, in increasing
order of goodness.

### 4.1 Show nothing when unknown (free)

Render `—` or omit the badge. This is honest and **matches the codebase's existing contract
exactly**: `level: CefrLevel | null`, and `docs/2026-07-16-level-assignment-background-job.md`
already establishes that "unleveled is a real state, forever." Zero new machinery. But 85% of
suggestions would show no level, which does not really deliver the requirement.

### 4.2 Derive the level from frequency — tested, and not good enough to display

Frequency and CEFR level correlate cleanly on the 8,301 rows where both are known:

| Level |     n | mean zipf |  p10 |  p50 |  p90 |
| ----- | ----: | --------: | ---: | ---: | ---: |
| A1    | 1,058 |      4.99 | 4.14 | 4.96 | 5.92 |
| A2    | 1,243 |      4.45 | 3.65 | 4.50 | 5.17 |
| B1    | 2,119 |      4.09 | 3.35 | 4.14 | 4.79 |
| B2    | 2,351 |      3.67 | 2.84 | 3.70 | 4.43 |
| C1    |   788 |      3.26 | 2.55 | 3.29 | 3.97 |
| C2    |   742 |      2.81 | 2.05 | 2.90 | 3.50 |

Monotonic, but the distributions overlap heavily. A threshold classifier fitted on the medians gets
**39% exact, 83% within one level**. That is fine as a _sort_ signal and not good enough to print
"B2" next to a word with authority. **Use it for ranking, never for the badge.**

### 4.3 Level the lexicon offline with the job that already exists — **approved (D2), built (§13)**

`apps/web/src/lib/levels.ts` already assigns CEFR levels to arbitrary text in batches of
`LEVEL_BATCH_SIZE = 25`. Point it at the lexicon build instead of at `words`, run it once, commit
the result. 53,536 rows ÷ 25 ≈ **2,142 requests**.

Cost, using the Message Batches API (50% off list, and this is the textbook batch workload — no
latency requirement, one-off, embarrassingly parallel):

| Model            | Batch input $/MTok | Batch output $/MTok | Est. total |
| ---------------- | -----------------: | ------------------: | ---------: |
| Claude Haiku 4.5 |              $0.50 |               $2.50 |   **≈ $2** |
| Claude Opus 5    |              $2.50 |              $12.50 |  **≈ $10** |

(≈1.5M input tokens at ~700/request including the system prompt, ≈0.54M output at ~250/request.
Prompt caching on the stable system prompt would cut the input side further.)

**Ten dollars, once, turns a 15%-leveled lexicon into a ~100%-leveled one.** That is the answer to
the level requirement. Re-run only when the lexicon is rebuilt. Two notes:

- The CEFR-known 8,301 rows become a **free eval set** — level them too and measure agreement
  against CEFR-J before trusting the other 45k. That is a real quality gate, not a vibe check.
- Keep the human-curated CEFR value where one exists; the LLM value fills gaps, it does not
  overwrite Tono Laboratory.

**The eval was run, and it changed the model choice.** Same deterministic 300-row sample
(`order by md5(key)`), the human grade withheld, scored by `pnpm level:lexicon --eval`:

| model              |   exact | within one | declined |  bias | C1 recall | C2 recall |
| ------------------ | ------: | ---------: | -------: | ----: | --------: | --------: |
| `claude-haiku-4-5` |     39% |        89% |        3 | −0.30 |      9/37 |      5/25 |
| `claude-opus-5`    | **50%** |    **93%** |       28 | +0.23 | **23/35** | **10/20** |

Haiku 4.5 scores **exactly what frequency inference scored** — 39% (§4.2) — and its errors are not
evenly spread: it calls 14 of 25 C2 words C1, and 21 of 85 B1 words A2. It is systematically soft at
both ends, and softness at the hard end is the expensive kind of wrong here, because **the 45,237
unlevelled rows are the dictionary tail and the tail is mostly hard words**. Opus 5 clears the bar
frequency inference set (50% / 93%) and recovers C1–C2 specifically. It costs ~$11 against Haiku's
~$3; on a one-off pass that difference is not worth 11 points of accuracy on the column the whole
feature exists to display.

Two honest caveats on the number:

- **Opus 5 declines ~9% of items** (28 of 300) against Haiku's 1%. That is the prompt's rule 6
  working as intended — proper nouns and fragments should be unlevelled — but it means the pass will
  leave a few thousand rows unlevelled by choice, permanently. `level` stays nullable forever, which
  is exactly the contract this codebase already has.
- **50% exact is agreement with CEFR-J, not correctness.** Human CEFR assignment is itself noisy at
  ±1 level, so 93% within-one is arguably the more meaningful figure. Treat the badge as a strong
  hint, not an authority — §13.

---

## §5 Where the index lives

### 5.1 Prefix fan-out is small — measured on the 53k lexicon

```
prefix 'ubi':     2 matches   → ubiquitous, ubiquity
prefix 'serend':  1 match     → serendipity
prefix 'abs':    54 matches
prefix 'com':   531 matches
prefix 'th':    604 matches
prefix 'a':   3,342 matches
```

Only 1–2 character prefixes fan out badly, and those are the prefixes where suggestions are useless
anyway. **Do not query below 2 characters** (Baymard's autocomplete research and every mainstream
implementation agree), cap at 3 characters for the first query if the list feels noisy, and always
`LIMIT` server-side.

### 5.2 Postgres, with `text_pattern_ops` — not `pg_trgm`

For left-anchored `LIKE 'abc%'`, a B-tree with `text_pattern_ops` is the right index; `pg_trgm` +
GIN exists for the un-anchored `%abc%` case and is strictly more expensive here. Use trigram only if
you later add typo tolerance (§9).

```sql
create table lexicon (
  key         text primary key,          -- lower, unaccented, ASCII-folded — the search key
  text        text not null,             -- display spelling
  level       text,                      -- CEFR or null; "unleveled" is a real state
  level_source text,                     -- 'cefrj' | 'octanove' | 'job'
  zipf        real not null,             -- ranking
  ru          text[] not null default '{}'
);
create index lexicon_prefix_idx on lexicon (key text_pattern_ops);
create index lexicon_zipf_idx   on lexicon (zipf desc);
```

Note it is **not owner-scoped** — this is shared reference data, the first table in the schema that
is. It gets a read-only RLS policy rather than the owner-id policy every other table has, and that
exception should be stated in `supabase/README.md` rather than left to be inferred.

The query, in a `suggest_words` RPC alongside `resolve_words`:

```sql
select text, level, ru
  from lexicon
 where key like $1 || '%'
 order by zipf desc
 limit 8;
```

Ranking by `zipf desc` alone puts the right answer first in every prefix tested above (`come` for
`com`, `the` for `th`, `absolutely` for `abs`). An exact-match boost is worth adding so that typing
`run` in full keeps `run` above `running`.

**Both indexes earn their keep, and which one runs depends on the prefix** — measured against the
loaded table (§12). A rare prefix range-scans `lexicon_prefix_idx`; a common one walks
`lexicon_zipf_idx` in `zipf desc` order and stops after eight hits, which is cheaper than scanning
3,340 candidates and sorting them. Dropping either makes the other case worse — tested, and
`lexicon_zipf_idx` is not the redundant one it looks like.

**But the planner only gets this right once the table has statistics,** and that is the one real
trap phase 0 turned up. Straight after the bulk load, with no `ANALYZE`, Postgres costs
`key like 'ubi%'` as if it matched a fifth of the table, walks the zipf index, and discards 53,536
rows per query: **30 ms and 46,159 buffers, against 0.07 ms and 3 buffers once analyzed.**
Autovacuum closes the gap on its own schedule, and the window in between is exactly when someone
benchmarks the new route and concludes the design is slow. `load-lexicon.ts` therefore runs
`analyze lexicon` after committing.

### 5.3 Server route, not a bundled asset — **approved (D1)**

`expo-sqlite` is already a dependency, so bundling the lexicon into the app as a SQLite asset is
genuinely available: zero latency, zero network, works offline. It is the right call for an app with
no backend. **It is the wrong call here**, for one reason that outweighs the rest:

**The backend is staying, and a bundled lexicon ties dictionary updates to App Store releases.**
`apps/mobile` has no `expo-updates` in its dependencies, so there is no OTA channel — a fixed
translation, a corrected level, or a re-run of the LLM level pass (§4.3) would ship only in the next
binary, and only to learners who update. A `lexicon` table behind a route is one `pnpm db:migrate`
away from being current for everyone, on the same infrastructure that already serves every other
screen. The asymmetry is not close.

The secondary reasons all point the same way:

- **`owned` needs the server anyway** (§6). It is a join against the learner's `words` rows on
  `norm_key`, and `norm_key` needs Postgres (unaccent + NFKC) — `CLAUDE.md` is explicit that text →
  word identity never goes through a client-side guess. A local-only dropdown would have to fall
  back to `clientDedupeKey`, which is deliberately weaker.
- **The corpus is ~1 MB gzipped** (53,536 rows; the CEFR-only slice is 8,845 rows / 152 KB but is
  the one that misses `ubiquitous`). Fine as a binary asset, not free either — and it buys nothing
  the route does not already give.
- **Latency is not the constraint.** Every other interaction on this screen is already a round trip:
  the filter chips, the sort, the favorite toggle. A debounced 8-row query is the cheapest of them.

**Offline is the one thing given up**, and it costs nothing today: adding a word is already
online-only. If offline suggestions are wanted later, the additive move is to cache
a top-N slice locally (zipf ≥ 4.0 is ~10k rows) and fall back to the route for the tail — a
refinement of this design, not a replacement for it.

---

## §6 The wire contract

Following the rule in `CLAUDE.md` — the HTTP contract is declared in `packages/shared/src/api.ts`,
and routes assign their body to the declared type:

```ts
// packages/shared/src/api.ts
export const API_V2_ROUTES = {
  …,
  /** Prefix suggestions for the add-word field. Shared reference data, not owner-scoped. */
  suggest: `${API_V2}/lexicon/suggest`,
} as const;

export function suggestPath(prefix: string, limit = 8): string {
  return `${API_V2_ROUTES.suggest}?q=${encodeURIComponent(prefix)}&limit=${limit}`;
}

/** One dropdown row. */
export interface WordSuggestion {
  /** The spelling that goes into the input on select. */
  text: string;
  /** CEFR level, or null — "unleveled" is a real state here exactly as it is on `words`. */
  level: CefrLevel | null;
  /** Up to three Russian glosses, best first. May be empty (6.1% of rows). */
  ru: string[];
  /** True when this word is already in the learner's collection. */
  owned: boolean;
}

export interface SuggestResponse { suggestions: WordSuggestion[] }
export function isSuggestResponse(body: unknown): body is SuggestResponse { … }
```

It goes under `API_V2` — the native namespace, which is now the only namespace that matters — and
through `withBearer` like every other v2 route, so `ownerId` is derived from the token rather than
trusted from the request.

`owned` is the one field that makes the route owner-aware: it is a left join against `words` on
`norm_key`, and it is what lets the dropdown say _"already in your collection"_ before the learner
submits and gets `already-present` as a surprise (§8). Note it is computed **server-side on
purpose** — the screen does hold the whole collection in `data.items` and could match locally, but
only through `clientDedupeKey`, which `CLAUDE.md` documents as deliberately weaker than `norm_key`
(it may merge less, never more). For a badge that is an acceptable failure mode; doing it on the
server just makes it correct for free, since the query is already there.

**One contract decision phase 0 surfaced and did not settle: does `WordSuggestion.level` include
A1?** `CEFR_LEVELS` in `packages/shared/src/word-types.ts` is `A2–C2`; the `cefr_level` Postgres enum
is `A1–C2`, with 0004 explaining the split — _"A1 is headroom; the UI offers A2–C2"_, because the
level job never assigns A1 to a word a learner bothered to add. A dictionary is the other case:
CEFR-J grades **1,058 lexicon rows A1**, and the ask was explicitly "A1 – C2". They are loaded, so
the data is there either way. What phase 2 has to choose is whether `CefrLevel` widens to A1 (which
also widens the `/lesson-items` filter grammar and its 10,752-case exhaustive check) or whether the
suggestion contract gets its own wider level type. **Widening the shared type is the wrong default**
— the filter's vocabulary is "levels a learner's own word can have", which is genuinely A2–C2, and
they are two different questions that happen to share an enum.

Two things deliberately **not** in the contract:

- **No fuzzy/typo parameter.** See §9 — add it when there is evidence it is needed, with a measured
  threshold, not speculatively.
- **No `ItemsQuery`-style grammar.** This is one string and a limit. Do not grow a second query
  language next to `items-query.ts`.

---

## §7 The UI — hand-rolled, and the hazards are all React Native's

There is no dropdown primitive in `apps/mobile/src/ui/` and no Base UI on this side of the
workspace, so this is built from parts the kit already has: `TextField` for the input, `Panel` for
the popup surface, `Chip` for the level badge, `Muted` for the translations, and the `space` /
`radius` / `type` tokens. An absolutely-positioned `View` under the field wrapping a `FlatList`.

**A new `Autocomplete` component in `@/ui` is the right home for it**, not 150 inline lines in an
already-long screen file. `apps/mobile/src/app/lesson-items/index.tsx` is the biggest screen in the
app and its own header comment flags it as the one to watch on small devices.

### 7.1 The five things that will bite

1. **`keyboardShouldPersistTaps="handled"` on the list.** Without it the first tap only dismisses
   the keyboard and the learner has to tap twice. This reads as a broken dropdown and is the single
   most common RN autocomplete bug.
2. **`autoCorrect={false}` and `autoCapitalize="none"` on the field.** iOS autocorrect will
   silently rewrite a word the learner deliberately typed — which is _precisely_ the failure this
   feature exists to prevent. Shipping the dropdown without this makes the problem worse, not
   better. (`AddWordForm` does not currently set either; the search field beside it already sets
   `autoCorrect={false}`.)
3. **The keyboard covers the dropdown.** The field sits inside a scrolling screen with the filter
   chips and the item list below it. Cap the popup height (8 rows ≈ 320 dp) and scroll the field
   toward the top of the viewport on focus, or the suggestions render behind the keyboard.
4. **Nested scrolling.** A `FlatList` inside the screen's scroll view is the classic RN gesture
   conflict. At `limit=8` the list should not need to scroll at all — which is the main practical
   reason to keep the cap at 8 (§7.2).
5. **Stale responses.** Debounce ~150 ms and carry a request sequence number, dropping any response
   whose sequence is older than the newest issued. An out-of-order response repopulating the list
   after the learner has typed another character is the classic typeahead race, and it is more
   visible on a phone where the network is slower and less even.

### 7.2 Row shape

```
ubiquitous          C1     повсеместный, вездесущий
ubiquity            C2     повсеместность
```

Cap at **8 rows**. Baymard's autocomplete research puts the limit at "fewer than 10" and warns
against making the suggestion list itself scroll — with 8 rows the list fits on a phone without an
inner scroll region, which also sidesteps hazard 4 above. Truncate `ru` to two glosses at phone
width; the full set belongs on the word detail page (`/lesson-items/[id]`), which already renders
`WordDetails.translations_ru`.

Accessibility is not free here the way it was going to be on web, where `Autocomplete.Status` was a
component. The RN equivalents are `accessibilityRole="menuitem"` on the rows, an
`accessibilityLiveRegion="polite"` count announcement on the popup, and an `accessibilityLabel` on
each row that reads the word, its level, and its translations as one string rather than three
fragments.

---

## §8 What happens on select

Selecting a suggestion should **fill the input, not submit**. The learner may want to edit it, and a
dropdown that submits on tap makes a mis-tap unrecoverable — and on a phone, mis-taps are the
common case. This also keeps the write path completely unchanged: `addWord` →
`POST /api/v2/lesson-items` still receives a plain string, and the server never learns whether the
learner picked a suggestion or typed it out.

Two opportunities the `owned` flag opens up:

1. **Kill the `already-present` surprise.** Today the learner types a duplicate, submits, and is
   told the word is already in the collection. With `owned` the dropdown can mark the row
   _"in your collection"_ and the learner never hits that path. Keep the `already-present` result —
   it is still reachable by typing a duplicate directly — but it stops being the common case.
2. **Seed the enrichment, carefully.** The lexicon has an RU translation and a level for the word
   the learner just added, and the two background jobs are about to go compute both. It is tempting
   to write the lexicon values straight into `words.level` / `words.details`.
   **Do not — at least not on the details side.** `CLAUDE.md` states plainly that `words.details` is
   written only by the enrichment job and `words.level` only by the level job, and there is a real
   consistency reason beyond convention: the lexicon's `ru` is three Wiktionary glosses, while
   `WordDetails` is a structured payload with part of speech, word-family forms, and examples.
   Writing the former into the latter's slot produces a half-populated `details` that `details_at`
   then marks as attempted, and the enrichment job never revisits it. If seeding is wanted, `level`
   is the defensible one — it is a single enum with a `level_source` column that already
   distinguishes `'job'` from `'user'`, so `'lexicon'` is a third honest value. Even then, prefer
   letting `scheduleWordJobs` do its work; it is already wired on both write paths.

---

## §9 Deliberately deferred

- **Typo tolerance.** "I can tell if I typed the word correctly" is served by _showing the RU
  translation_, which is the actual ask. Fuzzy matching is a different feature (recovering from a
  misspelling) and it is not free: `pg_trgm` + GIN, a similarity threshold to tune, and a real risk
  of burying the exact prefix match under noise. It also belongs server-side rather than in the
  app, since that is where the corpus is. Ship prefix first, measure, then decide.
- **Phrases and sentences.** The collection holds `word` / `phrase` / `sentence`
  (`lesson_item_kind`), and the lexicon covers 155 multiword entries out of 53k. Suggestions will
  effectively only fire for single words. That is correct — nobody wants a dropdown while typing a
  sentence — but the dropdown should quietly stop querying once the input contains a space rather
  than showing an empty popup.
- **Personalization.** Ranking by the learner's own level (surface B1 words to a B1 learner) is a
  real idea and needs a learner-level concept the app does not have.

---

## §10 Licensing — this is a redistribution, and both licences are share-alike

Shipping the lexicon means redistributing derived data, so the obligations are real:

| Source                            | Licence                                                          | Obligation                                          |
| --------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| WikDict / DBnary / Wiktionary     | **CC BY-SA**                                                     | Attribute; the derived lexicon must be shared alike |
| CEFR-J Vocabulary Profile 1.5     | Tono Laboratory, TUFS — free for research **and commercial** use | Cite properly                                       |
| Octanove Vocabulary Profile C1/C2 | **CC BY-SA 4.0**                                                 | Attribute; share alike                              |
| `wordfreq`                        | CC BY-SA (data), MIT (code)                                      | Attribute                                           |

Two consequences worth stating rather than discovering later:

1. **Share-alike propagates to the generated artifact,** not to the application code. The lexicon
   file is the derived database; keep it in its own directory with a `LICENSE` and an
   `ATTRIBUTION.md` naming all four sources, and the app itself is unaffected. This is the standard
   arrangement for Wiktionary-derived dictionaries.
2. **An in-app attribution line is required**, not optional — a small "Dictionary data from
   Wiktionary (CC BY-SA), CEFR levels from CEFR-J and Octanove" line near the dropdown or on an
   About screen. `apps/mobile/src/ui/LegalLinks.tsx` already exists and is where this belongs.

If share-alike on the artifact is unacceptable for any reason, the fallback is to generate the whole
lexicon with the LLM instead (§4.3 already costs ~$10 for the level pass; translations would be a
larger job) — but that trades a licence obligation for a quality regression, and Wiktionary's
Russian is good.

---

## §11 Phasing

| Phase | Where                          | Deliverable                                                                                                                                                                      | Effort                             |
| ----- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 0 ✅  | `apps/web` + `supabase`        | **Done** — see §12.                                                                                                                                                              | Built and loaded 2026-08-15        |
| 1     | `apps/web`                     | LLM level pass over the lexicon via the Batches API, gated on agreement against the 8,301 known-CEFR rows. `pnpm level:lexicon` / `:plan`, matching the existing job convention. | ~$10 and one afternoon             |
| 2     | `packages/shared` + `apps/web` | `WordSuggestion` / `SuggestResponse` in `api.ts`, `suggest_words` RPC, `GET /api/v2/lexicon/suggest`                                                                             | Small                              |
| 3     | `apps/mobile`                  | `Autocomplete` in `@/ui`, wired into `AddWordForm`. Debounce, stale-response guard, `owned` badge, the five hazards in §7.1.                                                     | Medium — the only real client work |
| 4     | _Optional_                     | Cached top-10k slice locally → instant first keystroke + offline                                                                                                                 | Medium                             |

Phases 0–3 deliver the whole ask and are all approved (D1, D2); phases 0 and 1 are built, so the
level badge now appears on 86.5% of rows instead of 15.5%. Phase 4 is
explicitly **not** approved — it is recorded as the additive move if offline suggestions are ever
wanted, not as planned work. Nothing here touches the web UI.

**The gate between phases 1 and 2** was the eval: level the 8,301 rows CEFR-J already knows and
measure agreement before trusting the model on the other 45k. **It ran, it passed on Opus 5 and
failed on Haiku 4.5**, and the model choice changed because of it — §4.3.

---

## §12 Phase 0, as built (2026-08-15)

| Artifact      | Where                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------- |
| The build     | `apps/web/scripts/lexicon/build_lexicon.py` + `requirements.txt` + `README.md`           |
| The data      | `apps/web/scripts/lexicon/data/lexicon.jsonl.gz` (1.1 MB) + `ATTRIBUTION.md` + `LICENSE` |
| The schema    | `supabase/migrations/0010_lexicon.sql` — applied                                         |
| The loader    | `apps/web/scripts/lexicon/load-lexicon.ts` — `pnpm lexicon:load` / `:plan`               |
| The exception | The non-owner-scoped table is written up in `supabase/README.md` (D3)                    |

```
  CEFR: 8843 headwords (1825 from Octanove)
  read 96101 · dropped 1536 junk headwords, 8 with no usable RU, 40198 below zipf 2.5 · 743 fold collisions
✅ 53616 rows → data/lexicon.jsonl.gz (1101 KB gzipped)
   8301 carry a CEFR level (15%) · 0 have no RU gloss
```

The level spread reproduces §4.2 exactly — A1 1,058 · A2 1,243 · B1 2,119 · B2 2,350 · C1 788 ·
C2 743 · **unlevelled 45,315**, which is what phase 1 exists to fix. And **8,301 rows carry a
human CEFR level**, so the eval set the gate depends on is real and in place.

### The six probes, against the live table

| prefix   | matches | plan                 |    time | top two                         |
| -------- | ------: | -------------------- | ------: | ------------------------------- |
| `ubi`    |       2 | `lexicon_prefix_idx` | 0.14 ms | ubiquitous · ubiquity           |
| `serend` |       1 | `lexicon_prefix_idx` | 0.05 ms | serendipity                     |
| `abs`    |      54 | `lexicon_prefix_idx` | 0.10 ms | absolutely (B1) · Absolute (B1) |
| `com`    |     530 | `lexicon_zipf_idx`   | 0.95 ms | come (A1) · come in             |
| `th`     |     603 | `lexicon_zipf_idx`   | 0.14 ms | the (A1) · that (A1)            |
| `a`      |   3,340 | `lexicon_zipf_idx`   | 0.07 ms | and (A1) · a-                   |

Counts land within one or two of the pre-build estimates in §5.1; ranking puts the intended word
first in every case. The table is **11 MB with both indexes after a fresh load**, confirming the
~10 MB estimate. It sits at 23 MB here after three test reloads — every reload rewrites all 53k
rows, and `VACUUM` marks the old versions reusable without returning the file to the OS. That is
free space the next reload consumes, not growth; it needs no attention.

### Four things the build settled that the design had only sketched

1. **The search key is `lesson_item_norm_key(text)`, computed by a trigger.** The doc's schema had
   `key` as a plain column the build script would fill. It cannot be: `owned` is a left join between
   `lexicon.key` and `words.norm_key`, and that join is exact only if **one** function produces both
   sides. `CLAUDE.md`'s rule that text → word identity never goes through a client-side guess
   applies just as well to a build-script guess. The Python `fold()` survives only to dedupe the
   artifact and join the CEFR lists, and nothing it computes is stored. Verified: 59 of the 77 words
   already in the collection resolve to a lexicon row, and the 18 that do not are phrases
   (`despite / in spite of`), plurals (`concessions`, `appeals` — the lemmatization gap the Sources
   note flags), and test junk (`zzz-offline-sync-test`). None are normalization failures.
2. **The loader stages, then dedupes in SQL.** Two artifact rows can fold to one key, and a
   multi-row `INSERT … ON CONFLICT` whose own rows collide on the arbiter raises "cannot affect row
   a second time" — the trap `resolve_words` documents in 0007. A temp table plus `DISTINCT ON (key)
… ORDER BY key, zipf DESC` lets Postgres resolve the collision with its own key function. This is
   where 78 of the 53,616 rows merge.
3. **A rebuild must not discard phase 1's work,** which the sketch had no answer for. The upsert
   takes an incoming level only when a human CEFR list vouched for the word and otherwise keeps what
   is there, so `level_source = 'job'` survives a full reload. Tested end to end: seeded
   `ubiquitous → C1/job`, reloaded all 53,616 rows, and it is still `C1/job` while `absolutely`
   is still `B1/cefrj`.
4. **`ANALYZE` is part of the load, not hygiene** — see §5.2 for the 30 ms → 0.07 ms measurement.

The loader is idempotent: a second run reports `53538 → 53538 rows, 0 pruned`.

### Known, accepted, not fixed

- **1,058 A1 rows have nowhere to go in the TS contract yet** — the phase 2 decision written up
  in §6.
- **No lemmatization.** `concessions` is absent while `concession` is present, so a learner typing a
  plural gets no suggestions. Wiktionary indexes lemmas; that is the corpus's shape, not a bug in
  the join. `Maximax67/Words-CEFR-Dataset` in Sources is the lead if it turns out to matter.
- **743 fold collisions produced a handful of odd levels.** `Aš` (a Czech town) folds to `as`, which
  CEFR-J grades A1, so it shows as A1. Cosmetic, bounded, and phase 1's pass will overwrite nothing
  — a CEFR-sourced level is protected by design. Left alone deliberately.
- **Single-letter headwords are excluded** by the `^[a-z][a-z' -]{1,30}$` filter, so `a` and `I` are
  not in the corpus. Harmless: the client does not query below two characters.

---

## §13 Phase 1, as run (2026-08-15)

| Artifact      | Where                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The flag      | `supabase/migrations/0011_lexicon_level_at.sql` — `level_at` + partial queue index. Applied.                           |
| The prompt    | `apps/web/src/lib/lexicon-levels-prompt.ts` — a sibling of `levels-prompt.ts`, not a reuse                             |
| The job       | `apps/web/src/lib/lexicon-levels.ts` — submit / poll / collect / write / score                                         |
| The DB handle | `apps/web/src/lib/lexicon-db.ts` — `load-lexicon.ts` was refactored onto it                                            |
| The CLI       | `apps/web/scripts/level-lexicon.ts` — `pnpm level:lexicon` / `:plan` / `--eval` / `--status` / `--collect` / `--force` |

```
  queue: 45237 row(s) → 1810 request(s) of 25
  model: claude-opus-5
  ≈1.73M input + 0.54M output tokens ≈ $11.12 at batch rates (estimate)
  ended  ok=1810 err=0 running=0  (3m)
  collected: 38011 levelled, 7226 declined, 0 request(s) failed

  lexicon now: A1 1448 · A2 2772 · B1 5483 · B2 10672 · C1 15535 · C2 10402 · unlevelled 7226
```

**46,312 of 53,538 rows carry a level — 86.5%, up from 15.5%.** All 1,810 requests succeeded, in
three minutes, for about $11. `ubiquitous`, the word this whole document started from, is C1. The
8,301 human-graded rows are byte-for-byte unchanged, and the queue is empty, so a re-run is a no-op.

### Three things worth knowing about the result

**1. The model declined 7,226 rows (16%), and it declined the right ones.** Sorted by frequency, the
refusals are `have not`, `not but`, `were-`, `in-and-out`, `I do`, `of the time`, `who is a`,
`of that time`, `which from`, `to even` — Wiktionary fragments that are not vocabulary anyone
studies. That is rule 6 of the prompt working exactly as written, and it is a better outcome than a
confident level on a phrase that should not be in a study list. Those rows are unlevelled
**permanently**: `level_at` is stamped, so they are never re-asked and never re-billed.

**2. The model is internally consistent; the human/model seam is where levels disagree.** Measured
over the 412 singular/plural pairs where both members are levelled single words:

| pair          |   n | mean gap |
| ------------- | --: | -------: |
| model → model | 120 | **0.12** |
| human → model | 237 | **1.39** |

**3. …and that seam is a data artifact, not a model error.** The extreme cases look alarming —
`arm` [A1, CEFR-J] beside `arms` [C2, model] — until you read the gloss WikDict attached to the
plural entry:

| row        | gloss            | verdict                                                       |
| ---------- | ---------------- | ------------------------------------------------------------- |
| `arms`     | герб             | heraldic coat of arms — C2 is right                           |
| `taxis`    | таксис           | the biological term, **not** a plural of `taxi` — C2 is right |
| `mores`    | моральный кодекс | social mores — C2 is right                                    |
| `articles` | практика         | articles of clerkship — C2 is right                           |
| `points`   | стрелка          | railway points — specialist, C2 is defensible                 |

The model levelled the sense the Russian gloss named, which is precisely what it was told to do.
CEFR-J levelled the base lemma's everyday sense. Both are correct about different words that happen
to share a spelling, and Wiktionary is the one that filed them under one headword.

**This is a phase 3 display problem, and the design already solves it.** A learner typing `arm`
would otherwise see `arms [C2]` and conclude the badge is broken — but the dropdown shows the gloss
on the same row, so they see `arms — герб [C2]` and it reads as informative rather than wrong. This
is the requirement _"I want to see the Russian translation so I know if I typed the right word"_
paying for itself in a way nobody anticipated: the gloss is not only spelling confirmation, it is
what makes a surprising level legible.

### Design notes

- **This job does not go through LangChain,** which `CLAUDE.md` otherwise requires. LangChain has no
  Message Batches binding, and the 50% batch discount is half the cost D2 was approved on. The trade
  is LangSmith auto-tracing, which buys little for a one-off offline pass that measures its own
  accuracy against a human-graded eval set. Stated at the top of `lexicon-levels.ts`.
- **Every submission writes a manifest** (`scripts/lexicon/.batches/<id>.json`, gitignored): the
  batch id plus, per request, the keys it asked about **in order**. Not a cache — results come back
  keyed by `custom_id` and by index within the request, and nothing in the response says which word
  index 7 of request 412 was. It is also what lets `--collect` finish a run whose terminal was
  closed, and what makes `custom_id` an ordinal rather than the headword (the id must match
  `^[a-zA-Z0-9_-]{1,64}$`, and these keys contain apostrophes, spaces and hyphens).
- **`--force` clears only `level_source = 'job'`.** Tono Laboratory's 8,301 values are never
  re-asked and never overwritten — the queue predicate is `level is null and level_at is null`.
- **No extended thinking.** Per item this is recall, not reasoning, and adaptive thinking across
  1,810 requests would multiply the output bill D2 was approved on.

---

## Sources

- [openlanguageprofiles/olp-en-cefrj](https://github.com/openlanguageprofiles/olp-en-cefrj) — CEFR-J Vocabulary Profile 1.5 and Octanove Vocabulary Profile C1/C2
- [WikDict downloads](https://download.wikdict.com/dictionaries/) and [about](https://www.wikdict.com/page/about) — en-ru SQLite, CC BY-SA, via DBnary
- [kaikki.org raw data](https://kaikki.org/dictionary/rawdata.html) — the fuller wiktextract dump (2.6 GB gz), if WikDict's coverage proves insufficient
- [wordfreq](https://pypi.org/project/wordfreq/) — Zipf frequencies
- [EFLLex](https://github.com/GliteTech/research-ace-cefr/blob/main/tasks/t0010_download_efllex_lexicon/assets/dataset/efllex-2018/description.md) — 15,280 CEFR-graded lemmas, A1–C1, **CC BY-NC-SA** (non-commercial — noted and rejected on licence grounds)
- [Maximax67/Words-CEFR-Dataset](https://github.com/Maximax67/Words-CEFR-Dataset) — CEFR-J plus lemmas/stems/POS and n-gram frequency, if the join above needs lemmatization
- [Baymard: autocomplete design patterns](https://baymard.com/blog/autocomplete-design) — the <10-suggestions and no-inner-scroll guidance
- [PostgreSQL `pg_trgm`](https://www.postgresql.org/docs/current/pgtrgm.html) — for §9's deferred typo tolerance; note that left-anchored `LIKE 'abc%'` wants `text_pattern_ops` instead, per §5.2
