# Story Map — Interactive English Lesson Podcast (Idiomatic)

**Source vision**: [`PRD-base.md`](./PRD-base.md)
**Created**: 2026-06-06
**Purpose**: Decompose the PRD into independently-shippable stories. Each story below becomes its **own** Spec Kit feature (its own `specs/00N-*/` folder, branch, plan, tasks, implementation). Do **not** run `speckit.specify` on the whole PRD — run it once per story using the "specify input" block provided.

> This file is the backlog. It is not a spec. Detailed acceptance criteria live in each generated `spec.md`.

---

## How to use this map

1. Pick a story (start with P1).
2. Copy its **Specify input** block.
3. Run: `/speckit.specify --number <N> --short-name <slug> "<paste the input>"`
4. Then `/speckit.plan` → `/speckit.tasks` → `/speckit.implement` for that story.
5. Build/merge in priority order so later stories can assume earlier ones exist.

**Numbering**: Story N → `--number N --short-name <slug>` → `specs/00N-<slug>/`.

---

## Build order & dependencies

```
S1 (lesson-generation)  ──► S2 (live-tutor-qa) ──► S3 (lesson-notes)
        │                          │                      │
        └──────────────► S4 (adaptive-progress) ◄─────────┘
```

- **S1** is the foundation (MVP). It also carries the **cross-cutting** account/persistence and input-guardrail requirements, because everything else builds on an authenticated, persistent lesson.
- **S2** depends on S1 (needs a playing lesson + the teacher voice).
- **S3** depends on S1 (needs playback); enriched by S2 (notes from Q&A answers).
- **S4** depends on S1 + S2 (struggle signal comes from questions asked); consumes notes from S3 if present.

---

## Cross-cutting requirements (assigned, not separate stories)

These came from the original mega-spec and must land somewhere. Assignment:

- **Accounts & privacy** (FR-021, FR-022) → **S1** (lessons must be owned/private from day one).
- **Responsive web** (FR-023) → **S1** (platform baseline).
- **Input guardrails & status messaging** (FR-024, FR-025) → **S1** for input/generation; each later story owns the status messaging for its own feature.

---

## S1 — Generate a story-driven podcast lesson from a list  (P1, MVP)

**Slug**: `lesson-generation` · **Branch**: `002-lesson-generation` *(auto-numbered 002; `001` prefix was already taken by `001-english-lesson-podcast`)*

**Value**: Turn a learner's list of words/sentences/idioms into a ~5–10 min two-voice (curious learner + warm teacher) audio lesson that explains each item through vivid mini-stories, replayable later. This is the core value prop; nothing else has anything to operate on without it.

**In scope**: list input; story-driven script generation; two distinct personas; natural-sounding audio render; ~5–10 min length bounding; coverage of every teachable item; persistence + replay; authenticated learner account; private ownership; responsive web; graceful handling of empty/oversized/unteachable input.

**Out of scope**: live Q&A / interruption (S2); notes (S3); cross-session adaptation (S4).

**Independent test**: Submit 5–10 idioms → one coherent ~5–10 min lesson, two distinct voices, every item taught through stories, replayable after re-login.

**Specify input**:
> Generate a story-driven, two-voice podcast lesson from a learner-provided list of English words, sentences, and idioms. The system produces a ~5–10 minute audio lesson presented as a conversation between a curious learner persona and a warm teacher persona, explaining each submitted item through vivid mini-stories rather than dictionary definitions. Every teachable item is covered at least once; lesson length is bounded for large inputs. Lessons and their audio are persisted to an authenticated learner account, private to that learner, and replayable in later sessions on responsive web (desktop + mobile browser). Empty, oversized, or unteachable input is handled gracefully with clear messaging, and generation/playback status is communicated. OUT OF SCOPE: live interruption/Q&A, note capture, and cross-session adaptive progress — those are separate features.

---

## S2 — Interrupt the podcast for a live spoken answer  (P2)

