# Feature Specification: Generate a Story-Driven Podcast Lesson from a List

**Feature Branch**: `002-lesson-generation`  
**Created**: 2026-06-06  
**Status**: Draft  
**Input**: User description: "Generate a story-driven, two-voice podcast lesson from a learner-provided list of English words, sentences, and idioms. The system produces a ~5–10 minute audio lesson presented as a conversation between a curious learner persona and a warm teacher persona, explaining each submitted item through vivid mini-stories rather than dictionary definitions. Every teachable item is covered at least once; lesson length is bounded for large inputs. Lessons and their audio are persisted to an authenticated learner account, private to that learner, and replayable in later sessions on responsive web (desktop + mobile browser). Empty, oversized, or unteachable input is handled gracefully with clear messaging, and generation/playback status is communicated. OUT OF SCOPE: live interruption/Q&A, note capture, and cross-session adaptive progress — those are separate features."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Turn a word list into a story-driven audio lesson (Priority: P1)

A learner pastes a list of English words, sentences, and idioms they want to learn. The system generates a single coherent ~5–10 minute audio lesson presented as a conversation between a curious learner persona and a warm teacher persona. Each submitted item is explained through a vivid mini-story rather than a dictionary definition, and every teachable item is covered at least once. The learner listens to the finished lesson in the browser.

**Why this priority**: This is the core value proposition and the foundation of the entire product. Without it, there is nothing to play back, persist, extend with live Q&A, annotate, or adapt. A learner who can submit a list and receive one good lesson already has a usable product.

**Independent Test**: Submit 5–10 idioms and listen to the result. Verify the output is one coherent 5–10 minute lesson, with two clearly distinct voices (learner + teacher), where every submitted item is taught through a story rather than a definition.

**Acceptance Scenarios**:

1. **Given** an authenticated learner with a list of 8 valid idioms, **When** they submit the list, **Then** the system generates a single audio lesson of approximately 5–10 minutes in which all 8 idioms are each explained through a mini-story.
2. **Given** a generated lesson, **When** the learner plays it, **Then** they hear two distinct voices — a curious learner persona asking and reacting, and a warm teacher persona explaining — not a single narrator reading a list.
3. **Given** a mixed list of single words, full sentences, and idioms, **When** the lesson is generated, **Then** each item type is taught conversationally with a concrete example or scenario, and no item is reduced to a bare definition.
4. **Given** generation is in progress, **When** the learner waits, **Then** the system communicates that the lesson is being created and indicates when it is ready to play.

---

### User Story 2 - Save, find, and replay lessons in a private account (Priority: P2)

A learner signs in to their own account. Every lesson they generate — along with its audio — is saved privately to that account. In a later session, after signing back in, the learner can find their previously generated lessons and replay them without regenerating.

**Why this priority**: Persistence and private ownership are what make this more than a one-shot toy. They are an explicit cross-cutting requirement for the whole product (every later feature assumes an authenticated, persisted, owned lesson). It is P2 only because a learner can experience the core value (Story 1) within a single session before persistence matters.

**Independent Test**: Generate a lesson, sign out, sign back in (or return in a new session), and confirm the same lesson and its audio are still present and playable, and that another account cannot see it.

**Acceptance Scenarios**:

1. **Given** an unauthenticated visitor, **When** they attempt to generate or open a lesson, **Then** they are required to authenticate first.
2. **Given** an authenticated learner who generated a lesson previously, **When** they return in a later session and sign in, **Then** they see their prior lessons listed and can replay any of them, including its audio, without regenerating.
3. **Given** Learner A's lesson, **When** Learner B is signed in, **Then** Learner B cannot view, list, or play Learner A's lesson.
4. **Given** a learner with multiple saved lessons, **When** they open their lesson list, **Then** each lesson is identifiable (e.g., by its source items and creation time) so they can choose which to replay.

---

### User Story 3 - Graceful handling of empty, oversized, or unteachable input (Priority: P3)

A learner submits input that cannot be turned into a good lesson — nothing at all, far too many items, or content that is not teachable English (gibberish, unsupported language, or unrecognizable text). Instead of failing silently or producing a broken lesson, the system explains clearly what went wrong and what the learner can do next.

