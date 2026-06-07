# Quickstart: Adaptive Live Story (006-adaptive-live-story)

How to provision, configure, run, and verify the adaptive live-narrated lesson. Builds on 002 (lessons generate + play) and 005 (live Q&A). The new mode narrates the lesson **live** — there is no `<audio>` element in the live-story UI; on unavailability it shows its own retry/try-later panel (research R7).

## 1. Provision the live-story Agent (one-time, ElevenLabs dashboard)

Create a **dedicated Conversational AI Agent** for the live story (separate from the 005 tutor agent, so each prompt/tool set is tuned independently — research R10):

- **Voice**: set to the **pinned teacher voice** — the same id as `ELEVENLABS_TEACHER_VOICE_ID` (Constitution I: scripted podcast, live tutor, and live narration MUST be the same voice). For the **TTS model**, pick a real-time model such as **Flash v2** (`eleven_flash_v2`) for low-latency narration + barge-in.
- **LLM**: select **Claude Haiku 4.5** natively (no custom LLM proxy); **reasoning off** for conversational/narration latency.
- **Pipeline**: cascaded STT → LLM → TTS (default; **not** speech-to-speech — the transcript must stay available, Constitution).
- **System prompt**: paste the versioned template from `apps/web/lib/live-story/agent-prompt.ts`. It makes the agent (a) **narrate the lesson beat by beat** in the teacher persona, (b) after each beat call **`advanceNarration`** and follow its instruction, (c) call **`markItemTaught`** when it teaches a planned item, (d) on a learner barge-in, decide **question vs. scenario change** — answer briefly, or call **`setScenario`** — then resume toward remaining items, (e) treat empty/unintelligible input as "ask to repeat" (never fabricate), and (f) call **`concludeLesson`** only when all items are taught. It uses dynamic variables `{{lesson_summary}}`, `{{items_list}}`, `{{beats_outline}}`, `{{target_minutes}}`, `{{scenario}}`.
- **Client tools**: declare the four tools the agent may call — **`advanceNarration`** (no params), **`markItemTaught`** (`itemId`), **`setScenario`** (`scenario`), **`concludeLesson`** (no params). Their handlers run in the browser (`apps/web/lib/live-story/client-tools.ts`) and return a short string the agent uses to continue. Contracts: `contracts/live-story.schema.json` → `ClientToolContract`.
- **Dynamic variables**: enable and declare `lesson_summary`, `items_list`, `beats_outline`, `target_minutes`, `scenario`.
- **Auth**: keep the agent **private** (the app mints a conversation token server-side).
- **Interruptions**: leave the agent **interruptible** (default) so the learner can barge in over narration or an answer (US2/US3).

Copy the agent id → `ELEVENLABS_STORY_AGENT_ID`.

### Scriptable alternative

If the 002/005 `pnpm provision:agent` helper is extended, run it with the story prompt + client-tool
declarations from `apps/web/lib/live-story/agent-prompt.ts`; it reads `ELEVENLABS_API_KEY` +
`ELEVENLABS_TEACHER_VOICE_ID` (key never leaves your machine) and prints the
`ELEVENLABS_STORY_AGENT_ID` line to paste into `apps/web/.env.local`.

## 2. Environment

Add to `apps/web/.env` (server-only; reuse existing ElevenLabs vars):

```
# Live story (006)
ELEVENLABS_STORY_AGENT_ID=agent_story_xxx   # the provisioned live-story agent
# reused:
# ELEVENLABS_API_KEY=...                     # server-only; mints conversation tokens
# ELEVENLABS_TEACHER_VOICE_ID=...            # must equal the story agent's voice
# TARGET_MIN_SECONDS / TARGET_MAX_SECONDS    # clamp the plan's target length (R8)
```

Live story is **feature-gated**: if `ELEVENLABS_API_KEY` or `ELEVENLABS_STORY_AGENT_ID` is missing, the live-story UI shows a clear "live unavailable" panel with a **retry / try-later** affordance — never a blank/frozen screen (FR-026, research R7; the modes stay decoupled — no pre-render substitution).

## 3. Database migration

