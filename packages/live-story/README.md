# @idiomatic/live-story

The **adaptive live-narrated story** subsystem (feature 006-adaptive-live-story). A ready
lesson is told *live* in the pinned teacher voice — no `<audio>` element — and the learner can
barge in to ask questions or steer the scenario, while every taught item is tracked to
completion. This package is the brain and the boundary for that mode; the platform
(ElevenLabs Conversational AI) owns the realtime audio.

## Why this is a package

Keeping the live-story logic in its own package means:

- **The agent's "brain" is isolated from the app.** The system prompt, the narration state
  machine, and the client tools have no Next.js / Supabase / DOM dependencies. They depend
  only on `@idiomatic/contracts` and `@idiomatic/generator`, so they're trivial to unit-test
  and reason about in isolation.
- **The dependency direction is enforced (app → package, never the reverse).** Instead of
  importing the web app's persistence types, the package exposes narrow ports the app
  implements: `LessonReader` (read lesson + items) and `LiveStoryRepository` (persist the
  transcript). The package never reaches back into app code.
- **Platform glue stays in the app.** Next.js routes, React hooks, the Supabase repository,
  and `process.env` reading all live in `apps/web`. The package contains zero realtime/audio
  handling — that is bought from ElevenLabs (Constitution Principle IV).

## What's inside

Source is grouped by concern. Everything is re-exported from the package root
(`@idiomatic/live-story`), so consumers never import a subfolder path directly.

```text
src/
  index.ts        # barrel — the package's public surface
  types.ts        # contracts the host app provides (Clock/IdGenerator, LessonReader, LiveStoryConfig)
  agent/          # the ElevenLabs agent contract
  narration/      # the pure core state machine
  services/       # server-side orchestration + token mint
  persistence/    # transcript storage boundary + in-memory impl
scripts/
  create-live-story-agent.ts   # provision the ElevenLabs agent (see "Deploy" below)
```

### `agent/` — the ElevenLabs agent contract

| File | Role |
|---|---|
| `agent-prompt.ts` | **Source of truth** for the system prompt configured on the ElevenLabs story agent, plus the client-tool descriptions. Versioned (`LIVE_STORY_PROMPT_VERSION`). |
| `client-tools.ts` | Thin glue (`advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson`) over the state machine; returns short instruction strings the agent continues from. |
| `plan-context.ts` | Builds the per-session dynamic variables (`{{lesson_summary}}`, `{{items_list}}`, …) injected into the prompt. |

### `narration/` — the pure core

| File | Role |
|---|---|
| `narration-state.ts` | **Pure** state machine: covered-set + completion guard, scenario pin (latest wins), clarification guard, caption reducer. No SDK/DOM. |

### `services/` — server-side orchestration

| File | Role |
|---|---|
| `start-story-service.ts` | `StartStoryService` — derives the plan (read-only), mints the conversation token, opens a `LiveSession`, returns grounding. Degrades to a clear "unavailable" outcome. |
| `transcript-service.ts` | `TranscriptService` — validates + persists turns incrementally (off the speech path); barge-in correction upserts a teacher turn in place. |
| `token.ts` | `mintConversationToken` — server-side ElevenLabs conversation-token mint (the `xi-api-key` never leaves the server). |

### `persistence/` — transcript storage boundary

| File | Role |
|---|---|
| `repository.ts` | `LiveStoryRepository` port + record types (the persistence boundary). |
| `in-memory-repository.ts` | `InMemoryLiveStoryRepository` — same owner-scoping as the real impl, for tests and the local dev stack. |

### `types.ts` — contracts the host app provides

A single file with the interfaces the package defines but expects the web app to implement or
fill in:

| Type | Role |
|---|---|
| `LessonReader` / `LessonView` | The minimal read shape the services need from the lesson store. |
| `LiveStoryConfig` | Server-side config (agent id, key, target-length window). The env reader that fills it lives in the app. |
| `Clock` / `IdGenerator` | Injectable ports so timestamps and ids are deterministic in tests. |

The feature-gate predicate lives on `StartStoryService.available()` (the agent id + key must
both be configured server-side).

## How the web app uses it

The app wires its own implementations into the package's ports at the composition root
(`apps/web/lib/container.ts`):

