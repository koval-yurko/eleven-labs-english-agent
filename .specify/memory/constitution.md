<!--
SYNC IMPACT REPORT
==================
Version change: (none) → 1.0.0
Bump rationale: Initial ratification of the project constitution (first concrete
  version replacing the unfilled template).

Modified principles: N/A (initial adoption)
Added principles:
  - I. Voice-First Experience Quality
  - II. One Language, End-to-End (TypeScript/Node)
  - III. Evaluated, Reproducible Generation
  - IV. Buy the Hard Parts, Build the Glue
  - V. Learner Data Integrity & Privacy
Added sections:
  - Technology & Architecture Constraints
  - Development Workflow & Quality Gates
  - Governance

Templates requiring updates:
  - ✅ .specify/templates/plan-template.md (Constitution Check gate is generic; no edit needed)
  - ✅ .specify/templates/spec-template.md (no constitution-coupled sections; no edit needed)
  - ✅ .specify/templates/tasks-template.md (task categories compatible; no edit needed)
  - ✅ .claude/commands/speckit.*.md (no outdated principle references)

Follow-up TODOs: none. RATIFICATION_DATE set to first adoption date (2026-06-06).
-->

# Idiomatic Constitution

## Core Principles

### I. Voice-First Experience Quality

The product is an audio experience; it is judged by how it sounds, not how it
reads. Every feature that touches the listener MUST protect three qualities:

- **Voice consistency**: the teacher voice in the scripted podcast and the live
  tutor MUST be the same ElevenLabs voice. A change that splits or alters the
  teacher voice is a breaking change and requires explicit approval.
- **Expressiveness**: generated audio MUST sound like a told story (two distinct,
  natural voices), never like a screen reader reading a list. Flat, robotic, or
  monotone output is a defect, not a stylistic choice.
- **Low-latency interruption**: barge-in and live Q&A MUST stay responsive.
  Perceived time-to-first-audio for a live answer SHOULD be under ~1.5s; any
  change that regresses interruption latency MUST be measured and justified.

**Rationale**: These three properties are the entire reason a learner chooses
this over a flashcard app. They are non-negotiable because they cannot be bolted
on later without re-architecting the audio path.

### II. One Language, End-to-End (TypeScript/Node)

All runtime code for v1 MUST be TypeScript on Node. No Python or second runtime
is introduced for v1. New code MUST type-check with no new `any` leaks across
module boundaries, and shared data shapes (lesson scripts, notes, progress)
MUST have explicit types/schemas.

**Rationale**: ElevenLabs runs the realtime voice transport on its own infra, so
the code we own is glue. Keeping that glue in a single typed language removes a
whole class of integration bugs and operational overhead.

### III. Evaluated, Reproducible Generation

LLM-driven lesson generation is a first-class engineering surface, not a prompt
hack. Therefore:

- Prompts and generation workflows (Mastra) MUST live in version control; ad-hoc
  prompts embedded as untracked strings are not acceptable for shipped features.
- Lesson-generation changes MUST be checked against evals (LangSmith via the
  `@mastra/langsmith` exporter) before they are considered done. "It looked good
  once" is not evidence.
- Generation MUST be reproducible enough to debug: inputs, model/version, and the
  resulting structured script MUST be recoverable for any produced lesson.

**Rationale**: Generated content quality is the product's core value and its
biggest regression risk. Without evals and traceability, quality drifts silently.

### IV. Buy the Hard Parts, Build the Glue

Prefer managed platform capabilities over re-implementing them. The genuinely
hard realtime parts — turn-taking, barge-in, STT→LLM→TTS cascading — are owned by
ElevenLabs Agents and MUST NOT be reimplemented. Storage, auth, and transport use
the decided managed services (Supabase, Auth0, ElevenLabs). Introducing custom
infrastructure that duplicates a managed capability MUST be justified in the
plan's Complexity Tracking section with a concrete reason the managed option fails.

**Rationale**: The team's leverage is in the lesson experience, not in operating
realtime audio or auth infrastructure. Every line of undifferentiated infra is a
liability.

### V. Learner Data Integrity & Privacy

Notes and progress are the learner's memory across sessions and MUST be handled
with care:

- Notes MUST stay anchored to the exact item (word/idiom) being discussed; losing
  that anchor is a data-loss defect.
- Progress (mastered vs. struggled) MUST persist durably in Supabase and feed the
  next lesson; it is not best-effort.
- Secrets (ElevenLabs, Claude, Supabase, Auth0 keys) MUST never be committed or
  exposed to the browser. Server-only credentials stay server-side.
- Learner-identifying data MUST only be accessed by the authenticated owner.

**Rationale**: The adaptive promise ("lessons remember what you already know")
depends entirely on this data being correct, durable, and private.

## Technology & Architecture Constraints

The stack in `spec/PRD-base.md` §4 is the decided baseline; changes to it are
governance-level decisions, not casual refactors:

- **Language/runtime**: TypeScript / Node (no Python in v1).
- **Frontend**: Next.js (App Router), responsive web only for v1.
- **Auth**: Auth0. **Data & storage**: Supabase (Postgres + Storage).
- **Generation**: Mastra workflow + Claude. **Scripted audio**: ElevenLabs Text
  to Dialogue (Eleven v3). **Live tutor**: ElevenLabs Agents with Claude.
- **Architecture stance**: cascaded (STT → LLM → TTS) is mandatory for v1 so the
  transcript stays available for notes, feedback, and progress. Speech-to-speech
  is out of scope for v1.
- The two subsystems — **Lesson Generator** (batch) and **Interactive Player +
  Live Tutor** (realtime) — MUST stay independently buildable and testable; they
  communicate through the structured lesson script, not shared internal state.

Swapping any decided component requires the amendment procedure below.

## Development Workflow & Quality Gates

- **Spec-driven flow**: features move through `/speckit.specify` →
  `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`. Plans MUST pass the
  Constitution Check gate before tasks are generated.
- **Testing**: each subsystem MUST have contract tests on its boundary (the lesson
  script schema, the notes/progress data contracts). Integration with external
  managed services (ElevenLabs, Supabase, Auth0, Claude) MUST be tested against
  mocks/fixtures in CI; live keys are not required to run the test suite.
- **Generation quality gate**: changes to lesson generation MUST run evals
  (Principle III) and not regress baseline quality before merge.
- **Review**: every change MUST be reviewed for compliance with these principles.
  A reviewer MUST be able to point to the principle a change satisfies or the
  justification for any deviation.

## Governance

This constitution supersedes ad-hoc practice. When guidance here conflicts with a
convenience, the constitution wins or it must be amended first.

- **Amendments**: proposed as a change to this file, with a short rationale and a
  migration note when behavior or stack changes. Amendments take effect when
  merged and the version + dates below are updated.
- **Versioning policy** (semantic):
  - **MAJOR**: a principle is removed or redefined in a backward-incompatible way,
    or a decided stack/architecture component is dropped.
  - **MINOR**: a new principle or section is added, or guidance is materially
    expanded.
  - **PATCH**: clarifications, wording, and non-semantic refinements.
- **Compliance review**: plans and PRs MUST verify compliance. Any deviation MUST
  be recorded in the plan's Complexity Tracking with its justification; unjustified
  violations block merge.
- **Runtime guidance**: `spec/PRD-base.md` and the `.specify/` templates provide
  the operational detail that implements these principles; they MUST stay
  consistent with this document.

**Version**: 1.0.0 | **Ratified**: 2026-06-06 | **Last Amended**: 2026-06-06
