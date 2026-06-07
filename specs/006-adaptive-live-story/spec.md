# Feature Specification: Adaptive, Interruptible Live-Narrated Lesson

**Feature Branch**: `006-adaptive-live-story`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "Add an adaptive, interruptible live-narrated lesson mode on top of existing lesson generation and live Q&A. Instead of playing a pre-rendered audio file, the system narrates the lesson live in the teacher voice from a generated lesson plan (an ordered set of teachable items and story beats with a bounded target length), in a single realtime session that also handles interruptions. The learner can interrupt at any moment to ask a spoken question (barge-in) AND to change the story scenario on the fly (e.g. 'make this about space travel'); the system adapts the narration to the new scenario, keeps that change in effect, and still teaches every planned item at least once. Throughout the session the learner sees subtitle-level live captions of both the teacher's speech and their own recognized speech, finalized turn-by-turn, with the teacher caption corrected to what was actually spoken when the learner barges in. The full session — narration plus Q&A exchanges, using corrected text — is captured as a durable text transcript associated with the lesson and reviewable in later sessions; this transcript, not the audio, is the replayable record. Live-session unavailability is communicated with a fallback. OUT OF SCOPE: persisting/replaying the realtime audio itself; a hybrid pre-rendered-spine-plus-live-branches approach; karaoke/word-synced caption highlighting; pronunciation scoring; note capture; cross-session adaptive progress."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hear a lesson narrated live that teaches every planned item (Priority: P1)

A learner opens a lesson and chooses to experience it live rather than as a pre-recorded recording. The system narrates the lesson aloud in the teacher voice, working through an ordered plan of teachable items woven into story beats. The learner listens to a coherent, paced narration that covers each planned teaching item at least once and reaches a natural ending within a bounded target length.

**Why this priority**: This is the foundational shift of the feature — replacing playback of a fixed audio file with a single live narration session driven by a lesson plan. Without it, none of the adaptive or interactive behavior exists. A learner who can start a live narration, hear every planned item taught in the teacher voice, and reach the end already has a complete, valuable lesson experience.

**Independent Test**: Start a live narration of a lesson, let it run to completion without interrupting, and confirm the narration is spoken in the teacher voice, covers every item from the lesson plan at least once, and ends within the bounded target length.

**Acceptance Scenarios**:

1. **Given** a lesson with a generated plan of teachable items and story beats, **When** the learner starts the live narration, **Then** the system begins speaking the lesson aloud in the teacher voice without playing a pre-rendered audio file.
2. **Given** a live narration runs from start to finish without interruption, **When** it ends, **Then** every teachable item in the plan has been taught at least once.
3. **Given** a live narration is in progress, **When** the learner listens, **Then** the narration is paced and coherent (story beats connect the items) and reaches a natural conclusion rather than stopping abruptly or running indefinitely.
4. **Given** the lesson plan defines a bounded target length, **When** the narration completes uninterrupted, **Then** its length stays within that target range.

---

### User Story 2 - Steer the story scenario mid-session and keep learning every item (Priority: P2)

Partway through the narration, the learner decides they would rather the lesson be set somewhere else — for example, "make this about space travel." They simply say so. The narration adapts to the new scenario, continues in that setting from then on, and still ensures every planned teaching item is covered at least once before the lesson ends.

**Why this priority**: Scenario steering is the headline adaptive capability that distinguishes this mode from any fixed recording — the lesson becomes the learner's story while still delivering the full curriculum. It builds on the live narration of Story 1 and is the primary reason to narrate live rather than pre-render. It is P2 because live narration that teaches all items (Story 1) already delivers standalone value.

**Independent Test**: Start a live narration, partway through ask to change the scenario (e.g., to space travel), and confirm the narration shifts to the new setting, stays in that setting for the remainder, and still teaches every planned item at least once by the end.

**Acceptance Scenarios**:

