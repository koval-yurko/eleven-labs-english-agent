# Story Map — Interactive English Lesson Podcast (Idiomatic)

**Source vision**: [`PRD-base.md`](./PRD-base.md)
**Created**: 2026-06-06 · **Last updated**: 2026-06-25 (flattened to a single story list; dropped build-order/dependency graph)
**Purpose**: Decompose the PRD into independently-shippable stories. Each story below becomes its **own** Spec Kit feature (its own `specs/00N-*/` folder, branch, plan, tasks, implementation). Do **not** run `speckit.specify` on the whole PRD — run it once per story using the "Specify input" block provided.

> This file is the backlog. It is not a spec. Detailed acceptance criteria live in each generated `spec.md`.

---

## How to use this map

1. Pick a story (start with the next un-built one).
2. Copy its **Specify input** block.
3. Run: `/speckit.specify --number <N> --short-name <slug> "<paste the input>"`
4. Then `/speckit.plan` → `/speckit.tasks` → `/speckit.implement` for that story.

**Status** is one of `To-do`, `In progress`, or `Done (00N)` — where `00N` is the spec folder (`specs/00N-<slug>/`) assigned when the folder is created. S-numbers and folder numbers diverge; each story records its own folder.

---

## S1 — Generate a story-driven podcast lesson from a list

**Status**: Done (002)

Turn a learner's list of words/sentences/idioms into a ~5–10 min two-voice (curious learner + warm teacher) audio lesson that explains each item through vivid mini-stories, replayable later. The MVP foundation — also carries the cross-cutting account/privacy, responsive-web, and input-guardrail requirements.

**Specify input**:
> Generate a story-driven, two-voice podcast lesson from a learner-provided list of English words, sentences, and idioms. The system produces a ~5–10 minute audio lesson presented as a conversation between a curious learner persona and a warm teacher persona, explaining each submitted item through vivid mini-stories rather than dictionary definitions. Every teachable item is covered at least once; lesson length is bounded for large inputs. Lessons and their audio are persisted to an authenticated learner account, private to that learner, and replayable in later sessions on responsive web (desktop + mobile browser). Empty, oversized, or unteachable input is handled gracefully with clear messaging, and generation/playback status is communicated. OUT OF SCOPE: live interruption/Q&A, note capture, and cross-session adaptive progress — those are separate features.

---

## S2 — Interrupt the podcast for a live spoken answer

**Status**: Done (005) — retired by S4

While listening, the learner interrupts to ask a spoken follow-up and gets a live spoken answer in the same teacher voice, with barge-in, then resumes exactly where they left off. Turns a passive podcast into a tutor.

