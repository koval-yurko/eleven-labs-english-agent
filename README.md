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

## Status

Early development. Full requirements, data model, API surface, and build phases are in [`PRD-base.md`](./spec/PRD-base.md).
