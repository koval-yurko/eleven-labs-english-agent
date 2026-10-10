# Splitting `apps/web` — `services/api` on Hono, `tutor-web` and `feedback-tracker` as clients

**Date:** 2026-10-10
**Status:** Steps 0–5 done in code (branch `services-split`); the deploy cutover is §8.1.
Production is unchanged until that cutover: the real-platform `waitUntil` check and the write paths are proved on its preview step.
**Question:** `apps/web` is three things in one Next.js project: the HTTP API, the domain logic and
jobs, and a deprecated learner UI plus the `/ops` operator pages. `apps/voice-worker` is a backend
process filed under `apps/`. How do we split these so that the folder a file sits in tells you what
it is and where it runs?

**Companions:** `docs/2026-08-09-shareable-core-refactor.md` (how `packages/shared` was carved out),
`docs/2026-08-09-expo-repo-structure-migration.md` (the workspace layout this extends),
`docs/2026-09-09-mobile-debug-reports-and-feedback.md` §12 (the `/ops` surfaces),
`docs/2026-08-28-env-variable-sync.md` (`env-sync.mjs` targets).

---

## 1. Decisions taken (2026-10-10)

| # | Decision |
| --- | --- |
| D1 | `/ops` leaves `apps/web` and becomes its own Next app, **`apps/feedback-tracker`**. |
| D2 | The rest of the web UI (learner pages, PWA, offline layer) becomes **`apps/tutor-web`**. It stays deprecated: kept compiling, no new features. |
| D3 | The API is rewritten in **Hono**. Next.js stops being the backend. |
| D4 | A new root folder, **`services/`**, holds everything that runs as a backend: `services/api` and `services/voice-worker`. |

Decisions from walking through the open questions (2026-10-10):

| # | Decision |
| --- | --- |
| D8 | **Delete `/demo`** with its `addPing` / `askClaudeAction` actions. No API endpoints are added for it. |
| D9 | **One Auth0 application:** `tutor-web` and `feedback-tracker` share today's web application. Both domains are added to its callback/logout URLs. |
| D10 | **`feedback-tracker` shows every learner's reports, and any authenticated user may read and triage them.** This is an accepted risk (§6.1). |
| D11 | **CLI scripts live in `packages/server/scripts`.** They load `services/api/.env`. Root script names are unchanged. |
| D12 | **The cookie-authenticated routes are removed from the API.** `tutor-web` serves those paths itself as same-origin proxies. `services/api` drops `@auth0/nextjs-auth0` and every cookie-session env key. |

D5–D7 are this document's own proposals, made in the sections that follow. D13 (`services/api`
bundles itself with esbuild) came out of the step 0 spike (§4.4).

## 2. What is there today (measured)

| Area | Size | Next.js coupling |
| --- | --- | --- |
| `apps/web/src/app/api/**` | 25 route handlers | Route-file convention only. `withBearer` → lib call → `json()`. Two per-route configs: `mcp` `maxDuration = 60`, `health` `revalidate = 0`. |
| `apps/web/src/lib/**` | ~5.5k lines | 6 of ~45 files import Next or Auth0-Next (see §2.1). |
| `apps/web/src/agent/**` | prompt registry, `agents.lock.json`, `sync-agents.ts`, Vapi/OpenAI/EL MCP config | None. |
| `apps/web/scripts/**` | migrate, level, enrich, lexicon, report, livekit-cost, dispatch fixture | None (tsx CLIs). |
| Learner UI (`/`, `/lessons`, `/lesson-items`, `/demo`, `/offline`, PWA) | ~3.8k lines TSX | Server components and server actions call `lib/` **in-process**. Cookie session. Dexie offline mirror. |
| `/ops/reports` | 2 pages, 7 server actions | Calls `lib/debug-reports*` in-process and is owner-scoped through the cookie session. |

### 2.1 The six Next-coupled `lib/` files

| File | Coupling | Fix |
| --- | --- | --- |
| `lib/http.ts` | `NextResponse.json` | Plain `Response` / Hono `c.json`. |
| `lib/auth/bearer.ts` | `NextResponse` types; Next's `ctx.params` shape | Becomes Hono middleware that sets `c.var.ownerId`. `getBearerOwnerId(req)` is already framework-free. |
| `lib/sync-flush.ts` | `after()` ×2 | The caller passes in a `defer(fn)` function. The API wires it to `waitUntil` (`@vercel/functions`). |
| `lib/tutor-session.ts` | `revalidatePath` | Move the revalidation out to the UI caller. The API has no page cache to revalidate. |
| `lib/auth0.ts`, `lib/auth/session.ts` | `@auth0/nextjs-auth0` cookie session | **UI-only.** Moves to `tutor-web` and `feedback-tracker`. The API never sees a cookie again. |
| `lib/sync/**` | `"use client"`, Dexie | **Browser-only.** Moves to `tutor-web`. |

`after()` is called in 6 places: `sync-flush.ts` ×2, `lesson-items/actions.ts` ×2,
`api/v2/livekit/session-end`, `api/v2/lessons/session` and `api/words-agent/elevenlabs-webhook`.
All of them become `waitUntil`.

Dead code found on the way: `lib/supabase/user-client.ts` (`getUserSupabase`) has no callers. Delete
it instead of porting it.

### 2.2 Routes that authenticate with the cookie session

The `/api/v2/*` namespace is bearer-only (`withBearer`). These routes still depend on the cookie
session:

| Route | Caller | After the split |
| --- | --- | --- |
| `GET /api/health` | monitors; `auth` section reads the cookie | Drop the cookie probe. Report `bearer` config presence instead. |
| `POST /api/lessons/session` | web `pagehide` beacon | Moves to `tutor-web` as a same-origin proxy (§5.2). |
| `GET /api/words-agent/signed-url` | web lesson page | Moves to `tutor-web` as a proxy to `/api/v2/words-agent/token`. |

The webhooks (`/api/words-agent/elevenlabs-webhook`, `/api/v2/vapi/webhook`) check their own
signatures, and `/api/mcp` checks `MCP_TOKEN`. They keep their paths unchanged.

