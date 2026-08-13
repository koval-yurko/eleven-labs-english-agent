# Expo migration — repo restructure to a pnpm workspace

**Date:** 2026-08-09 · **Status:** ready to implement. Every command below was verified against the
working copy on 2026-08-09.

This note decides **where the code lives and how it gets there**. Its companion,
`docs/2026-08-12-expo-app-creation.md`, decides **what the native app does** — read that for the app
itself, with `docs/2026-08-12-expo-build-plan.md` as the stage-by-stage build order. (It replaces the
earlier `docs/2026-08-07-Expo-migration.md`, which proposed a hybrid WebView shell and is superseded.)

Prerequisite — the shared-core extraction (`docs/2026-08-09-shareable-core-refactor.md`) — **is done**.
`src/shared/` exists today: 10 modules, 994 lines, zero imports outside the folder.

---

## 1. The decision

**Same repo, converted to a pnpm workspace in one mechanical commit:**

- `apps/web` — today's Next app, moved verbatim
- `apps/mobile` — the Expo app (step 7)
- `packages/shared` — today's `src/shared/` folder, relocated; not a new package to design

The mobile app is a thin client of *this* server: it mints signed URLs from
`/api/words-agent/signed-url`, resolves agent versions from the committed `src/agent/agents.lock.json`,
and must speak the exact `TranscriptLine` / `items_list` contract `src/shared/tutor.ts` defines. Two
repos would make every prompt-version bump a two-PR version-skew problem, and a hand-copied contract
would drift silently — a mismatched `KICKOFF_MESSAGE` produces a *working* session with a polluted
transcript, noticed weeks later.

A separate repo and a sibling `mobile/` folder were both evaluated and rejected. Not revisiting.

**Total cost of the restructure:** one `git mv` of the tree, one mechanical import substitution across
30 files, one code change (`migrate.mjs`), and a Vercel root-directory setting. No schema change, no
data migration, no external reconfiguration.

---

## 2. Preflight — re-verify before you start

These five facts are what make the move cheap. They were true on 2026-08-09; confirm they still are,
because a stale assumption here is what turns a one-commit restructure into a debugging session.

```bash
# 1. No path aliases in use — the tsconfig "@/*" entry is dead code. Expect 0.
grep -r 'from "@/' src scripts | wc -l

# 2. 30 files / 52 imports reach src/shared by relative path. Expect 30 and 52.
grep -rlE 'from "(\.\./)+(src/)?shared/' src scripts | wc -l
grep -rhoE 'from "(\.\./)+(src/)?shared/[^"]*"' src scripts | wc -l

# 3. src/shared imports nothing outside itself. Expect no output.
grep -rE '^\s*(import|export).*from "' src/shared | grep -v 'from "\./'

# 4. Only two files in src/lib touch Next. Expect http.ts and tutor-session.ts.
grep -rn 'from "next' src/lib

# 5. Four files resolve paths relative to themselves. Expect exactly:
#    src/agent/sync-agents.ts, scripts/{enrich-words,level-items}.ts, scripts/migrate.mjs
grep -rln 'import.meta.url' src scripts
#    Three of them only reach .env, which travels with them. Only migrate.mjs also
#    reaches supabase/migrations, which does not — expect exactly one hit here.
grep -rln '"supabase", "migrations"' scripts/
```

Also worth knowing before you start:

- **`next-env.d.ts` and `.env` are untracked** (`next-env.d.ts` is gitignored). They need plain `mv`,
  not `git mv` — see step 1.
- **`apps/web`'s package is named `english-tutor`**, so `pnpm --filter web` matches nothing until you
  rename it.
- `.env.local` does not exist in this repo; only `.env` and `.env.example`.
- `public/` contains exactly one file, `sw.js`, referenced by name in `eslint.config.js`.

---

## 3. Target structure

