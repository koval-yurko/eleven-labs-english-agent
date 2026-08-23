# `packages/shared/src` — structure options, and a docs folder for the package

**Status:** **approved 2026-08-22** — Option A (domain folders), the full package docs set, and
narrative prose moving out of the code into those docs. Nothing has been moved yet; §7 is the
migration plan and §8 records what was decided. The four options are kept below as the record of
what was weighed, not as an open question.

> **Approved:** D1 Option A · D2 strip prefixes · D3 fake to `testing/` · D4 ESLint layering zones ·
> D5 delete the barrel · D6 full docs set · **D7 open** — see §6.4.

---

## 1. What is there today

Fourteen modules, flat, 2 971 lines. No README, no per-package docs, no subfolders.

| module | lines | imported from apps | what it is |
| --- | ---: | ---: | --- |
| `api.ts` | 774 | 33 | the HTTP contract: paths, response bodies, error envelope |
| `tutor-transport.ts` | 349 | 11 | the provider-agnostic voice-transport interface |
| `tutor.ts` | 296 | 16 | transcript shapes, kickoff/resume messages, session constants |
| `sync-ops.ts` | 260 | 15 | the offline outbox op algebra and its limits |
| `items-query.ts` | 175 | 6 | the `/lesson-items` filter/sort URL grammar |
| `tutor-pause.ts` | 168 | 1 | the held pause as pure decisions + three effect functions |
| `item-list.ts` | 165 | 3 | in-memory search, facet grouping, sort labels |
| `word-types.ts` | 149 | 17 | CEFR vocabularies, `WordDetails`, `ItemRow`, `ItemDetail` |
| `theme.ts` | 144 | 26 | the colour tokens, one table for both clients |
| `word-key.ts` | 137 | 4 | the three normalizations of "a typed string → a word" |
| `tutor-transport-fake.ts` | 130 | **0** | a recording no-op transport, used only by `check.ts` |
| `mirror-store.ts` | 111 | 9 | the device-database contract, stated without naming one |
| `lesson-types.ts` | 88 | 8 | `Lesson`, `LessonDetail`, `LessonSession` |
| `index.ts` | 25 | **0** | a barrel re-exporting twelve of the above |

Plus `check.ts` (29 KB) at the package root — the property-check harness, run by `pnpm check:shared`,
deliberately outside `src/` so it can be a Node script without punching a hole in the purity rule.

### The dependency graph is already a clean layering

Nothing in this package imports anything that imports it back. Grouped by depth:

```
layer 0 — import nothing
    theme.ts        word-types.ts        word-key.ts

layer 1
    tutor.ts         → word-types
    items-query.ts   → word-types
    sync-ops.ts      → word-key

layer 2
    lesson-types.ts    → tutor
    tutor-transport.ts → tutor
    mirror-store.ts    → sync-ops, tutor
    item-list.ts       → word-types, items-query, word-key

layer 3
    tutor-pause.ts          → tutor, tutor-transport
    tutor-transport-fake.ts → tutor-transport

layer 4
    api.ts → items-query, lesson-types, tutor, tutor-transport, word-types
```

This is worth saying plainly because it changes what the problem is. The package is **not**
tangled. Every option below is about making an existing order legible, not about untangling one.

### More than half of this package is prose

Measured across `src/**`: **1 618 of 2 971 lines are comments — 54%.** But those split into two
kinds that must not be treated alike:

| | lines | share | what it is |
| --- | ---: | ---: | --- |
| module headers | 292 | 10% | the narrative block at the top of each file: why the module exists, what drift it prevents, which alternative was rejected |
| attached TSDoc | 1 326 | 45% | `/** … */` bound to an exported symbol or an interface field |
| code | 1 353 | 46% | |

All counts here come from one snapshot taken 2026-08-22 with `api.ts` and `tutor-transport.ts`
under concurrent edit on `master`; they will drift by a few lines and are meant as proportions,
not as figures to reconcile exactly.

Per-file the concentration is uneven and worth knowing before editing any of them:
`tutor-transport.ts` is 78% comment, `word-key.ts` 65%, `api.ts` 59% (459 comment lines), against
`tutor-transport-fake.ts` at 30%. The headers alone range from 4 lines (`tutor.ts`) to 47
(`word-key.ts`).

The distinction matters because only the first row is documentation *about* the package. The second
row is documentation *of a symbol*, and it is rendered on hover and in autocomplete at all 140 call
sites across both apps. §6.4 is where that lands as a decision.

