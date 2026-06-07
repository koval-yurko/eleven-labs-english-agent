# Quickstart: Live, Interruptible Q&A (005-live-tutor-qa)

How to provision, configure, run, and verify the live tutor. Builds on the 002 setup (lessons must already generate and play).

## 1. Provision the live-tutor Agent (one-time, ElevenLabs dashboard)

Create one **Conversational AI Agent** for the live tutor:

- **Voice**: set to the **pinned teacher voice** — the same id as `ELEVENLABS_TEACHER_VOICE_ID`. (Constitution I: the live tutor and scripted podcast MUST be the same voice.)
- **LLM**: select **Claude Haiku 4.5** natively (no custom LLM proxy). Turn **reasoning off** for conversational latency (research R2).
- **Pipeline**: cascaded STT → LLM → TTS (default; **not** speech-to-speech — the transcript must stay available).
- **System prompt**: paste the versioned template from `apps/web/lib/live-tutor/agent-prompt.ts`. It uses dynamic variables `{{lesson_summary}}`, `{{items_list}}`, `{{current_item}}` and instructs the tutor to answer briefly and grounded in the lesson, ask the learner to repeat/clarify on empty/unintelligible input, and briefly answer-or-redirect off-topic questions.
- **Dynamic variables**: enable and declare `lesson_summary`, `items_list`, `current_item`.
- **Auth**: keep the agent **private** (the app mints a conversation token server-side).

Copy the agent id.

## 2. Environment

Add to `apps/web/.env` (server-only; reuse existing ElevenLabs vars from 002):

```
# Live tutor (005)
ELEVENLABS_AGENT_ID=agent_xxx          # the provisioned live-tutor agent
# reused from 002:
# ELEVENLABS_API_KEY=...               # server-only; mints conversation tokens
# ELEVENLABS_TEACHER_VOICE_ID=...      # must equal the agent's voice
```

Live Q&A is **feature-gated**: if `ELEVENLABS_API_KEY` or `ELEVENLABS_AGENT_ID` is missing, the UI shows the "live tutor unavailable" fallback and the lesson stays fully playable (FR-017).

## 3. Database migration

```bash
pnpm migrate    # applies supabase/migrations/0004_qa.sql (qa_exchanges, qa_turns + RLS)
```

## 4. Install the client SDK

```bash
pnpm --filter @idiomatic/web add @elevenlabs/react
```

## 5. Run & verify (happy path)

```bash
pnpm --filter @idiomatic/web dev
```

1. Sign in, open a **ready** lesson, press play.
2. Grant microphone access when prompted (hands-free requires a live mic).
3. **Speak a question** while an item is being explained → the lesson **pauses immediately** and the tutor answers **in the teacher voice**, grounded in that item.
4. **Speak over the answer** (barge-in) → the answer **stops** and the tutor takes your new question.
5. Stop asking → the lesson **resumes from the exact point** it paused.
6. Reload the lesson and call `GET /api/lessons/{id}/exchanges` (or the review UI) → your exchange transcript is there, tied to the lesson and the item you were on.

## 6. Verify the guardrails

- **Unintelligible**: stay silent / make noise → tutor asks you to repeat; after 3 failed tries a "Return to the lesson" affordance appears (FR-014/FR-015). Lesson never lost.
- **Off-topic**: ask something unrelated → brief answer or redirect back to the lesson (FR-016).
- **Unavailable**: unset `ELEVENLABS_AGENT_ID` and restart → opening the player shows the clear unavailable message; playback still works (FR-017).

## 7. Tests (no live keys needed)

```bash
pnpm test         # unit + contract + integration; realtime transport + token mint are faked
pnpm typecheck
pnpm lint
pnpm test:e2e     # Playwright: interrupt → answer → barge-in → resume-at-point, desktop + mobile (faked transport)
```

The ElevenLabs realtime session, token mint, and `onMessage` stream are replaced by in-memory fakes in CI (Constitution Dev Workflow — external managed services exercised against mocks). Contract tests assert the `QaExchange`/`QaTurn` schemas and the route behaviors (`401`/`404`/`409`/`503`, ownership, append-only ordering, item anchoring).

## Notes / tradeoffs

- The agent stays **connected for the listening window** of a play session and is torn down on stop/navigate/lesson-end (research R7). This consumes Conversational-AI minutes — accepted for v1 personal scale.
- **Current item** is resolved client-side by a character-proportional estimate over the script (research R3); precise per-segment timings are a future enhancement isolated behind `current-item.ts`.
- **Acoustic echo**: lesson audio and mic are briefly live together; the controller pauses/ducks the lesson within ~300ms of detected speech and relies on browser echo cancellation. Validate during the E2E/manual pass.
- Live answer **audio is not persisted** in v1 — only the text transcript (research R9).