```text
eleven-labs-english-agent/            # same repo, same remote, same history
├── pnpm-workspace.yaml               # NEW — packages + linker settings (§6.1)
├── package.json                      # workspace root: scripts only, no dependencies
├── pnpm-lock.yaml                    # one lockfile for the whole workspace
├── .prettierrc  .nvmrc  .gitignore   # unchanged, stay at root
├── CLAUDE.md  README.md  .claude/    # updated in step 6, stay at root
├── skills-lock.json                  # unchanged
├── docs/                             # repo-level: research spans both apps
├── spec/                             # repo-level
├── supabase/                         # repo-level: the DB is shared infrastructure
│   ├── migrations/
│   └── README.md                     # the RLS/ownership convention CLAUDE.md cites
├── packages/
│   └── shared/                       # = today's src/shared/, relocated. 0 runtime deps
│       ├── package.json              # "@tutor/shared" + subpath exports (step 3)
│       ├── tsconfig.json             # NEW (step 3)
│       ├── eslint.config.js          # NEW — the boundary rule, moved here (step 3)
│       └── src/
│           ├── index.ts              # barrel (package entry; unused inside the repo)
│           ├── tutor.ts              # wire contract: items_list, kickoff/resume, sanitizeTranscript
│           ├── api.ts                # routes, request/response shapes, ApiErrorBody, guards
│           ├── word-types.ts         # WordDetails, ItemKind, CefrLevel, ItemRow/Detail/Facet
│           ├── word-key.ts           # wordInputKey, clientDedupeKey + the weaker-than-Postgres rule
│           ├── lesson-types.ts       # Lesson, LessonItem, LessonSession, NewLesson
│           ├── items-query.ts        # the /lesson-items URL grammar, both directions
│           ├── item-list.ts          # search predicate, facet grouping, sort labels
│           ├── sync-ops.ts           # outbox op algebra, limits, planNewItems
│           ├── mirror-store.ts       # the device-storage contract (Dexie impl stays in the app)
│           └── check.ts              # = today's scripts/check-shared.ts
├── apps/
│   ├── web/                          # the Next app, moved verbatim
│   │   ├── package.json              # renamed to "web"; + @tutor/shared workspace dep
│   │   ├── next.config.ts            # + transpilePackages: ["@tutor/shared"]
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js          # minus the shared-boundary block (it moved)
│   │   ├── next-env.d.ts  .env  .env.example
│   │   ├── public/sw.js
│   │   ├── scripts/                  # migrate.mjs, level-items.ts, enrich-words.ts
│   │   └── src/                      # app/ agent/ lib/ proxy.ts — shared/ has moved out
│   └── mobile/                       # NEW — Expo SDK 55 (step 7)
│       ├── app.json  package.json  eas.json
│       ├── metro.config.js           # generated, untouched (§6.2)
│       └── src/
│           ├── TutorScreen.tsx       # port of apps/web/src/app/lessons/[id]/LessonTutor.tsx
│           ├── WebViewShell.tsx
│           └── api.ts                # absolute URLs + Bearer token
```

**Why `supabase/`, `docs/` and `spec/` stay at the root.** The migrations describe one database that
both apps reach through the same server. Filing them under `apps/web` would imply the web app owns the
schema; it doesn't, it's just the only thing that runs `pnpm db:migrate`.

**Why `src/agent/` does *not* become a package.** Prompts + `agents.lock.json` + `sync-agents.ts` are
conceptually shared, but only the server reads them (`agent-registry.ts` → the signed-URL route), and
the mobile app gets versions over HTTP (§8.1). One consumer, no package.

---

## 4. The migration

Steps 1–6 are **one commit that changes no behaviour**. Verify, deploy, *then* start the Expo work.
Never interleave "restructure the repo" with "write the native app" — when something breaks you want
to know which one did it.

### Step 1 — move the tree

**Order matters:** lift `src/shared` out *before* moving `src`, or `git mv src apps/web/` drags it into
the app and step 3 has to pull it back out.

```bash
git switch -c chore/pnpm-workspace

# 1. the shared core leaves src/ first
mkdir -p packages/shared
git mv src/shared packages/shared/src

# 2. everything else becomes the web app
mkdir -p apps/web
git mv src public scripts apps/web/
git mv package.json next.config.ts tsconfig.json eslint.config.js .env.example apps/web/

# 3. the untracked files, which git mv cannot touch
mv next-env.d.ts .env apps/web/
```

Two things to get right in this block:

- **Do not add `next-env.d.ts` or `.env` to a `git mv` list.** Neither is tracked, and `git mv`
  validates every source before moving any — one untracked path aborts the whole command having moved
  nothing.
- **Do not silence these commands with `2>/dev/null`.** In a commit whose premise is "changes no
  behaviour", a step that fails quietly is the worst possible failure mode.

`git mv` records a rename, so `git log --follow packages/shared/src/tutor.ts` still shows full history
(including its earlier life as `src/lib/tutor.ts`) and `git blame` is unaffected. Never
delete-and-recreate.

**Stays at the root, untouched:** `docs/`, `spec/`, `supabase/` (both `migrations/` *and* `README.md`),
`.gitignore`, `.prettierrc`, `.nvmrc`, `CLAUDE.md`, `README.md`, `skills-lock.json`, `.claude/`,
`pnpm-lock.yaml`.

Then make these edits. **Exactly one is a code change:**

**`apps/web/scripts/migrate.mjs`** — the only path-sensitive file in the tree. One binding currently
serves two purposes that the move splits apart:

```js
const root = join(dirname(fileURLToPath(import.meta.url)), "..");     // line 23

for (const file of [".env.local", ".env"]) {                          // line 26–28
  dotenv.config({ path: join(root, file) });                          //   → wants apps/web  ✅
}

const migrationsDir = join(root, "supabase", "migrations");           // line 43
                                                                      //   → wants repo root ❌
```

After the move `root` resolves to `apps/web`, which is **correct for `.env` and wrong for the
migrations**. Add a second binding rather than changing the first:

```js
const repoRoot = join(root, "..", "..");
const migrationsDir = join(repoRoot, "supabase", "migrations");
```

Nothing else needs this: `src/agent/sync-agents.ts`, `scripts/level-items.ts`,
`scripts/enrich-words.ts` and `src/lib/agent-registry.ts` all resolve relative to their own file and
travel with `.env`, so they keep working untouched.