1. **Given** a live narration is in progress in one setting, **When** the learner asks to change the story scenario, **Then** the narration adapts so that subsequent content is set in the requested scenario.
2. **Given** the learner has changed the scenario, **When** the narration continues, **Then** the new scenario stays in effect for the rest of the session (it is not a one-off mention that reverts to the original setting).
3. **Given** the scenario was changed mid-session, **When** the lesson reaches its end, **Then** every planned teaching item has still been taught at least once, regardless of the setting change.
4. **Given** the learner changes the scenario more than once, **When** the narration continues after each change, **Then** the most recent requested scenario is the one in effect.
5. **Given** a scenario-change request is ambiguous or impossible to honor sensibly, **When** the system processes it, **Then** it either applies the closest reasonable interpretation or tells the learner it could not change the setting, rather than silently ignoring the request or breaking the narration.

---

### User Story 3 - Interrupt to ask a spoken question and continue the lesson (Priority: P2)

While the lesson is being narrated, the learner has a question about what they just heard. They start speaking; the narration stops to listen. The system answers the question aloud in the same teacher voice, taking into account what is currently being taught, and then the lesson continues toward covering the remaining planned items.

**Why this priority**: Barge-in Q&A turns the live narration into a two-way tutor and is the other half of "interruptible." It shares the same interruption mechanism as scenario steering (Story 2) and is essential to the interactive promise, but the narration plus scenario steering already deliver core value, so it is P2 alongside steering.

**Independent Test**: During a live narration, speak a question aloud; confirm the narration stops promptly, a spoken answer relevant to the current teaching context is produced in the teacher voice, and the lesson then continues toward teaching any not-yet-covered items.

**Acceptance Scenarios**:

1. **Given** the lesson is being narrated, **When** the learner starts speaking, **Then** the narration stops promptly and the system listens to the learner.
2. **Given** the learner has asked a question while a particular item was being taught, **When** the system answers, **Then** the spoken answer is relevant to that item and the surrounding context, in the same teacher voice.
3. **Given** the learner barges in over the teacher's speech (whether narration or an answer), **When** they begin speaking, **Then** the teacher's speech stops quickly so the learner can be heard.
4. **Given** a question-and-answer exchange has ended, **When** the learner stops speaking, **Then** the lesson continues so that all planned items are still taught at least once before it ends.
5. **Given** the learner says nothing intelligible after interrupting, **When** the system processes it, **Then** it asks the learner to repeat or clarify rather than fabricating an answer, and the session is not left stuck.

---

### User Story 4 - See live subtitle captions of both voices, corrected turn-by-turn (Priority: P3)

Throughout the session the learner sees on-screen subtitle-style captions: the teacher's spoken words and the learner's own recognized speech, each finalized turn by turn as that turn completes. When the learner barges in and cuts off the teacher mid-sentence, the teacher's caption for that turn is corrected to reflect only what was actually spoken aloud, not the full text the teacher had intended to say.

**Why this priority**: Captions make the session accessible and let the learner follow and verify what was said, and the barge-in correction keeps the on-screen record honest. It is P3 because the spoken, adaptive, interactive experience (Stories 1–3) is the core value; captions enhance and verify it.

**Independent Test**: Run a session with at least one learner interruption that cuts off the teacher mid-sentence, and confirm that (a) both teacher and learner speech appear as turn-by-turn captions, (b) each turn is finalized when it completes, and (c) the interrupted teacher turn's caption shows only what was actually spoken before the cut-off.

**Acceptance Scenarios**:

1. **Given** the teacher is speaking, **When** a turn of speech completes, **Then** that turn appears as a finalized caption attributed to the teacher.
2. **Given** the learner is speaking, **When** their turn completes, **Then** their recognized speech appears as a finalized caption attributed to the learner.
3. **Given** the learner barges in and cuts off the teacher mid-sentence, **When** that teacher turn is finalized, **Then** its caption reflects only what was actually spoken aloud, not the full intended text.
4. **Given** a multi-turn session, **When** the learner reads the captions, **Then** turns appear in the order they occurred and are clearly attributed to teacher vs. learner.

---

### User Story 5 - Review the full session as a durable transcript later (Priority: P3)

After a live session, the learner can come back in a later session and read the full text record of what happened: the narration and the Q&A exchanges, using the corrected text (what was actually spoken). This text transcript — not the audio — is the replayable record of the lesson; there is no saved recording to play back.