---

## 2. What is actually wrong

Five findings, each with the evidence.

**F1 — The grouping exists, but it lives in filename prefixes instead of folders.**
`tutor`, `tutor-transport`, `tutor-transport-fake`, `tutor-pause` is a directory spelled with
hyphens. Same for `word-types` / `word-key`, and `items-query` / `item-list` — which are not even
consistent with each other about the plural.

**F2 — Nothing tells a newcomer where to start.** Fourteen alphabetised peers give no reading
order. `api.ts` sits on top of five other modules and `theme.ts` sits under nothing, and the folder
listing says neither. The per-file headers are excellent — genuinely the best documentation in this
repo — but you have to open a file to get them, and there is no map that says which to open first.

**F3 — The barrel has zero consumers.** All 140 import sites across `apps/` name a subpath
(`@tutor/shared/api`, `@tutor/shared/theme`, …). Not one imports `@tutor/shared`. `index.ts` is
dead weight that contradicts the rule stated in its own header ("import the specific module … so a
client bundle pulls only what it names").

**F4 — A test double sits beside production code and is publicly importable.**
`tutor-transport-fake.ts` is reachable as `@tutor/shared/tutor-transport-fake` because the exports
map is `"./*": "./src/*.ts"`. Nothing today stops a screen importing it; nothing but convention
will stop it later.

**F5 — The layering is real but unenforced.** The repo's own ESLint config says the boundary is
"enforced rather than remembered", and it enforces the *outer* boundary (no npm packages, no app
imports) properly. The *inner* order is remembered only. `word-types.ts` importing `api.ts` would
create a cycle and no gate would notice.

---

## 3. Constraints, verified rather than assumed

**C1 — Nested folders need no config change.** The exports map `"./*": "./src/*.ts"` uses a
subpath *pattern*, and `*` in a pattern substitutes greedily across `/`. So
`@tutor/shared/tutor/pause` already resolves to `./src/tutor/pause.ts` with the package.json exactly
as it is today. Verified empirically: a probe file at `src/__probe__/deep.ts` imported from
`apps/web` as `@tutor/shared/__probe__/deep` type-checked clean, and a deliberately wrong nested
path failed with TS2307 — so resolution really happened rather than being skipped. (Probe files
removed; tree is clean.)

**C2 — The tooling globs are already nesting-ready.** `tsconfig.json` includes `src/**/*.ts`;
`eslint.config.js` scopes the purity rule to `src/**/*.ts`. Both keep working at any depth.

**C3 — The cost is 140 external import sites plus ~20 internal relative imports plus `check.ts`.**
All of them are compile-checked. A rename that misses one cannot reach a device: `pnpm typecheck`,
`pnpm lint`, `pnpm check:shared` and `pnpm --filter mobile check` each fail loudly.

**C4 — One residual risk worth naming: Metro.** `apps/mobile` has no `metro.config.js`, so it uses
the Expo default, which has package-exports resolution on. The current flat layout already depends
on that same `"./*"` pattern, so nesting exercises the same code path one level deeper rather than a
new one — but the bundle step in `pnpm --filter mobile check` is the gate that proves it, and it is
not optional for this change.

---

## 4. Four options

Each is described by what the tree looks like, what the import specifiers become, what it buys, and
what it costs.

### Option A — Domain folders ✅ **APPROVED**

Group by *the thing the code is about*. Prefixes move into the folder name and out of the filename.
Single-file concerns that belong to no domain stay as top-level modules rather than being given a
folder of one.

```
src/
  api.ts                    the wire contract — sits on top of every domain
  theme.ts                  design tokens — sits under nothing
  words/
    types.ts                ← word-types.ts
    key.ts                  ← word-key.ts
    query.ts                ← items-query.ts
    list.ts                 ← item-list.ts
  lessons/
    types.ts                ← lesson-types.ts
  tutor/
    session.ts              ← tutor.ts
    transport.ts            ← tutor-transport.ts
    pause.ts                ← tutor-pause.ts
  offline/
    ops.ts                  ← sync-ops.ts
    mirror.ts               ← mirror-store.ts
  testing/
    fake-transport.ts       ← tutor-transport-fake.ts
```

Imports before → after:

```
@tutor/shared/word-types           →  @tutor/shared/words/types
@tutor/shared/tutor-transport      →  @tutor/shared/tutor/transport
@tutor/shared/sync-ops             →  @tutor/shared/offline/ops
@tutor/shared/api                  →  unchanged
@tutor/shared/theme                →  unchanged
```

**Buys:** the folder listing becomes six lines instead of fourteen, and each line is a domain a
person can hold in their head. The `tutor-` prefix stops being repeated four times. `testing/`
separates the fake from production code (F1, F2, F4). Because `api.ts` and `theme.ts` stay put, the
two most-imported modules — 59 of the 140 sites — need no edit at all.

**Costs:** 81 import sites change. `lessons/` holds a single file, which looks thin; it is a real
domain that will grow (lesson progress, scheduling), but today it is a folder of one. And
`words/types` is marginally less self-describing than `word-types` when read in an import list.

### Option B — Layer folders — not taken

Group by dependency depth instead of by subject: `core/` for the leaves, `domain/` for what builds
on them, `contract/` for what sits on top.

```
src/
  core/       theme.ts  word-types.ts  word-key.ts
  domain/     tutor.ts  items-query.ts  sync-ops.ts  lesson-types.ts
              tutor-transport.ts  mirror-store.ts  item-list.ts  tutor-pause.ts
  contract/   api.ts
  testing/    tutor-transport-fake.ts
```

**Buys:** the one thing Option A cannot give — the layering becomes *enforceable*. Three
`no-restricted-imports` zones (`core/**` may import nothing local; `domain/**` may import `core/**`
only; `contract/**` may import both) turn F5 from a convention into a build error, in exactly the
spirit the existing config already argues for.

**Costs:** it optimises for the wrong question. Nobody opens this package asking "what is in layer
2"; they ask "where does the pause live". `domain/` would hold eight of the fourteen files, so the
flat-list problem (F2) survives inside it. And a file's layer changes when its imports change, so
files would move for reasons that have nothing to do with what they are about.

### Option C — Stay flat, fix names and add documentation — not taken

No moves. Delete the dead barrel, make the plural consistent (`item-list.ts` → `items-list.ts`),
add `packages/shared/README.md` and `packages/shared/docs/`.

**Buys:** zero churn, zero migration risk, zero import-site edits, and it still fixes F2 and F3.
The documentation carries the map that the folder structure would otherwise carry.

**Costs:** F1 and F4 are untouched — the prefixes keep doing a directory's job, and the fake stays
publicly importable next to production code. At fourteen files this is survivable, but the growth
rate argues against betting on it: the package was extracted on 2026-08-09 with ten modules and has
fourteen thirteen days later — and **three of the four additions were `tutor-*` files, all landed
today**. The prefix group that most needs a folder is the one that is actively growing.

### Option D — Domain folders with an explicit public surface — not taken

Option A, plus a per-domain `index.ts`, plus a hand-written exports map that lists exactly the
subpaths a client may name:

```jsonc
"exports": {
  "./api":    "./src/api.ts",
  "./theme":  "./src/theme.ts",
  "./words":  "./src/words/index.ts",
  "./tutor":  "./src/tutor/index.ts",
  "./offline":"./src/offline/index.ts",
  "./testing":"./src/testing/index.ts"
}
```

**Buys:** the boundary becomes real rather than conventional. `testing/` can be dropped from the map
entirely, which makes F4 impossible instead of merely discouraged, and a domain's internal file
layout stops being part of its public API.

**Costs:** it re-introduces exactly what F3 says nobody wanted — whole-domain imports. `@tutor/shared/tutor`
would pull the transport interface into a screen that only wanted `KICKOFF_MESSAGE`. That is nearly
free here (this package is mostly types and string constants, and Metro tree-shakes the rest), but
"nearly free" is a bundle-size argument that has to be re-made every time the package grows a
function. It also means the exports map must be edited by hand for every new module — a step that
will be forgotten.

### Side-by-side

| | A · domains | B · layers | C · flat | D · domains + surface |
| --- | --- | --- | --- | --- |
| fixes F1 prefixes | yes | partly | no | yes |
| fixes F2 no reading order | yes | no | via docs only | yes |
| fixes F3 dead barrel | yes | yes | yes | replaced by real barrels |
| fixes F4 fake is public | yes, by convention | yes, by convention | no | yes, by construction |
| fixes F5 unenforced order | no (add-on possible) | **yes, natively** | no | partly |
| import sites changed | 81 | 140 | 0 | 140 |
| package.json edited | no | no | no | **yes, and forever after** |
| answers "where does X live?" | **yes** | no | no | yes |

---

## 5. The decision

**Option A, with both add-ons.** Approved 2026-08-22.

1. **Take the layering lint rule from Option B anyway.** Option A's folders do not encode the
   layering, but the layering can still be enforced on top of them: `words/**` and `theme.ts` may
   not import from `tutor/**`, `offline/**` or `api.ts`; `testing/**` may not be imported from
   outside `check.ts`. Four `no-restricted-imports` zones in the existing config. This is the
   cheapest half of Option B and it is the half that carries the value.

2. **Delete `index.ts`.** It has no consumers, and every consumer already follows the rule its
   header states. Removing it means dropping `"."`, `main` and `types` from package.json, which is
   the one part of this change that is not purely mechanical — so verify it with the mobile bundle
   step, and treat it as separable from the moves (see the migration plan).

Option A was taken over B because "where does the pause live" is the question people actually ask,
and over D because paying a permanent package.json maintenance cost to prevent one import of a fake
is the wrong trade at this size. Option C — stay flat, document only — was the fallback had the 81
import-site edits been unwelcome; they were not.

---

## 6. The package docs folder

Approved: the proposed layout, **and the reversal of the charter that came with it**. The docs are
not a companion to the file headers — they replace them as the home of the package's narrative.

### 6.1 Where the documentation lives today

Three places, none of them a map:

- **Module headers** — 292 lines across fourteen files. Genuinely good: `word-key.ts` explains the
  three normalizations and which one is the identity; `items-query.ts` explains the encoder/decoder
  drift that caused it to be written. But you have to open a file to find any of it, and the file
  you need to open is the one you do not yet know the name of.
- **`/docs/2026-*.md`** — twenty-plus date-stamped research notes. These are a *history*: they
  record why a decision was made on a day. They stay exactly as they are.
- **`CLAUDE.md`** — one paragraph of rules.

### 6.2 Layout

One doc per `src/` folder or top-level module, plus an index and the architecture note. That rule is
mechanical on purpose — "which doc does this go in" should never need a judgement call, and the doc
set can never drift out of step with the folder set.

```
packages/shared/
  README.md              the map — what is here, the rules, how to add a module
  docs/
    architecture.md      the layering, the purity boundary and how it is enforced, why
                         dependencies stay zero, what belongs here vs. on the server
    words.md             ← src/words/       CEFR vocabularies, the three normalizations and
                                            which one is the identity, the URL query grammar,
                                            client-side search and facet grouping
    lessons.md           ← src/lessons/     the lesson shapes and their relationship to words
    tutor.md             ← src/tutor/       transcript shapes, the kickoff/resume message set,
                                            the provider-agnostic transport, the pause machine
    offline.md           ← src/offline/     the op algebra, why every op is idempotent, the
                                            mirror-store contract and what it deliberately
                                            does not abstract (reactive reads)
    api.md               ← src/api.ts       route table, envelopes, what is deliberately absent
    theme.md             ← src/theme.ts     the token table, why a palette qualifies for the
                                            pure core
    testing.md           ← src/testing/ + check.ts   the fake transport, how to add a property check
```

`lessons.md` was missing from the first draft of this layout while Option A created a `lessons/`
folder — the one-doc-per-folder rule is what makes that class of gap impossible rather than
noticed later.

### 6.3 The charter

Five rules, stated in `packages/shared/README.md` so they are enforceable in review rather than
merely intended.

1. **The docs own the narrative.** Why a module exists, what drift it prevents, what it
   deliberately does *not* do, which alternative was rejected and why — all of it lives in
   `docs/`. Not a copy: the prose is **moved**, and the file it came from no longer carries it.
2. **Moved, not summarized.** The migration cuts existing prose and re-knits it into the domain's
   story. Paraphrasing 292 lines of carefully-argued text into bullet points would lose the
   arguments, which are the only reason the text is worth keeping.
3. **The code keeps a locator, not an essay.** Every module opens with two or three lines: one
   sentence saying what it is, and a pointer to its doc — e.g.
   `/** The offline outbox op algebra. See ../docs/offline.md. */`. This is what keeps a reader who
   opened the file directly from concluding there is no documentation.
4. **Subject names, never dates.** `/docs` at the repo root is date-stamped because it is a
   history. This folder is reference, and reference is looked up by subject.
5. **Every doc points at its research notes rather than restating them.** `tutor.md` links
   `2026-08-22-openai-realtime-second-provider.md` and `2026-08-16-tutor-pause-hold-the-line.md`;
   it does not re-tell those stories.

**The risk this accepts, stated plainly.** Prose next to code is prose that gets edited when the
code is edited; prose in another file is prose that can quietly go stale. Three things hold against
that: rule 3 means every file names its doc, so the reader is never stranded; rule 1 means there is
exactly one home per subject, so there is never a second copy to forget; and the one-doc-per-folder
rule means a new module makes it obvious which doc must grow. This is the standard trade for
discoverability, and it is the right one at fourteen modules and growing.

### 6.4 What moves, and the one open question

**Moving — 292 lines of module header:**

| target doc | source headers | header lines |
| --- | --- | ---: |
| `words.md` | `words/key.ts` (47), `words/query.ts` (26), `words/list.ts` (13), `words/types.ts` (9) | 95 |
| `tutor.md` | `tutor/transport.ts` (41), `tutor/pause.ts` (33), `tutor/session.ts` (4) | 78 |
| `offline.md` | `offline/mirror.ts` (17), `offline/ops.ts` (14) | 31 |
| `theme.md` | `theme.ts` (26) | 26 |
| `testing.md` | `testing/fake-transport.ts` (23), plus the `check.ts` header | 23+ |
| `api.md` | `api.ts` (19) | 19 |
| `architecture.md` | `index.ts` (13, deleted in step 4), plus the rationale comments in `eslint.config.js` and `tsconfig.json` | 13+ |
| `lessons.md` | `lessons/types.ts` (7) | 7 |

**Not moving — config-file comments.** The blocks in `eslint.config.js` and `tsconfig.json` explain
the line directly beneath them (`types: []`, the `no-restricted-imports` regex). Their *rationale*
is summarized into `architecture.md`; the comments themselves stay, because a rule you can disable
by deleting one line needs its warning at that line.

**Open — D7: the 1 326 lines of attached TSDoc.** These are `/** … */` blocks bound to an exported
symbol or an interface field:

```ts
/** Whether the provider can silence its own output mid-turn without ending the turn. */
silenceOutput: boolean;
```

Read literally, "move documentation from comments to docs" would take these too. I do not think it
should, and the reason is not stylistic: this text is rendered on hover and in autocomplete at all
140 call sites in `apps/`, in an editor, at the moment someone is deciding what to pass. A Markdown
file cannot appear there. Moving it would trade documentation that arrives unbidden for
documentation someone has to go and find — and for `api.ts`, whose 459 comment lines are almost
entirely field-level, that is most of what the file is worth.

Three ways to settle it, for approval:

| | what happens to TSDoc | consequence |
| --- | --- | --- |
| **D7-a** *(recommended)* | stays on the symbol | hover keeps working; docs carry narrative only; ~1 326 lines stay in `src/**` and the package stays ~45% comment |
| **D7-b** | stays, but trimmed to one sentence per symbol; any "why"/history paragraph inside a block moves to the doc | hover keeps working and gets terser; a genuine reduction in `src/**`; the most editing work of the three |
| **D7-c** | moves to the docs as an API reference section per domain | `src/**` drops to ~46% comment → near zero narrative; hover goes blank at 140 call sites; the reference must be hand-kept in sync with the types |

If the intent behind the instruction was "the file should not open with twenty lines of essay", D7-a
already delivers it — that essay is entirely the 292-line header row. If the intent was "src should
be code", D7-b gets most of the way without blinding the editor.

## 7. Migration plan

Six steps, each independently verifiable, in this order. Steps 1–4 are the structure; steps 5–6 are
the documentation. The split matters: steps 1–4 are compile-checked and cannot silently go wrong,
while steps 5–6 touch no code the compiler reads and therefore need a different kind of review.

**1 — Pure moves, no content edits.** `git mv` every file into its folder and rename it. Nothing
compiles at the end of this step; that is fine, because it is not pushed alone. Keeping the moves
free of content changes is what lets `git log --follow` and `git blame` survive the rename.

**2 — Rewrite every import specifier.** One codemod over `apps/` plus the relative imports inside
`src/` plus `check.ts`:

```bash
# external call sites
grep -rl '@tutor/shared/' apps --include='*.ts' --include='*.tsx' | xargs sed -i '' \
  -e 's|@tutor/shared/word-types|@tutor/shared/words/types|g' \
  -e 's|@tutor/shared/word-key|@tutor/shared/words/key|g' \
  -e 's|@tutor/shared/items-query|@tutor/shared/words/query|g' \
  -e 's|@tutor/shared/item-list|@tutor/shared/words/list|g' \
  -e 's|@tutor/shared/lesson-types|@tutor/shared/lessons/types|g' \
  -e 's|@tutor/shared/tutor-transport-fake|@tutor/shared/testing/fake-transport|g' \
  -e 's|@tutor/shared/tutor-transport|@tutor/shared/tutor/transport|g' \
  -e 's|@tutor/shared/tutor-pause|@tutor/shared/tutor/pause|g' \
  -e 's|@tutor/shared/tutor|@tutor/shared/tutor/session|g' \
  -e 's|@tutor/shared/sync-ops|@tutor/shared/offline/ops|g' \
  -e 's|@tutor/shared/mirror-store|@tutor/shared/offline/mirror|g'
```

Order matters in that list: `tutor-transport-fake` must be rewritten before `tutor-transport`, and
both before the bare `tutor`, or the shorter pattern eats the longer one. Then fix the relative
imports inside `src/` by hand — there are about twenty and the compiler names every one.

Verify: `pnpm typecheck && pnpm lint && pnpm check:shared && pnpm --filter mobile check`. The bundle
step in that last command is the one that proves C4.

**3 — Add the layering lint zones** to `eslint.config.js`, with a comment saying what each zone is
protecting, in the style the existing rules already use.

**4 — Delete `index.ts`** and drop `"."`, `main` and `types` from package.json. Separate commit
because it is the only step that changes how the package is *resolved* rather than where its files
sit — so if the mobile bundle objects, this is the commit to revert, not the whole migration. Keep
its header text; it is the seed of `architecture.md` in step 6.

**5 — Scaffold `README.md` and `docs/`.** The eight files from §6.2, each with its section headings
and its links into `/docs/2026-*`, but empty of moved prose. Committing the shape before the content
means step 6's diffs are pure moves, which is what makes them reviewable.

**6 — Move the prose, one commit per doc.** Eight commits, each cutting the headers of one domain
into its doc and leaving the locator stub of charter rule 3 behind. One commit per doc rather than
one for all of them, because a reviewer's job here is to confirm nothing was *lost* — an argument
dropped in the re-knitting is invisible in a 292-line diff and obvious in a 95-line one.

Order matters between 6 and 1–4: the docs must be written against the new paths, or every
cross-reference in them is born wrong.

### Verifying

Steps 1–4 are covered by the compiler: `pnpm typecheck && pnpm lint && pnpm check:shared &&
pnpm --filter mobile check`, with the bundle step in that last command being what proves C4.

Steps 5–6 are not — comments do not affect any of those gates, so a paragraph deleted rather than
moved passes everything. Two checks instead:

```bash
# every module still names its doc (charter rule 3)
grep -L 'docs/' packages/shared/src/**/*.ts          # must print nothing

# reconcile the move: lines leaving src/** should reappear under docs/
git diff --stat HEAD~8 -- packages/shared/src packages/shared/docs
```

The reconciliation is a prompt to look, not a passing number — prose gets re-knit, so the counts
will not match exactly. A doc that gained far fewer lines than its headers lost is the signal.

---

## 8. Decisions

| # | decision | outcome |
| --- | --- | --- |
| D1 | structure | ✅ **Option A** — domain folders |
| D2 | strip the domain prefix inside folders (`tutor/transport.ts`) | ✅ yes |
| D3 | move `tutor-transport-fake.ts` to `testing/` | ✅ yes |
| D4 | ESLint layering zones (the useful half of Option B) | ✅ yes |
| D5 | delete the unused `index.ts` barrel | ✅ delete, as its own commit |
| D6 | package docs | ✅ full set — one doc per folder or top-level module, plus `architecture.md` and `README.md` |
| D6b | narrative prose moves out of the code into those docs | ✅ yes — 292 lines of module header, moved not summarized, locator stub left behind |
| **D7** | the 1 326 lines of TSDoc attached to symbols and fields | ⬜ **open** — D7-a keep on the symbol *(recommended)* · D7-b trim to one sentence, move the "why" · D7-c move wholesale (§6.4) |

D7 is the only thing blocking step 6; steps 1–5 can proceed on what is already decided.