**`apps/web/package.json`** — three edits:

1. `"name": "english-tutor"` → `"name": "web"`. Root scripts filter by package *name*, not directory.
   (Alternative: use `pnpm --filter ./apps/web` everywhere instead. Pick one.)
2. Add `"@tutor/shared": "workspace:*"` to `dependencies`.
3. Remove the `check:shared` script — it becomes `packages/shared`'s own (step 3).

**`apps/web/tsconfig.json`** — the `include` globs are relative and still correct. The `paths` entry
`"@/*": ["./src/*"]` is dead (0 usages): delete it, or replace it with
`"@tutor/shared/*": ["../../packages/shared/src/*"]` so editor go-to-definition lands on source
(optional — workspace resolution works without it). Don't leave both.

**`apps/web/eslint.config.js`** — the `no-restricted-imports` block is scoped to `src/shared/**`, which
no longer exists in this app. Move it to `packages/shared`'s own config (step 3). The `public/sw.js`
and `scripts/**` blocks stay and remain correct — both directories moved with the app.

**`.gitignore`** — already fine as-is: `node_modules/`, `.next`, `*.tsbuildinfo` and `next-env.d.ts`
are all non-anchored, so nesting them under `apps/web/` changes nothing. The only edit is adding
`apps/mobile/.expo/`, `apps/mobile/ios/`, `apps/mobile/android/` in step 7.

### Step 2 — the workspace root

`pnpm-workspace.yaml` (see §6.1 for why these settings, and §6.3 for the React pin):

```yaml
packages:
  - "apps/*"
  - "packages/*"
nodeLinker: hoisted
hoistingLimits: workspaces
overrides:
  react: 19.2.7
  react-dom: 19.2.7
```

Root `package.json` — **scripts only, plus exactly one devDependency**. Keeping app dependencies out
of the root is what stops them being hoisted into an app's resolution and becoming phantom deps. The
single exception is `prettier`: §6.5 keeps one formatter at the root covering both apps, `packages/`,
`docs/` and `spec/`, and `prettier --write .` needs a binary in the root `node_modules/.bin`. A
formatter cannot leak into a shipped bundle, so it does not carry the risk the rule exists to prevent.

```jsonc
{
  "name": "english-tutor-monorepo",
  "private": true,
  "packageManager": "pnpm@11.20.0", // upgraded from 9.15.4 — §6.1
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "pnpm --filter web dev",
    "build": "pnpm --filter web build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "check:shared": "pnpm --filter @tutor/shared check",
    "db:migrate": "pnpm --filter web db:migrate",
    "db:migrate:status": "pnpm --filter web db:migrate:status",
    "sync:agents": "pnpm --filter web sync:agents",
    "sync:agents:plan": "pnpm --filter web sync:agents:plan",
    "level:items": "pnpm --filter web level:items",
    "level:items:plan": "pnpm --filter web level:items:plan",
    "enrich:words": "pnpm --filter web enrich:words",
    "enrich:words:plan": "pnpm --filter web enrich:words:plan",
    "mobile": "pnpm --filter mobile start"
  },
  "devDependencies": { "prettier": "^3.4.2" }
}
```

Keeping every old script name working from the root is the difference between a smooth migration and a
week of "wait, where do I run this now". Every command in CLAUDE.md keeps working verbatim.

**Verify the pnpm upgrade actually took**, because the failure is silent. pnpm 9 reads `packages:`
from `pnpm-workspace.yaml` and ignores everything else in it *without warning* — you get a workspace
that looks correct and an isolated symlinked `node_modules` that breaks React Native later:

```bash
pnpm --version                    # must be 11.x — a `packageManager` field alone does nothing
                                  # unless pnpm runs through a corepack shim
pnpm config get node-linker       # must print `hoisted`   (pnpm 9 prints `undefined`)
pnpm config get hoisting-limits   # must print `workspaces`(pnpm 9 prints `undefined`)
pnpm ls -r --depth=-1             # must list the root and every workspace package by its new name
```

