# repo — replace the graffiti code map with graphify

- **Date:** 2026-09-19, adapted 2026-09-20 for this repo.
- **Status:** **approved** — this spec was copied from a sibling project's identically-dated
  design doc for the same migration. Its decisions (D1–D12) carry over; the two repo-specific
  forks (§3, §7) were resolved for this repo on 2026-09-20 (install `graphifyy[sql]`; add CI).
  §11's Gate 1 has been run here and passed. Gate 1b (head-to-head against this repo's
  `graffiti`), Gate 2 (the cache premise) and the CI OAuth-token path are still open — same as
  they were left open in the sibling doc before its own gates ran.
- **Scope:** repo-wide tooling for this one pnpm workspace (`apps/web`, `apps/mobile`,
  `packages/shared`, `supabase/`, `docs/`). The sibling repo had a `platform/`-style sibling
  project directory living above its per-project boundary; this repo has no such split — it is
  a single project, so "repo-wide" and "project-wide" mean the same thing here.
- **Amends:** nothing. graffiti arrived here without a spec too, in commit `cf72fa3`
  (`chore: add graffiti code map, and fix the CLAUDE.md paths it exposed`, 2026-09-14) — the same
  pattern the sibling doc described for its own repo's `8bff451`. This is the first written
  record of how the code map is wired in *this* repo, and it supersedes the
  `## graffiti code map` section of `CLAUDE.md` in place.

## 1. What changes, in one line

Unchanged from the sibling spec: `graphify` replaces `graffiti`; the graph itself stays
untracked, but the **LLM-extracted semantic cache is committed**, because it is the one output
that costs money to recreate.

## 2. Why

Same capability case as the sibling doc — clustering (Leiden/Louvain, no API key), `god-nodes`,
`path`, `explain` and `affected` (a blast-radius query) over a tree-sitter AST graph. Measured
for *this* repo rather than carried over: a code-only build (`graphify update .`, no docs, no
LLM) across `apps/`, `packages/shared/` and `supabase/migrations/` produced **3,945 nodes, 8,477
edges, 221 communities**.

## 3. The constraint that nearly sinks it — here it's SQL, not Terraform

The sibling repo is Terraform-heavy, so its blocking gap was graphify's HCL extractor. **This
repo has zero `.tf`/`.tfvars`/`.hcl` files** — that specific gap does not exist here, and §3's
Terraform prerequisite from the sibling doc does not carry over as written.

This repo has a different one. graphify's SQL extractor (`extract_sql`,
`graphify/extractors/sql.py`) also lives behind an optional extra
(`Provides-Extra: sql`, installing `tree-sitter-sql`), and it was missing here. A code-only build
without it emitted, verified 2026-09-20:

```
warning: 19 .sql file(s) contributed nothing to the graph because a dependency is
missing: tree_sitter_sql not installed. Install it with: pip install "graphifyy[sql]" (#1745)
```

That's every file in `supabase/migrations/` — the RLS-guarded `words`/`lesson_items` schema and
every server-only RPC CLAUDE.md calls out by name, including `resolve_words` (the one path from
typed text to a word id) — silently absent from the graph. A query for `resolve_words` before
the extra surfaced only its TypeScript caller (`resolveWords()` in `apps/web/src/lib/words.ts`);
the actual Postgres function definition never appeared. Same failure shape as the sibling's
33-Terraform-files gap, different extra, same fix pattern: `uv tool install "graphifyy[sql]"` is
this repo's prerequisite, and §11 proves it exactly the way the sibling doc proved `[terraform]`.

(Installing `[sql]` replaced `[terraform]` in the same `uv tool` environment — `uv tool install`
resolves one extra set per tool, so the two are mutually exclusive locally. That's fine: this
repo has no Terraform to lose coverage on.)

## 4. Decisions

| id | decision | choice |
|---|---|---|
| D1 | Code map tool | graphify replaces graffiti |
| D2 | SQL coverage | the `graphifyy[sql]` extra is a **prerequisite** — this repo's analogue of the sibling's `[terraform]` (§3) |
| D3 | Search guard | `Bash\|Grep` → `graphify hook-guard search`, unmodified |
| D4 | Read guard | wrapped locally to add `.sql` only; **no `--strict`** |
| D5 | Git hooks | `post-commit` + `post-checkout`; the merge-driver line is stripped |
| D6 | What is committed | `graphify-out/` ignored **except** `cache/semantic*/` |
| D7 | Doc coverage | routine, not on-demand |
| D8 | Who regenerates the semantic cache | **both** — by hand, and by CI on `master` |
| D9 | CI branch scope | `master` only |
| D10 | The project skill | short and repo-local, replacing the existing 12-line `.claude/skills/graffiti/SKILL.md` |
| D11 | Staleness signal | a `SessionStart` mtime check, not `graphify watch` |
| D12 | When graffiti is deleted | **last**, gated on a head-to-head query (§11) |

