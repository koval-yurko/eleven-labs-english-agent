# Story Map — Interactive English Lesson Podcast (Idiomatic)

**Source vision**: [`PRD-base.md`](./PRD-base.md)
**Created**: 2026-06-06 · **Last reordered**: 2026-06-07
**Purpose**: Decompose the PRD into independently-shippable stories. Each story below becomes its **own** Spec Kit feature (its own `specs/00N-*/` folder, branch, plan, tasks, implementation). Do **not** run `speckit.specify` on the whole PRD — run it once per story using the "specify input" block provided.

> This file is the backlog. It is not a spec. Detailed acceptance criteria live in each generated `spec.md`.

---

## How to use this map

1. Pick a story (start with the next un-built one in order).
2. Copy its **Specify input** block.
3. Run: `/speckit.specify --number <N> --short-name <slug> "<paste the input>"`
4. Then `/speckit.plan` → `/speckit.tasks` → `/speckit.implement` for that story.
5. Build/merge in priority order so later stories can assume earlier ones exist.

**Numbering**: the **S-number** is the logical story order. The **spec-folder number** is assigned sequentially as folders are created (002–005 are already taken), so S-numbers and folder numbers diverge — each story records its own branch/folder.

---

## Build order & dependencies

```
S1 lesson-generation [002] ──► S2 live-tutor-qa [005] ──► S3 adaptive-live-story [006]   ◄── next up
        │                            │                             │
        │                            ├──► S4 lesson-notes [007*] ◄─┘
        │                            │
        │                            └──► S5 adaptive-progress [008*]
        │
        ├──► TE2 internal-logging [003]      (tech · enhances S1)
        └──► TE1 tts-parallel-render [004]    (tech · enhances S1)

  [NNN] = spec folder specs/NNN-<slug>/   * = provisional (assigned when the folder is created)
  Folders are numbered in creation order — TE2/TE1 took 003/004 between S1 and S2, so S2 is 005.
```

- **S1** is the foundation (MVP). It also carries the **cross-cutting** account/persistence and input-guardrail requirements, because everything else builds on an authenticated, persistent lesson. *(Done.)*
- **S2** depends on S1 (needs a playing lesson + the teacher voice). *(Done.)*
- **S3** (adaptive-live-story) depends on S1 + S2 (reuses the generation pipeline as a *planner* and the live convai session + teacher voice + transcript tables). It is an **alternative experience mode** that replaces static MP3 playback with one live-narrated, steerable stream; it does not remove S1's rendered-podcast mode. **Next up.**
- **S4** (lesson-notes) depends on S1 (playback); enriched by S2. It **must support S3's live mode** too: the live mode has no audio playhead, so a note anchors to the active item/beat + transcript offset (and a caption line can become a note).
- **S5** (adaptive-progress) depends on S1 + S2 (struggle signal comes from questions asked); **S3 live sessions are an additional struggle-signal source**; consumes S4 notes if present. Adapts *across* sessions — distinct from S3's *within*-session steering.

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

**Out of scope**: live Q&A / interruption (S2); notes (S4); cross-session adaptation (S5).

**Independent test**: Submit 5–10 idioms → one coherent ~5–10 min lesson, two distinct voices, every item taught through stories, replayable after re-login.

**Specify input**:
> Generate a story-driven, two-voice podcast lesson from a learner-provided list of English words, sentences, and idioms. The system produces a ~5–10 minute audio lesson presented as a conversation between a curious learner persona and a warm teacher persona, explaining each submitted item through vivid mini-stories rather than dictionary definitions. Every teachable item is covered at least once; lesson length is bounded for large inputs. Lessons and their audio are persisted to an authenticated learner account, private to that learner, and replayable in later sessions on responsive web (desktop + mobile browser). Empty, oversized, or unteachable input is handled gracefully with clear messaging, and generation/playback status is communicated. OUT OF SCOPE: live interruption/Q&A, note capture, and cross-session adaptive progress — those are separate features.

---

## S2 — Interrupt the podcast for a live spoken answer  (P2)

**Slug**: `live-tutor-qa` · **Branch**: `005-live-tutor-qa` · **Depends on**: S1