After the upgrade, pnpm notices the previous install used a different linker and refuses to run any
script until `node_modules` is purged (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` in a
non-interactive shell). That is expected and correct — step 4's `rm -rf node_modules` is the fix. Root
scripts stay unusable until then, so do not read that error as a broken workspace.

### Step 3 — make `packages/shared` a real package

The folder already moved in step 1. What is left is packaging it and repointing imports.

```jsonc
// packages/shared/package.json
{
  "name": "@tutor/shared",
  "version": "0.0.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    // Subpath exports are what let `../../shared/word-types` become
    // `@tutor/shared/word-types` instead of collapsing every import to the barrel.
    "./*": "./src/*.ts"
  },
  "scripts": {
    // two configs — see below
    "typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.check.json",
    "lint": "eslint .",
    "check": "tsx check.ts"
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/node": "^22.10.2", // for check.ts only — the core is denied these, see below
    "tsx": "^4.22.4",
    "typescript": "^5.7.2",
    "eslint": "^9.17.0",
    "typescript-eslint": "^8.18.1"
  }
}
```

Add `"type": "module"` too — the source is ESM, and without it Node treats the package as CJS.

**`dependencies` must stay empty.** The moment something here needs `zod` or `@supabase/supabase-js`,
server code is sneaking in.

**Two tsconfigs, and the split is the point.** `check.ts` is a Node CLI script: it imports
`node:process` and iterates a `URLSearchParams`. The core does neither — it may *construct* a
`URLSearchParams` but never iterate one, which is exactly where platform differences begin. Giving
one config both sets of capabilities would silently license a `node:fs` import inside the core, so
the core gets a config that **cannot** compile such an import and the harness gets its own.

```jsonc
// packages/shared/tsconfig.json — the PURE CORE only
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"], // DOM is for URLSearchParams, not because this runs in a browser
    "types": [], // no ambient @types — a `node:*` import here is a hard error
    "strict": true,
    "noUncheckedIndexedAccess": true, // must match apps/web
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

```jsonc
// packages/shared/tsconfig.check.json — the harness, which is allowed to be a Node script
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["check.ts", "src/**/*.ts"]
}
```

Three lines are load-bearing. Without `DOM`, `items-query.ts` fails to compile standalone on
`URLSearchParams`. Without `types: []`, installing `@types/node` for the harness would silently make
Node's API available to the core. Without `noUncheckedIndexedAccess`, the package typechecks looser
on its own than inside `apps/web` — a future edit would pass `pnpm -r typecheck` and fail the app build.

```js
// packages/shared/eslint.config.js — the boundary, actually enforced
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // everything in the package, harness included
    files: ["**/*.ts"],
    rules: { "no-undef": "off" },
  },
  {
    // the boundary applies to src/** ONLY — check.ts sits outside it precisely so it can be a
    // Node script without punching a hole in this rule
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/lib/*", "**/lib", "**/app/*", "**/app"],
              message: "The pure core may not reach into the app — extract the pure part instead.",
            },
            {
              regex: "^[^.]", // anything not starting with "." is a bare specifier
              message: "packages/shared has zero runtime dependencies — no npm imports.",
            },
          ],
        },
      ],
    },
  },
);
```

> The bare-specifier rule is **new**. The rule that exists today blocks only `lib`/`app` paths — an
> `import { z } from "zod"` inside the core passes lint. The folder is clean in fact, but under
> `nodeLinker: hoisted` a phantom npm import also resolves at runtime, so install wouldn't catch it
> either. Add it now, while the package is being created.
>
> **Then prove it fires.** A misconfigured rule and a clean codebase produce identical output, and
> `regex:` in `no-restricted-imports` needs ESLint ≥ 9.6. Paste two bad imports into any core module,
> confirm two errors, revert:
>
> ```bash
> printf 'import { z } from "zod";\nimport { x } from "../../../apps/web/src/lib/llm";\n' \
>   | cat - src/word-key.ts > /tmp/probe.ts && cp /tmp/probe.ts src/word-key.ts
> ./node_modules/.bin/eslint src/word-key.ts    # expect 2 errors, one per pattern
> git checkout src/word-key.ts
> ```

**Move the property suite into the package.** It tests exactly this code (URL round-trip, sync-ops
rules, transcript caps, api guards); a test living in a different package from its subject is the
drift this whole migration exists to prevent.

**Move it first, then substitute** — that order rewrites its imports once instead of twice. (Substitute
first and its `../src/shared/x` becomes `@tutor/shared/x`, which you then have to rewrite again to
relative once the file is inside the package.)

**It lands beside `src/`, not inside it.** `src/**` is the pure core and the tsconfig/ESLint rules
above are scoped to exactly that path; a Node script living in there would force both to be loosened
for every module.

```bash
git mv apps/web/scripts/check-shared.ts packages/shared/check.ts
perl -pi -e 's{from "\.\./src/shared/}{from "./src/}g' packages/shared/check.ts
```

Its imports become **relative** (`./src/items-query`), not `@tutor/shared/items-query`.
Self-referencing the package by name works, but buys nothing and adds a resolution mode to debug.

**Then repoint every other import.** Run from `apps/web/`:

```bash
grep -rlE 'from "(\.\./)+(src/)?shared/' src scripts \
  | xargs perl -pi -e 's{from "(\.\./)+(src/)?shared/}{from "\@tutor/shared/}g'
```

Expect **29 files / 46 imports** here — `check.ts` accounts for the other 1 file / 6 imports and was
handled by the move above, which is the whole reason the totals in §2 are 30 and 52. Keep the
`(src/)?` group anyway: it costs nothing and catches any future script that reaches the folder through
`src/` rather than around it.

`pnpm typecheck` is the completeness check — every missed import is a hard error, so there is nothing
to eyeball.

**Ship raw TypeScript, no build step.** Metro handles workspace source out of the box (SDK 52+), and
Next needs one line. A `tsup`/`tsc` build step here buys nothing and adds a stale-dist failure mode.