D4 diverges from the sibling doc on purpose: it added `.tf`, `.tfvars`, `.yaml` and `.yml` because
its `slo.yaml` is a real documentation-bearing YAML file with no structural extractor. This repo
has no equivalent — its only YAML is `pnpm-workspace.yaml` / `pnpm-lock.yaml` (build tooling
config, and the lockfile is already excluded from graphify's doc treatment as a package
manifest). Adding `.yaml`/`.yml` to the guard here would nudge on files with nothing worth
querying. `.sql` is the one real gap (§3), so it's the only addition.

## 5. The hook surface (D3, D4)

Identical mechanics to the sibling doc — same graphify version (0.9.64), same source lines.
graphify's own project install writes two `PreToolUse` entries; the first is taken as-is, the
second is wrapped.

**The search guard needs no help**, same as the sibling repo: a Grep nudges whenever a graph
exists, with no extension test at all (`cli.py:867-871`).

**The read guard is extension-filtered, and the list is hardcoded.** `_HOOK_SOURCE_EXTS`
(`cli.py:71-75`, consulted at `cli.py:881`) lists 29 extensions and omits `.sql` (and `.yaml`,
`.tf`, `.tfvars`, but see D4 above for why only `.sql` is added here). No environment variable or
config file extends it.

So `.claude/hooks/graphify-read-guard.sh` reads the hook JSON, emits the nudge itself when the
path ends in `.sql`, and otherwise pipes stdin straight to `graphify hook-guard read`.
Repo-local, so `uv tool upgrade` cannot undo it, and no patching of an installed package.

`--strict` is rejected for the same reason as the sibling doc: it hard-denies the first raw
`Read` of each session until a query has run, and the graph will never cover everything (e.g.
`.env.example`, `Info.plist`, `LICENSE` are already unclassified and skipped, per the
`update` output logged in §11).

## 6. What is committed, and why it is only one directory (D6)

Unchanged from the sibling doc — this is a property of graphify's own cache design
(`cache.py:938-946`, `cache.py:973-978`), not of either repo. AST entries are version-namespaced
and free to recompute; semantic entries are content-keyed, upgrade-proof, and cost real LLM
calls, so only they are committed.

| path | tracked | why |
|---|---|---|
| `graphify-out/cache/semantic/` | **yes** | the paid artifact; content-keyed, upgrade-proof by design |
| `graphify-out/cache/semantic-deep/` | **yes** | same, should `--mode deep` ever be used |
| `graphify-out/graph.json` | no | derived, rebuilt free from the caches |
| `graphify-out/graph.html` | no | derived visualization |
| `graphify-out/cache/ast/` | no | free to recompute, and discarded on upgrade anyway |
| `manifest.json`, `.graphify_*` | no | a clone without a manifest re-queues the doc files, but every one is a content-hash **cache hit — zero LLM calls** |

The `.gitignore` needs the same nested re-inclusion (a flat `graphify-out/` +
`!graphify-out/cache/semantic*/` negation stages nothing, silently — verified independently in
the sibling repo, not re-verified here, but the mechanism is graphify's own gitignore semantics,
not repo-specific):

```gitignore
graphify-out/*
!graphify-out/cache/
graphify-out/cache/*
!graphify-out/cache/semantic/
!graphify-out/cache/semantic-deep/
```

This replaces the current single-line `.graffiti/` entry. Dated backup directories
(`graphify-out/<YYYY-MM-DD>/`, observed firsthand during the §11 rebuild here) are covered by
`graphify-out/*` the same way.

## 7. Regenerating the semantic cache (D7, D8, D9) — CI is net-new here

Two routes that converge, same as the sibling doc:

**By hand**, any time:

```bash
graphify extract . --backend claude-cli
git add graphify-out/cache/semantic/
git commit -m "chore(repo): refresh graphify semantic cache"
```

