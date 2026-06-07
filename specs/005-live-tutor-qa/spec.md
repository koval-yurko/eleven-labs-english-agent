# Feature Specification: Live, Interruptible Q&A During a Podcast Lesson

**Feature Branch**: `005-live-tutor-qa`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "Add live, interruptible Q&A to an existing generated podcast lesson (assumes the lesson-generation feature exists). While a lesson is playing, the learner can play/pause/resume and interrupt at any moment to ask a spoken follow-up question. The system pauses playback and returns a live spoken answer relevant to the current lesson context, using the SAME teacher voice as the scripted podcast. The learner can barge-in (interrupt the tutor's answer to speak again). When the exchange ends, playback resumes from the exact point of interruption. Each Q&A exchange's text transcript is captured and associated with the lesson and the relevant item. Empty/unintelligible interruptions prompt for clarification; off-topic questions are answered briefly or redirected; live-tutor unavailability is communicated with a fallback. OUT OF SCOPE: persistent note capture and cross-session adaptive progress (separate features); phoneme-level pronunciation scoring."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Interrupt the lesson to ask a spoken question and resume where you left off (Priority: P1)

While listening to a generated podcast lesson, a learner has a question about what they just heard. They simply start speaking; the lesson playback pauses automatically. The system understands the spoken question, considers what is currently being taught, and replies with a live spoken answer in the same teacher voice as the podcast. When the answer finishes, the lesson resumes playing from the exact moment it was paused.

**Why this priority**: This is the core value of the feature — turning a one-way podcast into an interactive tutor. Without it there is no live Q&A. A learner who can ask one question mid-lesson, hear a relevant spoken answer in the teacher's voice, and continue the lesson already has the complete loop that makes the feature worthwhile.

**Independent Test**: Play a lesson, speak a question aloud part-way through an item being explained, and confirm the lesson pauses, a spoken answer relevant to that item is produced in the teacher voice, and the lesson then resumes from the exact point it paused.

**Acceptance Scenarios**:

1. **Given** a lesson is playing, **When** the learner starts speaking a question, **Then** the lesson playback pauses promptly and the system begins listening to the question.
2. **Given** the learner has finished asking a question while item X was being taught, **When** the system answers, **Then** the spoken answer is relevant to item X and the surrounding lesson context, not a generic or unrelated response.
3. **Given** a spoken answer is produced, **When** the learner hears it, **Then** it is voiced in the same teacher voice used in the scripted podcast (not a different or obviously distinct voice).
4. **Given** the tutor's answer has finished and the learner does not speak again, **When** the exchange ends, **Then** the lesson resumes playing from the exact point at which it was paused (no lost or repeated content beyond a brief natural lead-in).
5. **Given** the learner also wants manual control, **When** they use the play/pause/resume controls, **Then** playback responds accordingly and pausing manually does not itself trigger a question.

---

### User Story 2 - Barge in to interrupt the tutor's answer and ask again (Priority: P2)

A learner asks a question and, partway through the tutor's spoken answer, realizes they want to clarify or ask something else. They simply start speaking over the answer; the tutor stops talking and listens to the new question. This can repeat for several back-and-forth turns, forming a short live conversation, before the lesson eventually resumes.

**Why this priority**: Barge-in is what makes the exchange feel like a real conversation rather than a rigid one-question transaction. It builds directly on Story 1 and meaningfully improves naturalness, but the feature still delivers value with single-question exchanges if barge-in were absent — hence P2.

**Independent Test**: Ask a question, and while the tutor is mid-answer, start speaking again; confirm the tutor's answer stops quickly, the new question is heard, a new relevant answer is produced, and the lesson still resumes from the original interruption point once the exchange ends.

**Acceptance Scenarios**:

