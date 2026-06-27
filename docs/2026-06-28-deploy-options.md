# Deploy options — cheapest & simplest (research)

_2026-06-28_

Research into the cheapest and simplest way to deploy this app. **TL;DR: deploy to
Vercel on the free Hobby plan via a GitHub push.** It's the lowest-friction, $0 option
and the app's shape fits it exactly. Everything below explains why, and what to pick if
Hobby's terms don't fit.

## What we're actually deploying

The thing that matters for hosting is that **this app is stateless**. It's a Next.js 16
(App Router) frontend + thin server layer; all persistent state and heavy lifting live in
external managed services we already pay for / use:

| Concern            | Where it lives            | Host has to…                  |
| ------------------ | ------------------------- | ----------------------------- |
| Database           | Supabase (managed PG)     | nothing — just hold a URL/key |
| Auth / sessions    | Auth0                     | run middleware + set cookies  |
| Voice conversation | ElevenLabs (client-side)  | mint a signed URL, then idle  |
| LLM calls          | Anthropic via LangChain   | short outbound HTTPS requests |
| Tracing            | LangSmith (optional)      | nothing                       |

Server surface is tiny: two API routes (`/api/health`,
`/api/words-agent/signed-url`), one server-actions file (`src/app/actions.ts`), and the
Auth0 auth gate in `src/proxy.ts`. **No database to host, no background workers, no
websockets held open server-side** — the ElevenLabs Conversational AI session is a direct
browser↔ElevenLabs connection (we only hand the browser a signed URL). This is the
easiest possible Next.js app to host.

### The one real constraint: Node.js runtime

`src/proxy.ts` runs `auth0.middleware()` on essentially every request, and we use server
actions. The Auth0 nextjs-auth0 v4 SDK and these paths want a **full Node.js serverless
runtime**, not an edge/Workers runtime. This is the single fact that ranks the options
below — it makes platforms that "just run Next on Node" (Vercel, Netlify, Railway,
Render) a clean fit, and makes Cloudflare (Workers/edge-first) the awkward one.

## Options, ranked for *this* app

### 1. Vercel — Hobby (free) — RECOMMENDED

- **Cost:** $0 on Hobby. Pro is $20/mo/solo if/when needed.
- **Simplicity:** highest. Import the GitHub repo → add env vars → deploy. Built by the
  Next.js team, so Next 16 features (server actions, middleware, ISR, Node runtime) work
  with zero adapters or config. Preview URL per PR, push-to-deploy.
- **Fit:** perfect. Nothing in the app needs anything Hobby lacks.
- **Watch-outs:**
  - **Hobby is non-commercial only.** Fine for a personal/learning project (this looks
    like one); if it becomes a commercial product you must move to Pro ($20/mo).
  - Set the env vars in the dashboard (all the secrets from `.env.example`), and set
    `APP_BASE_URL` + Auth0 **Allowed Callback/Logout URLs** to the deployed domain.

### 2. Netlify — free tier

- **Cost:** $0 (100 GB bandwidth, 125k function invocations, 300 build min/mo). Pro ~$20.
- **Simplicity:** very high, similar Git-push flow; runs Next on Node via its adapter.
- **Why #2 not #1:** equivalent effort to Vercel but one step less "native" for Next 16.
  **Its key edge: the free tier permits commercial use**, so it's the better $0 pick *if*
  this is/becomes commercial and you want to avoid Vercel Pro.

### 3. Railway — Hobby

- **Cost:** ~$5 credit first month, then ~$1/mo credit; realistically **~$5/mo** for an
  always-on small app. Flat $20/mo Pro (not per-seat) if it grows.
- **Simplicity:** high. Deploys the app as a normal Node container — full Node runtime, no
  Next-specific quirks. Could also host a DB later in the same project (we don't need to).
- **Why consider:** most predictable pricing and no "serverless function" caps; nice if
  you dislike usage-metered tiers. Not free, though, so it loses to Vercel/Netlify on cost.

### 4. Render — free / starter

- **Cost:** has a genuine free web-service tier (spins down when idle → cold starts), or
  ~$7/mo to stay warm.
- **Simplicity:** high, standard Node deploy. Comparable to Railway; the free tier's
  idle-spindown makes first request after idle slow — acceptable for a demo, not great UX.

### 5. Cloudflare (Pages/Workers via OpenNext) — NOT recommended here

- **Cost:** $0 and unbeatable bandwidth, BUT:
- **Fit is poor for this app.** Cloudflare runs Next on the Workers/edge runtime via the
  OpenNext/next-on-pages adapter. Our **Auth0 middleware + server actions expect Node
  APIs**, which is exactly the class of thing that needs workarounds or breaks on edge.
  The cheap bandwidth doesn't help a low-traffic, auth-gated app, and you'd trade away the
  "simplest" requirement. Skip unless you later re-architect to be edge-compatible.

## Cost summary

| Platform   | Cheapest plan | Monthly | Commercial use on free? | Effort | Runtime fit |
| ---------- | ------------- | ------- | ----------------------- | ------ | ----------- |
| **Vercel** | Hobby         | **$0**  | ❌ (Pro $20)            | ★ lowest | native    |
| Netlify    | Free          | **$0**  | ✅                      | ★ low  | good        |
| Railway    | Hobby         | ~$5     | ✅                      | ★ low  | full Node   |
| Render     | Free          | $0*     | ✅                      | ★ low  | full Node (*cold starts) |
| Cloudflare | Free          | $0      | ✅                      | ✗ high | edge — poor fit |

## Recommendation

**Use Vercel Hobby (free).** It's both the cheapest ($0) and the simplest (zero-config,
native Next 16), and the app has nothing that exceeds the Hobby tier. **If the project is
or becomes commercial, switch the $0 choice to Netlify** (commercial use allowed free), or
pay $20/mo for Vercel Pro. Reach for Railway only if you want flat, non-metered pricing.