```ts
import {
  InMemoryLiveStoryRepository,
  StartStoryService,
  TranscriptService,
} from "@idiomatic/live-story";
import { SupabaseLiveStoryRepository } from "./supabase/live-story-repository"; // implements LiveStoryRepository
import { liveStoryConfig } from "./config"; // env reader → LiveStoryConfig

// `repo` is the app's LessonRepository — it structurally satisfies the narrow LessonReader port.
const startStory = new StartStoryService(repo, liveStoryRepo, liveStoryConfig(), logger);
const transcripts = new TranscriptService(repo, liveStoryRepo, logger);
```

The React hook (`app/lessons/[id]/live-story/useLiveStory.ts`) imports the pure pieces
directly:

```ts
import {
  buildClientTools,
  createNarrationState,
  appendCaption,
  scenarioPinText,
  type Caption,
} from "@idiomatic/live-story";
```

## Deploy / update the ElevenLabs agent

The live story runs against a dedicated **ElevenLabs Conversational AI agent**. The
`agent-prompt.ts` in this package is the canonical, version-controlled copy of that agent's
prompt + client-tool descriptions, but ElevenLabs hosts the running agent — so the source
here and the agent there must be kept in sync.

`scripts/create-live-story-agent.ts` provisions an agent that matches what the client expects:
the pinned teacher voice, a native Claude LLM, the versioned system prompt, the four client
tools (`advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson`), and the
dynamic-variable placeholders the plan grounding fills.

### First-time deploy

1. Set these in `.env`, `.env.local`, or `apps/web/.env.local` (the script reads all three;
   your api key never leaves your machine):

   | Variable | Required | Purpose |
   |---|---|---|
   | `ELEVENLABS_API_KEY` | ✅ | Creates the agent (and, at runtime, mints conversation tokens). |
   | `ELEVENLABS_TEACHER_VOICE_ID` | ✅ | The pinned teacher voice — must match the rest of the product (Constitution I). |
   | `LIVE_STORY_LLM` | optional | Agent LLM. Default `claude-haiku-4-5` (narration latency). |
   | `LIVE_STORY_TTS_MODEL` | optional | Realtime TTS model. Default `eleven_flash_v2` (English v2 required). |

2. Run the provisioning script:

   ```bash
   pnpm --filter @idiomatic/live-story provision:agent
   # or, from the repo root:
   pnpm provision:story-agent
   # with overrides:
   LIVE_STORY_LLM=claude-sonnet-4-6 pnpm provision:story-agent
   ```

3. The script prints the new `agent_id`. **Set it in `apps/web/.env.local`** (server-only):

   ```bash
   ELEVENLABS_STORY_AGENT_ID=<printed agent_id>
   ```

   The app is feature-gated on this: `ELEVENLABS_API_KEY` **and** `ELEVENLABS_STORY_AGENT_ID`
   must both be present, or the Live Story UI shows the "unavailable" panel.

### Updating an existing agent

The script **always creates a new agent** (it does not patch). To change the prompt or tools
on the agent you already point at, edit it in the **ElevenLabs Conversational AI dashboard**
for that `ELEVENLABS_STORY_AGENT_ID` — paste the updated `LIVE_STORY_SYSTEM_PROMPT` and bump
`LIVE_STORY_PROMPT_VERSION` here so the source stays the record of truth. Alternatively, re-run
the script to provision a fresh agent and swap `ELEVENLABS_STORY_AGENT_ID` to the new id.

## Develop

```bash
pnpm --filter @idiomatic/live-story typecheck
pnpm --filter @idiomatic/live-story test
```

The subsystem's tests currently live in the web app
(`apps/web/tests/**/live-story-*.test.ts`, `narration-state.test.ts`). Run the full gate from
the repo root before committing:

```bash
pnpm test && pnpm typecheck && pnpm lint
```

## Conventions

- Keep narration logic **pure** and in `narration-state.ts`; add client tools over it.
- Never put realtime/audio handling in this package (buy it from the platform).
- Never read `process.env` here — accept config through `LiveStoryConfig`.
- Add new pipeline events as `story.*` `EventId`s and emit through the injected logger.