1. **Given** the tutor is speaking an answer, **When** the learner starts speaking, **Then** the tutor's answer stops promptly and the system listens to the new question.
2. **Given** a multi-turn exchange (question → answer → barge-in → answer), **When** the learner finally stops asking, **Then** the lesson resumes from the same original interruption point, not from where the conversation drifted.
3. **Given** the learner barges in, **When** the new answer is produced, **Then** it takes into account the immediately preceding turns of the exchange (it is a continuation, not a cold restart).

---

### User Story 3 - Capture each Q&A exchange as a transcript tied to the lesson and item (Priority: P3)

Every spoken exchange between the learner and the tutor is captured as text — both the learner's question(s) and the tutor's answer(s) — and associated with the lesson and the specific lesson item the learner was on when they interrupted. The learner (and the system) can later see what was asked and answered against which part of the lesson.

**Why this priority**: Capturing the exchange turns ephemeral spoken Q&A into a reviewable record and is the hook future features (notes, adaptive progress) depend on. It is P3 because the live spoken interaction (Stories 1–2) delivers the experience first; the transcript hardens and preserves it.

**Independent Test**: Conduct a Q&A exchange while a specific item is being taught, then inspect the lesson's record and confirm a text transcript of that exchange exists and is linked to both the lesson and that item.

**Acceptance Scenarios**:

1. **Given** a completed Q&A exchange, **When** the exchange ends, **Then** a text transcript of the learner's question(s) and the tutor's answer(s) is captured for that lesson.
2. **Given** the learner interrupted while item X was being taught, **When** the transcript is captured, **Then** it is associated with item X (the relevant item) as well as the lesson.
3. **Given** multiple exchanges occur during one lesson, **When** the lesson record is reviewed, **Then** each exchange is captured separately and tied to the item that was active at its moment of interruption.

---

### User Story 4 - Graceful handling of unclear, off-topic, or unavailable Q&A (Priority: P3)

When an interruption is empty or unintelligible, the tutor asks the learner to repeat or clarify rather than guessing. When a question is off-topic relative to the lesson, the tutor answers briefly or gently redirects back to the lesson. When the live-tutor capability is unavailable, the learner is told clearly and offered a sensible fallback instead of a silent failure or a frozen lesson.

**Why this priority**: This protects the core interaction from frustration and dead-ends. It is P3 because the happy-path conversation (Stories 1–2) is the value; this guardrail story keeps that value robust under messy real-world input and service hiccups.

**Independent Test**: Trigger (a) a silent/garbled interruption, (b) an unrelated off-topic question, and (c) a live-tutor-unavailable condition, and confirm each yields a clear, appropriate spoken or on-screen response and never leaves the lesson stuck.

**Acceptance Scenarios**:

1. **Given** the learner interrupts but says nothing intelligible (silence, noise, or unrecognizable speech), **When** the system processes it, **Then** the tutor asks the learner to repeat or clarify rather than fabricating an answer, and the lesson remains safely paused (not lost).
2. **Given** the learner asks something off-topic relative to the lesson, **When** the system answers, **Then** it gives a brief answer or politely redirects back to the lesson context rather than going on an unrelated tangent.
3. **Given** the live-tutor capability is unavailable or fails, **When** the learner interrupts, **Then** the system clearly communicates that live Q&A is not available right now and offers a fallback (e.g., continue the lesson and try again later) instead of freezing or silently dropping the question.
4. **Given** a repeated empty/unintelligible interruption, **When** clarification keeps failing, **Then** the system lets the learner cleanly return to the lesson rather than trapping them in an endless clarification loop.

---

### Edge Cases