```ts
// apps/web/next.config.ts
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@tutor/shared"],
};
```

### Step 4 — verify the web app is the same app

```bash
# also clear the root .next/ and tsconfig.tsbuildinfo — both are orphaned by the move
rm -rf node_modules apps/web/node_modules .next tsconfig.tsbuildinfo
pnpm install
pnpm typecheck && pnpm lint && pnpm check:shared && pnpm build

# the dry-run entry points: zero side effects, and the cheapest proof that
# .env and path resolution survived the move
pnpm sync:agents:plan && pnpm level:items:plan && pnpm enrich:words:plan
pnpm db:migrate:status          # proves the migrate.mjs repoRoot fix

pnpm dev
```

**The first install will stop on `ERR_PNPM_IGNORED_BUILDS`.** pnpm 10+ blocks dependency postinstall
scripts until they are named, and appends an `allowBuilds:` block to `pnpm-workspace.yaml` with
`set this to true or false` placeholders. Under pnpm 9 these ran unblocked, so approving them restores
the previous behaviour rather than granting anything new — and both are load-bearing here:

```yaml
allowBuilds:
  esbuild: true # the engine behind tsx: sync:agents, level:items, enrich:words, check:shared
  sharp: true # Next's image optimizer at build time
```

Re-run `pnpm install` after editing. Leaving the placeholders in place fails the install outright, and
answering `false` leaves `tsx` unable to run — i.e. every dry-run check below silently unavailable.

**Confirm the linker actually produced what you asked for.** With `hoistingLimits: workspaces` the root
`node_modules` should contain *only* the root's own devDependency, and each app should have its own flat
tree. If the root is full of the app's dependencies, `hoistingLimits` did not apply:

```bash
ls node_modules            # expect: prettier, and nothing else
ls apps/web/node_modules   # expect: the app's full flat tree (next, react, sharp, esbuild, …)
```

Run `pnpm check:shared` **before and after** the move and diff the output — identical means the
package's semantics survived relocation. (If you have already moved the file, the suite is
self-asserting: it prints `shared core: all properties hold` or exits non-zero, so a pass is meaningful
even without a captured baseline.)

Two things to exercise by hand, because no typecheck covers them:

1. **A real tutor session.** It crosses the new package boundary through `tutor.ts` and hits the server
   action, the beacon route and the webhook — the writers that must agree on `sanitizeTranscript`.
2. **The offline write path.** Create a lesson, add and remove an item, delete a lesson, go offline and
   reconnect. `lib/sync/engine.ts` writes through the `MirrorStore` contract into Dexie transactions,
   and a broken transaction still typechecks.

### Step 5 — repoint the deploy

Vercel: **Project Settings → General → Root Directory = `apps/web`**, and enable **"Include files
outside the root directory"** (the build needs `pnpm-workspace.yaml`, the root lockfile, and
`packages/shared`). Vercel detects pnpm workspaces and installs from the root lockfile automatically.

Same env vars, same domain. The ElevenLabs webhook URL, Auth0 callback URLs and Supabase config are
all unaffected. **Deploy before writing any Expo code**, so if the restructure broke the deploy you
find out with one variable in play.

### Step 6 — update `CLAUDE.md` and `README.md`

**`CLAUDE.md`** — replace "single pnpm package (no workspace)" with the workspace layout, and note that
commands run from the root via `--filter`. It already documents the shared-core conventions (the
boundary rule, the items-query grammar, the word-key invariant, the sync-ops rules, the mirror
contract, the API contract): **repoint those paths from `src/shared/…` to `packages/shared/src/…`**
rather than rewriting them. The rules are unchanged by the move.

**`README.md`** — its integration table and layout section cite `src/lib/…`, `src/agent/…`,
`src/app/…`, all now under `apps/web/`. While you're there: it advertises `pnpm provision:agent`
(lines 13 and 37), which hasn't existed for a while — the script is `pnpm sync:agents`.

### Step 7 — only now, `apps/mobile`

```bash
cd apps && npx create-expo-app@latest mobile --template default
cd mobile && npx expo install @elevenlabs/react-native @livekit/react-native \
  @livekit/react-native-webrtc @livekit/react-native-expo-plugin \
  @config-plugins/react-native-webrtc react-native-webview react-native-auth0 expo-dev-client
pnpm add @tutor/shared@workspace:*
```

Use `npx expo install` rather than `pnpm add` for the native packages — it picks versions matching your
SDK. Set `"name": "mobile"` in its `package.json` so the root `--filter mobile` script works. Then
follow `docs/2026-08-12-expo-build-plan.md` from stage S0. Note that the package list there differs
from the one above — the native tutor is WebRTC-only, so the plan is the current source of truth.

**What the app gets from `@tutor/shared` and must not reimplement:** the signed-URL path and response
guard (`api.ts`), the kickoff/resume protocol and `formatItemsList` (`tutor.ts`), `sanitizeTranscript`
before beaconing a transcript over cellular, and `TutorSessionInput` as the session-save body. That is
most of `TutorScreen.tsx`'s non-UI logic, already written and property-checked.

