# Feature Specification: Live-Only Lesson Experience

**Feature Branch**: `007-live-only`  
**Created**: 2026-06-07  
**Status**: Draft  
**Input**: User description: "Retire the pre-rendered audio podcast and the playback-anchored live Q&A so the product is **live-only**, assuming the adaptive live-narrated story already exists. Lesson generation produces only the text lesson plan/script (ordered teachable items, story beats, bounded target length) with its coverage guarantee and the two distinct personas — it no longer synthesizes, stitches, or stores any audio file. The lesson experience is exclusively the live-narrated, steerable story; the pre-rendered audio player and the older playback-position Q&A mode are removed from the product, along with their audio storage and Q&A transcript tables — the live-session transcript is the durable record. Generation quality is still evaluated on the script (every teachable item covered, two distinct personas, story-driven), without any audio-render or audio-length checks. The product's voice-consistency and reproducibility principles are reframed away from the now-removed 'scripted podcast.' OUT OF SCOPE: changing live-story behavior; removing script/coverage generation (the planner still needs them); preserving previously rendered audio; a flag to keep the old mode; auth/persistence redesign."

## Overview

The product currently carries **two parallel lesson realities**: a pre-rendered audio podcast (with its older playback-position live Q&A bolted onto pause/resume), and the newer adaptive live-narrated story. The live story already teaches every item, steerably, in the teacher voice, with a durable transcript — making the pre-rendered path redundant and a source of cost (audio synthesis minutes, audio storage, signed URLs), surface area, and a confusing dual user interface.

This feature makes the product **live-only**. Lesson generation produces a text plan/script (with its coverage guarantee and two distinct personas) but no longer synthesizes, stitches, or stores any audio file; a lesson is considered ready once it has a valid script/plan. The lesson page offers exclusively the live-narrated story. The pre-rendered audio player, the playback-position Q&A mode, their stored audio, and their Q&A transcript records are removed; the live-session transcript becomes the single durable record of a lesson session.

This is a deliberate retirement of an existing product surface, not a new capability. It also reframes the product's voice-consistency and reproducibility principles away from the now-removed "scripted podcast."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A generated lesson is ready without any audio render (Priority: P1)

A learner submits a list of words/sentences/idioms. The system generates the text lesson plan/script — ordered teachable items, story beats, a bounded target length, full coverage of every item, two distinct personas — and marks the lesson ready as soon as that script is valid. No audio file is synthesized, stitched, or stored at any point.

**Why this priority**: This is the foundational behavioral change. Without removing the audio-render tail from generation, the product is not live-only and continues to incur audio-synthesis and storage cost. Everything else depends on "ready" meaning "has a valid plan."

**Independent Test**: Submit a valid list → the lesson reaches the ready state with a derivable plan; verify that no audio object exists in storage and no audio record is written for that lesson. Generation completes faster than the previous render-inclusive path.

**Acceptance Scenarios**:

1. **Given** a learner submits a valid list of teachable items, **When** generation completes, **Then** the lesson is marked ready and has a complete script/plan covering every teachable item with two distinct personas and a bounded target length.
2. **Given** a lesson has just been generated, **When** the system finishes, **Then** no audio file has been created in storage and no audio record exists for that lesson.
3. **Given** the lesson script fails its coverage or persona quality check, **When** generation runs, **Then** the lesson does not reach ready and the learner sees a clear status message — with no reference to audio rendering or audio length.

---

### User Story 2 - The lesson opens directly into the live story (Priority: P1)

A learner opens any lesson. They are presented with exactly one experience: the live-narrated, steerable story. There is no audio player to press play on, and no separate "live tutor" panel anchored to playback position.

**Why this priority**: This is the user-facing collapse from two modes to one. It removes the confusing dual UI and ensures every learner reaches the maintained, capable experience. It is co-equal with Story 1 because a live-only product must both generate plan-only *and* present live-only.

**Independent Test**: Open a ready lesson → only the live story panel is present; there is no audio player element and no separate playback-position Q&A panel. Start it → live narration teaches every item and the session transcript persists.

**Acceptance Scenarios**:

1. **Given** a ready lesson, **When** the learner opens its page, **Then** the only lesson experience offered is the live-narrated story — no pre-rendered audio player and no separate playback-position Q&A panel are shown.
2. **Given** the learner starts the live story, **When** narration runs, **Then** the lesson is taught live exactly as the adaptive-live-story feature already behaves (this feature does not change live-story behavior).
3. **Given** the learner completes or ends a live session, **When** they reopen the lesson later, **Then** the durable live-session transcript is the reviewable record of that session.

