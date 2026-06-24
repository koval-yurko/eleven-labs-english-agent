# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Idiomatic** — an English lesson generator, **live-only**. A lesson is a Claude-generated teaching
*script*; the single learner experience is an adaptive, interruptible **live-narrated story** run by
ElevenLabs Conversational AI (voice + barge-in + STT/TTS + narrator agent whose LLM is Claude). The
live-session transcript (`live_sessions`/`session_turns`) is the only durable conversational record.
No audio is ever pre-rendered or persisted.

TypeScript (strict), Node 20 LTS, pnpm workspace. For a deep architecture walkthrough of `apps/web`
and the live-story flow, read `Explain.md`.

## Layout

```text
packages/contracts/   # shared Zod schemas + DTOs — the subsystem boundary
packages/generator/   # script-only lesson generation: adapters, prompts, evals, observability
packages/live-story/  # adaptive live-story: agent prompt, pure narration state machine, client tools, services
apps/web/             # Next.js App Router: UI, API routes, Auth0, Supabase persistence (stays thin — glue only)
supabase/migrations/  # Postgres schema, owner-scoped RLS
```

## Commands

```bash
pnpm test                  # unit + contract + integration (Vitest), providers mocked
pnpm typecheck             # strict TS across packages
pnpm lint                  # ESLint flat config
pnpm eval:generation       # generation-quality gate: coverage · two-persona · story-not-definition
pnpm smoke:generate        # one real Claude call → validates a generated SCRIPT (no audio)
pnpm provision:story-agent # push the versioned prompt/config to the ElevenLabs live-story agent
pnpm test:e2e              # Playwright (needs `npx playwright install chromium`)
pnpm db:migrate            # apply Supabase migrations
```

Before committing feature work: `pnpm test && pnpm typecheck && pnpm lint`.

## Invariants (the non-obvious rules)

- **Generation is script-only.** `generateLesson` (`packages/generator/src/index.ts`) returns
  `{ script, metadata }`; a lesson is **ready** on a valid script. Never synthesize, stitch, or store
  audio. Never reintroduce a server render path.
- **Voice is bought, not built.** ElevenLabs owns turn-taking/barge-in/VAD/STT/TTS. App code has no
  `<audio>` element and no STT/TTS. Keep realtime/audio handling out of app code.
- **Narration logic is pure.** All state lives in `packages/live-story/src/narration/narration-state.ts`
  (no SDK/DOM): covered-set + completion guard (conclude only when *every* item is covered AND the beat
  budget is spent — coverage always wins), scenario pin, caption reducer. Client tools
  (`agent/client-tools.ts`) are thin glue that mutate it and return the agent's next instruction string
  (the agent drives its own loop). The agent prompt (`agent/agent-prompt.ts`) is a versioned source
  artifact pasted onto the `ELEVENLABS_STORY_AGENT_ID` agent — re-provision with `pnpm provision:story-agent`.
- **Captions and transcript share one corrected-text path.** Consume only finalized turns (`onMessage`,
  `onAgentResponseCorrection`), never the tentative stream. Persistence is best-effort and OFF the speech
  path — a failed write must never interrupt narration. A teacher turn with a known `elevenTurnRef` is
  upserted in place. No realtime audio is ever persisted.
- **Secrets stay server-side.** `xi-api-key` and the Supabase service-role key never reach the browser —
  only a short-lived conversation token does. Privacy is enforced in code by `owner_id` filtering (Auth0
  sub); RLS is a defense-in-depth second layer. `pnpm check:bundle` / `pnpm rls:smoke` guard this.
- **Observability is a soft dependency.** Structured logger (`packages/generator/src/observability/`,
  injected port, NDJSON, secret-redacting) + LangSmith both degrade to no-ops without keys. Add new
  pipeline stages' `EventId`s to `observability/events.ts` and emit through the injected logger — never
  `console.log`. Raw learner text / draft bodies are gated to `debug`.

## Active Technologies
- TypeScript (strict) on Node 20 LTS (Constitution II). + Next.js (App Router) · LangSmith SDK (existing soft dep) + LangSmith (008-langsmith-tracing)
- Supabase Postgres. Forward migration `0007_live_story_tracing.sql` adds (008-langsmith-tracing)

## Recent Changes
- 008-langsmith-tracing: Added TypeScript (strict) on Node 20 LTS (Constitution II). + Next.js (App Router) · LangSmith SDK (existing soft dep) + LangSmith
