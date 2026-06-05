# PRD — Interactive English Lesson Podcast (codename: "Idiomatic")

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