---

## 5. The rule for `packages/shared`

The contents are settled — the whole folder moves as-is. This section is the test to apply to anything
you are tempted to **add** later.

> **Be generous with types. Be strict with runtime code.**

A **type** is erased at compile time: no runtime cost, no bundle cost, no dependency, and it cannot go
stale in a shipped binary in any way a hand-copied interface isn't strictly worse. Share every DTO both
clients name.

**Runtime code** is different, and the reason is release cadence, not purity. `apps/web` deploys in
minutes; `apps/mobile` deploys in days, behind App Review, onto devices that update whenever the user
feels like it. **Every line of runtime logic in `packages/shared` is a line you can no longer fix by
deploying.** It earns its place only when it *cannot* change unilaterally anyway — i.e. it defines a
wire protocol both sides must agree on simultaneously.

**The test:** *if this had a bug, could I fix it by deploying the web app alone?* If yes, it belongs on
the server and the app should call it over HTTP. If no — because both sides must change in the same
instant to stay compatible — it belongs in the package.

What that produced:

| Module | Kind | Why it qualified |
| --- | --- | --- |
| `tutor.ts` | runtime | The tutor wire contract. Four writers converge on one `conversation_id` row — server action, beacon, webhook, native client — and all must cap transcripts identically. |
| `sync-ops.ts` | runtime | The outbox op union and the rules that build one. The server replays exactly what a client queues. |
| `items-query.ts` | runtime | Both directions of the `/lesson-items` URL grammar, plus the whitelists that keep arbitrary strings out of PostgREST. |
| `word-key.ts` | runtime | The client key must stay *weaker* than Postgres `norm_key`; a copy that merges more aggressively silently drops words the learner typed. |
| `item-list.ts` | runtime | In-memory search predicate, facet grouping, sort labels. |
| `api.ts` | types + constants | Route paths, request/response shapes, `ApiErrorBody`, the guards. A renamed field must be a typecheck failure, not a runtime `undefined` on a shipped device. |
| `mirror-store.ts` | types | The device-storage contract. |
| `word-types.ts`, `lesson-types.ts` | types | Every DTO both clients name. |

### What deliberately does *not* cross

- **Dexie** — `lib/sync/db.ts` (schema), `dexie-store.ts` (implementation), `live.ts` (the `liveQuery`
  hooks). The *contract* is shared; the *implementation* is not. Reactivity especially: `liveQuery`
  rides IndexedDB's own mutation events, and a SQLite adapter needs its own change notification, so
  there is no honest generic version. The full native port surface, if you ever want native offline, is
  one `MirrorStore` implementation plus those three hooks — which the hybrid-WebView shape doesn't
  require at all.
- **`lib/http.ts`** (`NextResponse`) and **`lib/tutor-session.ts`** (`revalidatePath`) — the only two
  Next-coupled files in `lib/`. Mobile reaches them over HTTP. Their *shapes* did move: `ApiErrorBody`
  and `TutorSessionInput` live in `shared/api.ts`, because a client has to construct them.
- **`lib/supabase/user-client.ts`** — would run in RN, and with the Auth0 JWT the app could query
  Postgres directly under RLS. No: the standing convention is "ownership is enforced in code, RLS is
  defense-in-depth". Move the enforcing code into a binary you can't hot-fix and RLS silently becomes
  your only line of defence.
- **`lib/agent-registry.ts`** — a pure reader over `agents.lock.json`, zero deps, would work. No:
  compiling agent ids into the app means a `pnpm sync:agents` that retires a version breaks every
  installed copy until the next review cycle. That's what `/api/agent-versions` (§8.1) prevents.
- **`lib/format-date.ts`** — exists to pin timezone and locale so SSR and hydration produce identical
  text. RN has no hydration and no SSR; sharing it would export a UTC-pinned `en-US` format to a
  platform where the user's real locale is the correct answer.
- **`lib/asset-version.ts`** — PWA/service-worker cache busting. No meaning in a native binary.
- **`useKeepAwake` / `useAudioHealth` / `session-journal`** — workarounds for iOS *browser* limits that
  the native app fixes by construction. `expo-keep-awake` covers the screen case in one line. Deleting
  this layer is a real benefit of going native; copying it across would forfeit that.
- **`src/proxy.ts`** — cookie gate. The Bearer path is added *alongside* it in `apps/web`, not shared.

---

## 6. pnpm + Expo traps

### 6.1 Keep pnpm, flip one setting

**The problem is not pnpm.** React Native tooling — autolinking, CocoaPods podspec resolution, some
Babel plugins, Gradle codegen — assumes a classic **flat `node_modules`**. pnpm's default linker
(`isolated`: a symlink farm over a content-addressed store) violates that, and the failures are opaque
Kotlin/codegen errors that point nowhere useful.

Every package manager converges on the same requirement:

