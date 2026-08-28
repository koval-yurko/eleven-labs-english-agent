# Environment variable sync — local ⇄ Vercel ⇄ EAS

Research for two commands:

```bash
pnpm env:push    # local .env files  →  Vercel (web) and EAS (mobile), every environment
pnpm env:pull    # Vercel and EAS    →  local .env files, read from production
```

Measured against the live projects on 2026-08-28 (Vercel CLI 59.9.1, eas-cli latest, both
authenticated as the repo owner). Claims that are documented but not verified say so.

**Decisions taken 2026-08-28** (they shape everything below):

1. `.env.example` is the push allowlist. A key commented out with `#` is a known key that is
   **never synced in either direction**.
2. **Every environment carries the same values.** One app version; development, preview and
   production are copies of each other and of the laptop. Production is the pull source.
3. `APP_VARIANT` is synced.
4. `pnpm install` may be run to unblock the EAS CLI.
5. The five unused production keys in §3.1 are deleted.
6. `SUPABASE_DB_URL` is synced to Vercel like any other key.

---

## 1. What exists today

### 1.1 The five files

| Path | Committed? | Read by | Role |
| --- | --- | --- | --- |
| `apps/web/.env` | no (`.env*` ignored) | Next.js dev + `tsx` scripts | web values |
| `apps/web/.env.example` | **yes** | the sync command | the key registry / allowlist |
| `apps/mobile/.env` | no | Expo CLI → `app.config.ts` | mobile values |
| `apps/mobile/.env.example` | **yes** | the sync command | the key registry / allowlist |
| `/.env.local` (repo root) | no | **nobody** | stale `vercel env pull` artifact |

`/.env.local` holds one line: an expired `VERCEL_OIDC_TOKEN`. Next.js loads env files relative
to the app directory (`apps/web/`), not the repo root, so **nothing in this monorepo ever reads
it**. It is a leftover from running `vercel env pull` at the root, where the `.vercel/` link
lives. Delete it; the pull command writes to `apps/web/.env` instead.

### 1.2 The two remotes

**Vercel** — project `eleven-labs-english-agent`, linked at the repo root via
`.vercel/project.json`. Live state: **39 rows, 34 distinct keys**:

| target | keys today | after the first `env:push --apply` |
| --- | ---: | --- |
| production | 34 | identical to the laptop's registered keys |
| preview | 33 | identical |
| **development** | **10** | identical — this is the drift the push closes |