**Why this priority**: Persisting the session as durable text turns an ephemeral live experience into a reviewable record and is the hook that later features depend on. It is P3 because the live experience (Stories 1–3) must exist first; the transcript hardens and preserves it.

**Independent Test**: Complete a live session (including at least one interruption with a cut-off teacher turn), leave, return in a separate later session, open the lesson, and confirm a full text transcript of the narration and exchanges — using corrected text — is present and associated with that lesson.

**Acceptance Scenarios**:

1. **Given** a completed live session, **When** the learner returns in a later session and opens the lesson, **Then** a durable text transcript of the session is available and associated with that lesson.
2. **Given** the session included barge-ins that cut off teacher turns, **When** the transcript is reviewed, **Then** it uses the corrected text (what was actually spoken), consistent with the finalized captions.
3. **Given** the session included both narration and Q&A exchanges, **When** the transcript is reviewed, **Then** both are present in the order they occurred and attributed to teacher vs. learner.
4. **Given** no realtime audio is persisted, **When** the learner reviews the lesson later, **Then** the replayable record is the text transcript and the system does not offer a saved audio recording of the live session.

---

### User Story 6 - Clear fallback when the live session is unavailable (Priority: P3)

When the live-narration capability cannot start or fails mid-session, the learner is told clearly what happened and is offered a sensible fallback rather than facing a silent failure, a frozen screen, or a blank lesson.

**Why this priority**: This protects the experience from dead-ends when the realtime capability is degraded or unavailable. It is P3 because the happy-path live experience (Stories 1–3) is the value; this guardrail keeps that value robust.

**Independent Test**: Force a live-session-unavailable condition at start and a failure mid-session, and confirm each surfaces a clear message and a usable fallback instead of leaving the learner stuck.

**Acceptance Scenarios**:

1. **Given** the live-narration capability cannot start, **When** the learner tries to begin, **Then** the system clearly communicates that the live lesson is unavailable right now and offers a sensible fallback rather than failing silently.
2. **Given** a live session fails or the connection drops mid-narration, **When** the failure occurs, **Then** the learner is informed and left in a recoverable state (e.g., able to retry) rather than stuck on a frozen or blank screen.
3. **Given** a fallback is offered, **When** the learner takes it, **Then** they can still make progress with the lesson rather than being blocked entirely.

---

### Edge Cases

- **Session ended before completion**: If the learner ends or abandons the session before the narration finishes, the "every item taught at least once" guarantee applies only to sessions that run to their natural end; the partial transcript captured so far is still preserved.
- **Scenario change very late in the lesson**: A scenario change requested when only a few items remain must still be honored for the remaining narration while ensuring any not-yet-taught items are still covered before the end.
- **Scenario change that conflicts with an item's meaning**: A teaching item that is hard to fit naturally into the new scenario must still be taught at least once, even if the story framing around it is looser.
- **Accidental / background speech**: A cough, side conversation, or background noise that triggers listening should be treated as an empty/unintelligible interruption and return to the narration rather than producing a spurious answer or a spurious scenario change.
- **Ambiguous interruption (question vs. scenario change)**: When it is unclear whether the learner asked a question or requested a scenario change, the system resolves to the most reasonable interpretation and continues without breaking item coverage.
- **Rapid repeated interruptions**: Speaking again immediately after the narration resumes starts a new exchange cleanly without the previous answer bleeding into the new content.
- **Repeated unintelligible interruptions**: The learner can always cleanly return to the narration rather than being trapped in an endless clarification loop.
- **Connectivity loss mid-session**: A dropped connection informs the learner and leaves the session recoverable; the transcript captured up to that point is preserved.
- **Caption vs. spoken mismatch on barge-in**: The teacher caption must never show text that was cut off and never actually spoken aloud.

## Requirements *(mandatory)*

### Functional Requirements

**Live narration from a plan**

- **FR-001**: The system MUST narrate a lesson live, aloud, in the teacher voice, instead of playing a pre-rendered audio file.
- **FR-002**: The system MUST drive the narration from a generated lesson plan consisting of an ordered set of teachable items and story beats with a bounded target length.
- **FR-003**: The system MUST conduct the narration and all interruptions within a single realtime session (no regeneration or page reload required to handle an interruption).
- **FR-004**: When a session runs to its natural end, the system MUST have taught every planned teachable item at least once.
- **FR-005**: The system MUST bring the narration to a natural conclusion within the plan's bounded target length when uninterrupted.

