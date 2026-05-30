# PRD — Interactive English Lesson Podcast (codename: "Idiomatic")

> Working title; rename freely. This document is written to be handed to a coding agent. Requirements are numbered (`FR-x`, `NFR-x`) so they can be referenced in commits, issues, and acceptance checks.

---

## 1. Summary

Build a system that takes a list of English words, sentences, or idioms and turns it into a short, fun, story-driven audio lesson shaped as a **two-person podcast** (a curious learner + a warm teacher who explains each item through vivid mini-stories). The learner can **interrupt the podcast at any moment** to ask a follow-up question and get a live spoken answer in the *same teacher voice*, or to capture a note. Sessions are remembered across time so lessons adapt to what the learner already knows.

Two cooperating subsystems:

1. **Lesson Generator** (offline/batch) — turns an input list into a structured, expressive two-voice podcast.
2. **Interactive Player + Live Tutor** (realtime) — plays the podcast, handles interruptions, runs a live interruptible voice agent for Q&A, and captures notes.

---

## 2. Goals & non-goals

### Goals
- G1. Generate an engaging, story-based lesson from an arbitrary list of words/sentences/idioms.
- G2. Render it as a natural two-voice podcast (not text-to-speech that sounds read-aloud).
- G3. Let the learner interrupt at any point for (a) a live spoken Q&A, and (b) note capture, without losing their place.
- G4. Keep one consistent teacher voice across the scripted podcast and the live tutor.
- G5. Persist learner progress and notes so future lessons adapt.

### Non-goals (v1)
- NG1. Mobile native apps (web responsive only in v1).
- NG2. Languages other than English instruction (architecture should not preclude it later).
- NG3. Multi-user/social features, leaderboards.
- NG4. Pronunciation scoring/phoneme analysis (transcript is captured; scoring is a later phase).
- NG5. Telephony / phone-call delivery.

---

## 3. Target user & primary use case

A self-directed intermediate/advanced English learner who wants to internalize idioms and phrases through stories rather than flashcards.

**Primary flow:** learner pastes/imports a list → system generates a ~5–10 min lesson → learner listens → interrupts when curious ("wait, can I use this at work?") → teacher answers live → learner saves a note → resumes → at the end, items they struggled with are flagged for the next session.

---

## 4. Tech stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Language | **TypeScript / Node** end-to-end | No Python required for v1 |
| Frontend | **Next.js** (App Router) | Responsive web |
| Auth | **Auth0** | Existing tenant |
| Database & storage | **Supabase** (Postgres + Storage) | Lessons, audio assets, notes, progress |
| Lesson generation brain | **Mastra** workflow + **Claude** | Multi-step generation (see §7) |
| Scripted podcast audio | **ElevenLabs Text to Dialogue (Eleven v3)** | Multi-speaker, audio tags; ~3,000-char limit per request → generate per segment |
| Live tutor | **ElevenLabs Agents** (Conversational AI) | Managed turn-taking + barge-in |
| Live tutor LLM | **Claude** (native in ElevenLabs; Sonnet for reasoning, Haiku for latency) | Custom-LLM proxy only if needed (see §8.2) |
| Eval/observability | **LangSmith** via `@mastra/langsmith` exporter | Lesson quality evals |

**ElevenLabs SDK packages (scoped, post-Aug-2025):** `@elevenlabs/react` (client hook), `@elevenlabs/client` (browser JS), `@elevenlabs/elevenlabs-js` (server/management), optional `@elevenlabs/agents-cli` for config-as-code.

**Architecture stance:** cascaded (STT → LLM → TTS) via ElevenLabs Agents — chosen deliberately so the **transcript is available** for notes, feedback, and progress tracking, and so the teacher keeps the ElevenLabs voice. (Speech-to-speech was rejected for v1: loses the transcript and the ElevenLabs voice.)

---

## 5. User stories

