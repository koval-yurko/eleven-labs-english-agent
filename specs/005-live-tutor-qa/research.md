# Phase 0 Research: Live, Interruptible Q&A

**Feature**: 005-live-tutor-qa | **Date**: 2026-06-07

All Technical-Context unknowns are resolved below. Each item: **Decision · Rationale · Alternatives considered**.

---

## R1 — Realtime transport: how do we run hands-free, interruptible voice in the browser?

**Decision**: Use **ElevenLabs Agents (Conversational AI)** via the **`@elevenlabs/react`** SDK (v1.x: `ConversationProvider` + `useConversationControls` / `useConversationStatus` / `useConversationMode`). The platform owns microphone capture, **VAD-based turn detection, barge-in, STT, the LLM call, and streaming TTS**. We connect a session for the listening window of a play and let the platform handle interruption mechanics.

**Rationale**: Principle IV ("Buy the Hard Parts, Build the Glue") explicitly names turn-taking and barge-in as ElevenLabs-owned and forbids reimplementing them. The SDK exposes exactly the seams we need as glue: `onMessage` (transcripts), `useConversationMode` (`speaking`/`listening`, `isSpeaking`/`isListening`) to drive lesson pause/resume, `endSession`, `setVolume`, and `onError`. Barge-in is automatic — when the learner speaks while the agent is talking, the platform stops the agent — so the spec's "barge-in" (US2) is satisfied by the platform, not our code.

**Alternatives considered**:
- *Hand-rolled STT→LLM→TTS over raw WebSockets*: rejected — duplicates the managed realtime capability (Principle IV violation) and re-implements barge-in/VAD, the hardest part.
- *Speech-to-speech models*: rejected — the constitution mandates the **cascade** so the transcript stays available for notes/feedback; speech-to-speech is an explicit non-goal.
- *`@elevenlabs/client` (vanilla) instead of React SDK*: viable, but the app is Next.js/React and 002 already anticipated `@elevenlabs/react`; the React provider gives us the lifecycle hooks cleanly.

---

## R2 — Agent LLM: how does Claude drive the agent (Principle IV: "Agents with Claude")?

**Decision**: Configure the agent's LLM to a **native Claude model — Claude Haiku 4.5** — directly in the ElevenLabs agent settings. **No custom-LLM proxy.** Reasoning is left off for conversational latency.

**Rationale**: ElevenLabs Agents support Anthropic Claude (Haiku 4.5, Sonnet 4.5, etc.) as a first-class selectable LLM; a proxy is only needed for models they don't host. Haiku is the documented recommendation for "real-time / live voice" latency, which directly serves Constitution I's < ~1.5s time-to-first-audio budget. The cascade (STT → Claude → ElevenLabs TTS) keeps the transcript available, as required. LLM cascading (automatic backup models on primary failure) adds resilience for free.

**Alternatives considered**:
- *Custom-LLM proxy to the Anthropic API*: rejected for v1 — adds a server to operate and a latency hop with no benefit over native selection; revisit only if we need a model/behavior the native integration can't express.
- *ElevenLabs default LLM*: rejected — the constitution specifies Claude, and Claude gives better grounded, on-topic answers (FR-005/FR-016).
- *Claude Sonnet 4.5*: held as a quality fallback if Haiku's answers underperform; it trades latency, so Haiku is the default and Sonnet is a config change, not a code change.

---

## R3 — Which lesson item is "active" at the interruption point?

**Decision**: Resolve the active item **client-side from the `LessonScript`** using a **character-proportional time estimate**: distribute `estimatedDurationSeconds` across `segments` proportional to each segment's `text` length to get per-segment start offsets, find the segment covering the lesson `<audio>.currentTime`, then map that segment id → `coverage[].sourceItemId` to get the relevant `SourceItem`. Boundary/gap cases resolve to the **most recently active** taught item (matches the spec assumption). No change to the generator or stored script.

**Rationale**: Keeps the batch generator subsystem untouched (subsystem independence) and works for **all existing lessons** with zero backfill. The association only needs to identify the item under discussion; a deterministic estimate is internally consistent and good enough for v1 (SC-006 association is defined against this resolver). The `coverage` map already provides the segment→item link generation guarantees.