**Value**: While listening, the learner interrupts to ask a spoken follow-up and gets a live spoken answer in the **same teacher voice**, with barge-in, then resumes exactly where they left off. This turns a passive podcast into a tutor.

**In scope**: play/pause/resume; interrupt at any moment; live spoken answer relevant to current lesson context; tutor uses same teacher voice; barge-in (learner can interrupt the answer); resume from exact interruption point; capture text transcript of each exchange linked to lesson + item; status when live tutor unavailable; handle empty/unintelligible interruptions and off-topic questions.

**Out of scope**: note capture (S4); progress/adaptation (S5); pronunciation scoring.

**Independent test**: During playback, interrupt, speak a question → relevant spoken answer in the same teacher voice within a few seconds; barge-in works; playback resumes at the interruption point; transcript stored.

**Specify input**:
> Add live, interruptible Q&A to an existing generated podcast lesson (assumes the lesson-generation feature exists). While a lesson is playing, the learner can play/pause/resume and interrupt at any moment to ask a spoken follow-up question. The system pauses playback and returns a live spoken answer relevant to the current lesson context, using the SAME teacher voice as the scripted podcast. The learner can barge-in (interrupt the tutor's answer to speak again). When the exchange ends, playback resumes from the exact point of interruption. Each Q&A exchange's text transcript is captured and associated with the lesson and the relevant item. Empty/unintelligible interruptions prompt for clarification; off-topic questions are answered briefly or redirected; live-tutor unavailability is communicated with a fallback. OUT OF SCOPE: persistent note capture and cross-session adaptive progress (separate features); phoneme-level pronunciation scoring.

---

## S3 — One adaptive, steerable live story instead of a fixed recording  (P3) — **NEXT**

**Slug**: `adaptive-live-story` · **Branch**: `006-adaptive-live-story` *(next free spec number; folders are numbered sequentially by creation — 002–005 are taken)* · **Depends on**: S1 + S2

**Value**: Today the lesson is a **frozen MP3** and the live tutor is a **separate realtime session** bolted onto it at the pause/resume seam — two streams living their own life. The learner can interrupt and ask, but can never change what the recording says next. S3 collapses them into **one live-narrated stream**: the teacher voice tells the story live, the learner interrupts to ask questions *and to change the scenario on the fly* ("make this about cooking instead"), and the story adapts while still teaching every item. Because narration is generated live, it can finally bend to the learner.

**Key model shift**: split S1's `generateLesson` into **plan (batch, text-only)** + **narrate (live)**. The plan (ordered items, story beats, target length) keeps the coverage/length guarantees; the ElevenLabs convai agent (Claude + same teacher voice) narrates the plan in the same realtime session that handles interruption and steering — no static `<audio>` element. The synthetic "curious learner" persona disappears because the *real* learner is now in the loop.

**In scope**: live continuous narration of a planned lesson in the teacher voice (beat-chunked self-continuation so a turn-based agent narrates multi-minute content); interrupt at any moment to ask a question (reuses S2 barge-in/VAD); **steer/change the story scenario mid-session** with the change pinned so it doesn't drift back, while still covering all teachable items; **subtitle-level live captions for both sides** (teacher line + learner's recognized speech, finalized-turn granularity) with corrections applied on barge-in; a **durable text transcript** of the whole session (narration + Q&A) that becomes the replayable record; coverage tracked live via a progress/`nextBeat` client tool; status/fallback when the live session is unavailable.

**Out of scope**: durable **audio** replay / persisting the realtime audio (transcript is the record — replay = re-narrate, and it will differ); the hybrid "pre-rendered spine + live branches" model (S3 is full live narration; rejected in design); karaoke/word-synced highlighting (needs alignment timestamps — `AudioAlignmentEvent`, deferred); live word-streaming interim captions via the SDK's private `internal_tentative_*` / `onDebug` path (unstable — captions use the stable `onMessage` finalized turns); pronunciation scoring; notes (S4); cross-session adaptation (S5).

**Independent test**: Start a lesson → the teacher narrates it live with subtitles for both speakers; interrupt and ask a question → spoken answer + captions, then narration continues; say "change the story to be about X" → the narration adapts to X yet still teaches the remaining items; end the session → a full readable transcript (narration + exchanges, with interruption corrections) is persisted and reviewable later.