**By CI, on `master` only.** Unlike the sibling repo, **this repo has no `.github/workflows/` at
all today** — there is no `claude.yml` or `claude-code-review.yml` precedent to point at for the
`claude[bot]`-actor-guard pattern, and this would be the first GitHub Actions workflow in the
repo. It needs a `CLAUDE_CODE_OAUTH_TOKEN` secret provisioned on
`koval-yurko/eleven-labs-english-agent`, which has not been done. Scoped to docs only, since
there's no yaml worth watching here (see D4):

```yaml
name: graphify semantic cache
on:
  push:
    branches: [master]
    paths: ['docs/**', '**/*.md']
jobs:
  extract:
    if: github.actor != 'claude[bot]'
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - run: pipx install "graphifyy[sql]"
      - run: graphify extract . --backend claude-cli
        env: { CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }} }
      - run: |
          git add graphify-out/cache/semantic/
          git diff --cached --quiet || git commit -m "chore(repo): refresh graphify semantic cache"
          git push
```

The install line uses `[sql]`, not `[terraform]` — CI's code-only pass over `supabase/migrations/`
needs the same extra §3 proved matters locally, even though this job only triggers on doc/md
pushes (a mixed doc+migration commit would otherwise silently drop the SQL nodes from the CI
rebuild too).

**No empty commits**, same double guard as the sibling doc (`paths:` filter + `git diff --cached
--quiet`), and it's exact for the same reason: graphify's cache entries carry no timestamps.

**Master-only** for the same reason as the sibling doc: content-hash naming makes cache entries
conflict-free between files; single-branch ownership makes them conflict-free within one — this
repo's branch is also called `master`.

**Locally, code-only is the default** — `graphify update .` never touches `cache/semantic/`; to
pull docs into a local graph, `git pull` then `graphify extract .`, every entry a cache hit.

## 8. Staying fresh (D5, D11)

**Git hooks handle code**, with one repo-specific wrinkle: **this repo currently has no
`.git/hooks/` directory at all** (not even the default git sample hooks) — `graphify hook
install` will be creating it fresh, not appending to an existing pre-commit setup the way the
sibling doc assumed. The rebuild still runs detached so commits don't block, and `post-checkout`
still does a full rebuild.

**Both hooks are inert in linked worktrees — and this repo actually uses worktrees.**
`.gitignore` already excludes `.claude/worktrees`, and the repo has a `git-worktree` skill
installed for exactly this workflow. So the caveat that was hypothetical in the sibling doc is an
active operational note here: anyone working from a linked worktree must run `graphify update .`
by hand — the git hooks will not fire there.

**Docs need a different signal**, same design as the sibling doc
(`.claude/hooks/graphify-doc-stale.sh`, `SessionStart`, `find -newer`), adapted to this repo's
actual doc surface: it compares mtimes of `docs/`, `README.md` and `spec/PRD-base.md` against
`graphify-out/graph.json` (the sibling's `slo.yaml` and `results.md` don't exist here).

## 9. Files touched

| file | change |
|---|---|
| `.claude/settings.json` | replace the current `Grep\|Glob → graffiti hook` entry with the two graphify guards, plus the `SessionStart` entry |
| `.claude/hooks/graphify-read-guard.sh` | new (§5) |
| `.claude/hooks/graphify-doc-stale.sh` | new (§8) |
| `.claude/skills/graphify/SKILL.md` | new (§10) |
| `.claude/skills/graffiti/` | deleted (currently a 12-line `SKILL.md`) |
| `.github/workflows/graphify-semantic-cache.yml` | new — **first CI workflow in this repo** (§7) |
| `CLAUDE.md` | the `## graffiti code map` section rewritten |
| `README.md` | new section, placed after `## Setup` and before `## Commands` (§10) |
| `.gitignore` | `.graffiti/` → `graphify-out/` + nested negation (§6) |
| `.graffiti/` | deleted (untracked local build output; nothing to `git rm`) |
| `.git/hooks/post-commit`, `post-checkout` | installed fresh — no existing hooks to preserve |

## 10. What the skill and the README each say (D10)

Same split as the sibling doc, for the same reason — different readers.

**The skill** (`.claude/skills/graphify/SKILL.md`) stays short, replacing the existing graffiti
skill: `query`/`explain`/`path`/`affected`/`god-nodes` as entry points, `graphify update .` after
editing code, docs reach the graph only through a semantic pass, and build queries from the
graph's own vocabulary (case-folded substring + IDF, no stemming, no synonyms).