**Alternatives considered**:
- *Persist precise per-segment timings (byte offsets from the CBR MP3 render)*: more accurate near boundaries and feasible (audio is constant-bitrate, rendered in order), but requires touching `packages/generator`'s render path and a schema/backfill for old lessons. **Deferred as a future enhancement**; the resolver is isolated in `current-item.ts` so it can be upgraded behind the same interface without touching callers.
- *Ask the agent to infer the item from the question*: rejected — non-deterministic and unverifiable; we want a stable anchor for the transcript.

---

## R4 — Grounding the answer in the lesson + current item (FR-005, FR-016)

**Decision**: Provision the agent with a **versioned base system prompt** (`lib/live-tutor/agent-prompt.ts`) that references **dynamic variables**, and inject per-session context two ways: (1) `dynamicVariables` at `startSession` (lesson summary, full item list, the current item) and (2) `sendContextualUpdate(...)` whenever the active item changes during playback or at the moment of interruption. The prompt instructs the tutor to: answer grounded in the lesson, keep answers brief, **ask the learner to repeat/clarify when input is empty or unintelligible** (FR-014), and **briefly answer-or-redirect off-topic questions** back to the lesson (FR-016).

**Rationale**: Dynamic variables + contextual updates are the SDK's supported, low-latency way to inject per-conversation state without re-provisioning the agent. Keeping the prompt template in source control satisfies Constitution III (no untracked prompt strings) and makes off-topic/clarification behavior reviewable and testable as a versioned artifact.

**Alternatives considered**:
- *Per-session prompt override (`overrides.agent.prompt`)*: works but requires enabling prompt overrides on the agent and ships more text per session; dynamic variables in a fixed template are tighter and safer. Override remains available if a template variable proves insufficient.
- *ElevenLabs knowledge base / RAG over the lesson*: overkill — a single lesson's script fits comfortably in the prompt/variables; no retrieval needed.

---

## R5 — Teacher-voice consistency (Constitution I)

**Decision**: **Provision the agent once with the existing pinned teacher voice id** (`ELEVENLABS_TEACHER_VOICE_ID` from 002). No per-session `overrides.tts.voiceId` is needed because the teacher voice is fixed across all lessons.

**Rationale**: Constitution I makes voice consistency a breaking-change-level invariant; binding it at the agent level (not per request) removes a whole class of "wrong voice" defects and keeps the override surface minimal (Principle IV — less glue). The scripted podcast and the live tutor then provably share one voice id.

**Alternatives considered**:
- *Per-session voiceId override*: only needed if the teacher voice varied per lesson — it doesn't. Rejected as unnecessary surface.

---

## R6 — Pause on speech & resume at the exact point (FR-002, FR-003, FR-010)

**Decision**: The lesson plays through the existing in-browser `<audio>` element. The agent session runs **concurrently and always-listening** during the play session. When the SDK signals the learner has started speaking (mode → `speaking`-user / `isListening` transitions / first tentative user transcript via `onMessage`), the controller **immediately pauses the `<audio>` and records `currentTime` as the interruption point**. When the exchange ends (agent finished and learner silent — mode settled back to idle `listening` with no pending agent turn), the controller **resumes from the stored `currentTime`**, regardless of how many barge-in turns occurred. Manual pause/resume controls set/clear a flag so a manual pause is **not** treated as a question (FR-004).

**Rationale**: Resume-at-point is pure client state on our own audio element — simple, exact, and independent of the realtime platform. Driving pause off the platform's turn signals reuses its VAD rather than building our own (Principle IV).

**Known risk — acoustic echo**: lesson audio and the live mic are active together briefly, so the lesson audio can bleed into the mic before we pause. Mitigation: pause/duck the lesson `<audio>` within ~300ms of detected speech (well inside the ≤0.5s SC-001 budget) and rely on the browser's getUserMedia echo cancellation. Documented as a tracked quality risk to validate in the E2E/manual pass, not a blocker.

**Alternatives considered**:
- *Connect the agent lazily only after a button press*: contradicts the chosen hands-free model (spec clarification) — rejected.
- *Building our own VAD to detect speech*: rejected — re-implements platform capability.

---

## R7 — Always-connected session cost & lifecycle (FR-017, performance)