- **Accidental / background speech**: A cough, a side conversation, or background noise may start the listening flow. The system should treat non-questions as empty/unintelligible (Story 4) and return to the lesson rather than producing a spurious answer.
- **Interruption at the very start or very end of the lesson**: Interrupting before the first item or during the closing seconds still produces a relevant answer (tied to the nearest/active item) and resumes correctly, including resuming "to the end" if the lesson had effectively finished.
- **Interruption exactly between two items**: When paused at a boundary, the exchange is associated with the most recently active item (the one just taught), and resumes into the next item.
- **Very long or rambling question**: An overly long spoken question is still handled (answered to the best of the lesson context) without breaking the resume point.
- **Learner stays silent after barging in**: If the learner interrupts the tutor's answer but then says nothing intelligible, the clarification flow (Story 4) applies, and the lesson can still resume from the original point.
- **Manual pause vs. spoken interruption**: A learner using the pause control to take a break must not have that treated as a question; only spoken input opens a Q&A exchange.
- **Connectivity loss mid-exchange**: If the connection drops during an exchange, the learner is informed and the lesson is left in a recoverable state (resume from the interruption point) rather than stuck.
- **Multiple rapid interruptions**: Speaking again immediately after a resume starts a new exchange cleanly, without the previous answer bleeding into the new one.

## Requirements *(mandatory)*

### Functional Requirements

**Playback control & interruption**

- **FR-001**: The system MUST let the learner play, pause, and resume a generated lesson during playback.
- **FR-002**: The system MUST allow the learner to interrupt a playing lesson at any moment by speaking, and MUST automatically pause lesson playback when a spoken interruption begins.
- **FR-003**: The system MUST capture the exact playback position at the moment of interruption so the lesson can later resume from that point.
- **FR-004**: The system MUST distinguish a deliberate manual pause from a spoken interruption, and MUST NOT open a Q&A exchange for a manual pause.

**Live answer & voice**

- **FR-005**: The system MUST interpret the learner's spoken question and produce a spoken answer that is relevant to the lesson and to the item being taught at the moment of interruption.
- **FR-006**: The spoken answer MUST be voiced in the same teacher voice used in the scripted podcast lesson.
- **FR-007**: The system MUST deliver the answer as live audio that the learner hears in the browser during the same session, without requiring the lesson to be regenerated.

**Barge-in & multi-turn exchange**

- **FR-008**: The system MUST allow the learner to barge in by speaking over the tutor's answer, and MUST promptly stop the in-progress answer when the learner begins speaking.
- **FR-009**: The system MUST support multiple back-and-forth turns within a single exchange, where each new answer takes the immediately preceding turns of that exchange into account.
- **FR-010**: When an exchange ends (the learner stops asking), the system MUST resume lesson playback from the exact interruption point captured in FR-003, regardless of how many turns the exchange contained.

**Transcript capture & association**

- **FR-011**: The system MUST capture a text transcript of each Q&A exchange, including the learner's question(s) and the tutor's answer(s).
- **FR-012**: The system MUST associate each captured exchange with the lesson it occurred in and with the relevant lesson item active at the moment of interruption.
- **FR-013**: When a lesson has multiple exchanges, the system MUST capture each exchange separately with its own item association and ordering.

**Robustness & messaging**

- **FR-014**: When an interruption is empty or unintelligible, the system MUST ask the learner to repeat or clarify rather than fabricating an answer, while keeping the lesson safely paused at the interruption point.
- **FR-015**: When repeated interruptions remain empty or unintelligible, the system MUST let the learner cleanly return to the lesson rather than looping indefinitely on clarification.
- **FR-016**: When a question is off-topic relative to the lesson, the system MUST answer briefly or redirect the learner back to the lesson context rather than pursuing an unrelated tangent.
- **FR-017**: When the live-tutor capability is unavailable or fails, the system MUST clearly communicate this to the learner and offer a fallback (e.g., resume/continue the lesson and retry later), and MUST NOT leave the lesson frozen or silently drop the question.

**Access & platform**

- **FR-018**: The system MUST restrict live Q&A to the authenticated learner who owns the lesson, consistent with lesson ownership and privacy.
- **FR-019**: The live Q&A experience (interruption, listening, spoken answer, barge-in, resume) MUST work on responsive web across desktop and mobile browsers.