**Specify input**:
> Add live, interruptible Q&A to an existing generated podcast lesson (assumes the lesson-generation feature exists). While a lesson is playing, the learner can play/pause/resume and interrupt at any moment to ask a spoken follow-up question. The system pauses playback and returns a live spoken answer relevant to the current lesson context, using the SAME teacher voice as the scripted podcast. The learner can barge-in (interrupt the tutor's answer to speak again). When the exchange ends, playback resumes from the exact point of interruption. Each Q&A exchange's text transcript is captured and associated with the lesson and the relevant item. Empty/unintelligible interruptions prompt for clarification; off-topic questions are answered briefly or redirected; live-tutor unavailability is communicated with a fallback. OUT OF SCOPE: persistent note capture and cross-session adaptive progress (separate features); phoneme-level pronunciation scoring.

---

## S3 — One adaptive, steerable live story instead of a fixed recording

**Status**: Done (006)

Collapse the frozen MP3 + separate live tutor into one live-narrated stream: the teacher voice tells the story live, the learner interrupts to ask questions and to change the scenario on the fly, and the story adapts while still teaching every item. `generateLesson` splits into a text-only plan + live narration; a durable text transcript is the replayable record.

**Specify input**:
> Add an adaptive, interruptible **live-narrated** lesson mode on top of existing lesson generation and live Q&A (assumes both exist). Instead of playing a pre-rendered audio file, the system narrates the lesson live in the teacher voice from a generated lesson plan (an ordered set of teachable items and story beats with a bounded target length), in a single realtime session that also handles interruptions. The learner can interrupt at any moment to ask a spoken question (barge-in) AND to change the story scenario on the fly (e.g. "make this about space travel"); the system adapts the narration to the new scenario, keeps that change in effect, and still teaches every planned item at least once. Throughout the session the learner sees subtitle-level live captions of both the teacher's speech and their own recognized speech, finalized turn-by-turn, with the teacher caption corrected to what was actually spoken when the learner barges in. The full session — narration plus Q&A exchanges, using corrected text — is captured as a durable text transcript associated with the lesson and reviewable in later sessions; this transcript, not the audio, is the replayable record. Live-session unavailability is communicated with a fallback. OUT OF SCOPE: persisting/replaying the realtime audio itself; a hybrid pre-rendered-spine-plus-live-branches approach; karaoke/word-synced caption highlighting; pronunciation scoring; note capture; cross-session adaptive progress — those are separate or rejected.

---

## S4 — Live-only: retire the pre-rendered podcast & playback Q&A

**Status**: Done (007)

Make the product live-only: generation produces a text plan/script (no TTS render, stitch, or Storage upload — a lesson is `ready` on a valid script), the lesson page offers only the live story, and the old audio + playback-Q&A subsystems and their tables are retired via a forward migration. The eval gate scores the script only; the Constitution is reframed away from the "scripted podcast."

**Specify input**:
> Retire the pre-rendered audio podcast and the playback-anchored live Q&A so the product is **live-only**, assuming the adaptive live-narrated story already exists. Lesson generation produces only the text lesson plan/script (ordered teachable items, story beats, bounded target length) with its coverage guarantee and the two distinct personas — it no longer synthesizes, stitches, or stores any audio file. The lesson experience is exclusively the live-narrated, steerable story; the pre-rendered audio player and the older playback-position Q&A mode are removed from the product, along with their audio storage and Q&A transcript tables — the live-session transcript is the durable record. Generation quality is still evaluated on the script (every teachable item covered, two distinct personas, story-driven), without any audio-render or audio-length checks. The product's voice-consistency and reproducibility principles are reframed away from the now-removed "scripted podcast." OUT OF SCOPE: changing live-story behavior; removing script/coverage generation (the planner still needs them); preserving previously rendered audio; a flag to keep the old mode; auth/persistence redesign.

---

## S5 — Capture notes during a lesson

**Status**: To-do

At any point during a live-narrated lesson the learner captures a note tied to the current moment (a phrase, a usage example from a tutor answer, or a line straight from the live captions), anchored to the active item/beat plus a transcript offset. Notes persist and are reviewable later.

**Specify input**:
> Add note capture to the live-narrated, steerable lesson experience (assumes the live-only adaptive-live-story mode exists; there is no pre-rendered playback mode). At any point during a live session the learner can capture a note (a phrase to remember, a usage example from a tutor answer, or a line from the live captions/transcript) without breaking the flow of the session. Each note is anchored to the moment it was captured using a live-mode reference: the active item/beat plus a transcript offset (the live mode has no audio playhead). Notes are persisted to the learner's account and made reviewable, with their anchor, when the learner reopens the lesson in a later session. OUT OF SCOPE: lesson generation, live Q&A/steering mechanics, cross-session adaptive progress, and any rendered-audio-position anchor — those are separate or removed features.

---

## S6 — Adaptive progress across sessions

**Status**: To-do

The system remembers what the learner studied and which items they struggled with (asked questions about or flagged), and uses that history so future lessons reinforce struggled items and de-emphasize mastered ones. Cross-session adaptation — distinct from S3's within-session steering.

**Specify input**:
> Add cross-session adaptive progress on top of existing lesson generation and the live-narrated story mode (assumes those features exist; the product is live-only). Maintain a per-learner progress history of items studied with a status of new, struggled, or mastered. At the end of a lesson, flag items the learner appeared to struggle with — items they asked live questions about during a live-narrated session or explicitly flagged. When generating a future lesson, use this history to give struggled items additional reinforcement and de-emphasize mastered ones, and surface the struggled items for the next session. An item is "struggled" when questioned or flagged; quizzing/scoring and pronunciation analysis are OUT OF SCOPE. The lesson-generation, live-story, and note-capture mechanics are consumed from their own features, not redefined here.

---

## S7 — Internal structured logging

**Status**: Done (003)

Levelled JSON logging across the generation pipeline — workflow steps, lesson-status transitions, teachability classification, and coverage validation — correlated by lesson id, with secrets redacted. Internal observability beyond HTTP/request-edge logging.

**Specify input**:
> Add internal structured logging to the lesson generation pipeline (assumes the lesson-generation feature exists). Emit levelled, JSON-line logs across the generator workflow steps, the generation bridge/runner lesson-status transitions (pending → generating → ready | failed), teachability classification, and coverage validation. Correlate every entry for one lesson run by lesson id, and always redact secrets. This is internal observability beyond HTTP/request-edge logging. OUT OF SCOPE: a third-party APM vendor or log-shipping infrastructure, and LangSmith eval-trace export.

---

## S8 — Parallelize batch TTS rendering

**Status**: Done (004) — retired by S4

A bounded-concurrency pool for the per-batch ElevenLabs Text-to-Dialogue renders (configurable cap under the plan's concurrency limit), preserving stitch order and extracting a reusable `mapWithConcurrency` utility. Retired by S4 — the live-only product no longer pre-renders audio.

**Specify input**:
> Parallelize the batch TTS rendering of a generated podcast lesson (assumes the lesson-generation feature exists). The ElevenLabs Text-to-Dialogue render currently processes segment batches sequentially; introduce a bounded-concurrency pool for the per-batch renders, with the cap configurable via env and set under the ElevenLabs plan's concurrency limit to avoid 429s. Preserve the final stitch order, extract the bounded-concurrency logic as a reusable mapWithConcurrency utility, and add a "generation can take a few minutes" note in the UI so the wait is expected. OUT OF SCOPE: progressive/streaming playback while later batches render, and the realtime live-tutor/live-story path.

---

## S9 — Improve LangSmith tracing

**Status**: Done (008) — implemented & green (typecheck/test/lint); live capture spike (T022) + dashboard wiring (T033) pending real ElevenLabs/LangSmith access

Make the pipeline observable in LangSmith end-to-end, not just for batch generation: extend tracing to the adaptive live-narrated story session (session, turns, scenario changes, coverage/beat progress, client-tool calls) and enrich the existing generation traces with structured run hierarchy, inputs/outputs, and metadata correlated by lesson/session id. LangSmith stays a soft dependency that no-ops without a key.

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

| Story | Slug                | Folder | Spec | Plan | Tasks | Implemented |
|-------|---------------------|--------|------|------|-------|-------------|
| S1    | lesson-generation   | 002    | ☑    | ☑    | ☑     | ☑           |
| S2    | live-tutor-qa       | 005    | ☑    | ☑    | ☑     | ☑           |
| S3    | adaptive-live-story | 006    | ☑    | ☑    | ☑     | ☑           |
| S4    | live-only           | 007    | ☑    | ☑    | ☑     | ☑           |
| S5    | lesson-notes        | —      | ☐    | ☐    | ☐     | ☐           |
| S6    | adaptive-progress   | —      | ☐    | ☐    | ☐     | ☐           |
| S7    | internal-logging    | 003    | ☑    | ☑    | ☑     | ☑           |
| S8    | tts-parallel-render | 004    | ☑    | ☑    | ☑     | ☑           |
| S9    | langsmith-tracing   | 008    | ☑    | ☑    | ☑     | ☑           |

---

## TO-DO

Future improvements — not yet finalised as stories.

- Agent stop/continue — jumps across chunks. Cannot remember the exact position where conversation stopped and continue from the same place.
- **Improve Live story Prompt** — have one big chunk instead of chunk-by-chunk talk. Investigate possible options for a Planned/Scenario Talk agent.
