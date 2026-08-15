# The suggestion lexicon

The corpus behind the add-word autocomplete on mobile — 53,616 English headwords with Russian
glosses, CEFR levels where a human list knows one, and a Zipf frequency for ranking.

Phase 0 of [`docs/2026-08-15-word-autocomplete-suggestions.md`](../../../../docs/2026-08-15-word-autocomplete-suggestions.md).

```
sources/ (21 MB, not committed)          →  build_lexicon.py  →  data/lexicon.jsonl.gz (1.1 MB, committed)
                                                                          │  pnpm lexicon:load
                                                                          ▼
                                                                 Postgres `lexicon` (0010)
```

## Why this exists at all

The obvious design — suggest from an open CEFR word list — fails on one measurement: **`ubiquitous`,
the placeholder in the app's own add-word field, is in no open CEFR-graded list.** A CEFR profile is
a syllabus of ~8,800 words; a learner using a vocabulary app types precisely the tail a syllabus
excludes. So the level has to be an _annotation on_ a bigger corpus rather than the thing that
defines it, and the corpus has to come from a dictionary. Hence three sources joined at build time.

## Rebuilding the artifact

Only needed when a source is updated or the filters change. The committed artifact is what ships;
you do not need any of this to run the app.

```bash
cd apps/web/scripts/lexicon
mkdir -p sources && cd sources
curl -O https://download.wikdict.com/dictionaries/sqlite/2/en-ru.sqlite3            # 20 MB
BASE=https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master
curl -O $BASE/cefrj-vocabulary-profile-1.5.csv
curl -O $BASE/octanove-vocabulary-profile-c1c2-1.0.csv
cd ..

python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
./.venv/bin/python build_lexicon.py
```

`sources/` and `.venv/` are gitignored. Expect:

```
  CEFR: 8843 headwords (1825 from Octanove)
  read 96101 · dropped 1536 junk headwords, 8 with no usable RU, 40198 below zipf 2.5 · 743 fold collisions
✅ 53616 rows → data/lexicon.jsonl.gz (1101 KB gzipped)
   8301 carry a CEFR level (15%) · 0 have no RU gloss
```

**Python, in a TypeScript repo, on purpose.** `wordfreq` is the frequency source and it is
Python-only — the alternatives were measured and rejected (WikDict's own `rel_importance` ranks
`the` 976th; the OpenSubtitles list ranks `ubiquitous` 42,859th). This script is offline and
one-off, reads three files and writes one, and touches nothing the app owns. Everything that talks
to our own infrastructure stays TypeScript.

## Loading it

```bash
pnpm db:migrate          # 0010_lexicon.sql — the table, the key trigger, the prefix index
pnpm lexicon:load:plan   # parse + validate the artifact, print the level spread, touch nothing
pnpm lexicon:load        # converge the table on the artifact
```

Idempotent — a second run reports zero changes. It needs `SUPABASE_DB_URL`, the same connection
string `pnpm db:migrate` uses.

Two things the loader does that a plain upsert would get wrong:

- **The search key is computed by Postgres, never by Python.** `lexicon.key` is
  `lesson_item_norm_key(text)` by trigger — the same function `words.norm_key` uses — because the
  `owned` flag on a suggestion is a left join between the two, and it is exact only if one function
  produces both sides. The build script's `fold()` is an approximation used to dedupe the artifact
  and to join the CEFR lists; it is never written anywhere.
- **A reload does not discard the level job's work.** Phase 1 writes `level_source = 'job'` straight
  into this table. The upsert takes an incoming level only when there is one (i.e. a human CEFR list
  vouched for that word) and otherwise keeps what is already there.

## Levelling it (phase 1)

Only ~15% of the corpus carries a CEFR level, because that is all the open lists cover. One offline
pass over the Message Batches API fills the rest.

```bash
pnpm level:lexicon:plan                        # the queue + a cost estimate, ZERO API calls
pnpm level:lexicon --eval --model=claude-opus-5   # THE GATE — score against 300 human-graded rows
pnpm level:lexicon --model=claude-opus-5       # submit, wait, write
pnpm level:lexicon --status                    # where are my batches
pnpm level:lexicon --collect                   # write results from a batch submitted earlier
```

**Run `--eval` before the real pass, and run it on more than one model.** It takes rows CEFR-J
already graded, withholds that grade from the model, and reports agreement. Measured on the same
deterministic 300-row sample:

| model              |   exact | within one | declined |           bias | C2 recall |
| ------------------ | ------: | ---------: | -------: | -------------: | --------: |
| `claude-haiku-4-5` |     39% |        89% |        3 | −0.30 (easier) |      5/25 |
| `claude-opus-5`    | **50%** |    **93%** |       28 | +0.23 (harder) | **10/20** |

Haiku matches frequency inference exactly (39%, §4.2 of the doc) and collapses at the hard end,
which is the wrong end to be wrong at — the 45k unlevelled rows are the dictionary tail, and the
dictionary tail is mostly hard words. Opus 5 costs ~4× more and is the right call here; ~$11 once.

Two things the job will not do:

- **It never overwrites a human CEFR value.** The queue is `level is null and level_at is null`, so
  the 8,301 rows from CEFR-J and Octanove are not even asked about. `--force` re-levels only rows
  with `level_source = 'job'`.
- **It never asks twice about a word it could not level.** `level_at` is the ATTEMPTED flag (0011):
  stamped whether or not an answer came back, so a proper noun the model declines costs one request
  ever, not one per run.

## Verifying

The probe prefixes from the doc's §5.1, against the built artifact:

| prefix   | matches | top by zipf           |
| -------- | ------: | --------------------- |
| `ubi`    |       2 | ubiquitous · ubiquity |
| `serend` |       1 | serendipity           |
| `abs`    |      54 | absolutely (B1)       |
| `com`    |     531 | come (A1)             |
| `th`     |     604 | the (A1)              |
| `a`      |   3,347 | and (A1)              |

Only 1–2 character prefixes fan out at all, and those are the prefixes where suggestions are
useless anyway — the client does not query below 2 characters and the server always `LIMIT`s.

## Licensing

The artifact in `data/` is **derived data under CC BY-SA 4.0** — see
[`data/ATTRIBUTION.md`](data/ATTRIBUTION.md) and [`data/LICENSE`](data/LICENSE). Share-alike
attaches to that file, not to the application code around it. An in-app attribution line is
required, not optional; `apps/mobile/src/ui/LegalLinks.tsx` is where it belongs (phase 3).