**Why this priority**: This protects the core experience and is an explicit cross-cutting input-guardrail requirement, but it is P3 because the happy path (Stories 1–2) delivers the product's value first; guardrails harden it.

**Independent Test**: Submit (a) nothing, (b) a list far larger than the supported maximum, and (c) gibberish/non-English text, and confirm each produces a clear, actionable message rather than a crash, an empty lesson, or a misleading "success."

**Acceptance Scenarios**:

1. **Given** an empty submission (no items), **When** the learner submits, **Then** the system declines to generate and clearly states that at least one teachable item is required.
2. **Given** a list exceeding the supported maximum number of teachable items, **When** the learner submits, **Then** the system clearly states the limit and lets the learner reduce the list (it does not silently drop items or produce an over-length lesson).
3. **Given** input that contains no teachable English items (e.g., gibberish or an unsupported language), **When** the learner submits, **Then** the system explains that it could not find teachable items and prompts the learner to revise the input.
4. **Given** a list mixing valid items with a few unteachable entries, **When** the learner submits, **Then** the system generates a lesson from the teachable items and clearly reports which entries were skipped and why.
5. **Given** generation fails for a technical reason after a valid submission, **When** the failure occurs, **Then** the learner is informed that generation did not complete and is offered a way to retry, rather than being left with an indefinite or silent wait.

---

### Edge Cases

- **Duplicate items**: When the same word/idiom appears more than once in the list, it is treated as a single teachable item (covered once), not repeated.
- **Single-item list**: A single valid item still produces a coherent (short) two-voice lesson, not an error.
- **Mixed teachable/unteachable**: Partially valid input proceeds with the teachable items and reports skipped ones (see Story 3, scenario 4).
- **Very long single item**: An overly long pasted "sentence" (e.g., a paragraph) is either treated as one item or flagged as not a discrete teachable item, with clear messaging — never silently truncated into nonsense.
- **Audio playback interrupted**: If the learner navigates away or loses connection mid-playback, returning to the lesson still allows replay from the start (resume-at-exact-point and barge-in are out of scope here — that is the live-tutor feature).
- **Generation in progress when learner leaves**: If the learner closes the session while a lesson is still generating, the completed lesson is still available when they return (generation is not lost by leaving).
- **Near-limit input**: A list at exactly the supported maximum generates a lesson that still respects the upper length bound.
- **Same list submitted twice**: Re-submitting the same list creates a new, separate lesson (the system does not silently deduplicate across lessons); both remain in the learner's library.

## Requirements *(mandatory)*

### Functional Requirements

**Input & teachability**

- **FR-001**: The system MUST accept a learner-provided list of English items consisting of single words, full sentences, and idioms.
- **FR-002**: The system MUST identify which submitted entries are teachable English items and which are not.
- **FR-003**: The system MUST treat duplicate entries as a single teachable item.
- **FR-004**: The system MUST reject an empty submission with a clear message stating at least one teachable item is required, and MUST NOT generate a lesson.
- **FR-005**: The system MUST enforce a maximum number of teachable items per lesson and, when input exceeds it, clearly communicate the limit and allow the learner to reduce the list rather than silently dropping items.
- **FR-006**: When a submission mixes teachable and unteachable entries, the system MUST generate a lesson from the teachable items and report which entries were skipped and why.
- **FR-007**: When a submission contains no teachable items, the system MUST decline to generate and prompt the learner to revise the input.

**Lesson generation & content quality**

- **FR-008**: The system MUST generate a single lesson as a conversation between two distinct personas: a curious learner persona and a warm teacher persona.
- **FR-009**: The system MUST cover every teachable item in the lesson at least once.
- **FR-010**: The system MUST explain each item through a vivid mini-story or concrete scenario, not a dictionary-style definition.
- **FR-011**: The generated lesson MUST be a single coherent piece (items connect into one flowing conversation), not a disjoint sequence of isolated definitions.
- **FR-012**: The system MUST bound lesson length to approximately 5–10 minutes of audio, including for inputs at the maximum supported item count.

**Audio rendering & playback**

- **FR-013**: The system MUST render the lesson to audio in which the two personas are voiced as two clearly distinct, natural-sounding voices.
- **FR-014**: The system MUST allow the learner to play the rendered audio in the browser.
- **FR-015**: The system MUST communicate generation status (in progress, ready, failed) and playback availability to the learner.
- **FR-016**: When generation fails after a valid submission, the system MUST inform the learner and offer a way to retry, avoiding an indefinite or silent wait.