```bash
# Requires SUPABASE_DB_URL (Supabase → Project Settings → Database → Connection string → "URI";
# Session pooler / port 5432 on IPv4-only networks).
pnpm db:migrate:status   # preview applied vs pending (no changes)
pnpm db:migrate          # applies supabase/migrations/0005_live_story.sql
                         #   (live_sessions, session_turns + RLS)
```

## 4. Client SDK

`@elevenlabs/react` is already installed (005). No new client dependency — the new mode uses the same SDK's `clientTools`, `sendContextualUpdate`, `onMessage`, and `onAgentResponseCorrection` (verified SDK surface).

## 5. Run & verify (happy path)

```bash
pnpm --filter @idiomatic/web dev
```

1. Sign in, open a **ready** lesson, choose **Live Story** (the live, interruptible mode).
2. Grant microphone access (hands-free requires a live mic).
3. The teacher **starts narrating live** in the teacher voice, working through the plan's beats. **Subtitle captions** of the teacher's speech appear, finalized turn by turn (US4).
4. Let it run uninterrupted → it teaches **every planned item** and reaches a **natural ending** within the target length (US1, SC-001/SC-002).
5. Restart and **say "make this about space travel"** mid-lesson → narration shifts to the new setting, **stays there**, and still teaches every item (US2, SC-003/SC-004).
6. **Ask a question** out loud → narration stops fast (≤~0.5s, SC-005), a relevant spoken answer comes back in the teacher voice, then narration continues toward remaining items (US3, SC-006).
7. **Barge in mid-sentence** → the teacher caption for that turn is **corrected** to only what was actually spoken (US4, SC-008).
8. Leave, return later, open the lesson → the **durable text transcript** (narration + Q&A, corrected text, in order, attributed) is there; there is **no saved audio** to replay (US5, SC-009).

## 6. Verify the guardrails

- **Empty/background speech**: cough or stay silent after the mic triggers → "could you repeat that?", no fabricated answer or scenario change; after N tries a "return to the narration" affordance appears (FR-016/FR-017, SC-010).
- **Coverage under steering**: change the scenario very late → not-yet-taught items are still covered before the end (FR-010, edge cases).
- **Unavailable**: unset `ELEVENLABS_STORY_AGENT_ID` and restart → Live Story shows the clear unavailable message with a **"Try again"** affordance, never a blank/frozen screen (FR-026, SC-011).
- **Abandon**: close the tab mid-session → reopen and check the transcript: the **partial** record up to the drop is preserved (FR-027, SC-009).

## 7. Tests (no live keys needed)

```bash
pnpm test         # unit + contract + integration; realtime transport, client tools, token mint faked
pnpm typecheck
pnpm lint
pnpm test:e2e     # Playwright: narrate→barge-in→resume, steer→coverage, caption-correction (faked transport)
```

The realtime session, client-tool invocations, `onMessage` stream, and token mint are replaced by in-memory fakes in CI (Constitution Dev Workflow). The **narration state machine** (coverage guarantee, scenario pin/latest-wins, length budget, barge-in caption correction, clarification escape) and **plan derivation** are **pure** and unit-tested without the SDK or a DOM. Contract tests assert the `LessonPlan`/`LiveSession`/`SessionTurn` schemas, the client-tool return contracts, and the route behaviors (`401`/`404`/`409`/`503`, ownership, append-only ordering + in-place barge-in correction).

## Notes / tradeoffs

- **Continuous narration** rides on the agent's **client-tool self-continuation loop** (research R1); barge-in interrupts within a beat, keeping it responsive.
- **Coverage and length** are enforced at **narration time** by the state machine + agent (research R3/R8), not pre-validated as in batch generation — observable via `story.*` log events and the transcript.
- **No realtime audio is persisted** (FR-025) — the text transcript is the only durable, replayable record.
- The agent stays **connected for the session** and is torn down on conclude/stop/navigate to bound Conversational-AI minutes (accepted for v1 personal scale).
- The plan is **derived read-only** from the existing `LessonScript` (research R2), so batch generation and its eval gate are untouched (the pre-rendered MP3 still exists for the separate 002/005 playback experience, but is not used by this mode's fallback — R7).