## What changes are needed to deploy (verified 2026-06-28)

**No source-code changes are required.** `pnpm build` succeeds with zero env vars set —
every `process.env` read is lazy (inside functions, not module top-level), so the build
never throws on missing secrets, and the only failures would surface at request time.
`.env` is gitignored (only `.env.example` is tracked), so no secrets leak. Vercel
auto-detects Next.js 16 + pnpm, so **no `vercel.json` is needed**.

Applied to the repo:

- **`.nvmrc` → `22`** — pins the Node version on Vercel (satisfies `engines: ">=20"`).
  Chose 22 (active LTS) over 20 because **Node 20 reached EOL in April 2026** — pinning an
  EOL line means no security patches and eventual removal from Vercel. (`CLAUDE.md` still
  says "Node 20 LTS"; worth updating.)

Everything else is **configuration in the Vercel / Auth0 dashboards**, not code.

### Environment variables to set in Vercel

Runtime — required:

| Var | Notes |
| --- | ----- |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET` | from the Auth0 app |
| `AUTH0_SECRET` | generate fresh: `openssl rand -hex 32` |
| `APP_BASE_URL` | **must equal the Vercel domain** (see gotcha) |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client-visible |
| `SUPABASE_SERVICE_ROLE_KEY` | server secret |
| `ANTHROPIC_API_KEY` | server secret |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_TEACHER_VOICE_ID`, `ELEVENLABS_STORY_AGENT_ID` | secret + ids |

Optional: `AUTH0_AUDIENCE`, `ANTHROPIC_MODEL`, `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`,
`LANGCHAIN_TRACING_V2`.

**Do NOT set on Vercel:** `SUPABASE_DB_URL` / `DATABASE_URL` — only `pnpm db:migrate` uses
them, and migrations run locally, never on the web host.

### The one real gotcha: Auth0 + `APP_BASE_URL`

Auth0 SDK v4 keys off `APP_BASE_URL` and requires the callback origin to match exactly:

- Set `APP_BASE_URL` to the production Vercel URL (e.g. `https://your-app.vercel.app`).
- In Auth0, add that domain to **Allowed Callback URLs** (`…/auth/callback`) and **Allowed
  Logout URLs**.
- ⚠️ Vercel **preview deployments** get a unique URL per push, so login won't work on
  previews unless you also register those URLs in Auth0. Simplest: exercise auth only on
  the production domain.

### Deploy checklist (Vercel)

1. Push the repo to GitHub; "Import Project" in Vercel.
2. Framework auto-detected as Next.js — no build config changes needed.
3. Add the runtime env vars above. Keep secrets server-side — only `NEXT_PUBLIC_*` are
   client-visible (matches our convention).
4. Set `APP_BASE_URL` to the Vercel domain and update Auth0's Allowed Callback/Logout URLs.
5. Run `pnpm db:migrate` against Supabase once (locally, using `SUPABASE_DB_URL`) — the
   web host doesn't run migrations.
6. Deploy. Verify `/api/health` and the Auth0 login round-trip on the live URL.

## Sources

- [10 Best Next.js Hosting Providers in 2026 — makerkit.dev](https://makerkit.dev/blog/tutorials/best-hosting-nextjs)
- [Vercel vs Netlify 2026 — techsy.io](https://techsy.io/en/blog/vercel-vs-netlify)
- [Cloudflare vs Vercel vs Netlify 2026 — pravinkumar.co](https://www.pravinkumar.co/blog/cloudflare-vs-vercel-vs-netlify-2026-pick-one)
- [Platforms with a real free tier for developers in 2026 — render.com](https://render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026)
- [Best Vercel alternatives in 2026 — northflank.com](https://northflank.com/blog/best-vercel-alternatives-for-scalable-deployments)