**The README** gets a new section for a human at a fresh clone. This repo's README has no
`## Prerequisites` section to slot into (unlike the sibling repo) — its `## Setup` already covers
the `pnpm` version prerequisite, so the graphify section goes right after it, before `## Commands`:

- `uv tool install "graphifyy[sql]"` and why (§3) — the failure mode is a silently incomplete
  graph over `supabase/migrations/`, not an error.
- The five query commands, with `resolve_words` as the one worked example against this repo.
- `graphify update .` for code; the manual `graphify extract .` block from §7 for docs.
- That CI on `master` regenerates the cache too, once wired (§7) — a convenience, not an
  obligation.
- That the git hooks do not fire in worktrees, and that this repo's worktree workflow makes that
  a real, not hypothetical, thing to know (§8).

## 11. Verification — two gates

**Gate 1 — SQL coverage. Run 2026-09-20, passed.** Built code-only *before* installing the
extra and queried `resolve_words` — the RPC CLAUDE.md names as the only path from typed text to
a word id, defined solely in `supabase/migrations/0007_words_m2m.sql:102` (commit `89d82d1`),
with no TypeScript or doc definition anywhere. Before the extra: the query surfaced only the
TypeScript caller `resolveWords()`, never the Postgres function; graphify logged
`19 .sql file(s) contributed nothing to the graph`. After `uv tool install "graphifyy[sql]"` and
`graphify update . --force`: the query's top hit became
`resolve_words() [src=supabase/migrations/0007_words_m2m.sql loc=L102]`, and the SQL warning was
gone. Node count moved from 3,875 to 3,945 (+70, all `supabase/migrations/`).

**Gate 1b — the head-to-head against this repo's `graffiti`.** **Not yet run.** Note that the
`graffiti` installed in *this* repo is a different, simpler tool than the one the sibling doc
benchmarked against (a small Mach-O binary — `build`/`update`/`query`/`serve`/`init`/`link`, no
LLM semantic cache, no `hook-guard` subcommands) — so this repo's own head-to-head has to be run
fresh; the sibling's Terraform-query result doesn't transfer. If graphify answers a query like
"what does `resolve_words` do" worse than this repo's `graffiti query`, the honest outcome is the
same as the sibling doc's: keep graffiti and report that.

**Gate 2 — the cache premise.** **Not yet run.** Same procedure as the sibling doc: run one doc
pass (`graphify extract . --backend claude-cli`), delete `graph.json` and `manifest.json`, keep
`cache/semantic/`, rebuild, and confirm the docs come back with zero LLM calls. Deferred here
because a full pass over this repo's 67 markdown files under `docs/` is a real LLM cost/time
spend, and the SQL-extra question (§3) was the load-bearing uncertainty worth resolving first.

`.claude/skills/graffiti/` and this repo's `graffiti` wiring are deleted **last**, after both
gates pass (D12). Until then graffiti is the control, per the sibling doc's own reasoning — this
repo has simply not run its own Gate 1b or Gate 2 yet.

## 12. Still open

- **Gate 1b** (head-to-head vs. this repo's own `graffiti`) and **Gate 2** (cache premise) —
  deferred, see §11.
- **The CI OAuth-token path** — same uncertainty the sibling doc flagged: whether `claude` on a
  GitHub Actions runner authenticates from `CLAUDE_CODE_OAUTH_TOKEN`. Untested here too, and
  compounded by this being the repo's first-ever workflow file — there's no existing
  `claude-code-action@v1` fallback already proven in this repo the way the sibling doc could
  point to `claude.yml`/`claude-code-review.yml`. If the OAuth path fails, the fallback is
  `anthropics/claude-code-action@v1` with a prompt that runs the pass through its own subagents,
  unproven in this repo specifically.
- **The `CLAUDE_CODE_OAUTH_TOKEN` secret** is not yet provisioned on
  `koval-yurko/eleven-labs-english-agent`.

## 13. What this does not change

- **No app or package logic is touched.** `apps/web`, `apps/mobile` and `packages/shared` are
  untouched; this is repo-level tooling only.
- **Supabase schema and RLS are untouched.** SQL migrations become *visible* to the graph (§3);
  nothing about the schema, RLS policies, or `pnpm db:migrate` changes.
- **No Vercel, Supabase, Auth0, ElevenLabs or LangSmith resource is involved**, so no cost
  changes there and nothing to provision or destroy on those platforms.
- **`pnpm sync:agents` and the prompt version registry remain the source of truth** for agent
  prompts; their appearance in the graph is a navigation convenience only.