17 of the 39 rows are `type=sensitive`; the rest are `type=encrypted` (Vercel's "Config").

**EAS** — project `6a38b3eb-8751-43eb-bb09-860d58ec4a68`, linked through
`extra.eas.projectId` in `apps/mobile/app.config.ts`. `eas.json` maps each build profile to an
environment: `development` → development, `preview` → preview, `production` → production.

> **Blocker (decision 4 clears it).** `eas env:list` currently fails in this checkout. It
> shells out to `expo config --json`, which throws
> `PluginError: Failed to resolve plugin for module "@daily-co/config-plugin-rn-daily-js"`.
> Both `@daily-co/*` packages are declared in `apps/mobile/package.json` but absent from
> `node_modules`. **Every `eas env:*` command is blocked until `pnpm install` runs.** The EAS
> half below is therefore written from the CLI's `--help` output and the Expo docs, not from
> live inspection. Two things get verified the moment install completes: whether EAS
> `sensitive` visibility round-trips through `env:pull`, and the live production key list.

---

## 2. The two CLIs are not symmetric

This is the whole reason the commands need writing rather than aliasing.

| capability | Vercel | EAS |
| --- | --- | --- |
| bulk **push** from a `.env` file | ❌ **does not exist** | ✅ `eas env:push --path <file>` |
| bulk **pull** to a `.env` file | ✅ `vercel env pull <file>` | ✅ `eas env:pull --path <file>` |
| one var at a time | `vercel env add NAME <targets>` | `eas env:set --name --value` |
| value classes | `config` (readable) / `secret` (`--sensitive`) | `plaintext` / `sensitive` / `secret` |
| scope | project | project **or account** |
| overwrite | `--force` (same target only) | `--force` |

**The gap that defines the work: Vercel has no `env push`.** The upload direction must be a
loop over `vercel env add`, one invocation per key. EAS gets that for free.

### 2.1 Flags worth knowing

```
vercel env add <name> production,preview,development --sensitive|--no-sensitive [--value V]
vercel env pull <file> --environment production --yes
vercel env ls --json
vercel env rm <name> <target> --yes
```

```
# cwd = apps/mobile for all of these
eas env:push   --environment development --environment preview --environment production \
               --path .env --force
eas env:pull   production --path .env.pulled
eas env:set    --name N --value V \
               --environment development --environment preview --environment production \
               --visibility plaintext|sensitive|secret
eas env:list   production --format long --include-sensitive
```

Defaults that will bite:

- `vercel env pull` defaults to **`.env.local` in the cwd** and to the **development**
  environment. Both wrong here; pass the path and `--environment production`.
- `eas env:push` and `eas env:pull` both default to **`--path .env.local`**. This repo keeps
  mobile values in `apps/mobile/.env`. Expo's CLI loads `.env.local` at *higher* precedence
  than `.env`, so an unqualified `eas env:pull` silently shadows the file you edit by hand —
  you change `.env`, nothing happens, and the cause is invisible. **Always pass `--path`.**
- `eas env` resolves the project from `app.config.ts`, so it must run with `cwd = apps/mobile`.

### 2.2 Can sensitive values be pulled back down?

> **CORRECTION (2026-08-28, measured during implementation). The answer below is wrong for the
> environment the tool reads.** `vercel env pull --environment production` returns the literal
> string `[SENSITIVE]` for every `type=sensitive` row. The measurement below was taken against
> the **development** target — the one `env pull` defaults to — where real values *do* come
> back. Production and preview are write-only.
>
> This was a data-loss bug, not a cosmetic one: `[SENSITIVE]` is non-empty, so the §5.2 step-3
> emptiness check waved it through and `--write` would have written that placeholder over 11
> real secrets in `apps/web/.env`. It also made `diff` report 13 changes where there were 2,
> since every secret compares unequal to a placeholder.
>
> It is now moot for this project: §9 removes `sensitive` storage entirely so that a laptop can
> be rebuilt from the remote. The sentinel is still detected, because the failure must not
> return silently if anyone re-enables it.
>
> EAS is the opposite of what was predicted: `plaintext` round-trips through `env:pull` fine.
> Its `secret` visibility remains unverified and unused.

Yes on Vercel, for this account — **verified empirically**. `vercel env pull` returned real,
non-empty values for `MCP_TOKEN` (len 51) and `VAPI_PRIVATE_KEY` (len 38), both of which
`vercel env ls --json` reports as `type=sensitive`. Vercel's "sensitive" flag restricts
*dashboard* reads and lower-privileged team members; the project owner reading over the CLI
still gets plaintext. (This is a Hobby-plan, single-owner project — `plan: "hobby"` in the OIDC
token. On a Team with restricted roles, expect blanks.)

EAS's `secret` visibility is documented as genuinely one-way — `env:pull` writes a placeholder
rather than the value. **Not verified** (§1.2). D3 therefore maps `# secret` to EAS
`sensitive`, never `secret`, so the round-trip survives. To be confirmed after `pnpm install`.

Either way the pull command must **detect** an empty value where `env ls` says a key exists,
and refuse to write a blanked `.env` over a populated one.

### 2.3 `VERCEL_OIDC_TOKEN` must never be pushed

`vercel env pull` **injects** `VERCEL_OIDC_TOKEN` into the output file — it is not a stored env
var, it is a ~12-hour token minted at pull time. Round-tripping a pulled file straight back
through push would upload a dead token as a real variable. Hence the denylist in D4.

---

## 3. Measured drift

### 3.1 Five keys live on production and are read by no source file

Searched `apps/web/src`, `apps/web/scripts`, `apps/mobile/src`, `packages/shared/src`,
`supabase/`:

| key | on Vercel | in `.env.example` | read anywhere |
| --- | --- | --- | --- |
| `GENERATION_MODEL_ID` | prod + preview | no | **no** |
| `MCP_RESOURCE_URL` | all three | no | **no** |
| `CRON_SECRET` | prod + preview | no | **no** |
| `ELEVENLABS_CONVAI_WEBHOOK_SECRET` | prod + preview | no | **no** |
| `SUPABASE_AUDIO_BUCKET` | prod + preview | no (but in `.env`) | **no** |

All five are also absent from both `.env.example` files, so they were never recorded as
existing. They look like residue from retired features (`SUPABASE_AUDIO_BUCKET` from the
private-audio work, `CRON_SECRET` from a scheduler that no longer exists). Deleting them is
the cheapest possible outcome of this refactor.

`APP_BASE_URL` also matches no source file, but it is **live**: `@auth0/nextjs-auth0` v4 reads
it straight from the environment (confirmed in
`apps/web/node_modules/@auth0/nextjs-auth0/dist/server/client.js`). Do not delete it.

### 3.2 Three keys must differ between laptop and production

| key | local value | production value |
| --- | --- | --- |
| `APP_BASE_URL` | `http://localhost:3000` | the deployed origin |
| `APP_ENV` | `dev` | `prod` |
| `APP_VARIANT` (mobile) | `development` | `production` |

These are the reason decision 2 ("one value everywhere") needs a carve-out. `APP_BASE_URL` and
`APP_ENV` get the `#` treatment from decision 1 — see D2. `APP_VARIANT` is handled differently
because `eas.json` can override it — see D10.

Everything else already agrees. `apps/mobile/.env` already points at production
(`EXPO_PUBLIC_API_BASE_URL=https://eleven-labs-english-agent.vercel.app`), which is exactly the
"one version, local equals production" model decision 2 describes.

### 3.3 Keys locally that Vercel does not have

`SUPABASE_DB_URL` (migrations, run from a laptop), `MCP_TOKEN_OLD` (rotation leftover),
`AUTH0_AUDIENCE` (in `.env.example` only, deliberately unset — `lib/auth0.ts` changes the web
login flow when it is truthy).

Per decision 1, `MCP_TOKEN_OLD` gets `#`-commented. `AUTH0_AUDIENCE` has no value anywhere, so
push skips it and reports it; `#`-commenting it is tidier and makes the intent explicit.

`SUPABASE_DB_URL` is synced (decision 6). Worth naming once and then not again: it is a direct
Postgres connection string that no function reads, so it widens the blast radius slightly for no
benefit. The marginal risk is small — Vercel already holds `SUPABASE_SERVICE_ROLE_KEY`, which
bypasses RLS anyway — and it stays a one-character change (`#`) to reverse.

### 3.4 Mobile keys leaking into the web project

`EXPO_PUBLIC_VAPI_PUBLIC_KEY` and `EXPO_PUBLIC_VAPI_ASSISTANT_ID` are set on all three Vercel
targets and are also in `apps/web/.env`. Next.js never reads `EXPO_PUBLIC_*`; they belong to
EAS and `apps/mobile/.env` only.

### 3.5 Sensitivity classification disagrees with the manifest

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is stored `type=sensitive` on Vercel, but `NEXT_PUBLIC_*` is
inlined into the client bundle at build time — public by construction, and `.env.example`
correctly does not mark it `# secret`. Conversely `ELEVENLABS_WEBHOOK_SECRET`,
`ELEVENLABS_CONVAI_WEBHOOK_SECRET` and `CRON_SECRET` are sensitive on Vercel but carry no
`# secret` annotation locally. D3 makes the manifest authoritative, so these four get corrected
in the file rather than in a dashboard.

---

## 4. Design

### D1 — Where the script lives: root `scripts/env-sync.mjs`

It spans both apps, like `supabase/` and `docs/` do, so it does not belong inside either one.
Plain `.mjs` with zero dependencies, in the style of `apps/web/scripts/migrate.mjs` — **not**
`tsx`. That matters: §1.2 shows `node_modules` can be half-installed, and the env sync is
exactly the tool you want working when the tree is broken.

### D2 — `.env.example` is the allowlist; `#` means "known, never synced"

*Decision 1.* Two states, no new syntax:

```dotenv
SUPABASE_SERVICE_ROLE_KEY=    # secret       ← synced, stored sensitive
APP_BASE_URL=                 # differs      ← NOT synced (commented below)
#APP_BASE_URL=
#APP_ENV=
#MCP_TOKEN_OLD=
#AUTH0_AUDIENCE=
```

- **Uncommented key** → synced in both directions. Value comes from `.env` on push.
- **Commented key (`#KEY=`)** → recorded as existing, never pushed, never written by pull.
- **Key in `.env` but not in `.env.example` at all** → not pushed, reported as unregistered.

One mechanism covers both cases that need it: keys that are retired (`MCP_TOKEN_OLD`) and keys
whose value must differ between laptop and production (`APP_BASE_URL`, `APP_ENV`, §3.2). The
trailing comment after `#` stays free-form, so the file keeps explaining itself.

Why an allowlist at all: a laptop `.env` accumulates scratch variables and one-off overrides.
Requiring a committed line before a value can reach production makes that an explicit,
reviewable act — and gives §3.1 a forcing function, since the only way to deploy a new variable
is to register it first.

### D3 — Sensitivity is read from the `# secret` annotation

`apps/web/.env.example` already carries it:

```dotenv
AUTH0_CLIENT_SECRET=          # secret
SUPABASE_SERVICE_ROLE_KEY=    # secret — bypasses RLS, server only
```

| annotation | Vercel | EAS |
| --- | --- | --- |
| `# secret` | `--sensitive` | `--visibility sensitive` |
| none | `--no-sensitive` | `--visibility plaintext` |

Never EAS `secret` — it does not round-trip (§2.2). `EXPO_PUBLIC_*` is forced to `plaintext`
regardless: the prefix already states that the value ships inside the .ipa.

Ten keys carry the annotation today; §3.5 lists the four that need correcting.

### D4 — Denylist for runtime-injected variables

`VERCEL_OIDC_TOKEN`, `VERCEL_*`, `NEXT_RUNTIME`, `TURBO_*`, `EAS_*`, `NODE_ENV`, `CI`. Never
pushed, stripped on pull. See §2.3.

### D5 — Pull updates `.env` in place, and can only ever add to it

**REVISED 2026-08-28.** The original design wrote `apps/<app>/.env.pulled` and required
`--write` to promote it. Two steps for the common case earned nothing: the review step was
performed on a file nobody opened, and the promote silently dropped every local-only key.

Pull now writes `apps/<app>/.env` directly, copying the previous file to `.env.bak` first, and
prints the same key-level diff — **values never printed, only lengths and a sha256 prefix**.
`--dry-run` shows the diff and writes nothing.

What makes overwriting in place safe is that the write is a merge, not a replacement. The output
is the remote's values for the keys it supplies, plus **every local key it does not**:

- `#`-commented registry keys, whose value must differ per environment (`APP_BASE_URL`,
  `APP_ENV`) — under the old `--write` these were silently deleted;
- keys the remote has never held (`MCP_PUBLIC_URL`, `SUPABASE_DB_URL` before it was pushed);
- write-only keys, whose remote value cannot be read (§2.2).

**REVISED AGAIN, same day: the file's layout belongs to whoever wrote it.** Pull no longer
regenerates `.env` from the registry's ordering. It rewrites only the text to the right of `=`,
on the lines whose value actually changed, and leaves everything else byte-identical — key
order, grouping comments, blank lines, and the whitespace aligning a trailing comment. A key
the remote does not supply is not touched at all, which is what makes "never delete" structural
rather than a rule the code has to remember. Keys the remote has that the file lacks are
appended under a dated comment, since no position in someone else's layout is obviously theirs.

Only when there is no `.env` at all — the restore-a-machine case — is the file generated from
the registry, because then the registry's ordering is the only layout in existence.

Verified against the live project: a stale value was rewritten in place with its trailing
comment and 3-space alignment intact, one key was appended, every other line was unchanged, and
a second pull was a byte-identical no-op.

### D6 — Dry run is the default

Every job in this repo has a `:plan` variant that changes nothing. Env sync inverts it: the
plan is the **default**, and mutation requires `--apply`. Uploading a wrong secret to
production is worse than a wasted LLM call.

### D7 — Vercel push is a loop; `rm` from every target, then one `add`

```bash
for t in production preview development; do
  vercel env rm "$key" "$t" --yes 2>/dev/null || true    # tolerate "does not exist"
done
printf '%s' "$value" | vercel env add "$key" production,preview,development --sensitive
```

Decision 2 makes this cleaner than the per-environment design would have been: one `add` per
key covers all three targets, because `vercel env add` accepts a comma-separated target list
and stores them as a single merged row.

`printf '%s'` rather than `echo` — `echo` appends a newline that ends up inside the stored
value. Use stdin rather than `--value` for anything that may contain newlines or shell
metacharacters (PEM keys, JSON blobs).

Why `rm` first instead of `--force`: this project currently has both merged rows (`VAPI_ORG_ID`
on all three targets as one row) and split rows (`VAPI_PRIVATE_KEY` as three separate ones).
Whether `--force` with a comma list *merges* three rows into one or overwrites them
individually is unverified, and probing it means writing to the live project. Clearing every
target first makes the result a merged row every time, which is exactly the shape decision 2
wants — so the question never has to be answered, and the row layout self-heals on first push.

### D8 — EAS push/pull is a single call, with `--path` and `cwd = apps/mobile`

```bash
eas env:push --environment development --environment preview --environment production \
             --path .env --force
eas env:pull production --path .env.pulled
```

`--environment` is declared repeatable (`<value>...`) in the CLI's own help, so all three
environments should be one call. **Unverified** — `eas env:*` is blocked until `pnpm install`
(§1.2). If the flag turns out to accept only one value, fall back to three sequential pushes;
nothing else in the design changes.

`eas env:push` reads the file's values but has no per-key visibility flag, so visibility for a
*new* key comes from a preceding `eas env:set`. In practice: `env:set --visibility sensitive`
for the `# secret` keys, then `env:push` for the bulk.

### D9 — Every environment holds identical values; production is the pull source

*Decision 2.* There is **no `--env` flag**, and there is nothing to choose:

- `env:push` writes all three Vercel targets and all three EAS environments, same values.
- `env:pull` reads **production** — since the three agree by construction, one read suffices,
  and production is the one that is definitionally correct.
- `env:diff` reads all three and reports any key whose value differs between them.

That last one is the invariant made checkable. "All environments are identical" is a claim that
decays silently the moment someone edits one value in a dashboard; a diff that reads three
targets and compares hashes turns it into a thing the tool can assert. It is also how the
current state gets caught — development holds 10 of 34 keys today (§1.2), which under this
model is simply drift, and the first `env:push --apply` closes it.

Two consequences worth stating rather than discovering:

- **A preview deployment now runs against the production Supabase, Auth0 and ElevenLabs
  projects.** That is what "one app version, local equals it" means, and it is already true for
  the 33 keys preview holds. It is not a new exposure, but it is now a deliberate one.
- **`APP_BASE_URL` cannot be one value across targets** — a preview deployment has its own
  origin, and Auth0 rejects a callback that does not match. It is `#`-commented (D2) and left
  exactly as it is on Vercel today, where production and preview already share a single merged
  row. Unchanged by this refactor, but it is the reason the carve-out in D2 exists rather than
  being a special case bolted on later.

### D10 — `APP_VARIANT` is synced, and `eas.json` gains a production override

*Decision 3, plus the fix that makes it safe.*

`apps/mobile/.env` holds `APP_VARIANT=development` (correct — local builds must not overwrite
a TestFlight install). Under decision 2 that value goes to **all three** EAS environments,
production included — which would give production builds the development bundle identifier,
because `eas.json`'s production profile is the only one declaring no `env` block and would fall
through to it:

```jsonc
"development": { "env": { "APP_VARIANT": "development" }, "environment": "development" },
"preview":     { "env": { "APP_VARIANT": "preview"     }, "environment": "preview"     },
"production":  {                                          "environment": "production"  }  // ← falls through
```

Fix, one line, so the build profile stays authoritative and the synced value is inert:

```jsonc
"production": { "env": { "APP_VARIANT": "production" }, "environment": "production" }
```

With that in place `APP_VARIANT` syncs like any other key and cannot break a store build.
Without it, syncing `APP_VARIANT` is a release-blocking bug on the one build you cannot
iterate on.

### D11 — Pull brings everything; unregistered keys are reported, not dropped

Push is allowlisted (D2), pull is not. A key that exists on production but not in
`.env.example` — the five in §3.1 — is written to `.env` and reported as
**"unregistered: adopt into .env.example or delete from the remote"**. Silently dropping it
would hide exactly the drift the tool exists to surface; silently adopting it would defeat the
allowlist.

### D12 — Not in v1

- Per-branch preview variables (`--git-branch`).
- EAS account-scoped variables (`--scope account`).
- Deletion. A key removed from `.env.example` is reported, never deleted from the remote.
  Deletion stays a deliberate `vercel env rm` / `eas env:delete`.

---

## 5. Command surface

```bash
pnpm env:diff                      # report only; local vs all three environments, both remotes
pnpm env:push                      # plan: what would change
pnpm env:push --apply              # do it, all environments
pnpm env:push --target web --apply
pnpm env:pull                      # updates .env from production, backing up to .env.bak
pnpm env:pull --dry-run            # shows the diff, writes nothing
```

`--target` ∈ `web | mobile | all` (default `all`). No `--env` (D9).

Root `package.json`:

```json
"env:diff": "node scripts/env-sync.mjs diff",
"env:push": "node scripts/env-sync.mjs push",
"env:pull": "node scripts/env-sync.mjs pull"
```

### 5.1 What `push` does

1. Parse `apps/<app>/.env.example` → ordered keys, commented-out set, `# secret` flags (D2, D3).
2. Parse `apps/<app>/.env` → values.
3. Drop commented and denylisted keys (D2, D4). Report keys in `.env` but not in the registry,
   and registered keys with no local value.
4. Read remote state (`vercel env ls --json` / `eas env:list --format long`) for all three
   environments and classify each key **new / changed / unchanged / remote-only**, plus
   **divergent** when the three environments disagree with each other (D9).
5. Print the plan. Values never printed — `len=51` and a sha256 prefix make "changed" provable
   without exposure.
6. Under `--apply`, mutate only **new**, **changed** and **divergent**, writing all three
   environments in one `add` per key (D7).

Empty local values are skipped, not pushed as `""` — an empty string is truthy-adjacent in a
way `undefined` is not, and `lib/auth0.ts` branches on exactly that distinction.

### 5.2 What `pull` does

1. `vercel env pull <tmp> --environment production --yes` / `eas env:pull production --path <tmp>`.
   Production only — the three agree by construction (D9), and `env:diff` is what checks it.
2. Strip denylisted keys (D4) — in particular the injected `VERCEL_OIDC_TOKEN`.
3. Abort if a key that `env ls` reports as existing arrives empty (§2.2 failure mode) rather
   than writing blanks over good values.
4. Drop keys that are `#`-commented in `.env.example` (D2) so a pull cannot clobber
   `APP_BASE_URL`, `APP_ENV` or a local-only value.
5. Diff against the current `.env`; report added / removed / changed / unregistered (D11).
6. Back up `.env` to `.env.bak`, then write `.env` — remote values plus every local key the
   remote does not supply, so the write can add and update but never delete (D5).

### 5.3 Parsing rules

Handle what both CLIs actually emit: `KEY="value"` with double quotes (Vercel's pull quotes
everything), `\n` escapes inside quoted values, `#` comments, blank lines, `export ` prefixes.
Preserve `.env.example`'s ordering and comments when writing, so the result stays a readable
document rather than a sorted blob.

---

## 6. Sequenced plan

### 6.1 Prerequisites

1. **`pnpm install`** — unblocks `@daily-co/*` and therefore every `eas env:*` command (§1.2).
   Then verify the two open EAS facts: does `sensitive` round-trip, and what does production
   actually hold.
2. `npm i -g vercel` — the CLI is not installed; everything above ran through `npx`, which
   re-downloads a ~59 MB package per invocation. A loop over 34 keys via `npx` is unusable.
3. Delete `/.env.local` (§1.1).
4. Fix the registries: correct the four `# secret` annotations from §3.5, and `#`-comment
   `APP_BASE_URL`, `APP_ENV`, `MCP_TOKEN_OLD`, `AUTH0_AUDIENCE`. Nothing from §3.1 gets adopted
   — all five are deleted (decision 5).
5. Add `"env": { "APP_VARIANT": "production" }` to `eas.json`'s production profile (D10).
6. Delete the five dead keys and move `EXPO_PUBLIC_VAPI_*` off the web project — §6.2.

### 6.2 Bringing every environment to parity (decision 2)

Nothing here is a separate manual chore — the first `env:push --apply` does it. What follows is
what that push will actually change, so the plan output is not a surprise:

- **Vercel `development`: +24 keys.** It holds 10 of 34 today. Everything Auth0, everything
  Supabase, `ANTHROPIC_API_KEY`, `ELEVENLABS_*`, `LANGSMITH_*` arrive. This is the largest
  single change and the one most worth reading the plan for.
- **Vercel `preview`: +1 key.** `ELEVENLABS_WEBHOOK_SECRET`, currently production-only.
- **Row layout self-heals.** The split rows (`VAPI_PRIVATE_KEY`, `MCP_TOKEN`, each stored three
  times) collapse into single merged rows, because D7 clears every target before one `add`.
- **Five keys are deleted** (decision 5, §3.1) from all targets: `GENERATION_MODEL_ID`,
  `MCP_RESOURCE_URL`, `CRON_SECRET`, `ELEVENLABS_CONVAI_WEBHOOK_SECRET`,
  `SUPABASE_AUDIO_BUCKET`. This is the one step the tool will **not** do for you — D12 keeps
  deletion manual. Run it once, by hand, before the first push:

  ```bash
  for k in GENERATION_MODEL_ID MCP_RESOURCE_URL CRON_SECRET \
           ELEVENLABS_CONVAI_WEBHOOK_SECRET SUPABASE_AUDIO_BUCKET; do
    for t in production preview development; do
      vercel env rm "$k" "$t" --yes 2>/dev/null || true
    done
  done
  ```

  Also drop `SUPABASE_AUDIO_BUCKET` from `apps/web/.env`, the only one of the five with a local
  value.

- **`EXPO_PUBLIC_VAPI_*` moves out of web** (§3.4): remove both keys from the Vercel project and
  from `apps/web/.env`. They belong to EAS and `apps/mobile/.env`, where they already are.

On mobile, `eas.json` keeps its three build profiles and its three `environment` mappings
untouched — they now point at three environments holding identical values, which is exactly the
model decision 2 describes. The per-profile `env` blocks still pin `APP_VARIANT`, so a
development build keeps its own bundle identity while reading production values. D10's
production override is what completes that.

### 6.3 Then build

`env:diff` first — read-only, mutates nothing, and it exercises the parser, the registry reader
and both remote readers. Its output is the review of everything in §3 before either write
direction exists. `env:pull` second (it only ever adds, and backs up to `.env.bak`). `env:push` last.

---

## 7. Why not a secret manager

Doppler, Infisical and 1Password's `op inject` solve this properly: one source of truth, audit
logs, per-environment inheritance, and connectors that push to Vercel and EAS for you. The
argument against them here is scale — one developer, two remotes, ~30 keys, and three
environments that are copies of each other rather than three things to reconcile (decision 2),
with both CLIs already authenticated on this machine. A manager adds a service
to stay logged into, a second place secrets live, and a new failure mode during `pnpm install`.

The line to watch is **a second developer**: at that point `.env` files stop being a laptop
detail and become a distribution problem. The design above is deliberately shallow enough to
throw away then — it wraps the vendor CLIs rather than replacing them, so nothing depends on it.

(`dotenv-vault` is the one option to skip outright — superseded by `dotenvx`, and its
encrypted-file model duplicates what Vercel and EAS already do server-side.)

---

## 8. Implementation status (2026-08-28)

`scripts/env-sync.mjs` is built and in use. **It implements the earlier reading of decision 2 —
production only — not the "every environment carries the same values" rule above.** The decision
was revised while the code was being written; the gap is real and listed in §10.

Three corrections the live systems forced, all verified:

1. **§2.2 is wrong for production** — see the correction box there. It surfaced only because
   `diff` prints a fingerprint rather than a value: eleven "changed" keys all showed
   `len=11 sha=3930fb7a`, which is the sha256 of the string `[SENSITIVE]`. A tool that printed
   `***` would have hidden it.
2. **EAS speaks two vocabularies for one field.** `env:list` prints `Visibility PUBLIC |
   SENSITIVE | SECRET`; `env:set` accepts `--visibility plaintext | sensitive | secret`.
   Comparing the printed word against the flag word marks every public variable as sensitive.
3. **`VERCEL` and `NX_DAEMON` are injected on pull too**, not just `VERCEL_*`. They carry no
   underscore, so the D4 prefix list missed them; both are denied by exact name now.

Also fixed: the pull writer emitted values unquoted, so any value containing whitespace, `#`, a
quote or a newline did not survive being read back (`a #b` re-parses as `a`). `formatValue()` is
now the strict inverse of `parseDotenv`, checked against eight hostile values.

`eas env:push`/`env:pull` were not needed: the mobile side has six keys, and `env:set` per key
gives per-key visibility, which `env:push` cannot express (D8).

## 9. D3 revised — recoverability is the requirement

The goal was restated during implementation: **`env:pull` must rebuild a laptop's `.env` from
the remote alone.** Vercel's `sensitive` type is write-only on production, so annotating a key
`# secret` also declared it unrecoverable — documenting a value honestly quietly cost the
ability to restore it. Twelve keys were in that state.

The annotation is split in two:

| annotation | meaning | Vercel storage |
| --- | --- | --- |
| `# secret` | documentation: this value is a credential | Config — readable back |
| `# write-only` | give up ever reading it back | `sensitive` |
| neither | ordinary value | Config |

`# write-only` has no users today, deliberately. It exists so the trade is made per key and
visibly in the committed registry, rather than as a side effect of describing a value
accurately.

**What it costs.** Those twelve keys are now Vercel Config: encrypted at rest, but readable by
anything holding a Vercel token for this project rather than masked in the dashboard. On a
single-owner project that audience is the owner, and the same values already sit in plaintext in
`apps/web/.env`. The exposure that genuinely changed is a leaked Vercel token. Revisit if the
project gains team members: `# write-only` on `SUPABASE_SERVICE_ROLE_KEY` and `AUTH0_SECRET` is
the escape hatch, at the cost of keeping those two somewhere a new machine can reach.

Verified by moving `apps/web/.env` aside and pulling with the remote as the only source:

```
recovered from production alone : 25
WRONG value                     : 0
NOT recoverable                 : 0
```

## 10. Gap between this document and the code

| decision | document | `scripts/env-sync.mjs` today |
| --- | --- | --- |
| 2 / D9 — environments | push writes all three, diff reports cross-environment drift | production only; no cross-environment read |
| D7 — Vercel push | `rm` from every target, one `add` with a comma list | `rm` + `add`, production target only |
| D8 — EAS push | one `env:push` with three `--environment` flags | `env:set` per key, production only |
| 5 — the §3.1 orphans | deleted from the remote | registered `#`-commented; nothing deleted (D12) |
| 6 — `SUPABASE_DB_URL` | synced like any other key | **done** — synced and verified recoverable |

Closing rows 1–3 is one change: thread a target list through `vercel.set`/`eas.set` and add a
third read to `classify`. Row 4 is a deliberate hold — D12 keeps deletion a manual act, and the
five keys are recorded in `apps/web/.env.example` with the `vercel env rm` needed to finish.

`MCP_PUBLIC_URL` (added to the registry by the MCP-tools work) is `#`-commented: it differs per
environment by design, which is the carve-out §3.2 describes, and its own comment asks for it to
be pushed deliberately rather than in bulk.