**Scenario steering**

- **FR-006**: The system MUST allow the learner to change the story scenario at any moment during the session by speaking the request.
- **FR-007**: The system MUST adapt subsequent narration to the requested scenario.
- **FR-008**: The system MUST keep a requested scenario change in effect for the remainder of the session (until the learner changes it again), rather than reverting to the original setting.
- **FR-009**: When the learner changes the scenario more than once, the system MUST treat the most recent request as the scenario in effect.
- **FR-010**: The system MUST still teach every planned item at least once even after one or more scenario changes.
- **FR-011**: When a scenario-change request cannot be honored sensibly, the system MUST apply the closest reasonable interpretation or tell the learner it could not change the setting, rather than silently ignoring it or breaking the narration.

**Interruption & Q&A**

- **FR-012**: The system MUST allow the learner to interrupt the narration at any moment by speaking (barge-in), and MUST stop the teacher's speech promptly when the learner begins speaking.
- **FR-013**: The system MUST interpret a spoken interruption as either a question or a scenario-change request and respond appropriately to each.
- **FR-014**: For a spoken question, the system MUST produce a spoken answer in the teacher voice that is relevant to the item being taught at the moment of interruption and the surrounding context.
- **FR-015**: After an interruption is resolved, the system MUST continue the session so that all planned items are still taught at least once before it ends.
- **FR-016**: When an interruption is empty or unintelligible, the system MUST ask the learner to repeat or clarify rather than fabricating an answer or a scenario change, and MUST NOT leave the session stuck.
- **FR-017**: When interruptions remain empty or unintelligible, the system MUST let the learner cleanly return to the narration rather than looping indefinitely on clarification.

**Live captions**

- **FR-018**: The system MUST display subtitle-level live captions of the teacher's speech and the learner's recognized speech during the session.
- **FR-019**: The system MUST finalize captions turn by turn, attributing each finalized turn to the teacher or the learner.
- **FR-020**: When the learner barges in and cuts off the teacher mid-turn, the system MUST correct that teacher turn's caption to reflect only what was actually spoken aloud, not the full intended text.

**Durable transcript**

- **FR-021**: The system MUST capture the full session — narration and Q&A exchanges — as a durable text transcript associated with the lesson.
- **FR-022**: The transcript MUST use corrected text (what was actually spoken), consistent with the finalized captions, including for barge-in-truncated teacher turns.
- **FR-023**: The transcript MUST preserve the order of turns and their attribution (teacher vs. learner).
- **FR-024**: The learner MUST be able to review the transcript in later sessions; the transcript — not the realtime audio — is the replayable record.
- **FR-025**: The system MUST NOT persist or offer replay of the realtime session audio.

**Robustness & access**

- **FR-026**: When the live-narration capability cannot start or fails mid-session, the system MUST clearly communicate this and offer a sensible fallback, and MUST NOT leave the learner on a frozen or blank screen.
- **FR-027**: When a session ends before completion (learner abandons or connection drops), the system MUST preserve the transcript captured up to that point.
- **FR-028**: The system MUST restrict the live session and its transcript to the authenticated learner who owns the lesson.
- **FR-029**: The live session experience (narration, interruption, scenario change, captions) MUST work on responsive web across desktop and mobile browsers.

### Key Entities *(include if feature involves data)*

