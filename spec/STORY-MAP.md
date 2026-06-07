# Story Map — Interactive English Lesson Podcast (Idiomatic)

**Source vision**: [`PRD-base.md`](./PRD-base.md)
**Created**: 2026-06-06 · **Last reordered**: 2026-06-07 (inserted **S4 — live-only**; pushed lesson-notes → S5, adaptive-progress → S6)
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
S1 lesson-generation [002] ─► S2 live-tutor-qa [005] ─► S3 adaptive-live-story [006] ─► S4 live-only [007]  ◄── next up
        │                           │                            │                           │
        │                           │                            │                           ├─► S5 lesson-notes [008*]
        │                           │                            │                           └─► S6 adaptive-progress [009*]
        │
        ├──► TE2 internal-logging [003]      (tech · enhances S1)
        └──► TE1 tts-parallel-render [004]    (tech · enhances S1 — RETIRED by S4 live-only)

  [NNN] = spec folder specs/NNN-<slug>/   * = provisional (assigned when the folder is created)
  Folders are numbered in creation order — TE2/TE1 took 003/004 between S1 and S2, so S2 is 005.
  S4 (live-only) RETIRES S1's audio render + storage, the whole of S2 (playback Q&A), and TE1 —
  the product collapses to one live-narrated stream (S3) with a text plan + durable transcript.