- US1. As a learner, I can create a "deck" by pasting a list of words/idioms (one per line) or importing from a file.
- US2. As a learner, I can generate a lesson from a deck and see/hear it as a two-voice podcast.
- US3. As a learner, I can play/pause/seek the podcast and see the current word/idiom highlighted.
- US4. As a learner, I can tap "Interrupt" (or just start speaking) to ask the teacher a question and hear a spoken answer in the same voice.
- US5. As a learner, after a live answer the podcast resumes from where I left off.
- US6. As a learner, I can save a note anchored to the current segment/word; it persists.
- US7. As a learner, my next lesson knows which idioms I already mastered and which I struggled with.
- US8. As a learner, I can review my saved notes and flagged items later.

---

## 6. End-to-end flow

```
Deck (word/idiom list)
  → [Lesson Generator: Mastra + Claude]  → structured Script (turns)
  → [ElevenLabs v3 Text to Dialogue]     → per-segment audio assets (Supabase Storage)
  → [Player UI: Next.js]                 → playback + transcript + word highlight
        ↕ interrupt
  → [ElevenLabs Agent (live tutor)]      → spoken Q&A (same voice), client tools
  → [Notes + Progress]                   → Supabase
  → [Post-call webhook]                  → persist session summary/progress
        → injected back as dynamic variables on next session
```

---

## 7. Subsystem A — Lesson Generator

### 7.1 Functional requirements
- FR-1. Accept an input deck: array of items, each `{ text, type: "word" | "sentence" | "idiom" }`.
- FR-2. Generate a lesson via a **multi-step Mastra workflow**, not a single mega-prompt:
  1. **Outline** — order items, group related ones, decide a through-line/theme.
  2. **Expand** — for each item, write a short vivid story/anecdote from the teacher that makes the meaning stick, plus 1–2 natural example sentences.
  3. **Dialogue** — interleave a curious LEARNER voice asking natural questions with the TEACHER's explanations.
  4. **Comprehension** — after each item (or cluster), insert a short follow-up question the teacher poses to the learner.
  5. **Audio tags** — annotate teacher/learner turns with v3 audio tags (`[chuckles]`, `[thoughtful]`, `[curious]`, `[excited]`) for expressive delivery.
- FR-3. Output a **structured Script**: ordered array of turns. Each turn:
  ```ts
  type Turn = {
    id: string;
    speaker: "teacher" | "learner";
    text: string;               // may contain inline [audio tags]
    word?: string;              // the deck item this turn relates to (for highlighting/anchoring)
    type: "intro" | "story" | "explanation" | "example" | "question" | "checkpoint" | "outro";
  };
  ```
- FR-4. Cache generated Scripts keyed by deck hash + generation params so regeneration is not re-paid unnecessarily.
- FR-5. Target lesson length configurable (default ~5–10 min of audio); generator should respect a soft turn/segment budget.
- FR-6. Instrument generation with LangSmith for later quality evals (story vividness, question usefulness).

### 7.2 Prompting guidance (for the generator)
- Teacher persona: warm, witty, concrete; teaches via story and analogy; never lectures.
- Keep individual turns short and speakable (voice, not prose).
- Learner persona: genuinely curious, asks the questions a real student would.
- Every item must get: a memorable story hook + at least one example sentence + one follow-up question.

---

## 8. Subsystem B — Interactive Player + Live Tutor

### 8.1 Scripted podcast synthesis
- FR-7. For each Script, synthesize audio using **ElevenLabs v3 Text to Dialogue**, two fixed `voice_id`s (teacher, learner).
- FR-8. Synthesize **per segment** (one item/cluster per request) to stay under the v3 per-request character limit and to produce per-segment audio that can be anchored to turns. Store each segment's audio + per-turn timing in Supabase.
- FR-9. The teacher `voice_id` used here MUST equal the live agent's voice (FR-16) so the handoff is seamless.

### 8.2 Live tutor (ElevenLabs Agent)
- FR-10. Configure one ElevenLabs Agent with:
  - **LLM**: native Claude (default `claude-sonnet-4-5`; allow switching to Haiku for latency). Custom-LLM (OpenAI-compatible proxy → Claude) is an *optional* later path, only if we need to inject Mastra-generated state the native path can't.
  - **System prompt** in structured form: `Personality / Environment / Tone / Goal / Guardrails / Tools`. Hard rule: responses ≤ 2–3 sentences unless asked, conversational, no monologue.
  - **First message** parameterized via dynamic variable (e.g. greet by name, reference last lesson).