| Manager | Layout | Works with RN? |
| --- | --- | --- |
| npm workspaces | flat/hoisted | yes |
| Yarn 1 Classic | flat/hoisted | yes |
| Yarn 2+ Berry, `nodeLinker: node-modules` | flat/hoisted | yes |
| Yarn 2+ Berry, **PnP** (its default) | zip archives, no `node_modules` | **no** — `create-expo-app` explicitly sets `node-modules` for this reason |
| pnpm, `nodeLinker: isolated` (its default) | symlinked | **no** |
| pnpm, `nodeLinker: hoisted` | flat/hoisted | yes |
| Bun workspaces | flat/hoisted | yes |

So switching to npm or yarn buys you a flat `node_modules` — which one line of pnpm config already
gives you — and costs you a **re-resolved** dependency tree. The 84 KB `pnpm-lock.yaml` currently pins
a *working* Next 16 + React 19.2.7 + `@base-ui/react` + Dexie tree; `npm install` / `yarn install`
resolve afresh from the manifest ranges and you will not get the same tree. That risk lands on the web
app, which works today — exactly what this migration promised not to touch. It also costs
`workspace:*` support (thinner on npm), the content-addressed store, and churn across every `pnpm`
reference in the repo.

> The pnpm 9 → 11 upgrade **also** rewrites `pnpm-lock.yaml` — the `lockfileVersion` bumps and the diff
> is the whole file. The distinction is **re-formatted vs re-resolved**: pnpm carries existing
> resolutions forward, so what installs stays what installs. Expect a large, boring lockfile diff.

Expo has first-class monorepo support for Bun, npm, pnpm and Yarn, and EAS Build picks the manager
from whichever lockfile is committed — `pnpm-lock.yaml` included. There is no "EAS wants yarn"
constraint; posts saying so are stale.

**So: `packageManager: "pnpm@11.20.0"`** (current `latest`; `hoistingLimits` needs ≥ 11.5.0, and
settings living in `pnpm-workspace.yaml` instead of a separate `.npmrc` needs pnpm 11) **plus the
linker settings in step 2.**

`hoistingLimits: workspaces` is the part worth understanding: it mirrors Yarn's `nmHoistingLimits` and
hoists only as far as each workspace package, so `apps/mobile` gets the flat tree RN needs and
`apps/web` gets its own rather than one giant pile at the root. That matters because of the **honest
downside of hoisting: you lose pnpm's strictness.** Under `isolated`, importing an undeclared package
fails loudly; under `hoisted` it silently works until an unrelated bump removes it. `hoistingLimits`
contains the blast radius to one app. It's a real cost — and the *identical* cost you'd pay switching
to npm or yarn, so it isn't an argument for switching.

Set this **before** the first `expo prebuild`, not after a day of debugging pod install.

**Do not** keep the isolated linker and selectively hoist RN packages with `hoistPattern` /
`publicHoistPattern`. Negative hoist patterns don't work under the hoisted linker, and selective
hoisting under `isolated` is precisely where teams lose days to mystery codegen errors. Hoist
everything.

**Fallback order**, only if hoisted pnpm genuinely fails after a real attempt — never preemptively:
Yarn 4 with `nodeLinker: node-modules` (the most battle-tested RN monorepo setup after pnpm-hoisted),
then npm workspaces, then Bun (fast and Expo-supported, but novelty risk on a stack that already has
Expo, LiveKit and CallKit in flight).

