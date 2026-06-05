# Quickstart: Lesson Generation (002)

Get the Lesson Generator + web app running locally and verify the core flow: submit a list → generate a two-voice lesson → replay it privately.

## Prerequisites

- Node 20 LTS, pnpm
- Accounts/keys (server-side only — never commit, never expose to browser; Constitution V):
  - **Auth0** tenant (Next.js app) — identity (FR-017)
  - **Supabase** project — Postgres + a **private** Storage bucket for audio
  - **Anthropic Claude** API key — generation brain
  - **ElevenLabs** API key + two voice IDs (one learner, one **fixed** teacher voice reused by S2)
  - **LangSmith** key (optional locally; required for the generation eval gate)

## Setup

```bash
pnpm install

# Configure env (server-only). Copy and fill:
cp .env.example .env.local
#   AUTH0_*               Auth0 application + API config
#   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (server only)
#   NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY  (browser-safe)
#   ANTHROPIC_API_KEY
#   ELEVENLABS_API_KEY / ELEVENLABS_TEACHER_VOICE_ID / ELEVENLABS_LEARNER_VOICE_ID
#   LANGSMITH_API_KEY     (optional locally)

# Apply database schema + RLS policies (lessons, source_items, lesson_audio)
pnpm db:migrate

# Configure Supabase third-party auth to trust the Auth0 issuer (RLS keys on auth.jwt()->>'sub')
# (one-time, per research R7 — see infra/README)
```

## Run

```bash
pnpm dev          # Next.js app at http://localhost:3000
```

1. Sign in via Auth0 (unauthenticated users are gated — FR-017).
2. Go to **Lessons → New**, paste a list (e.g. `break the ice`, `spill the beans`, `under the weather`).
3. Submit → status shows **pending → generating** (FR-015), then **ready**.
4. Open the lesson → press play → hear two distinct voices teaching each item through a story (FR-008/FR-010/FR-013).
5. Sign out, sign back in → the lesson is still in your library and replayable (FR-018, Story 2).

## Verify (maps to acceptance + success criteria)

```bash
pnpm test                 # unit + contract (Vitest), providers mocked — no live keys (research R11)
pnpm test:contract        # LessonScript schema conformance + coverage-map guarantee (FR-009/SC-002)
pnpm test:e2e             # Playwright desktop + mobile viewports (SC-009)
pnpm eval:generation      # LangSmith generation quality gate (Constitution III) — needs LANGSMITH_API_KEY
```

Manual checks:

| Check | Expected | Ref |
|---|---|---|
| Submit 8 valid idioms | one ~5–10 min lesson, all 8 taught via stories | US1 / SC-002, SC-003 |
| Listen | two clearly distinct voices, not read-aloud | SC-004 |
| Submit empty list | rejected: "add at least one item" (no lesson created) | FR-004 / SC-007 |
| Submit 25 items | `413`, states limit 20, no silent drop | FR-005 / R1 |
| Submit gibberish only | declined: nothing teachable, revise | FR-007 |
| Submit valid + a few junk entries | lesson from valid items + skipped report | FR-006 |
| Open another learner's lesson id | `404` (not even existence leaks) | FR-019 / SC-005 |
| Kill the tab mid-generation, return | lesson finished and present | R6 / edge case |
| Force a generation failure | status `failed` + working retry | FR-016 / SC-008 |

## Project layout (where things live)

- `packages/contracts` — LessonScript Zod schema + DTOs (the subsystem boundary)
- `packages/generator` — Mastra workflow, versioned prompts, teachability, ElevenLabs render+stitch, evals
- `apps/web` — Next.js UI, authenticated API route handlers, Supabase persistence

## Out of scope here (later features)

Live interruption / spoken Q&A (S2), note capture (S3), cross-session adaptive progress (S4). The fixed teacher voice ID and the LessonScript contract are the seams S2 builds on.