- FR-11. Barge-in / interruption MUST be enabled (default turn-taking). Learner can interrupt the agent mid-sentence by speaking.
- FR-12. On "Interrupt" from the player: pause podcast audio, capture current `{ segmentId, turnId, word }` as context, open the live agent session, inject that context as dynamic variables, conduct Q&A, then resume the podcast at the saved position.

### 8.3 Tools
- FR-13. **Client tools** (run in browser, "wait for response" where data is needed back):
  - `save_note({ text, word, segmentId })` → writes to Supabase, returns confirmation.
  - `highlight_word({ word })` → highlights the term in the UI.
  - `pause_podcast()` / `resume_podcast()` → player control from the agent if useful.
- FR-14. **Server tools** (webhooks to our API, with auth):
  - `get_learner_profile({ learnerId })` → returns known/weak idioms, last lesson summary (used to ground the live answer). Prefer injecting via dynamic variables at session start; expose as a tool for mid-session lookups.
  - `log_progress({ learnerId, word, outcome })` → record struggled/mastered.
- FR-15. **MCP tools** (optional): reuse existing MCP servers (e.g. Postgres) as agent tools where appropriate.

### 8.4 Player UI
- FR-16. Web player: play/pause/seek, current-segment indicator, live transcript, highlighted current word.
- FR-17. Visible "Interrupt / Ask" affordance + push-to-talk; show live agent state (listening/speaking/thinking).
- FR-18. Notes panel: shows notes anchored to segments; editable; persisted.
- FR-19. End-of-lesson summary: items covered, items flagged, notes captured.

---

## 9. Memory model (three layers — only layer 1 is automatic)

- FR-20. **Within-session**: rely on the agent's built-in context; expose `system__conversation_history` to tools/webhooks when full context is needed.
- FR-21. **Static knowledge (RAG)**: maintain an ElevenLabs **knowledge base** for the agent (idiom corpus, teaching guidelines). Respect the non-enterprise 20MB cap; support knowledge-base refresh.
- FR-22. **Cross-session memory** (we own this):
  - Register a **post-call webhook** that fires when a live session ends, carrying `conversation_id`, transcript, and analysis. Verify the HMAC secret; return 200.
  - Persist a session summary + per-item outcomes to Supabase.
  - On the next session, inject relevant state via **dynamic variables** (`{{learner_name}}`, `{{known_idioms}}`, `{{weak_idioms}}`, `{{last_lesson_summary}}`). Use the `secret__` prefix only for tokens/IDs that must never reach the LLM.

---

## 10. Data model (Supabase / Postgres)

```sql
-- learners linked to Auth0 subject
learners        (id pk, auth0_sub unique, name, level, created_at)

-- input lists
decks           (id pk, learner_id fk, title, created_at)
deck_items      (id pk, deck_id fk, text, type, position)

-- generated lessons
lessons         (id pk, deck_id fk, learner_id fk, script_hash, gen_params jsonb,
                 status, created_at)
lesson_turns    (id pk, lesson_id fk, position, speaker, text, word, turn_type)

-- synthesized audio
audio_assets    (id pk, lesson_id fk, segment_index, storage_path,
                 duration_ms, turn_timings jsonb)

-- live sessions
sessions        (id pk, lesson_id fk, learner_id fk, el_conversation_id,
                 started_at, ended_at, transcript jsonb, summary text)

-- learner artifacts
notes           (id pk, learner_id fk, lesson_id fk, turn_id fk null, word,
                 text, created_at)
progress        (id pk, learner_id fk, word unique_per_learner,
                 outcome, last_seen_at, strength int)  -- strength for future SRS
```

---

## 11. API surface (Next.js route handlers)

- `POST /api/decks` — create deck (+ items).
- `POST /api/lessons` — generate lesson from deck (triggers Mastra workflow; returns lesson + script).
- `POST /api/lessons/:id/synthesize` — synthesize audio segments (idempotent; skips cached).
- `GET  /api/lessons/:id` — lesson script + audio asset URLs.
- `POST /api/notes` — create note (also callable by the `save_note` client tool path).
- `GET  /api/learners/:id/profile` — known/weak idioms + last summary (backs `get_learner_profile` server tool).
- `POST /api/agents/session-context` — returns dynamic variables for a new live session.
- `POST /api/webhooks/elevenlabs/post-call` — HMAC-verified; persists session summary + progress.

