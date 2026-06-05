# Phase 0 Research: Lesson Generation

**Feature**: 002-lesson-generation · **Date**: 2026-06-06

The stack is fixed by the constitution and PRD §4, so no technology *selection* is open. Research here resolves the *how* — concrete patterns and the handful of feature-level decisions (max items, coverage guarantee, audio assembly, async status, Auth0↔Supabase ownership). Each item: Decision → Rationale → Alternatives considered.

---

## R1. Maximum teachable items per lesson

- **Decision**: Cap at **20** teachable items per lesson. Above 20 → "oversized" handling (FR-005): state the limit, let the learner trim; do not silently drop or over-length.
- **Rationale**: At ~5–10 min and a meaningful mini-story per item, ~20–30s of taught content per item fits ~10–15 items comfortably; 20 is the firm ceiling that still respects the upper length bound (SC-003) without flattening stories into definitions. Round, memorable, matches PRD "modest input sizes (up to a few dozen)."
- **Alternatives considered**: No cap (breaks length bound, violates FR-012); soft cap with auto-trim (violates FR-005's "no silent drop"); dynamic cap by item complexity (unpredictable UX, harder to message).

## R2. Coverage guarantee — every item taught at least once

- **Decision**: Generation produces a **structured script with an explicit item→segment coverage map** (each accepted item references the segment(s) that teach it). A deterministic post-generation **validation step** asserts every accepted item is referenced; on a miss, the workflow re-prompts for the uncovered items before the script is accepted. Coverage is verified in code, not trusted to the model.
- **Rationale**: FR-009/SC-002 demand 100% coverage — a testable invariant, not a hope. A machine-checkable map turns it into a contract test and an eval signal (Constitution III).
- **Alternatives considered**: Trust the LLM to "cover everything" (untestable, drifts); keyword-search the final transcript for each item (brittle for idioms taught via paraphrase/story; rejected as the *primary* check but usable as a secondary heuristic).

## R3. Lesson length bounding

- **Decision**: Budget length at **script time** via a target word/segment budget derived from item count (≈150 wpm speaking rate, ~5–10 min ⇒ ~750–1500 words), enforced as a prompt constraint and validated against the assembled script. Audio duration is measured after render and stored.
- **Rationale**: Cheaper and more reliable to bound the script than to trim audio post-hoc; keeps stories intact rather than cutting mid-sentence. Stored duration lets SC-003 be measured.
- **Alternatives considered**: Render-then-truncate audio (cuts stories, poor UX); fixed words-per-item (ignores that idioms need more runway than single words).

## R4. Expressive two-voice rendering (ElevenLabs Text to Dialogue)

- **Decision**: Render with **ElevenLabs Text to Dialogue (Eleven v3)** using two pinned voice IDs — one **learner** persona, one **teacher** persona — with **audio tags** for expressiveness (warmth, curiosity, emphasis). The **teacher voice ID is fixed in config** and reused unchanged by S2's live tutor.
- **Rationale**: Constitution I requires two distinct, natural, story-like voices and teacher-voice consistency across scripted + live. Pinning the teacher voice now prevents a breaking change later.
- **Alternatives considered**: Single voice for both speakers (fails "two distinct voices", SC-004); plain TTS without dialogue/tags (sounds read-aloud — a defect per Constitution I); per-lesson random teacher voice (breaks S2 consistency).

## R5. Segmentation around the ~3,000-char request limit + audio assembly

- **Decision**: Split the dialogue into **segments under the per-request character limit**, render each segment to audio, then **stitch segments in order into one lesson audio asset**. Store the final stitched asset in Supabase Storage; optionally retain per-segment assets to enable partial retry.
- **Rationale**: PRD §4 calls out the ~3,000-char limit → "generate per segment." Stitching yields the single continuous lesson the learner plays (FR-011/FR-014). Per-segment retention bounds the blast radius of a single failed render.
- **Alternatives considered**: One giant request (exceeds limit); client-side concatenation of many files at play time (more moving parts, worse seekability, no single shareable asset).

## R6. Asynchronous generation + status communication

- **Decision**: Submission creates a **Lesson row in `pending`** and returns immediately (202). A background generation run advances status `pending → generating → ready` (or `→ failed` with a reason). The client reflects status (FR-015) by **subscribing to the lesson row (Supabase Realtime) with polling fallback**. A `failed` lesson exposes **retry** (FR-016). Generation surviving the learner leaving is automatic because state lives in the DB, not the session.
- **Rationale**: Generation (LLM + multi-segment TTS) takes noticeable time; a synchronous request would time out and lose work if the learner leaves. DB-backed status satisfies SC-008 (no silent/indefinite waits) and the "generation not lost by leaving" edge case.
- **Alternatives considered**: Synchronous request-response (timeouts, lost work); client-only progress with no persistence (lost on navigation); email/webhook notification (overkill for v1, NG scope).

## R7. Auth0 identity ↔ Supabase ownership (privacy)

- **Decision**: **Auth0** is the identity provider (`@auth0/nextjs-auth0`). Supabase is configured with **Auth0 as a third-party auth provider** so Postgres **Row-Level Security** policies key on the Auth0 subject (`auth.jwt() ->> 'sub'` = `lessons.owner_id`). All Supabase access happens in **server-side route handlers**; the **service-role key never reaches the browser**. RLS is defense-in-depth beneath app-layer ownership checks.
- **Rationale**: Constitution V requires owner-only access and server-only secrets. Enforcing ownership at the database layer (RLS) means a logic bug in a route handler still can't leak another learner's lessons (SC-005). Matches the decided stack (Auth0 + Supabase).
- **Alternatives considered**: App-layer ownership checks only (one missed `WHERE owner_id` = data leak); Supabase Auth instead of Auth0 (contradicts decided stack); shipping anon key with permissive policies (insecure).

## R8. Mastra generation workflow shape (versioned, reproducible)

- **Decision**: A **Mastra workflow** with explicit, version-controlled steps: **(1) parse & normalize** input (split, trim, dedupe), **(2) classify teachability** (teachable English item vs. skip + reason), **(3) plan coverage** (assign each item a teaching beat, order for narrative flow), **(4) draft script** (two-voice conversation, story per item, within length budget), **(5) expressive pass** (insert audio tags / persona voicing), **(6) emit + validate** LessonScript (coverage map check from R2). Persist `{input, model id/version, prompt version, resulting script}` for every run (Constitution III reproducibility). Prompts live in `packages/generator/src/prompts`.
- **Rationale**: A staged workflow makes coverage, length, and teachability *individually* testable and eval-able rather than one opaque mega-prompt; reproducibility metadata makes any produced lesson debuggable.
- **Alternatives considered**: Single mega-prompt (opaque, hard to eval/guarantee coverage); untracked inline prompt strings (forbidden by Constitution III).

## R9. Teachability classification (empty / oversized / unteachable handling)

- **Decision**: Step 2 classifies each entry as **teachable** (English word/sentence/idiom) or **skipped** with a machine-usable **reason** (`non_english`, `gibberish`, `not_discrete`/too-long, `duplicate`). Aggregate outcomes drive FR-004 (empty → reject), FR-005 (oversized → limit message), FR-006 (mixed → proceed + report skipped), FR-007 (none teachable → decline + revise).
- **Rationale**: One classification pass produces every branch the spec requires, and the per-entry reasons feed the "which entries were skipped and why" UX (FR-006, Story 3.4).
- **Alternatives considered**: Pure regex/dictionary validation (can't judge idioms or story-teachability); reject-whole-list on any bad entry (fails FR-006 partial-success requirement).

## R10. Lesson library identity (replay & disambiguation)

- **Decision**: Lessons are listed by **source items (preview) + creation time** (FR-020); no LLM-generated title required for S1. Re-submitting the same list creates a **new** lesson (FR-021) — no cross-lesson dedupe.
- **Rationale**: Spec's Assumptions accept item-preview + timestamp as sufficient; avoids scope creep (titling/tagging) while keeping lessons distinguishable (Story 2.4).
- **Alternatives considered**: Auto-generated titles (nice-to-have, deferred); dedupe identical lists into one lesson (contradicts FR-021).

## R11. Testing external managed services without live keys

- **Decision**: Wrap each provider (Claude, ElevenLabs, Supabase, Auth0) behind a thin typed adapter; in CI use **mocks/fixtures** (recorded TTS asset fixtures, canned generation outputs, in-memory/seeded Supabase or test schema, stubbed Auth0 session). LangSmith evals run as a separate generation-quality gate, not in the unit/contract path.
- **Rationale**: Constitution Dev Workflow mandates CI runs against mocks/fixtures with no live keys. Adapters keep provider details out of business logic and make the coverage/length/privacy invariants testable deterministically.
- **Alternatives considered**: Hitting live APIs in CI (flaky, costly, needs secrets — forbidden); no provider abstraction (untestable, leaks vendor types across boundaries).

---

## Resolved unknowns

All Technical Context items are concrete; **no NEEDS CLARIFICATION remain**. The only spec-level open number (max teachable items) is resolved to **20** (R1). Remaining tuning (exact voice IDs, model variants for draft vs. expressive passes, segment size under the char limit) are implementation parameters captured in config, not blockers.