**Specify input**:
> Add an adaptive, interruptible **live-narrated** lesson mode on top of existing lesson generation and live Q&A (assumes both exist). Instead of playing a pre-rendered audio file, the system narrates the lesson live in the teacher voice from a generated lesson plan (an ordered set of teachable items and story beats with a bounded target length), in a single realtime session that also handles interruptions. The learner can interrupt at any moment to ask a spoken question (barge-in) AND to change the story scenario on the fly (e.g. "make this about space travel"); the system adapts the narration to the new scenario, keeps that change in effect, and still teaches every planned item at least once. Throughout the session the learner sees subtitle-level live captions of both the teacher's speech and their own recognized speech, finalized turn-by-turn, with the teacher caption corrected to what was actually spoken when the learner barges in. The full session — narration plus Q&A exchanges, using corrected text — is captured as a durable text transcript associated with the lesson and reviewable in later sessions; this transcript, not the audio, is the replayable record. Live-session unavailability is communicated with a fallback. OUT OF SCOPE: persisting/replaying the realtime audio itself; a hybrid pre-rendered-spine-plus-live-branches approach; karaoke/word-synced caption highlighting; pronunciation scoring; note capture; cross-session adaptive progress — those are separate or rejected.

**Design notes** (from 2026-06-07 design discussion):
- Reuse S1's Claude draft + `validateCoverage` as a **text-only planner** (`planLesson`); drop TTS render + Storage upload from this path. S1's rendered-podcast mode stays for users who want it.
- Continuous narration on a turn-based convai agent needs **beat-chunked self-continuation**: agent narrates a beat → calls a `nextBeat()` **client tool** (also the coverage/progress hook) → continues. Steering pinned via `sendContextualUpdate`.
- Captions/transcript rest on **verified-stable** SDK surface: `onMessage` (`source:"ai"|"user"`, finalized turns) for both caption streams; `onAgentResponseCorrection` (`original_*`/`corrected_*`) to fix caption + record on barge-in. Avoid `onDebug`/`internal_tentative_*`.
- S2 machinery this **retires** in the live mode: `usePlaybackQa.ts` and `current-item.ts` (char-proportional position→item) become obsolete; the `<audio>` pause/resume seam in `LiveTutorController.tsx` goes away. Also fixes the existing gap where `lib/live-tutor/context.ts` ignores the script (`_script`) and never calls `sendContextualUpdate`.
- Transcript persistence extends S2's `qa_exchanges`/`qa_turns` to cover the whole session (not just Q&A). The per-item live-coverage signal (`nextBeat`) and the transcript are reusable struggle signals for S5.

---

## S4 — Capture notes during a lesson  (P4)

**Slug**: `lesson-notes` · **Branch**: `007-lesson-notes` *(provisional; assigned when the folder is created)* · **Depends on**: S1 (rendered playback); enriched by S2; **must support S3's live mode**

**Value**: At any point during a lesson the learner captures a note tied to the current moment — a phrase to remember, a usage example from a tutor answer, or a line straight from the live captions. Notes persist and are reviewable later. Reinforces retention with durable takeaways. Works in **both** lesson modes: the rendered podcast (S1) and the live-narrated story (S3).

**In scope**: capture a note at any point — in rendered playback **and** in a live-narrated session — without losing place (rendered) or breaking flow (live); **anchor each note with a mode-appropriate reference**: an audio position in rendered mode, and the active item/beat plus a transcript offset in live mode (which has no audio playhead); capture a note directly from a **live caption/transcript line** (turn what the teacher just said into a note); persist; review all notes with their anchor when reopening the lesson in a later session.

**Out of scope**: lesson generation (S1); live Q&A / steering mechanics (S2/S3); cross-session adaptation (S5).

**Independent test**: In rendered playback capture a note; in a live session capture a note and capture one from a caption line; end session, return later → all notes present, linked to the correct lesson, and anchored correctly for their mode (audio position vs. item/beat + transcript offset).