- **Lesson** *(existing)*: A generated, owned lesson. The live mode attaches to a lesson and reuses its teacher voice; the durable session transcript is associated with the lesson.
- **Lesson Plan**: The ordered set of teachable items and story beats, with a bounded target length, that drives the live narration. Defines what "every planned item" means for coverage.
- **Teachable Item**: A single unit the lesson must teach (e.g., a word, phrase, or idiom). Coverage requires each to be taught at least once per completed session.
- **Live Session**: One realtime narration-plus-interaction episode for a lesson. Key attributes: the lesson it belongs to, the scenario currently in effect, the ordered turns, and which items have been covered.
- **Scenario**: The story setting currently in effect for the narration (e.g., "space travel"). Set initially by the plan and changeable by the learner mid-session; the most recent change persists for the rest of the session.
- **Session Turn**: A single utterance within the session — teacher narration, teacher answer, or learner speech — captured as corrected text, attributed and ordered.
- **Session Transcript**: The durable text record of a session (its ordered turns, corrected text), associated with the lesson and reviewable in later sessions. The replayable record in place of audio.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of live sessions that run to their natural end, every planned teachable item has been taught at least once.
- **SC-002**: In at least 95% of uninterrupted sessions, the narration reaches a natural conclusion within the plan's bounded target length.
- **SC-003**: When the learner requests a scenario change, subsequent narration reflects the new scenario in at least 95% of requests, and the change remains in effect for the rest of the session.
- **SC-004**: In at least 95% of sessions where the scenario was changed, every planned item is still taught at least once by the end.
- **SC-005**: When the learner starts speaking during the teacher's speech, the teacher's speech stops within roughly half a second of detected speech in at least 95% of barge-ins.
- **SC-006**: For a spoken question, a relevant spoken answer in the teacher voice begins within a few seconds of the learner finishing in at least 90% of exchanges (no indefinite or silent waits).
- **SC-007**: 100% of completed teacher and learner turns appear as finalized, correctly attributed captions during the session.
- **SC-008**: In 100% of barge-ins that cut off the teacher mid-turn, the finalized teacher caption (and the transcript) show only what was actually spoken aloud, never cut-off text.
- **SC-009**: 100% of completed or abandoned sessions yield a durable text transcript associated with the lesson and reviewable in a later session, with no realtime audio retained.
- **SC-010**: 100% of empty/unintelligible interruptions result in a clarification prompt (never a fabricated answer or scenario change), and the learner can always return to the narration without being trapped.
- **SC-011**: 100% of live-session-unavailable or mid-session-failure conditions surface a clear message and a usable fallback, with the learner never left on a frozen or blank screen.
- **SC-012**: In usability checks, at least 90% of learners can start a live lesson, change the scenario, ask a question, and reach the end on their first attempt without external help.
- **SC-013**: The full live experience is usable on both desktop and mobile browser widths.

## Assumptions

- **Lesson generation and live Q&A already exist and are preconditions**: This feature assumes generated, owned lessons (with a teacher voice and teachable items) and the live interruptible-session capability from prior features already exist. It consumes and extends those rather than redefining them.
- **Live mode is an alternative to pre-rendered playback, selected per session**: The live-narrated mode is offered as a way to experience a lesson; it does not necessarily remove or replace any existing pre-rendered playback. "Instead of playing a pre-rendered file" describes what happens within the live mode.
- **The lesson plan is derived from existing generation output**: The ordered teachable items, story beats, and bounded target length come from (or are derived from) the existing lesson-generation artifacts rather than a new authoring flow.
- **"Teacher voice" is the existing scripted teacher persona voice**: Live narration and answers reuse the established teacher voice identity rather than introducing a new persona.
- **Interruption is hands-free voice barge-in**: The microphone is live during the session; the learner interrupts — to ask a question or change the scenario — simply by speaking, with no button press required. The platform requests and holds microphone permission for the session and communicates clearly when the mic is active.
- **"Every planned item taught at least once" is measured over sessions that complete**: The coverage guarantee applies to sessions that run to their natural end; abandoned sessions preserve their partial transcript but are not held to full coverage.
- **Corrected text is the single source of truth for both captions and transcript**: What was actually spoken aloud (including barge-in truncation) is what both the live captions and the durable transcript reflect.
- **Bounded target length is a tuning parameter with a reasonable default**: The specific target length and acceptable range are configuration/tuning decisions, not fixed by this spec.
- **Out of scope (explicitly deferred or rejected)**: persisting or replaying the realtime audio itself; a hybrid pre-rendered-spine-plus-live-branches approach; karaoke/word-synced caption highlighting; pronunciation scoring; persistent note capture; and cross-session adaptive progress. This feature neither implements nor is blocked by any of those.