**Known papercut:** `eas-cli` has misdetected pnpm workspaces as yarn
([expo/eas-cli#2978](https://github.com/expo/eas-cli/issues/2978)). Not a blocker — pin the manager
explicitly in `eas.json` if it bites.

### 6.2 Metro config: do nothing

SDK 52+ configures Metro for monorepos automatically via `expo/metro-config`. If you copy an old
StackOverflow `metro.config.js` with `watchFolders`, `resolver.nodeModulesPaths`,
`resolver.extraNodeModules` or `resolver.disableHierarchicalLookup`, you will **cause** the bugs those
lines were written to fix. Ship the generated file untouched. SDK 55 additionally enables
`expo.experiments.autolinkingModuleResolution` by default in monorepos.

### 6.3 One React, one React Native

Duplicate React versions in a single app cause runtime errors; duplicate React Native versions in a
monorepo are unsupported. `apps/web` has `react ^19.2.7`; Expo SDK 55 ships RN 0.83 + React 19.2 —
compatible, but the `^` range means a future `pnpm update` can silently split them. That's what the
`overrides` block in step 2's `pnpm-workspace.yaml` is for.

`packages/shared` must list `react` as neither a dependency nor a peer. It has no React in it, and
keeping it that way removes the whole class of problem.

### 6.4 Two `.env` files, one discipline

`apps/web/.env` keeps every secret. `apps/mobile` gets a `.env` with only public values
(`EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_AUTH0_DOMAIN`, `EXPO_PUBLIC_AUTH0_CLIENT_ID`).
`EXPO_PUBLIC_*` is inlined into the bundle exactly like `NEXT_PUBLIC_*`, so the existing "secrets stay
server-side" convention carries over unchanged. Never let `ELEVENLABS_API_KEY` or the Supabase
service-role key near `apps/mobile` — the signed-URL route exists precisely so the app never needs
them.

### 6.5 Tooling across two apps

- **ESLint** — three flat configs: `apps/web` (moved), `packages/shared` (new, step 3), `apps/mobile`
  (`eslint-config-expo`). RN rules and Next rules do not mix; a root config serving both is a false
  economy.
- **Prettier** — stays at the root, unchanged, covers everything.
- **`tsc`** — no project references needed. Each package typechecks independently; `pnpm -r typecheck`
  runs all of them. Add references only if incremental build time becomes a real complaint.
- **Turborepo** — not yet. Two apps and one leaf package don't need a task graph.

---

## 7. Rollback

Everything through step 6 is **a single revertable commit plus a Vercel Root Directory setting change
back to `.`**. No data migration, no schema change, no external reconfiguration — which is exactly why
it must be its own commit.

---

## 8. Server work worth doing before the Expo port

Both are small, both improve the web app on their own merits, and both remove a hard dependency from
the mobile port — so they de-risk it without committing to it.

1. **`GET /api/agent-versions`** — expose the active tutor versions over HTTP instead of only through
   the server-rendered page. The web `Select` can consume it too. This is the seam that lets the app
   never compile in a version list.
2. **Accept `Authorization: Bearer` on `/api/words-agent/signed-url` and `/api/lessons/session`.**
   `AUTH0_AUDIENCE` is already wired in `src/lib/auth0.ts` and already in `.env.example` (it exists for
   Supabase third-party RLS), so the API and audience may already be configured. This is the largest
   single risk item in the 2026-08-07 estimate (2–3 days) and it might be half-done — **verify first**;
   it could move the total estimate meaningfully.

Neither requires Expo. If the Expo plan is shelved in favour of telephony (decision #4 of the
2026-08-07 note), neither is wasted.

---

## 9. Sequence

| # | Step | Output | Est. |
| --- | --- | --- | --- |
| 0 | Confirm decision #4 (telephony vs app) from the 2026-08-07 note | go / no-go | — |
| 1 | Verify the Auth0 API + audience state (§8.2) | known auth cost | 0.5 d |
| 2 | **Workspace restructure — §4 steps 1–6** | green build, deployed, zero behaviour change | 0.5–1 d |
| 3 | `/api/agent-versions` + Bearer auth on the two routes | server ready for a native client | 1–2 d |
| 4 | `apps/mobile` scaffold, dev build, TestFlight | app on a real phone | 1–2 d |
| 5 | Tutor screen port + CallKit + background modes | the actual feature | 4–6 d |
| 6 | WebView shell + device testing | shippable | 3–4 d |

Steps 1–3 total ~2.5 days, are useful regardless of the Expo outcome, and are fully reversible.
Step 2 is the one that has to be a clean standalone commit.

---

## Sources

- [Expo — Work with monorepos](https://docs.expo.dev/guides/monorepos/) — automatic Metro config for
  SDK 52+, the properties to delete from a legacy `metro.config.js`, `nodeLinker: hoisted`, and the
  duplicate-React / duplicate-React-Native caveats.
- [Expo SDK 55 changelog](https://expo.dev/changelog/sdk-55) — React Native 0.83 + React 19.2,
  `autolinkingModuleResolution` on by default in monorepos.
- [ElevenLabs — React Native SDK](https://elevenlabs.io/docs/eleven-agents/libraries/react-native) ·
  [Expo integration guide](https://elevenlabs.io/docs/conversational-ai/guides/integrations/expo-react-native) —
  re-exports `ConversationProvider` and every hook from `@elevenlabs/react` with an identical API;
  dev builds required, no Expo Go.
- [pnpm — Node-Modules & Hoisting settings](https://pnpm.io/settings/node-modules) — exact names and
  values for `nodeLinker`, `hoistingLimits` (added in v11.5.0), `hoistPattern`, `publicHoistPattern`.
- [Callstack — React Native monorepo with pnpm workspaces](https://www.callstack.com/blog/react-native-monorepo-with-pnpm-workspaces) —
  why the hoisted layout behaves predictably for RN, and why Yarn PnP does not.
- [expo/eas-cli#2978](https://github.com/expo/eas-cli/issues/2978) — EAS misdetecting a pnpm workspace
  as yarn.
- [rphlmr/expo-nextjs-monorepo](https://github.com/rphlmr/expo-nextjs-monorepo) ·
  [nandorojo/expo-next-monorepo-example](https://github.com/nandorojo/expo-next-monorepo-example) —
  reference layouts for this exact Next + Expo + shared-package shape.
- `docs/2026-08-12-expo-app-creation.md` — what the native app does (supersedes the 2026-08-07 note) ·
  `docs/2026-08-12-expo-build-plan.md` — the build order. This note is where the code lives.
- `docs/2026-08-09-shareable-core-refactor.md` — how `src/shared/` came to exist.
- Why native at all — originally `docs/2026-08-07-ios-locked-screen-background-voice.md`, which no
  longer exists; the conclusion is restated in `docs/2026-08-12-expo-app-creation.md`.