**Specify input**:
> Add note capture to an existing lesson experience that has two playback modes — a pre-rendered podcast (lesson-generation) and a live-narrated, steerable story (adaptive-live-story). At any point during either mode the learner can capture a note (a phrase to remember, a usage example from a tutor answer, or a line from the live captions/transcript) without losing their place in rendered playback or breaking the flow of a live session. Each note is anchored to the moment it was captured using a mode-appropriate reference: an audio position in the rendered mode, and the active item/beat plus a transcript offset in the live mode (which has no audio playhead). Notes are persisted to the learner's account and made reviewable, with their anchor, when the learner reopens the lesson in a later session. OUT OF SCOPE: lesson generation, live Q&A/steering mechanics, and cross-session adaptive progress — those are separate features.

---

## S5 — Adaptive progress across sessions  (P5)

**Slug**: `adaptive-progress` · **Branch**: `008-adaptive-progress` *(provisional; assigned when the folder is created)* · **Depends on**: S1 + S2 (struggle signal); **S3 live sessions are an additional struggle-signal source**; consumes S4 if present

**Value**: The system remembers what the learner studied and which items they struggled with (asked questions about or flagged), and uses that history so future lessons reinforce struggled items and de-emphasize mastered ones. Drives long-term learning value and stickiness. This is *cross-session* adaptation — distinct from S3, which steers a single session live.

**In scope**: per-learner progress history of items with status (new/struggled/mastered); flag struggled items at end of a lesson (questions asked or explicit flag); use history when generating future lessons to reinforce struggled and de-emphasize mastered; surface struggled items for next session.

**Out of scope**: quizzing/scoring; pronunciation analysis; the generation/Q&A/live-story/notes mechanics themselves (consumed from S1–S4).

**Independent test**: Complete a lesson where some items trigger questions, start a new lesson later → previously struggled items are reinforced and progress history reflects what was studied.

**S3 interaction**: S3 (live story) is simply **another source of the struggle signal** (questions asked during a live-narrated session) and a richer one — it provides per-item live-coverage data (which items the `nextBeat` progress actually delivered) and a full session transcript. Treat S2 and S3 sessions **uniformly** as Q&A/struggle sources rather than special-casing one. "Struggled = questioned or flagged" still holds.

**Specify input**:
> Add cross-session adaptive progress on top of existing lesson generation and live Q&A (assumes those features exist, including the live-narrated story mode). Maintain a per-learner progress history of items studied with a status of new, struggled, or mastered. At the end of a lesson, flag items the learner appeared to struggle with — items they asked live questions about (in either the Q&A or the live-narrated mode) or explicitly flagged. When generating a future lesson, use this history to give struggled items additional reinforcement and de-emphasize mastered ones, and surface the struggled items for the next session. An item is "struggled" when questioned or flagged; quizzing/scoring and pronunciation analysis are OUT OF SCOPE. The lesson-generation, live-Q&A, live-story, and note-capture mechanics are consumed from their own features, not redefined here.

---

## Technical enhancements (cross-cutting backlog)

Not user-facing stories — engineering enhancements that improve an existing story
(mostly S1). Each can become its own small Spec Kit feature or fold into an S1
polish pass. Tracked here so they aren't lost.

### TE1 — Parallelize batch TTS rendering  (Tech, enhances S1)

**Slug**: `tts-parallel-render` · **Branch**: `004-tts-parallel-render` · **Depends on**: S1

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
renders — a bigger latency win but a much larger change, deferred); the realtime
live-tutor / live-story path (a different streaming API — this enhancement does not apply there).

**Note**: the reusable concurrency primitive is useful beyond TTS (e.g. parallel item
classification if teachability becomes LLM-based, or bulk regeneration in S5).

### TE2 — Internal structured logging  (Tech, cross-cutting)

**Slug**: `internal-logging` · **Branch**: `003-internal-logging` · **Depends on**: S1

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
| S2 | live-tutor-qa | P2 | ☑ | ☑ | ☑ | ☑ |
| S3 | adaptive-live-story | P3 | ☐ | ☐ | ☐ | ☐ |
| S4 | lesson-notes | P4 | ☐ | ☐ | ☐ | ☐ |
| S5 | adaptive-progress | P5 | ☐ | ☐ | ☐ | ☐ |
| TE1 | tts-parallel-render | Tech | ☑ | ☑ | ☑ | ☑ |
| TE2 | internal-logging | Tech | ☑ | ☑ | ☑ | ☑ |