---

## 12. Non-functional requirements

- NFR-1. **Live tutor latency**: target sub-1s perceived time-to-first-audio on interruption; pick LLM (Haiku vs Sonnet) accordingly.
- NFR-2. **Voice consistency**: identical teacher `voice_id` across podcast and live agent (hard requirement).
- NFR-3. **Cost guardrails**: scripted podcast audio is pre-generated and cached (not re-synthesized per play); live agent minutes are the main variable cost — log per-session token/minute usage.
- NFR-4. **Resilience**: post-call webhook must be idempotent and tolerate retries; auto-disable protection per ElevenLabs (failures) should be monitored.
- NFR-5. **Security**: secrets in ElevenLabs secret storage / env; webhook HMAC verification; Auth0-gated APIs; `secret__` dynamic variables for any sensitive IDs.
- NFR-6. **Privacy**: store transcripts under the learner's account; provide delete.
- NFR-7. **Observability**: LangSmith for generation; structured logs (Pino) for synthesis + live sessions.

---

## 13. Build phases (suggested milestones for the agent)

- **Phase 0 — Scaffold**: Next.js app, Auth0 wiring, Supabase schema + migrations, env/secrets, ElevenLabs + Anthropic keys.
- **Phase 1 — Lesson Generator**: Mastra workflow (outline → expand → dialogue → questions → tags) producing the structured Script; cache by hash; LangSmith instrumentation. *Acceptance: a deck yields a valid Script JSON.*
- **Phase 2 — Synthesis**: v3 Text to Dialogue per segment, two voices, store assets + timings. *Acceptance: lesson plays end-to-end as natural two-voice audio.*
- **Phase 3 — Player UI**: playback, transcript, word highlight, notes panel (notes persist). *Acceptance: US1–US3, US6.*
- **Phase 4 — Live Tutor**: ElevenLabs Agent config (Claude + system prompt + barge-in), interrupt→handoff→resume, client tools (`save_note`, `highlight_word`, pause/resume). *Acceptance: US4–US5; interruption answered in same voice, podcast resumes.*
- **Phase 5 — Memory**: knowledge base, dynamic-variable injection at session start, post-call webhook → Supabase, profile server tool. *Acceptance: US7 — second lesson references prior progress.*
- **Phase 6 — Review (optional)**: notes review screen, flagged-item review queue, groundwork for spaced repetition (`progress.strength`).

---

## 14. Acceptance criteria (system-level)

- AC-1. Given a deck of ≥5 idioms, the system produces a playable two-voice podcast where each idiom has a story, an example, and a follow-up question.
- AC-2. The teacher voice in the podcast and in live Q&A is indistinguishable (same `voice_id`).
- AC-3. Interrupting mid-podcast yields a spoken answer within target latency, then the podcast resumes at the prior position.
- AC-4. A note saved during a session is anchored to the correct word/segment and visible after reload.
- AC-5. A second session for the same learner injects prior known/weak idioms into the live agent's context.
- AC-6. Post-call webhook persists a session summary and updates `progress`.

---

## 15. Open questions / decisions to confirm

- OQ-1. Spaced-repetition algorithm for review (SM-2 vs simpler strength decay) — deferred to Phase 6.
- OQ-2. Should interruption be push-to-talk only, or always-listening with VAD? (Affects UX and accidental-trigger handling.)
- OQ-3. Native Claude vs custom-LLM proxy — start native; revisit if lesson-state injection demands the proxy.
- OQ-4. Knowledge-base content scope and refresh cadence.
- OQ-5. Multi-language instruction (Ukrainian explanations?) — out of scope v1 but keep data model language-aware.

---

## 16. Glossary

- **Deck** — an input list of words/sentences/idioms.
- **Script** — structured array of dialogue turns generated from a deck.
- **Segment** — a synthesized audio chunk (one item/cluster) with per-turn timing.
- **Live tutor** — the ElevenLabs Agent that answers interruptions in realtime.
- **Dynamic variables** — `{{var}}` runtime values injected into the agent's prompt/first message/tools per session.