---

### User Story 3 - Generation quality is judged on the script alone (Priority: P2)

The team evaluates lesson-generation quality. The quality gate scores the produced script — every teachable item covered, two distinct personas present, story-driven rather than dictionary-style — with no audio-render success or audio-length checks anywhere in the gate.

**Why this priority**: The quality gate must match the new generation surface. Leaving audio-render/length checks in place would either fail (nothing renders audio anymore) or evaluate a property the product no longer produces. It is P2 because it protects quality and CI rather than directly delivering the learner experience.

**Independent Test**: Run the generation quality gate against a generated lesson → it passes or fails purely on script coverage, two-persona distinctness, and story-driven structure; it contains no audio-render or audio-length criteria, and the suite is green with the audio checks removed.

**Acceptance Scenarios**:

1. **Given** the generation quality gate runs, **When** it evaluates a lesson, **Then** it checks coverage of every teachable item, presence of two distinct personas, and story-driven structure — and nothing about audio rendering or audio duration.
2. **Given** a script that omits a teachable item or collapses the two personas, **When** the gate runs, **Then** it fails on that script-level criterion.

---

### User Story 4 - Retired data and surfaces no longer exist (Priority: P2)

The product no longer carries the pre-rendered audio subsystem or the playback-position Q&A subsystem. Their stored audio and their Q&A transcript records are removed; the live-session transcript records remain as the durable record. Previously rendered audio and old Q&A transcripts are discarded — this is accepted.

**Why this priority**: Completing the retirement (removing dead storage, records, and routes) is what actually realizes the cost and surface-area reduction that motivates this feature. It is P2 because Stories 1–2 already make the product behave as live-only; this story removes the now-orphaned remnants.

**Independent Test**: Inspect the product after the change → the audio storage location and audio records are gone, the playback-Q&A transcript records are gone, and the live-session transcript records remain and still function. Accessing a former audio or playback-Q&A entry point returns a not-found/removed response rather than serving stale data.

**Acceptance Scenarios**:

1. **Given** the retirement is complete, **When** the system is inspected, **Then** the audio storage location and audio records no longer exist, and the playback-position Q&A transcript records no longer exist.
2. **Given** the retirement is complete, **When** a live session runs, **Then** the live-session transcript records still exist and continue to capture the session as the durable record.
3. **Given** a previously rendered lesson's audio existed before this change, **When** the change is applied, **Then** that audio and any old Q&A transcript are discarded without an attempt to preserve or migrate them, and this loss is accepted.

---

### Edge Cases