**Decision**: Connect one agent session for the **active listening window of a play session** and `endSession()` when the learner stops playback, navigates away, or the lesson finishes. Only **one live session per learner at a time**. Surface availability before connecting (R8).

**Rationale**: Hands-free interruption requires the platform to be listening, which means a connected session, which consumes Conversational-AI minutes for the listening window. For a single self-directed learner at personal scale this is an acceptable v1 cost tradeoff (Scale/Scope). Explicit teardown bounds the cost and frees the mic.

**Alternatives considered**:
- *Local push-to-talk to avoid an always-on session*: rejected — the user chose fully hands-free in the spec clarification. (If cost becomes a problem, a local lightweight VAD that only opens the session on speech is the future optimization; noted, not built.)

---

## R8 — Availability detection & fallback (FR-017)

**Decision**: Live Q&A is "available" only when the server has both `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` configured **and** the token mint succeeds. The client also treats `onError` / failure to reach `connected` within a short timeout as unavailable. On unavailable: show a clear message ("Live tutor isn't available right now — keep listening and try again later") and keep the lesson fully playable; **never freeze playback or silently drop the question** (the lesson stays paused at the interruption point or simply continues).

**Rationale**: A server-side capability check + a client-side connect timeout covers both "not configured" and "transient outage" cleanly, satisfying FR-017's two halves (clear message + usable fallback).

**Alternatives considered**:
- *Assume available and only react to errors*: rejected — gives a worse first-run/misconfig experience and risks a frozen UI.

---

## R9 — Transcript capture & persistence (FR-011, FR-012, FR-013)

**Decision**: Capture turns **client-side from `onMessage`** (final user transcriptions + final agent replies), accumulate them into one **exchange** (opened at interruption, closed at resume), and **POST the completed exchange + ordered turns** to `/api/lessons/[id]/exchanges` **after** the exchange ends — never in the answer path. Persist to owner-scoped `qa_exchanges` (lesson_id, owner_id, source_item_id, interruption_position_seconds, exchange_index, elevenlabs_conversation_id, created_at) and `qa_turns` (exchange_id, owner_id, role `learner|tutor`, text, turn_index, created_at). Each exchange is anchored to the lesson + the item resolved in R3. Multiple exchanges per lesson are stored separately and ordered (FR-013).

**Rationale**: Client capture is the simplest reliable source (the SDK already surfaces both sides) and keeps persistence off the latency-critical path (Constitution I). Storing the `conversationId` gives reproducibility/debug (Constitution III) and a path to later reconcile against ElevenLabs' authoritative post-call transcript if needed.

**Alternatives considered**:
- *Rely solely on ElevenLabs post-call webhook/transcript API*: more authoritative but adds a webhook endpoint + async reconciliation and a delay before the transcript is queryable; **deferred** as a hardening enhancement. Client capture covers v1.
- *Persist live answer audio*: out of scope for v1 (text transcript is the durable record; audio retention is a noted future decision).

---

## R10 — Clarification-loop guard (FR-015)

**Decision**: The agent prompt drives "ask to repeat/clarify" on empty/unintelligible input (FR-014). The **client** counts consecutive clarification turns within an exchange; after a small threshold (default 3) it surfaces a "Return to the lesson" affordance and can cleanly resume playback, so the learner is never trapped (FR-015).

**Rationale**: The natural-language clarification belongs to the agent; the hard *guarantee* of escape belongs to deterministic client code, which is testable.

**Alternatives considered**:
- *Trust the model to give up*: rejected — non-deterministic; FR-015 needs a guaranteed exit.

---

## Resolved dependency / config summary

- **New client dependency**: `@elevenlabs/react` (managed SDK; not custom infra — Principle IV-compliant). Anticipated already in 002's dependency list.
- **New env**: `ELEVENLABS_AGENT_ID` (the provisioned live-tutor agent). Reuses existing `ELEVENLABS_API_KEY` and `ELEVENLABS_TEACHER_VOICE_ID`. Live Q&A is feature-gated on these being present (R8).
- **Agent provisioning** (one-time, documented in quickstart): LLM = Claude Haiku 4.5 (reasoning off), voice = teacher voice id, system prompt = the versioned template, dynamic variables enabled. Cascade (not speech-to-speech).
- **No new runtime/language**, no new Storage bucket, no change to batch generation behavior.
