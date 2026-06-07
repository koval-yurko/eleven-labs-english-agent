# Idiomatic

An interactive English lesson generator. Give it a list of words, sentences, or idioms and it produces a short, story-driven **two-voice podcast** — a curious learner and a warm teacher who explains each item through vivid mini-stories. You can **interrupt at any moment** to ask the teacher a follow-up out loud and get a spoken answer in the same voice, or to jot a note, then pick up right where you left off. Lessons remember what you already know and adapt over time.

## What it does

- Turns any list of English items into an engaging, fun lesson (not a flashcard drill).
- Renders it as a natural two-voice podcast with real expressiveness.
- Lets you interrupt mid-lesson for a live, spoken Q&A — then resumes.
- Captures notes anchored to the exact word being discussed.
- Tracks what you've mastered vs. struggled with, and feeds it into the next lesson.

## Tech stack

**ElevenLabs Agents + Node.js** are the two headline choices, and they're related:

- **ElevenLabs Agents** runs the live, interruptible tutor. It's a managed cascaded pipeline (speech-to-text → LLM → text-to-speech) that owns the genuinely hard realtime parts — turn-taking, barge-in, low latency — out of the box. Cascaded (vs. speech-to-speech) is deliberate: it keeps the **transcript** (needed for notes, feedback, and progress) and lets the teacher keep a high-quality **ElevenLabs voice**, shared with the scripted podcast so the handoff is seamless.
- **Node.js / TypeScript** because ElevenLabs runs the voice transport on its own infra — so the only code we write is glue, and it's all available in TS. No Python runtime to operate. This keeps the whole system in one language end to end.

Supporting pieces:

| Concern | Choice |
|---|---|
| Frontend | Next.js (web) |
| Lesson generation | Mastra workflow + Claude |
| Scripted podcast audio | ElevenLabs Text to Dialogue (Eleven v3) |
| Live tutor LLM | Claude (native in ElevenLabs Agents) |
| Data & storage | Supabase (Postgres + Storage) |
| Auth | Auth0 |

## How it fits together

```
Word / idiom list
  → Lesson Generator (Mastra + Claude)      → structured script
  → ElevenLabs v3 Text to Dialogue          → two-voice podcast
  → Player (Next.js)                         → playback + transcript + notes
        ↕ interrupt
  → ElevenLabs Agent (live tutor, Claude)   → spoken Q&A in the same voice
  → Supabase                                 → notes + progress, reused next session
```

## Develop, run & verify

pnpm workspace (Node 20 LTS). Packages: `packages/contracts` (shared Zod schemas — the
subsystem boundary), `packages/generator` (lesson generation + evals), `apps/web` (Next.js
app + API + persistence).

```bash
pnpm install

# Configure env (server-only keys; never exposed to the browser — Constitution V).
cp .env.example .env                  # Anthropic, ElevenLabs voices, LangSmith, Supabase
cp apps/web/.env.example apps/web/.env.local   # Auth0 + Supabase for the web app

pnpm db:migrate                       # apply Postgres schema + RLS (lessons, source_items, lesson_audio)
pnpm --filter @idiomatic/web dev      # Next.js app at http://localhost:3000
```

### Quality gates

| Command | What it checks |
|---|---|
| `pnpm test` | Unit + contract + integration (Vitest); providers mocked, **no live keys needed** |
| `pnpm typecheck` | Strict TS across all packages |
| `pnpm lint` | ESLint (flat config) |
| `pnpm eval:generation` | Generation-quality gate — coverage, two-voice, story-not-definition, length. Runs LIVE with `ANTHROPIC_API_KEY` + `ELEVENLABS_API_KEY`, else deterministic mocks (length reported but not gated). Uploads runs to LangSmith when `LANGSMITH_API_KEY` is set. |
| `pnpm test:e2e` | Playwright submit → generate → replay across desktop + mobile viewports (SC-009). One-time `npx playwright install chromium`. |
| `pnpm smoke:generate` | One real Claude + ElevenLabs lesson written to `/tmp/idiomatic-smoke.mp3` |
| `pnpm check:bundle` / `pnpm rls:smoke` | Security hardening: no provider secrets in the client bundle; RLS smoke test |

**E2E auth:** the unauthenticated gating checks run anywhere. The full authenticated flow
needs a signed-in Auth0 session — supply a Playwright `storageState` file via
`E2E_STORAGE_STATE` (otherwise that test self-skips). Point at an already-running app with
`E2E_BASE_URL=http://localhost:3000 pnpm test:e2e`.

**Generation tracing:** `generateLesson` is wrapped by `generateLessonTraced`
(`packages/generator/src/workflow/tracing.ts`), which records a LangSmith trace per run when
`LANGSMITH_API_KEY` is set and is a transparent pass-through otherwise.

**Internal logging:** the generation pipeline emits structured, newline-delimited-JSON logs
to stdout (`packages/generator/src/observability/`), correlated by lesson id. Each run binds
a child logger to `{ lessonId, ownerId }`, so the whole trail — `lesson.status` transitions,
`teachability.*`, `generate.draft`/`coverage`/`result`, `render.batch`/`total`, and
`generate.error` — is retrievable by id alone.

```bash
LOG_LEVEL=info   # debug | info | warn | error (default: info)
LOG_PRETTY=1     # human-readable dev lines instead of raw NDJSON

# one lesson's complete, ordered trail:
jq -c 'select(.lessonId=="<LESSON_ID>")' app.log
# just the failing stage + reason:
jq -c 'select(.event=="generate.error")' app.log
```

Secrets are always redacted; raw learner item text and draft/prompt bodies appear only at
`debug` (Constitution V). Logging is best-effort and isolated — an emit failure never affects
generation. No external APM/log-shipping is added.

## Status

Early development. Full requirements, data model, API surface, and build phases are in [`PRD-base.md`](./spec/PRD-base.md).

> **Generation architecture note:** plan.md described the generator as a Mastra workflow with
> the `@mastra/langsmith` exporter. It is implemented as a plain, testable `generateLesson`
> orchestrator instead, so traceability is wired directly with the `langsmith` SDK (see
> "Generation tracing" above) rather than a Mastra trace stream.

### Follow-ups (before production)

- **Configure a user-JWT-scoped Supabase client to enforce RLS.** Today the app
  uses only the service-role client, so privacy relies on explicit `owner_id`
  filtering in code and the `0003_rls.sql` policies stay dormant. Later, add a
  parallel Auth0-token-scoped client (and the Auth0↔Supabase trust) so
  Row-Level Security becomes a live second layer. Steps are documented in
  [`supabase/README.md`](./supabase/README.md) §T037.

## MCP

```
claude mcp add --scope local --transport http supabase "https://mcp.supabase.com/mcp?read_only=true"

claude mcp remove supabase
```