- **Lesson generated before this change (already had audio):** Opening it shows only the live story; its plan is derived from the persisted script. Any previously stored audio is gone and is not offered. The lesson is still usable because the script/plan still exists.
- **Coverage/persona quality check fails:** The lesson does not reach ready and the learner gets a clear status message with no mention of audio rendering or duration.
- **Live session unavailable:** The lesson page communicates unavailability with a retry/try-later message (as the live-story feature already does). Because there is no pre-rendered fallback anymore, there is no silent substitution to an audio player — the learner is told to try the live experience again rather than being dropped into a removed mode.
- **A learner had a live session in progress on the old build:** Live sessions are unaffected by this change; their transcript record path is unchanged.
- **Bookmarked/old link to a former audio or playback-Q&A entry point:** Returns a clear not-found/removed response rather than an error or stale audio.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Lesson generation MUST produce the text lesson plan/script — ordered teachable items, story beats, and a bounded target length — and MUST NOT synthesize, stitch, or store any audio file.
- **FR-002**: Generation MUST preserve the existing coverage guarantee (every teachable item covered at least once) and the two distinct personas in the produced script.
- **FR-003**: Generation MUST retain the information the live story needs to derive its plan and narration target (the ordered items, story beats, and an estimated target length), since plan derivation is unchanged.
- **FR-004**: A lesson MUST reach the ready state on the basis of having a valid script/plan, not on the basis of having rendered audio. "Ready" means "has a valid plan/script."
- **FR-005**: The lesson experience MUST be exclusively the live-narrated, steerable story; the system MUST NOT present a pre-rendered audio player or the playback-position Q&A mode on the lesson page.
- **FR-006**: This feature MUST NOT change the behavior of the live-narrated story itself; the live story continues to behave as already built.
- **FR-007**: The system MUST remove the pre-rendered audio storage location and audio records, and MUST remove the playback-position Q&A transcript records, via a forward change; previously stored audio and old Q&A transcripts are discarded and this data loss is accepted.
- **FR-008**: The system MUST retain the live-session transcript records as the single durable record of a lesson session.
- **FR-009**: The system MUST remove the audio entry points (audio retrieval/serving and the playback-position Q&A interaction surface) so that former audio or playback-Q&A access returns a clear not-found/removed response rather than serving stale data.
- **FR-010**: The generation quality gate MUST evaluate only the script — coverage of every teachable item, presence of two distinct personas, and story-driven structure — and MUST NOT include any audio-render or audio-length checks.
- **FR-011**: Developer/operator tooling that previously produced audio output (e.g. a smoke check that wrote an audio file) MUST no longer produce audio output; any retained tooling exercises only the plan/script path.
- **FR-012**: The product's stated voice-consistency and reproducibility principles MUST be reframed away from the now-removed "scripted podcast," so they describe the pinned teacher voice and the live narration rather than a rendered audio file. This reframing is an explicit, recorded decision, not an implicit code change.
- **FR-013**: The system MUST NOT provide a feature flag or toggle to keep the pre-rendered audio mode or the playback-position Q&A mode; this is a clean removal.
- **FR-014**: Status and error messaging on generation and on the lesson page MUST NOT reference audio rendering, audio length, or pre-rendered playback after this change.
- **FR-015**: The change MUST leave authentication, ownership/privacy, and the general persistence model unchanged (no auth/persistence/RLS redesign); only the retired records/storage and the audio-render path are removed.

### Key Entities *(include if feature involves data)*

- **Lesson plan/script**: The text artifact generation produces — ordered teachable items, story beats, two distinct personas, a bounded/estimated target length, and the coverage guarantee. After this change it is the *only* generation output; it carries no associated audio file and no audio-duration field that implies a rendered file.
- **Live-session transcript**: The durable record of a live-narrated session (narration plus interruptions/exchanges). Retained unchanged; becomes the single durable record of a lesson session.
- **Retired — pre-rendered audio**: The stored audio file and its record for a lesson. Removed; existing instances discarded.
- **Retired — playback-position Q&A transcript**: The exchange/turn records of the older playback-anchored Q&A mode. Removed; existing instances discarded.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of newly generated lessons reach the ready state with a valid plan/script and **zero** associated stored audio files and **zero** audio records.
- **SC-002**: 100% of lesson pages present exactly one lesson experience (the live story) — verifiably no pre-rendered audio player element and no separate playback-position Q&A panel.
- **SC-003**: The generation quality gate contains **zero** audio-render or audio-length criteria and still verifies coverage, two distinct personas, and story-driven structure on every evaluated lesson.
- **SC-004**: After the change, the audio storage location, audio records, and playback-position Q&A records no longer exist, while live-session transcript records remain functional — verifiable by inspecting the data model and a live session round-trip.
- **SC-005**: Per-lesson recurring audio-synthesis and audio-storage cost for new lessons drops to zero (no audio is synthesized or stored).
- **SC-006**: Time-to-ready for a generated lesson improves versus the previous render-inclusive path, because the audio-synthesis/stitch step is gone.
- **SC-007**: The full automated test/check suite is green with the audio and playback-Q&A coverage removed and the plan/quality-gate coverage updated.

## Assumptions

- The adaptive live-narrated story feature already exists and is the maintained lesson experience; this feature depends on it and does not re-specify it.
- Generation continues to produce the script with its coverage guarantee, two personas, and an estimated target length; only the audio-render/stitch/store tail is removed (the planner still needs the script and coverage).
- Forward-only data change: the audio storage location and audio records, and the playback-position Q&A records, are dropped without backfill or migration of existing content; live-session transcript records are left in place.
- No feature flag, toggle, or compatibility shim preserves the old modes — this is a clean removal.
- Authentication, ownership/privacy, and the broader persistence/RLS model are unchanged.
- The product's governing principles document (voice-consistency / reproducibility wording) is in scope to update as a recorded decision; the actual amendment is performed through the project's principle-update process during planning/implementation.
- Estimated/target length is retained as a planning input for narration pacing; it no longer implies or requires a rendered audio file of that duration.