```

- **S1** is the foundation (MVP). It also carries the **cross-cutting** account/persistence and input-guardrail requirements, because everything else builds on an authenticated, persistent lesson. *(Done.)*
- **S2** depends on S1 (needs a playing lesson + the teacher voice). *(Done — but RETIRED by S4 live-only.)*
- **S3** (adaptive-live-story) depended on S1 + S2 (reuses the generation pipeline as a *planner* and the live convai session + teacher voice + transcript tables). It introduced one live-narrated, steerable stream **alongside** the rendered podcast. *(Done.)*
- **S4** (live-only) depends on S3. It **retires the now-redundant pre-rendered paths**: generation becomes plan-only (no TTS render / stitch / storage), and the rendered `<audio>` player + the S2 playback-Q&A mode + their tables are removed. The live story (S3) becomes the **only** lesson experience. **Supersedes S3's "both modes coexist" decision. Next up.**
- **S5** (lesson-notes) depends on S3/S4 — the live story is the only mode now. A note anchors to the active item/beat + a transcript offset (live mode has no audio playhead), and a caption/transcript line can become a note. *(No rendered-playback / audio-position anchor — that mode is gone after S4.)*
- **S6** (adaptive-progress) depends on **S3 live sessions** as the struggle signal (questions asked during a live-narrated session) and consumes S5 notes if present. Adapts *across* sessions — distinct from S3's *within*-session steering.

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

## S3 — One adaptive, steerable live story instead of a fixed recording  (P3) — **BUILT**

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

## S4 — Live-only: retire the pre-rendered podcast & playback Q&A  (P3.5, refactor) — **NEXT**

**Slug**: `live-only` · **Branch**: `007-live-only` *(next free spec number)* · **Depends on**: S3

**Value**: After S3, the lesson exists as **two parallel realities**: the frozen MP3 podcast (S1) + its playback-anchored live Q&A (S2), *and* the new live-narrated story (S3). The pre-rendered path is now redundant — the live story already teaches every item, steerably, with a durable transcript. Carrying the MP3 render, the audio storage, and the playback-position Q&A adds real cost (TTS minutes, Storage, signed URLs), surface area, and a confusing dual UI. S4 makes the product **live-only**: generation produces a text **plan/script**, not audio; the lesson page offers **only** the live story; the old audio + playback-Q&A subsystems and their tables are retired. This is the `planLesson` split S3's design memo flagged but deliberately deferred to keep S3's blast radius small.

**In scope**: turn `generateLesson` into a **plan-only `planLesson`** (Claude draft script + `validateCoverage`, keeping `estimatedDurationSeconds` and the two-voice script for `derivePlan`/narration target) with **no** TTS render, audio stitch, or Storage upload — a lesson goes `ready` on a valid script; **remove** the pre-rendered `<audio>` player and the S2 playback-position Q&A from the lesson page so the live story (S3) is the only experience; **retire** audio storage (the Storage bucket + `lesson_audio`) and the `qa_exchanges`/`qa_turns` tables via a forward migration (keep `live_sessions`/`session_turns`); remove the TTS adapter/render path, the batch-render concurrency (TE1), audio DTO fields (`audioDurationSeconds`), the audio route, and `smoke:generate`'s audio output; update the **eval gate** to score the script only (coverage / two distinct personas / story-driven), with no audio-render or audio-length checks; update the **Constitution** where it defines the product around the "scripted podcast" + a render eval (Principle I → "the pinned teacher voice"; Principle III → drop render/audio-length scorers); move the one reused S2 artifact (`live-tutor/token.ts`) under `live-story/`.

**Out of scope**: changing the live-story behavior itself (S3 stays as built); removing script/coverage **generation** (the planner still needs the LessonScript + coverage + estimated duration); auth/persistence/RLS redesign; backfilling or preserving previously-rendered MP3s (those modes are removed — data loss for `lesson_audio`/`qa_*` is accepted); a feature flag to keep the rendered mode (this is a clean removal, not a toggle).

**Independent test**: Submit a list → the lesson becomes `ready` with a derivable plan and **no** audio object exists in Storage and **no** `lesson_audio` row is written. Open the lesson → there is **only** the Live Story panel — no `<audio>` element, no separate "Live tutor" panel. Start it → live narration teaches every item and the transcript persists. Search the codebase/build: the TTS render path, audio storage, and `qa_*` tables/routes are gone; `pnpm test && pnpm typecheck && pnpm lint` pass green with the audio/Q&A suites removed and the planner/eval suites updated.

**Specify input**:
> Retire the pre-rendered audio podcast and the playback-anchored live Q&A so the product is **live-only**, assuming the adaptive live-narrated story already exists. Lesson generation produces only the text lesson plan/script (ordered teachable items, story beats, bounded target length) with its coverage guarantee and the two distinct personas — it no longer synthesizes, stitches, or stores any audio file. The lesson experience is exclusively the live-narrated, steerable story; the pre-rendered audio player and the older playback-position Q&A mode are removed from the product, along with their audio storage and Q&A transcript tables — the live-session transcript is the durable record. Generation quality is still evaluated on the script (every teachable item covered, two distinct personas, story-driven), without any audio-render or audio-length checks. The product's voice-consistency and reproducibility principles are reframed away from the now-removed "scripted podcast." OUT OF SCOPE: changing live-story behavior; removing script/coverage generation (the planner still needs them); preserving previously rendered audio; a flag to keep the old mode; auth/persistence redesign.

**Design notes** (2026-06-07):
- Migrations are **forward-only**: add a migration that drops `lesson_audio` + the Storage bucket policy (`0002_storage.sql`) and `qa_exchanges`/`qa_turns` (`0004_qa.sql`); `live_sessions`/`session_turns` stay. Existing rows are discarded (accepted).
- The generator keeps the **Claude draft + `validateCoverage` + `LessonScript`** (with `estimatedDurationSeconds`); only the `TtsAdapter` / ElevenLabs render / stitch / `RenderedAudio` / `mapWithConcurrency`-for-TTS tail is removed. `derivePlan` (S3) is unchanged.
- The lesson status machine simplifies: `ready` now means "has a valid script/plan," not "has rendered audio."
- Web removals: `<audio>` player, `lib/live-tutor/*` (except the moved token), `lib/qa/*`, `supabase/audio-storage.ts` + `supabase/qa-repository.ts`, `generation/storage.ts`, the audio + exchanges routes, the `qa.ts` contracts, `LiveTutor*`/`usePlaybackQa`/`current-item`/`exchange-state`.
- **Constitution** is in scope to edit (run `/speckit.constitution` if the principle wording needs it) — this is the first story that deliberately removes a Principle-I/III anchor (the rendered podcast), so make that decision explicitly in the spec/plan, not implicitly in code.

---

## S5 — Capture notes during a lesson  (P4)

**Slug**: `lesson-notes` · **Branch**: `008-lesson-notes` *(provisional; assigned when the folder is created)* · **Depends on**: S3 + S4 (the live story is the only lesson mode)

**Value**: At any point during a live-narrated lesson the learner captures a note tied to the current moment — a phrase to remember, a usage example from a tutor answer, or a line straight from the live captions. Notes persist and are reviewable later. Reinforces retention with durable takeaways. (After S4 there is only the live mode — no rendered-playback anchor.)

**In scope**: capture a note at any point during a live-narrated session without breaking flow; **anchor each note to the active item/beat plus a transcript offset** (the live mode has no audio playhead); capture a note directly from a **live caption/transcript line** (turn what the teacher just said into a note); persist; review all notes with their anchor when reopening the lesson in a later session.

**Out of scope**: lesson generation (S1); live Q&A / steering mechanics (S3); cross-session adaptation (S6); any rendered-audio-position anchor (that mode is removed by S4).

**Independent test**: In a live session capture a note and capture one from a caption line; end session, return later → all notes present, linked to the correct lesson, and anchored to the right item/beat + transcript offset.

**Specify input**:
> Add note capture to the live-narrated, steerable lesson experience (assumes the live-only adaptive-live-story mode exists; there is no pre-rendered playback mode). At any point during a live session the learner can capture a note (a phrase to remember, a usage example from a tutor answer, or a line from the live captions/transcript) without breaking the flow of the session. Each note is anchored to the moment it was captured using a live-mode reference: the active item/beat plus a transcript offset (the live mode has no audio playhead). Notes are persisted to the learner's account and made reviewable, with their anchor, when the learner reopens the lesson in a later session. OUT OF SCOPE: lesson generation, live Q&A/steering mechanics, cross-session adaptive progress, and any rendered-audio-position anchor — those are separate or removed features.

---

## S6 — Adaptive progress across sessions  (P5)

**Slug**: `adaptive-progress` · **Branch**: `009-adaptive-progress` *(provisional; assigned when the folder is created)* · **Depends on**: **S3 live sessions** (the struggle signal — questions asked during a live-narrated session); consumes S5 notes if present

**Value**: The system remembers what the learner studied and which items they struggled with (asked questions about or flagged), and uses that history so future lessons reinforce struggled items and de-emphasize mastered ones. Drives long-term learning value and stickiness. This is *cross-session* adaptation — distinct from S3, which steers a single session live.

**In scope**: per-learner progress history of items with status (new/struggled/mastered); flag struggled items at end of a lesson (questions asked or explicit flag); use history when generating future lessons to reinforce struggled and de-emphasize mastered; surface struggled items for next session.

**Out of scope**: quizzing/scoring; pronunciation analysis; the generation/Q&A/live-story/notes mechanics themselves (consumed from S1–S4).

**Independent test**: Complete a lesson where some items trigger questions, start a new lesson later → previously struggled items are reinforced and progress history reflects what was studied.

**S3 interaction**: after S4 the **live-narrated session is the only** struggle-signal source — questions asked during narration, plus per-item live-coverage data (which items the narration's `advanceNarration`/`markItemTaught` progress actually delivered) and the full session transcript. (The S2 playback-Q&A source is gone — retired by S4.) "Struggled = questioned or flagged" still holds.

**Specify input**:
> Add cross-session adaptive progress on top of existing lesson generation and the live-narrated story mode (assumes those features exist; the product is live-only). Maintain a per-learner progress history of items studied with a status of new, struggled, or mastered. At the end of a lesson, flag items the learner appeared to struggle with — items they asked live questions about during a live-narrated session or explicitly flagged. When generating a future lesson, use this history to give struggled items additional reinforcement and de-emphasize mastered ones, and surface the struggled items for the next session. An item is "struggled" when questioned or flagged; quizzing/scoring and pronunciation analysis are OUT OF SCOPE. The lesson-generation, live-story, and note-capture mechanics are consumed from their own features, not redefined here.

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

| Story | Slug | Folder | Priority | Spec | Plan | Tasks | Implemented |
|-------|------|--------|----------|------|------|-------|-------------|
| S1 | lesson-generation | 002 | P1 | ☑ | ☑ | ☑ | ☑ |
| S2 | live-tutor-qa | 005 | P2 | ☑ | ☑ | ☑ | ☑ (retired by S4) |
| S3 | adaptive-live-story | 006 | P3 | ☑ | ☑ | ☑ | ☑ |
| S4 | live-only | 007 | P3.5 | ☐ | ☐ | ☐ | ☐ ◄ next |
| S5 | lesson-notes | 008* | P4 | ☐ | ☐ | ☐ | ☐ |
| S6 | adaptive-progress | 009* | P5 | ☐ | ☐ | ☐ | ☐ |
| TE1 | tts-parallel-render | 004 | Tech | ☑ | ☑ | ☑ | ☑ (retired by S4) |
| TE2 | internal-logging | 003 | Tech | ☑ | ☑ | ☑ | ☑ |