## 3. Target layout

```text
apps/                         # clients — things a person opens
  mobile/                     # Expo (unchanged)
  tutor-web/                  # Next.js — deprecated learner UI; HTTP client of services/api   (D2)
  feedback-tracker/           # Next.js — debug-report triage (ex-/ops); HTTP client of services/api (D1)
services/                     # backends — things that run on a server                      (D4)
  api/                        # Hono on Vercel — every /api/** route, webhooks, MCP          (D3)
  voice-worker/               # LiveKit agent → LiveKit Cloud (git mv from apps/, unchanged)
packages/
  shared/                     # @tutor/shared — pure contract (unchanged)
  server/                     # @tutor/server — domain logic, framework-free, Node-only       (D5)
    src/                      #   lessons, words, lesson-items, debug-reports, levels, details,
                              #   lexicon, llm, langsmith-trace, livekit-ledger/cost, supabase,
                              #   config, agent-registry, mcp/add-words, auth/bearer (verify only)
    src/agent/                #   prompt registry + agents.lock.json + sync-agents
    scripts/                  #   migrate, level, enrich, lexicon, report, verify, livekit-cost
supabase/  docs/  spec/       # unchanged
```

### 3.1 Dependency rules (enforced by lint and `package.json`, not by convention)

```text
apps/mobile            → @tutor/shared                      (HTTP → services/api)
apps/tutor-web         → @tutor/shared                      (HTTP → services/api)
apps/feedback-tracker  → @tutor/shared                      (HTTP → services/api)
services/api           → @tutor/server → @tutor/shared
services/voice-worker  → @tutor/shared                      (HTTP → services/api, grant-auth)
```

- **D5 — `@tutor/server` is framework-free.** `no-restricted-imports` bans `next`, `next/*`,
  `@auth0/nextjs-auth0*`, `hono` and `react*`. It ships raw TS with no build step, the same way
  `@tutor/shared` does.
- **D6 — No client app depends on `@tutor/server`.** Only `services/api` may. This is the actual
  boundary: `tutor-web` and `feedback-tracker` hold **no** Supabase key, Anthropic key or
  ElevenLabs key. They hold only Auth0 web-client config and `API_BASE_URL`. This is stronger than
  today, where the deprecated UI runs with every server secret.
- `voice-worker` keeps its rule of never importing the prompt registry. With the registry inside
  `@tutor/server` and `@tutor/server` out of the worker's dependencies, that rule becomes a
  compile error instead of a code comment.

## 4. `services/api` on Hono

### 4.1 Shape

```text
services/api/
  src/
    index.ts              # export default app — Vercel's zero-config Hono entry
    app.ts                # new Hono(); mounts the routers below; onError → ApiErrorBody envelope
    middleware/
      bearer.ts           # getBearerOwnerId → c.set("ownerId"); 401 + CORS on failure (fails closed)
      cors.ts             # the D25 CORS policy, applied to /api/v2/* only
    routes/
      v2/lessons.ts       # /api/v2/lessons, /:id, /:id/items, /session
      v2/lesson-items.ts  # /api/v2/lesson-items, /:id, /delete, /popularity
      v2/words-agent.ts   # token, livekit-token, openai-token, vapi-token
      v2/livekit.ts       # session-end, collection-items (grant-auth, not bearer)
      v2/misc.ts          # me, agent-versions, lexicon/suggest, sync/flush, debug-reports
      v2/ops.ts           # NEW — feedback-tracker's endpoints (§6)
      webhooks.ts         # /api/words-agent/elevenlabs-webhook, /api/v2/vapi/webhook
      mcp.ts              # /api/mcp → createMcpHandler(...)(c.req.raw)
      health.ts
  vercel.ts               # maxDuration, framework: hono
  .env / .env.example     # every server secret (moved from apps/web)
```

### 4.2 Porting rules

1. **Same paths, same bodies, same status codes.** Mobile, the worker, ElevenLabs, Vapi and MCP
   clients see no change. `@tutor/shared/api` stays the contract. Every route gets a parity check
   (§8, step 3) before the cutover.
2. `withBearer(handler)` becomes `router.use("*", bearer)` on the v2 router. "A route that forgot
   to authenticate" must stay impossible to write, so the bearer middleware is mounted on the
   router, not added route by route. Public routes (webhooks, mcp, health, the grant-auth livekit
   routes) are mounted on separate routers that don't have it.
3. Dynamic params: `c.req.param("id")` replaces Next's `ctx.params` promise.
4. `after(fn)` becomes `waitUntil(fn())` from `@vercel/functions`. `@tutor/server` never imports it.
   It receives a `defer` callback (§2.1).
5. `export const dynamic = "force-dynamic"` is deleted. A Hono function is never prerendered.
6. `maxDuration`: Hono on Vercel deploys as **one function**, so durations can no longer be set per
   route. The current Vercel default (300 s) already exceeds MCP's 60, so set nothing unless the
   spike shows otherwise.

### 4.3 Risks to settle in the spike (§8, step 0)

| Risk | Why it matters | Check |
| --- | --- | --- |
| Vercel's Hono build bundling raw-TS workspace packages (`@tutor/shared`, `@tutor/server`) | Next did this via `transpilePackages`; Hono has no equivalent flag | Deploy a hello route that imports both to a preview. |
| `mcp-handler` outside Next | Its handler takes a Web `Request`, but it was written for Next | Run `/api/mcp` `tools/list` and one `add_words_to_collection` against the preview. |
| `waitUntil` actually running after the response | Enrichment and levelling depend on it | Add a word on the preview, then confirm `details_at` / `level_at` get stamped. |
| Local dev | `pnpm dev` must still give the mobile app a backend on `:3000` | `@hono/node-server` + `tsx watch`, or `vercel dev`. Pick whichever keeps the existing LAN URL working. |

### 4.4 Spike results (step 0, 2026-10-10, branch `spike/hono-api`)

**What the spike contains:**
- a stub `@tutor/server` (`packages/server/src/spike.ts`) that imports `@tutor/shared`, imports a
  sibling module extensionless, and schedules work through an injected `defer`;