**Accounts, persistence & privacy** *(cross-cutting, owned by this feature)*

- **FR-017**: The system MUST require learners to be authenticated to generate, save, list, or play lessons.
- **FR-018**: The system MUST persist each generated lesson and its audio so it survives the session and can be replayed later without regeneration.
- **FR-019**: The system MUST associate each lesson with the learner who created it and MUST restrict access so only that learner can view, list, or play it.
- **FR-020**: The system MUST let a learner browse their own saved lessons and identify each one (e.g., by its source items and creation time) to choose which to replay.
- **FR-021**: The system MUST treat each submission as producing a distinct saved lesson (re-submitting the same list creates a new lesson rather than overwriting or deduplicating across lessons).

**Platform**

- **FR-022**: The learner-facing experience (submission, status, lesson library, and playback) MUST work on responsive web across desktop and mobile browsers.

### Key Entities *(include if feature involves data)*

- **Learner**: An authenticated account that owns lessons. Key attributes: identity, ownership relationship to its lessons. No other learner may access a learner's lessons.
- **Lesson**: One generated lesson belonging to a learner. Key attributes: the source input items, the structured two-voice script, the rendered audio, generation status (in progress / ready / failed), and creation time. Privately owned by exactly one learner.
- **Source Item**: A single teachable unit submitted by the learner (word, sentence, or idiom), including whether it was accepted as teachable or skipped (and why). Every accepted item is covered in its lesson.
- **Lesson Audio**: The rendered audio artifact for a lesson, persisted and replayable, voiced with two distinct personas.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A learner can go from submitting a valid list to playing a finished lesson without any manual steps beyond submitting and pressing play.
- **SC-002**: For a list of up to the supported maximum teachable items, 100% of accepted teachable items are covered at least once in the resulting lesson.
- **SC-003**: At least 95% of generated lessons fall within the 5–10 minute target length (and none materially exceed the upper bound).
- **SC-004**: In blind listening checks, listeners can distinguish the two personas as two different voices in at least 95% of lessons, and rate the teaching as "told through stories/examples" rather than "read as definitions" for at least 90% of items.
- **SC-005**: 100% of attempts by one learner to access another learner's lesson are denied.
- **SC-006**: After signing out and back in (or returning in a later session), a learner can locate and replay 100% of their previously generated lessons, including audio, without regeneration.
- **SC-007**: 100% of empty, oversized, and no-teachable-item submissions produce a clear, actionable message instead of a crash, an empty lesson, or a false "success."
- **SC-008**: At every stage after submission, the learner can tell whether the lesson is generating, ready, or failed (no indefinite or silent waits).
- **SC-009**: The submission, status, library, and playback flows are fully usable on both desktop and mobile browser widths.

## Assumptions

- **Authentication is a precondition, not a feature here**: This feature assumes an authentication capability exists (sign-in/sign-out) and consumes it to enforce ownership and privacy. It does not specify the auth method or account-management UX beyond requiring authenticated access.
- **Maximum teachable items**: A concrete upper bound on teachable items per lesson exists so that length can be bounded; a reasonable default of roughly 15–20 items is assumed (the exact number is a tuning decision for planning). Inputs beyond the bound are treated as "oversized."
- **"~5–10 minutes" is the target, not a hard contractual SLA**: Very small inputs (e.g., a single item) may yield a shorter lesson; the upper bound (~10 minutes) is the firmer constraint.
- **English-only teaching content**: Items are expected to be English words/sentences/idioms; non-English or unrecognizable input is treated as unteachable.
- **Generation is asynchronous**: Producing the script and rendering audio may take noticeable time, so status communication (FR-015) and resilience to the learner leaving (edge cases) are assumed necessary.
- **Out of scope (explicitly deferred to separate features)**: live interruption / spoken Q&A during playback, persistent note capture, and cross-session adaptive progress. This feature does not implement, and is not blocked by, any of those.
- **Source-item identification suffices for the library**: Showing source items + creation time is assumed adequate to let learners tell their lessons apart; richer titling/tagging is not required for this feature.