### Key Entities *(include if feature involves data)*

- **Lesson** *(existing)*: A generated, owned, replayable podcast lesson. Live Q&A attaches to a lesson during playback; the lesson's teacher voice is reused for live answers.
- **Lesson Item** *(existing)*: A single teachable unit within a lesson (word, sentence, or idiom). The item active at the moment of interruption is the "relevant item" an exchange is associated with.
- **Q&A Exchange**: One interruption-to-resume episode within a lesson. Key attributes: the lesson it belongs to, the relevant item, the interruption playback position, an ordered set of turns (learner questions and tutor answers), and its place in the sequence of exchanges for that lesson.
- **Exchange Turn**: A single utterance within an exchange — either a learner question or a tutor answer — captured as text, in order.
- **Interruption Point**: The exact playback position in the lesson where the learner interrupted, used to resume playback precisely after the exchange.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When the learner speaks during playback, the lesson pauses essentially immediately (within roughly half a second of detected speech) in at least 95% of interruptions.
- **SC-002**: The spoken answer begins playing within a few seconds of the learner finishing their question for at least 90% of exchanges (no indefinite or silent waits).
- **SC-003**: In blind listening checks, listeners identify the live answer's voice as the same teacher voice as the scripted podcast in at least 95% of answers.
- **SC-004**: After an exchange ends, the lesson resumes from the captured interruption point with no perceptible loss or repetition of content in at least 95% of resumes.
- **SC-005**: When the learner barges in over an answer, the tutor's answer stops within roughly half a second of detected speech in at least 95% of barge-ins.
- **SC-006**: 100% of completed exchanges are captured as a text transcript correctly associated with the lesson and the item active at the interruption point.
- **SC-007**: 100% of empty/unintelligible interruptions result in a clarification prompt (never a fabricated answer), and the learner can always return to the lesson without being trapped in a clarification loop.
- **SC-008**: 100% of live-tutor-unavailable conditions surface a clear message and a usable fallback, with the lesson never left frozen.
- **SC-009**: In usability checks, at least 90% of learners can interrupt, get an answer, and resume the lesson on their first attempt without external help.
- **SC-010**: The full interrupt → answer → barge-in → resume flow is usable on both desktop and mobile browser widths.

## Assumptions

- **Interruption mechanism is hands-free voice barge-in**: The microphone is live during playback; the learner interrupts the lesson — and barges in over the tutor's answer — simply by speaking, with no button press required. (Selected during specification.) The platform is assumed to request and hold microphone permission for the session, and to communicate clearly when the mic is active.
- **The lesson-generation feature exists and is the precondition**: This feature assumes lessons (with their teacher voice, items, and audio) already exist, are authenticated/owned, and are replayable. It consumes those; it does not redefine generation.
- **"Same teacher voice" means the scripted podcast's teacher persona voice**: Live answers reuse the existing teacher voice identity rather than introducing a new persona. The curious-learner persona is not used for live answers.
- **"Relevant item" is determined by playback position**: The lesson item active at the captured interruption point is treated as the relevant item; boundary cases resolve to the most recently active item.
- **Transcripts are captured and persisted with the lesson**: Q&A transcripts are stored against the lesson and item so they are reviewable. This is distinct from the out-of-scope "persistent note capture" (learner-authored notes) and "cross-session adaptive progress."
- **Exchanges are live in-session, but their text record persists**: The spoken interaction happens live in the session; the resulting transcript record persists with the lesson. Whether the live answer audio is also retained for later replay is a planning/tuning decision, not required by this spec.
- **Answer scope is grounded in the lesson**: Answers are expected to stay within the lesson's teaching context; off-topic questions get a brief answer or a redirect (FR-016) rather than open-ended general assistance.
- **Out of scope (explicitly deferred)**: persistent note capture and cross-session adaptive progress (separate features), and phoneme-level pronunciation scoring. This feature does not implement and is not blocked by any of those.