**Slug**: `live-tutor-qa` · **Branch**: `002-live-tutor-qa` · **Depends on**: S1

**Value**: While listening, the learner interrupts to ask a spoken follow-up and gets a live spoken answer in the **same teacher voice**, with barge-in, then resumes exactly where they left off. This turns a passive podcast into a tutor.

**In scope**: play/pause/resume; interrupt at any moment; live spoken answer relevant to current lesson context; tutor uses same teacher voice; barge-in (learner can interrupt the answer); resume from exact interruption point; capture text transcript of each exchange linked to lesson + item; status when live tutor unavailable; handle empty/unintelligible interruptions and off-topic questions.

**Out of scope**: note capture (S3); progress/adaptation (S4); pronunciation scoring.

**Independent test**: During playback, interrupt, speak a question → relevant spoken answer in the same teacher voice within a few seconds; barge-in works; playback resumes at the interruption point; transcript stored.

**Specify input**:
> Add live, interruptible Q&A to an existing generated podcast lesson (assumes the lesson-generation feature exists). While a lesson is playing, the learner can play/pause/resume and interrupt at any moment to ask a spoken follow-up question. The system pauses playback and returns a live spoken answer relevant to the current lesson context, using the SAME teacher voice as the scripted podcast. The learner can barge-in (interrupt the tutor's answer to speak again). When the exchange ends, playback resumes from the exact point of interruption. Each Q&A exchange's text transcript is captured and associated with the lesson and the relevant item. Empty/unintelligible interruptions prompt for clarification; off-topic questions are answered briefly or redirected; live-tutor unavailability is communicated with a fallback. OUT OF SCOPE: persistent note capture and cross-session adaptive progress (separate features); phoneme-level pronunciation scoring.

---

## S3 — Capture notes during a lesson  (P3)

**Slug**: `lesson-notes` · **Branch**: `003-lesson-notes` · **Depends on**: S1 (playback); enriched by S2

**Value**: At any point during playback the learner captures a note tied to the current moment (a phrase, or a usage example from a tutor answer). Notes persist and are reviewable later. Reinforces retention with durable takeaways.

**In scope**: capture a note during playback without losing place; associate note with lesson + approximate position; persist; review all notes when reopening the lesson.

**Out of scope**: lesson generation (S1); live Q&A (S2); adaptation (S4).

**Independent test**: During playback capture a note, end session, return later → note still present and linked to the correct lesson and position.

**Specify input**:
> Add note capture to an existing podcast-lesson playback experience (assumes lesson generation and playback exist). At any point during playback the learner can capture a note — for example a phrase to remember or a usage example from a live tutor answer — without losing their place in playback. Each note is associated with the lesson and the approximate position at which it was captured, persisted to the learner's account, and made reviewable when the learner reopens the lesson in a later session. OUT OF SCOPE: lesson generation, live Q&A/interruption, and cross-session adaptive progress — those are separate features.

---

## S4 — Adaptive progress across sessions  (P4)

**Slug**: `adaptive-progress` · **Branch**: `004-adaptive-progress` · **Depends on**: S1 + S2 (struggle signal), consumes S3 if present

**Value**: The system remembers what the learner studied and which items they struggled with (asked questions about or flagged), and uses that history so future lessons reinforce struggled items and de-emphasize mastered ones. Drives long-term learning value and stickiness.

**In scope**: per-learner progress history of items with status (new/struggled/mastered); flag struggled items at end of a lesson (questions asked or explicit flag); use history when generating future lessons to reinforce struggled and de-emphasize mastered; surface struggled items for next session.

**Out of scope**: quizzing/scoring; pronunciation analysis; the generation/Q&A/notes mechanics themselves (consumed from S1–S3).

**Independent test**: Complete a lesson where some items trigger questions, start a new lesson later → previously struggled items are reinforced and progress history reflects what was studied.

**Specify input**:
> Add cross-session adaptive progress on top of existing lesson generation and live Q&A (assumes those features exist). Maintain a per-learner progress history of items studied with a status of new, struggled, or mastered. At the end of a lesson, flag items the learner appeared to struggle with — items they asked live questions about or explicitly flagged. When generating a future lesson, use this history to give struggled items additional reinforcement and de-emphasize mastered ones, and surface the struggled items for the next session. An item is "struggled" when questioned or flagged; quizzing/scoring and pronunciation analysis are OUT OF SCOPE. The lesson-generation, live-Q&A, and note-capture mechanics are consumed from their own features, not redefined here.

---

## Technical enhancements (cross-cutting backlog)

Not user-facing stories — engineering enhancements that improve an existing story
(mostly S1). Each can become its own small Spec Kit feature or fold into an S1
polish pass. Tracked here so they aren't lost.

### TE1 — Parallelize batch TTS rendering  (Tech, enhances S1)

**Slug**: `tts-parallel-render` · **Depends on**: S1

**Value**: The ElevenLabs Text-to-Dialogue render currently processes segment
batches **sequentially**; audio-synthesis time dominates, so a multi-batch lesson
waits batch-after-batch. Bounded-parallel rendering cuts wall-clock to roughly
`TTS_time ÷ concurrency`. Gain scales with lesson length (modest for tiny inputs,
meaningful for real 5–10 item lessons).

**In scope**: a bounded-concurrency pool for the per-batch renders (cap configurable
via env, set under the ElevenLabs plan's concurrency limit to avoid 429s); preserve
stitch order; extract a reusable `mapWithConcurrency` utility; a "generation can take
a few minutes" note in the UI so the wait is expected.

**Out of scope**: progressive / streaming playback (start playing batch 1 while batch 2
renders — a bigger latency win but a much larger change, deferred); the realtime S2
live-tutor path (a different streaming API — this enhancement does not apply there).

**Note**: the reusable concurrency primitive is useful beyond TTS (e.g. parallel item
classification if teachability becomes LLM-based, or bulk regeneration in S4).

### TE2 — Internal structured logging  (Tech, cross-cutting)

**Slug**: `internal-logging` · **Depends on**: S1

**Value**: Today logging is effectively limited to REST/request edges. Internal
functionality — the generation pipeline steps, teachability decisions, coverage
validation, TTS batch timings, and lesson status transitions — is opaque when
debugging a failed or low-quality lesson. Structured internal logs make the system
observable and support the reproducibility principle (Constitution III).

**In scope**: structured logging (levelled, JSON) across the generator workflow steps,
the generation bridge/runner status transitions (`pending→generating→ready|failed`),
teachability classification, coverage validation, and TTS batch render timings;
correlate entries by lesson id; redact secrets. Beyond HTTP request logging.

**Out of scope**: a third-party APM vendor and log-shipping infrastructure; LangSmith
eval-trace export (already tracked as an S1 task, T052).

---

## Shared assumptions (apply to all stories)

- Single authenticated learner per account; no collaborative/classroom features.
- English instruction only (design shouldn't preclude other languages later).
- Responsive web only; no native apps.
- "Struggled" = learner asked a live question about an item or explicitly flagged it.
- Pronunciation/phoneme scoring deferred.
- Modest input sizes (up to a few dozen items); larger lists bounded or split with the learner informed.
- In-browser audio delivery; telephony out of scope.

---

## Status tracker

| Story | Slug | Priority | Spec | Plan | Tasks | Implemented |
|-------|------|----------|------|------|-------|-------------|
| S1 | lesson-generation | P1 | ☑ | ☑ | ☑ | ☑ |
| S2 | live-tutor-qa | P2 | ☐ | ☐ | ☐ | ☐ |
| S3 | lesson-notes | P3 | ☐ | ☐ | ☐ | ☐ |
| S4 | adaptive-progress | P4 | ☐ | ☐ | ☐ | ☐ |