- a Hono app (`services/api/src/index.ts`) with one route per risk.

`services/api/scripts/spike-probe.ts` runs 8 checks against any base URL. It was run three ways:

| Target | R1 workspace imports | R2 MCP (401, initialize, tools/list, tools/call) | R3 `waitUntil` | Router middleware + params |
| --- | --- | --- | --- | --- |
| `tsx src/dev.ts` (local dev) | PASS | PASS | PASS (response in 2 ms, job finished 3002 ms later) | PASS |
| `vercel build` output, **without** a build step (Vercel's own TS compile) | **FAIL**: `ERR_MODULE_NOT_FOUND …/@tutor/server/src/spike.ts` | not reached | not reached | not reached |
| `vercel build` output, **with** the esbuild step (D13) | PASS | PASS | PASS (1 ms / 3003 ms) | PASS |

**R1: Vercel's Node builder does NOT handle raw-TS workspace packages.** This was the one real
finding. Vercel's Node builder works like this:
- it compiles each file with `tsc` using `rewriteRelativeImportExtensions`, then traces the result
  with NFT;
- it ships the compiled `.js` and links the workspace packages in through `.vc-config.json`
  `filePathMap`;
- it never rewrites a package's `exports`. `@tutor/server`'s `"./*": "./src/*.ts"` therefore
  still points at a `.ts` file the function doesn't contain;
- `rewriteRelativeImportExtensions` only rewrites imports that are written with `.ts`. The
  extensionless style `@tutor/shared` uses (`./words/query`) would fail next, even if the
  `exports` problem were fixed.

The failure was reproduced by loading the built function with its `filePathMap` links recreated by
hand. `vercel build` itself reports success, so this would only have surfaced as a 500 on the
first deployed request.

**D13 — `services/api` bundles itself with esbuild** (`services/api/build.mjs`, `"build"` script):
- The entry is `src/index.ts` and the output is `server.mjs` at the package root.
- `@tutor/*` and relative imports are inlined. **Every npm package stays external**, so NFT still
  traces `node_modules` and native or optional dependencies behave as they do today.
- Vercel runs the `build` script itself. Its entrypoint search checks root `server.*` before
  `src/*` and logs "Multiple entrypoints found: server.mjs, src/index.ts. Using server.mjs."
  No `vercel.json` or `vercel.ts` is needed.
- **Rejected alternative:** compiling `@tutor/shared` to `dist/` with conditional exports. That
  would change how Metro and Next consume it and need `.js` extensions throughout `shared`, all to
  fix a problem only the API has.
- `server.mjs` is gitignored, and `tsx` serves `src/` directly in dev, so the bundle exists only on
  Vercel.

**Other findings:**
- **`mcp-handler@2.1.1` is framework-agnostic.** Its typings say so ("mount it at the route you
  want (a Next.js route handler, Hono, Nitro, ...)"), its `next` peer is optional, and nothing in
  `dist/` imports `next`. `app.on(["GET","POST","DELETE"], "/api/mcp", c => mcp(c.req.raw))` worked
  unchanged, including a `defer` call made from inside a tool.
- **pnpm installs `next` into `services/api` anyway,** as `mcp-handler`'s optional peer, because
  `next` exists elsewhere in the workspace. It isn't bundled, because NFT never reaches it. It
  should disappear when `apps/web` is deleted. Not worth an override.
- **The function is one 5.5 MB bundle,** including `hono`, `mcp-handler`, `@modelcontextprotocol`
  and both `zod` majors. With Vercel's 5 GB limit there's no concern until the real dependencies
  arrive.
- **Vercel's Hono route config 404s every path outside `/api`** (`"src": "^(?!/api).*$"`). That is
  fine, because every route lives under `/api`.
- **`vercel build` run locally performs its own `pnpm install`** and prunes the workspace tree to
  the API's dependencies. Run `pnpm install` afterwards. This only affects the spike, not CI.
- **R4 local dev:** `tsx watch src/dev.ts` on `@hono/node-server` works. The spike used port 3001
  to run beside `apps/web`. After the cutover it takes 3000, so the mobile app's LAN URL is
  unchanged.

**Not yet verified (needs a real preview deployment):** that `waitUntil` keeps the function alive
on Vercel's runtime. Locally, `waitUntil` falls back to letting the promise run, which proves the
wiring but not the platform. The probe's R3b reports `404 "unknown on this instance"` if a
different instance serves the follow-up read. In that case, the `[spike] deferred job … finished`
line in the runtime logs is the evidence.

## 5. `apps/tutor-web` (D2)

### 5.1 It becomes a BFF over `services/api`

Every in-process `lib/` call becomes a server-side `fetch` to `services/api` with a bearer token:

- `@auth0/nextjs-auth0` stays, but the web Auth0 client now **requests the API audience**
  (`AUTH0_AUDIENCE = AUTH0_API_AUDIENCE`). `auth0.getAccessToken()` then returns a JWT that
  `getBearerOwnerId` accepts, and `/api/v2/*` sees `tutor-web` exactly as it sees mobile. The
  comment in `bearer.ts` about keeping `AUTH0_AUDIENCE` off the web client stops applying, because
  the old reason (protecting the web login flow) is exactly the flow being changed here.
- A small `lib/api.ts` in `tutor-web` (`apiFetch(path, init)`) attaches the token and decodes the
  `ApiErrorBody` envelope. Server components and server actions call it.
- The server actions keep their names, so the components don't change. Only the bodies change:

| Server action | Becomes |
| --- | --- |
| `lessons/saveLessonSessionAction` | `POST /api/v2/lessons/session` |
| `lessons/flushOutbox` | `POST /api/v2/sync/flush` (already exists, and already calls the same `applyOps`) |
| `lesson-items/addWordAction` | `POST /api/v2/lesson-items` (the API's `waitUntil` now does the enrichment) |
| `lesson-items/bumpItemPopularityAction` | `POST /api/v2/lesson-items/popularity` |
| `demo/*` | **Deleted** together with the `/demo` page (D8) |

- `revalidatePath` stays in `tutor-web`'s actions, which is where it belongs (§2.1).

### 5.2 Same-origin proxy routes

Two browser-initiated calls can't attach a bearer header themselves:

- The `pagehide` **beacon** (`navigator.sendBeacon` can't set headers).
- The **ElevenLabs signed URL** fetch from the lesson page.

`tutor-web` keeps these two routes (`/api/lessons/session` and `/api/words-agent/signed-url`). Each
one reads the cookie session, then forwards to `services/api` with the bearer. This is the only
`app/api/**` that `tutor-web` has.

### 5.3 What moves with it

`lib/sync/**` (Dexie), `SyncProvider`, the service worker, the manifest, `proxy.ts` (the Auth0
gate, minus its `/api/*` and `/.well-known/*` branches) and all UI components.

## 6. `apps/feedback-tracker` (D1)

- Same BFF pattern as `tutor-web`: the shared Auth0 web application (D9), `apiFetch` with a bearer
  token, no server secrets.
- Its 2 pages and 7 server actions need API endpoints that don't exist yet. **New, under
  `/api/v2/ops/debug-reports`: bearer-authenticated and NOT owner-scoped (D10).** They read and
  write every learner's reports:

| Today (`ops/reports/actions.ts` / pages) | New endpoint |
| --- | --- |
| list page | `GET /api/v2/ops/debug-reports?status=&archived=` |
| detail page | `GET /api/v2/ops/debug-reports/:id` (includes verdict, diagnosis and links) |
| `triageReportAction`, `resolve…`, `reopen…` | `PATCH /api/v2/ops/debug-reports/:id` |
| `archive…`, `unarchive…` | `PATCH …/:id { archived }` |
| `archiveResolvedAction` | `POST /api/v2/ops/debug-reports/archive-resolved` |
| `deleteReportAction` | `DELETE /api/v2/ops/debug-reports/:id` |

  The DTOs go in `@tutor/shared/api`, alongside the existing `debug-reports` POST contract.
- Mobile never calls `/ops` endpoints, and the CORS policy for `/api/v2/ops/*` is "none": they are
  called server-to-server from `feedback-tracker`.
- `pnpm report <id>` (the CLI) is unaffected. It moves to `packages/server/scripts` and still reads
  the database directly.
- The `CLAUDE.md` exception ("`/ops` is the one non-deprecated part of `apps/web`") is replaced by
  this: `feedback-tracker` is an operator tool, **not deprecated**, and never linked from a learner
  surface.

### 6.1 Cross-owner access: an accepted risk (D10)

This is the codebase's first deliberate exception to "every query filters `owner_id`". The ops
router sits behind the bearer middleware only, and the queries take no `ownerId`. Because the
Auth0 web application is shared (D9) and the API audience is shared with mobile, "any
authenticated user" means **every learner**, not just the operator.

**What a learner's token could read through `/api/v2/ops/*`:**
- every report's description;
- `transcriptTail`;
- `deviceState`;
- the attached email, if one was given.

**What it could write:** triage status, archive state, and deletion.

**Accepted because** the only learner today is the operator.

**How it stays visible:**
- the ops router lives in its own file (`routes/v2/ops.ts`) with a header comment that points
  back here;
- every query function it uses has an explicit `AllOwners` name (`listAllDebugReports`,
  `updateDebugReportAnyOwner`), so a reviewer can't mistake them for owner-scoped reads;
- the `CLAUDE.md` ownership convention gets one sentence naming this exception.

**Trigger to close it:** the first learner who isn't the operator. **Fix:** an `OPS_OWNER_IDS`
env allowlist checked by a `withOperator` middleware on the ops router. It fails closed when unset
and returns 403 for a non-operator. That's one middleware and one env key. No route changes.

## 7. Deployment and configuration

| Deployable | Where | Domain |
| --- | --- | --- |
| `services/api` | **The existing Vercel project** (`eleven-labs-english-agent`), Root Directory `apps/web` → `services/api` | **Unchanged.** Mobile's `apiBaseUrl`, the worker's backend URL, ElevenLabs/Vapi webhook URLs and `MCP_PUBLIC_URL` all keep working with no reconfiguration. |
| `apps/tutor-web` | New Vercel project | New domain. Auth0 web app: add its callback/logout URLs. |
| `apps/feedback-tracker` | New Vercel project | New domain. Auth0: add callback/logout URLs to the same web application (D9). |
| `services/voice-worker` | LiveKit Cloud (unchanged) | Only the `Dockerfile` paths change. |

**D7 — The API keeps the production domain.** Every inbound integration points at it, and the
deprecated UI is the cheapest thing to move.

These steps need someone with dashboard access (I can't do them from here): the Vercel Root
Directory change, creating the two new Vercel projects, and the Auth0 URL allowlists.

Env:
- `services/api/.env` gets every key from today's `apps/web/.env`, minus `AUTH0_SECRET` /
  `APP_BASE_URL` / `AUTH0_CLIENT_*` (cookie-session keys the API no longer uses, per D12). It keeps
  `AUTH0_DOMAIN` and `AUTH0_API_AUDIENCE` for verification.
- `packages/server/scripts` has **no `.env` of its own**. Its dotenv loads `../../services/api/.env`
  (D11), so the jobs and the API can't drift onto different credentials.
- `tutor-web` and `feedback-tracker` get the same `AUTH0_*` values (one web application, D9, with
  `AUTH0_AUDIENCE` set), their own `APP_BASE_URL`, and `API_BASE_URL`. Nothing else.
- `scripts/env-sync.mjs` targets become `api | tutor-web | feedback-tracker | mobile | worker`.

## 8. Migration plan

Each step leaves `master` green (`pnpm typecheck && pnpm lint && pnpm check:shared` plus
`pnpm --filter mobile check`). Production stays on today's `apps/web` until step 5.

| Step | What | Done when |
| --- | --- | --- |
| 0 | **Spike** (§4.3) on a throwaway branch: a Hono preview deployment that imports both workspace packages and serves `/api/mcp` and one `waitUntil`. | All four risks answered. Findings appended to this doc. |
| 1 | **Extract `packages/server`.** `git mv` `lib/` (minus the UI-only files), `agent/` and `scripts/`, then fix the 6 couplings (§2.1) and delete `user-client.ts`. `apps/web` imports `@tutor/server` and keeps running on Next as before. Root scripts (`sync:agents`, `level:*`, `enrich:*`, `lexicon:*`, `report`, `db:migrate`) filter `@tutor/server`. | Production deploy of `apps/web` behaves identically. `sync:agents:plan` shows no diff. |
| 2 | **`git mv apps/voice-worker services/voice-worker`.** Add `services/*` to `pnpm-workspace.yaml`, then update the `Dockerfile` COPY paths, `livekit.toml` and the README links. | `pnpm --filter voice-worker check` passes; `lk agent deploy` from the new path works. |
| 3 | **Build `services/api` in Hono**, route by route, beside the still-live Next routes. Leave out the two cookie routes (D12). Add the new `ops` endpoints (§6, cross-owner per §6.1). Parity script: the same request against the `apps/web` preview and the `services/api` preview should give the same status and the same JSON. | The 23 ported routes plus the ops endpoints pass parity. Mobile pointed at the API preview runs a lesson end to end. |
| 4 | **Carve out the two Next apps.** `git mv` the UI into `apps/tutor-web` (history kept) and `/ops` into `apps/feedback-tracker`. Replace the in-process calls with `apiFetch`, add the two proxy routes, and point both at the `services/api` preview. | Both apps typecheck and build with no `@tutor/server` dependency. A login, add-word, lesson and triage round trip works against the preview. |
| 5 | **Cutover.** Change the Vercel Root Directory to `services/api` and deploy; create the `tutor-web` and `feedback-tracker` projects; update the Auth0 URLs; run `env-sync` pushes. Delete `apps/web`. | Mobile on production works with no app update. Webhooks arrive. `/api/mcp` answers. |
| 6 | **Docs and tooling.** Update `CLAUDE.md` (layout, commands, the `/ops` exception, "web is deprecated" → "tutor-web is deprecated", the D10 ownership exception), point the graphify scope at `services/`, then run `graphify update .`. | `graphify query "withBearer"` resolves to `services/api`. |

**Step 1, done 2026-10-10** (branch `services-split`). What landed, and where it departs from the
row above:

- **67 files moved with `git mv`**, with every relative import resolved against the old layout
  before it was rewritten. `apps/web` now imports `@tutor/server/<module>`. Inside the package the
  imports stay relative. A `"./agent/prompts"` entry in `exports` maps the registry's
  `index.ts`.
- **Split rather than moved:**
  - `auth/bearer.ts`: `getBearerOwnerId` moved to the server package; `withBearer` (`NextResponse`
    + CORS) stays in `apps/web`.
  - `tutor-session.ts`: `persistTutorSessionFor` moved; the cookie + `revalidatePath` wrapper
    stays in `apps/web/src/lib/tutor-session.ts`.
- **`Defer` is a thunk, `() => Promise<void>`** (`packages/server/src/defer.ts`), not the
  promise the spike used. `after(fn)` then still starts the work *after* the response, exactly as
  before the split. Hono will wire it as `(task) => waitUntil(task())`. `scheduleWordJobs(defer,
  ownerId)` and `registerAddWords(server, defer)` take it; the web app passes `deferAfter`
  (`apps/web/src/lib/defer.ts`).
- **Script env:** every script and `sync-agents.ts` read `.env` through
  `packages/server/scripts/env-home.mjs`. For now it points at `apps/web/`; D11's switch to
  `services/api/` is that one line, at step 5.
- **Stays in `apps/web` as UI or transport:**
  - transport: `http.ts`, `withBearer`;
  - UI: `auth0.ts`, `auth/session.ts`, `sync/**`, `asset-version.ts`, `format-date.ts`,
    `theme-css.ts`.
- **Deleted:** `supabase/user-client.ts` (no callers).
- **Boundary enforced:** `packages/server/eslint.config.js` bans apps/services, `next`,
  `@auth0/nextjs-auth0`, `hono`, `@vercel/functions`, React and Dexie. A probe file importing three
  of them fails with 3 errors.
- **Verified:**
  - `pnpm -r typecheck` (0 errors) and `pnpm -r lint` (clean);
  - `check:shared` (17/17);
  - `next build` of `apps/web`: same 25 API routes and pages;
  - `sync:agents:plan`: "nothing to do — every provider already matches the registry";
  - `db:migrate:status`, `level:items:plan`, `enrich:words:plan` and `report --list` all run from
    the new home;
  - mobile `check:logic` and `bundle` pass.
- **Pre-existing, not from this change:** `expo-doctor` fails 2 of its 20 checks. They are online
  checks (newer Expo SDK patch releases, React Native Directory metadata), and the lockfile diff
  touches no mobile package.
- **Applied migrations keep their old `apps/web/scripts/lexicon` comments.** They're history.

**Step 2, done 2026-10-10** (branch `services-split`):

- **The move:** `git mv apps/voice-worker services/voice-worker`, plus `services/*` added to
  `pnpm-workspace.yaml`. The lockfile change is the importer key alone (52 lines out, 52 in). The
  worker's `tsconfig` paths and its README links (`../../packages/...`) keep the same depth, so
  they still resolve.
- **Deploy surface updated:**
  - `Dockerfile` COPY / `download-files` / `CMD` paths;
  - `.dockerignore`;
  - `.gitignore` (`.local/`, `console-recordings/`);
  - `scripts/env-sync.mjs` (the `worker` target's directory);
  - the deploy workflow's path triggers, which now also include `packages/server/package.json`;
  - `livekit.toml` names no path and is unchanged.
- **The `Dockerfile` copies `packages/server/package.json` and prunes it after install.** The
  worker never depends on it.
- **Measured:** the install stage builds with or without that manifest. pnpm 11.20's
  `--frozen-lockfile --filter` tolerates a missing workspace member, so step 1 had not broken the
  image. The `Dockerfile` comment saying a missing member "makes it refuse" is stale for this pnpm.
  The line is kept anyway because it follows the file's "copy every member" rule.
- **Verified:**
  - `docker build --target build` (frozen install + `livekit-agents download-files` at the new
    path);
  - `pnpm --filter voice-worker typecheck / lint / check` (90 properties);
  - `pnpm -r typecheck`, `pnpm -r lint` and `check:shared`;
  - graphify resolves the worker's symbols under `services/voice-worker/`.
- **Not run:** `lk agent deploy`. It ships to production LiveKit Cloud, and the CI workflow does it
  on merge to `master`.

**Step 3, done 2026-10-10** (branch `services-split`). `services/api` serves 23 ported routes plus
3 new ops route files. It isn't deployed: `apps/web` still serves production.

*How the port was done, and where it departs from §4:*

- **Route bodies are copied, not rewritten.**
  - Each `apps/web/src/app/api/**/route.ts` (minus the two D12 cookie routes) was copied to
    `services/api/src/routes/**/route.ts`. The only mechanical edits were `../` depth, `after` from
    `lib/after`, and dropping Next segment config (`dynamic`, `maxDuration`).
  - `services/api/src/lib/{http,auth/bearer,after,defer}.ts` give the same API on `Response`, so the
    bodies read unchanged and the port reviews as a diff.
  - Hono only routes: `src/app.ts` is one table of path → module, with static paths before `:id`,
    and it hands handlers `(req, { params: Promise })` exactly as Next did.
- **Departs from §4.2 rule 2: `withBearer` stays a wrapper, not router middleware.** The
  handler's signature is the guarantee that a route can't be written without auth, and it's the
  one the ported bodies use. Ops routes use `withServerBearer` (no CORS).
- **A method a route doesn't export answers 405, as on Next.** Hono adds `Allow`, which RFC 9110
  requires and Next omitted. That's the one intended header difference, and parity skips it.
- **`after` (`lib/after.ts`) is `waitUntil(task())`.** The task starts immediately rather than
  after the response is flushed. Every caller does its own work first and schedules only
  observability or enrichment, so nothing a response depends on races it.
- **`/api/health`'s `auth` field reads the bearer token** instead of the cookie session. The
  field and its contract are kept, and it still never affects the status code.
- **Extends D13: the bundle inlines npm packages too.**
  - `hoistingLimits: workspaces` puts `@tutor/server`'s dependencies in
    `packages/server/node_modules`, which an external import from `services/api/server.mjs`
    can't see. The spike's stub had no dependencies, so it never hit this.
  - Kept external: `hono` (framework detection), `@vercel/functions`, and
    `@elevenlabs/elevenlabs-js`.
  - The ElevenLabs SDK was 7.5 MB, 63% of the bundle, and only the ElevenLabs webhook uses it. On
    Next each route was its own function; on Hono every cold start would parse it. The webhook now
    `import()`s it lazily, and the bundle went from 12.1 MB to 3.8 MB.
  - A `createRequire` banner lets bundled CommonJS `require` Node builtins.
- **Ops endpoints (§6):**
  - `GET /api/v2/ops/debug-reports` (list + facets + resolved count);
  - `GET|PATCH|DELETE …/:id` (the detail view resolved server-side: transcript, links, prompt
    version, verdicts with labels, diagnosis);
  - `POST …/archive-resolved`.
  - DTOs are in `@tutor/shared/api`. The row types moved to `@tutor/shared/debug/report`, and
    rows now carry `owner_id`.
  - **Departs from §6.1:** instead of `…AllOwners` function names, `debug-reports.ts` takes
    `owner: string | typeof ALL_OWNERS`, where `ALL_OWNERS` is a `unique symbol`, so no request
    string can become it and every cross-owner call site names it. Owner-scoped callers (`/ops`,
    `pnpm report`) are unchanged.
  - The detail view joins the transcript on the report's own `owner_id`, so the only cross-owner
    read is the report itself.

*Verified:*

- **Parity (`services/api/scripts/parity.ts`, read-only by construction): 66/66**, in three runs.
  Each compared old (`apps/web` via `next start`) against new:
  - new as the source bundle;
  - new as the bundle served with Node;
  - new as **the function directory `vercel build` produced**. Vercel picked `server.mjs`, and
    tracing shipped `hono`, `@vercel/functions` and `@elevenlabs` (24 MB function).
- **What parity compares:**
  - 401s with and without a malformed token, every v2 CORS preflight, and 405s;
  - grant-less worker routes and unsigned webhooks;
  - an ElevenLabs webhook with a stale signature, which proves the lazy SDK import loads in the
    built function;
  - MCP without its token, and health's shape;
  - **every authenticated GET the mobile app makes, compared exactly against a real learner's
    data:** `me`, agent versions, lessons, a lesson, its items, items (two sorts), an item, lexicon
    suggest;
  - the ops endpoints (401 without a token, 405 on preflight, the list with `owner_id`, the detail
    view's keys, a 404, a 400 for an empty PATCH).
- **How authenticated parity ran without an Auth0 token:**
  - a throwaway local issuer (self-signed certificate, trusted by `NODE_EXTRA_CA_CERTS`) served a
    JWKS as `parity.localtest.me` and minted RS256 tokens;
  - both servers were pointed at it through env overrides on those two local processes only;
  - `nextjs-auth0` rejects `localhost` and ported domains, hence `localtest.me`;
  - nothing was written, and the issuer, its key and its token were deleted afterwards.
- `pnpm -r typecheck` (0 errors), `pnpm -r lint`, `check:shared` 17/17, and `next build` of
  `apps/web`.

*Not yet verified (needs a preview deployment, which is your call):*

- `waitUntil` keeping the function alive on Vercel's runtime (as in the spike, §4.4);
- writes: word add → enrichment stamped, sync flush, lesson session, debug report, worker session
  end;
- a full mobile lesson against the preview.

**Step 4, done 2026-10-10** (branch `services-split`). `apps/tutor-web` and `apps/feedback-tracker`
exist, and both are HTTP clients of `services/api` with no `@tutor/server` dependency.

*What moved:*

- **55 files moved with `git mv`** (history kept):
  - the learner UI, `public/`, `lib/sync`, `asset-version`, `format-date` and `theme-css` →
    `apps/tutor-web` (same relative layout, so no import rewrites);
  - `/ops/reports/**` → `apps/feedback-tracker/src/app/reports/**` (`/ops` is dropped from the
    URLs).
- `/demo` was deleted (D8).
- **`apps/web` is API-only until step 5:** route handlers plus `http`, `auth/bearer`, `defer`,
  `tutor-session`, `auth0`, `auth/session` and `proxy.ts`. It still serves production and builds
  with all 25 routes. Its UI dependencies are gone.
- **`feedback-tracker` has its own copies** of `Button`, `ConfirmDialog`, `ThemeToggle`, `Tooltip`,
  `icons`, `globals.css`, `theme-css` and `format-date`, never a relative import into another app.
  A shared UI package for two Next apps, one of them deprecated, isn't worth it.

*How data flows:*

- **`lib/api.ts`** (in both apps): `apiFetch` / `apiFetchOrNull` / `apiRequest`, server-side only.
  It sends `auth0.getAccessToken()` as the bearer to `API_BASE_URL`, with `cache: "no-store"`.
  `AUTH0_AUDIENCE` must equal the API audience, and the comment in `auth0.ts` explains why it's no
  longer left unset.
- **Each `@tutor/server` call became one v2 call:**
  - lessons list → `GET /lessons`;
  - lesson page → `GET /lessons/:id` + `/items` + `/agent-versions`. The API caps sessions at its
    page size and reports `sessionCount`;
  - items page → `GET /lesson-items?…` (rows and facets in one call);
  - item page → `GET /lesson-items/:id`.
  - Detail pages turn **any** failure into a 404, as before, so a malformed id never shows an error
    page.
- **Server actions keep their names and signatures:**
  - `saveLessonSessionAction` → `POST /lessons/session`;
  - `flushOutbox` → `POST /sync/flush`. Revalidation targets now come from the applied records' op
    kinds, since the API answers with ids only;
  - `addWordAction` / `bumpItemPopularityAction` → `POST /lesson-items` / `…/popularity`. The
    level and enrichment fast paths now run in the API, not the action;
  - the ops actions → `PATCH|DELETE /ops/debug-reports/:id` and `POST …/archive-resolved`.
- **Same-origin routes (§5.2):** `POST /api/lessons/session` (the beacon) and
  `GET /api/words-agent/signed-url` forward the body with the bearer attached
  (`lib/forward.ts`).
- **A new API route was needed:** `GET /api/v2/words-agent/signed-url`, because the web lesson
  connects over WebSocket and the v2 `token` route is WebRTC.
  - The v1 route it replaces **had no auth check of its own**, and the web gate let every `/api/*`
    request through, so in production anyone can currently mint ElevenLabs signed URLs on our key.
  - The v2 route requires a bearer. The v1 route disappears with `apps/web` at step 5.
- **feedback-tracker** renders the detail endpoint's server-computed `diagnosis` and `verdicts`, so
  `StateDiff` and `Verdicts` hold no rules. Additions:
  - a Learner column on the list (the tail of `owner_id`) and a Learner field on the detail page;
  - the lesson link points at tutor-web only when `TUTOR_WEB_URL` is set.
  - `RESOLVED_STATUS` moved to `@tutor/shared/debug/report`, and the server re-exports it.
- **Boundaries:** both apps' ESLint configs ban `@tutor/server`, `packages/server`, `services/` and
  the other apps. `transpilePackages` names only `@tutor/shared`.

*Verified:*

- `pnpm -r typecheck` (8 packages, 0 errors), `pnpm -r lint` clean, and `next build` of all three
  Next apps.
- **End to end, signed in, against real data: 16/16.**
  - Setup: a throwaway local JWKS issuer (as in step 3), `services/api` trusting it, and session
    cookies minted with nextjs-auth0's own `@auth0/nextjs-auth0/testing` →
    `generateSessionCookie`.
  - tutor-web:
    - `/lessons` renders all 34 of the learner's lesson titles;
    - a lesson page renders its title and every active word;
    - `/lesson-items` renders the API's rows, and an item page renders its word;
    - unknown and malformed ids give 404;
    - the signed-URL route forwards (unknown version → the API's 400, no ElevenLabs call), and
      gives 401 without a session;
    - the beacon forwards (unknown lesson → 404, nothing stored).
  - feedback-tracker:
    - `/reports` renders all 30 reports with the Learner column;
    - a detail page renders;
    - an unknown report gives 404, and `/` redirects to `/reports`.
  - Without a session, both apps redirect pages to `/auth/login`.
  - No form action was submitted, so nothing was written. The issuer, its key, the token and the
    cookies were deleted afterwards.
- **Follow-up, not a regression:** an API route given a non-UUID id throws, and Hono answers a
  plain-text 500 (Next answered an empty 500). The clients turn it into a 404. An `app.onError`
  that returns the `ApiErrorBody` envelope would be tidier.

*Not verified (needs the real Auth0 tenant):* the login round trip itself
(`/auth/login` → callback), which needs both apps' origins in the Auth0 application's allowed
callback and logout URLs; and the access token Auth0 issues once `AUTH0_AUDIENCE` is set.

**Step 5, code side done 2026-10-10** (branch `services-split`). The repo is in its final shape.
The deploy cutover (§8.1 below) is a dashboard job, and it hasn't happened yet.

*What changed:*

- **`apps/web` is deleted.** Its env registry was moved with `git mv` to
  `services/api/.env.example`, minus the cookie-session keys (D12).
- **`ENV_HOME` points at `services/api/`**, so the CLI jobs and the API read one `.env` (D11).
  `sync:agents:plan`, `db:migrate:status`, `enrich:words:plan` and `report --list` were re-run
  from it.
- **`pnpm dev` runs `services/api` on :3000**, the old Next port, so the phone's LAN `apiBaseUrl`
  is unchanged. The web apps' `API_BASE_URL` defaults to `http://localhost:3000`.
  `pnpm build` builds the three Vercel deployables.
- **`scripts/env-sync.mjs` targets:** `api | tutor-web | feedback-tracker | mobile | worker`.
  - Each Vercel target has its own linked directory: `api` uses the existing project linked at the
    repo root; each web app is linked in its own folder.
  - An unlinked target is skipped with "run `vercel link` in apps/…" rather than failing.
- **Worker `Dockerfile` and deploy workflow** list the new workspace manifests. The `docker build
  --target build` install stage passes.
- **`parity.ts`** now requires `--old` and `--new` (there is no local baseline left). Its job is
  the deploy cutover: production against a `services/api` preview.
- **Found while verifying, now fixed: Vercel would have installed with pnpm 9.**
  - Vercel reads the package manager from the Root Directory's `package.json`. Without one it
    logs "Using pnpm@9.x based on project creation date", and pnpm 9 silently ignores
    `pnpm-workspace.yaml` (`nodeLinker`, `overrides`, `allowBuilds`).
  - The three deployables now declare `"packageManager": "pnpm@11.20.0"`.
  - `ENABLE_EXPERIMENTAL_COREPACK=1` is in each one's env registry, so `env:push` sets it on the
    project. Verified with a local `vercel build`: "Detected ENABLE_EXPERIMENTAL_COREPACK=1 and
    "pnpm@11.20.0"" → "using pnpm v11.20.0".
  - Whether today's `apps/web` production build was already on pnpm 9 is unknown from here; its
    build log would say.
- **`next` is still installed under `services/api`** as `mcp-handler`'s optional peer. The two web
  apps keep it in the workspace, so §4.4's "disappears with `apps/web`" was wrong. It's never
  bundled.
- **Updated for the new layout:** `CLAUDE.md`, `README.md` (rewritten for the new layout), the
  mobile "copied from the web" pointers (→ `apps/tutor-web`), and the shared, server and worker
  comments. Applied migrations and dated docs keep their old paths, as history.

*Verified:*

- `pnpm -r typecheck` (7 packages, 0 errors), `pnpm -r lint` clean, `check:shared` 17/17, and
  mobile `check:logic`;
- `next build` of both web apps;
- local `vercel build` of `services/api` with corepack;
- `pnpm dev` → `/api/health` reports Supabase, ElevenLabs and Anthropic ok, and `/api/v2/me` gives
  401 without a token;
- the worker image's install stage.

#### 8.1 The deploy cutover: your checklist

These need dashboard access. Order matters: the API's domain must answer the phone at every
moment, and the web apps are new projects, so they can go live before or after it.

1. **Preview the API first.** In the existing Vercel project (`eleven-labs-english-agent`), add
   `ENABLE_EXPERIMENTAL_COREPACK=1` (Production and Preview). Then deploy this branch as a preview
   with **Root Directory = `services/api`** (Settings → Build → Root Directory). Keep "Include
   files outside the root directory" on, because the build needs the workspace, lockfile and
   `packages/`.
   - Confirm the build log says pnpm 11.20.0 and "Using server.mjs".
2. **Prove the preview.**
   - Run `pnpm parity:api --old https://<production> --new https://<preview> --token-file <token>`.
     The token is an access token from the phone or Auth0. Expect a pass on every check, with the
     health shape and `allow` header skipped as documented.
   - Then point a dev build of the phone at the preview and run one lesson: start, speak, save a
     word, end. That is the check for `waitUntil` on the platform and for the write paths (§4.4,
     step 3 notes).
3. **Create the two web projects.** Two new Vercel projects from this repo:
   - Root Directory `apps/tutor-web` and `apps/feedback-tracker`;
   - Framework Next.js;
   - `ENABLE_EXPERIMENTAL_COREPACK=1`, the Auth0 web keys, `AUTH0_AUDIENCE` = the API audience, and
     `API_BASE_URL` = the API's production origin;
   - for feedback-tracker, `TUTOR_WEB_URL` as well.
   - Then run `vercel link` in each app folder, and `pnpm env:push` / `env:diff` take over from
     there.
4. **Auth0.** In the existing web application, add each new origin's `/auth/callback` to Allowed
   Callback URLs and the origin to Allowed Logout URLs (D9). Log in to both; the login round trip
   is the one thing no local test could cover.
5. **Promote.** Merge to `master`. The existing project now builds `services/api` on the same
   domain, so the phone, webhooks, MCP and the worker change nothing.
6. **Afterwards:**
   - `pnpm env:diff --target api` will list `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`,
     `AUTH0_SECRET` and `APP_BASE_URL` as remote-only. They're unused by the API (D12) and can be
     removed from the project.
   - Point any uptime monitor at `/api/health` as before.

**Your local checkout** keeps the env files git doesn't move. Copy `apps/web/.env` →
`services/api/.env` and drop the four cookie keys. Each web app's `.env` comes from its
`.env.example`, using the same Auth0 web keys plus `AUTH0_AUDIENCE` set to the API audience.

Rollback for step 5: point the Vercel Root Directory back to `apps/web` at the last pre-cutover
commit. The domain never moved, so nothing external has to be reverted.

## 9. Open questions: resolved 2026-10-10

| Q | Question | Answer | Recorded as |
| --- | --- | --- | --- |
| Q1 | Delete `/demo`? | Yes, delete. No endpoints are added for it. | D8 |
| Q2 | One Auth0 web application or two? | One, shared by `tutor-web` and `feedback-tracker`. | D9 |
| Q3 | Should `feedback-tracker` stay owner-scoped? | No. It shows every learner's reports, and any authenticated user may access them. | D10, §6.1 |
| Q4 | Where do `scripts/` live? | `packages/server/scripts`, loading `services/api/.env`. | D11 |
| Q5 | Remove the cookie routes from the API? | Yes. `tutor-web` proxies those paths. | D12 |

Nothing is open. The next step is step 0, the spike (§8).
