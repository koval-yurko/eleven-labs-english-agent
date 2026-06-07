# Phase 0 Research: Adaptive, Interruptible Live-Narrated Lesson

**Feature**: 006-adaptive-live-story · **Date**: 2026-06-07

Resolves the unknowns surfaced by the spec + Technical Context. Each decision is constrained by the constitution (Principle IV: buy the realtime hard parts; I: one pinned teacher voice + low-latency barge-in; V: privacy) and by what the existing 005 code + `@elevenlabs/react` SDK actually provide (verified against the SDK source — see the `elevenlabs-convai-transcript-facts` memory).

---

## R1 — Continuous narration on a turn-based agent

**Decision**: Drive narration as a **client-tool self-continuation loop**. The agent narrates **one story beat at a time** and ends each beat by calling a client tool `advanceNarration()`. The tool's return value (a short string) tells the agent what to narrate next: the next beat, a reminder of which items still must be taught, or "now bring the lesson to a natural close." A single initial trigger (`sendContextualUpdate` "Begin narrating the lesson now, starting with beat 1") kicks it off after `onConnect`.

**Rationale**: A Conversational-AI agent is request/response; it does not stream an open-ended monologue on its own. Chunking into beats and looping via a client tool keeps **all** audio/turn-taking/barge-in on the platform (Principle IV) while giving us a deterministic hook to (a) track coverage, (b) enforce the length budget, and (c) re-assert the steered scenario every beat. Beats are short enough that barge-in interrupts within one beat, keeping the SC-005 ≤0.5s stop responsive. The SDK exposes `clientTools: Record<string, (params) => Promise<string|number|void>>` (verified), and the agent must declare these tools in its config (quickstart step).

**Alternatives considered**:
- *One long first-message / single TTS blob*: can't be steered mid-stream, can't track per-item coverage, and barge-in truncation correction gets coarse. Rejected — defeats the feature.
- *Server-side narration orchestration (server calls Claude, streams TTS itself)*: reimplements the cascade ElevenLabs already owns. Rejected (Principle IV).
- *Time-based polling to advance*: racy against barge-in and TTS pacing. The tool-call boundary is the natural, race-free beat boundary.

---

## R2 — Where the lesson plan comes from

**Decision**: **Derive the `LessonPlan` read-only from the persisted `LessonScript` + `source_items`** at session start, in a pure `derivePlan()` helper in `packages/generator/src/workflow/`. No new batch flow, no new generation prompt, **no change to the `lessons` table**. The plan = ordered teachable items (from `coverage` / `source_items`, `order_index`) + story beats (condensed from `segments`, grouped by which item(s) they teach) + a bounded target length (from `estimatedDurationSeconds`, clamped to the configured target window).

**Rationale**: The spec's own assumption is "the lesson plan is derived from existing generation output." Deriving keeps the batch generator untouched, so the **generation eval gate cannot regress** (Constitution III) and subsystem independence holds (the boundary artifact is `LessonScript`, exactly as 005 already reads it). It is purely additive and needs no migration to existing tables. `derivePlan` lives in the generator package because it is pure, generation-domain logic next to `validate-coverage`, but it is invoked by the web service — not by the batch pipeline.

**Alternatives considered**:
- *New `planLesson` batch flow that replaces `generateLesson` and drops TTS* (the original memo direction): larger change, removes the pre-rendered asset still used by the separate 002/005 playback experience, and would touch the eval gate. Deferred — derivation gives the same plan with far less blast radius. (If pre-render is later removed, `derivePlan` is the seam that stays.)
- *Persist a `plan` column on `lessons`*: unnecessary — the plan is cheap to derive and the `LessonScript` is already persisted and versioned.

---

## R3 — Guaranteeing every planned item is taught (coverage at narration time)

**Decision**: Enforce coverage **live**, in the pure `narration-state` machine, not at generation time. The machine holds the plan's item set and a `covered: Set`. The agent reports progress by calling `markItemTaught(itemId)` (or `advanceNarration` returns the next item to teach). `advanceNarration` will **not** return "conclude" until every planned item is in `covered`; if beats run low, its return value explicitly lists the not-yet-taught items and instructs the agent to teach them next (even with looser story framing — edge case "item conflicts with scenario"). `concludeLesson()` is rejected (returns "still must teach: …") while any item is uncovered.

**Rationale**: With live, steerable narration there is no pre-validated script to guarantee SC-001. The deterministic tool-return contract is what makes "every item taught at least once" a guarantee (FR-004/FR-010/SC-001/SC-004) rather than a hope, and it survives scenario changes because coverage is tracked independently of the setting. The completed/abandoned distinction (FR-027, SC-001 "sessions that run to their natural end") falls out naturally: coverage is only asserted at `concludeLesson`; an abandoned session simply never reaches it and keeps its partial transcript.

**Alternatives considered**: Trusting the prompt alone ("be sure to cover everything") — not a guarantee; coverage would drift, exactly the failure Constitution III warns about. Rejected.

---

## R4 — Scenario steering (interpret + pin for the rest of the session)

**Decision**: The agent distinguishes a **question** from a **scenario-change request** itself (system-prompt intent rules) and, for a scenario change, calls `setScenario(scenario)`. The handler (a) records the change as a `scenario_change` turn, (b) updates `narration-state.scenario`, and (c) re-pins it via `sendContextualUpdate("From now on the story is set in: <scenario>. Continue teaching the remaining items in this setting.")`. Every subsequent `advanceNarration` return also embeds the current scenario so the setting **persists** and the **most recent** change wins (FR-008/FR-009). An impossible/ambiguous request is handled by the agent per prompt: apply the closest reasonable interpretation or tell the learner it can't change the setting (FR-011) — it does not call `setScenario` with garbage.

**Rationale**: `sendContextualUpdate(text)` is the SDK's documented steering channel (verified) and is non-destructive to turn-taking. Pinning **every beat** (not once) is what prevents the model from drifting back to the original setting over a long narration. Recording the change as a turn keeps the transcript honest about when the world changed.

**Alternatives considered**: Re-minting the session with new dynamic variables on each scenario change — drops the connection, loses barge-in responsiveness and continuity. Rejected. Relying on a single `sendContextualUpdate` without per-beat reinforcement — observed drift risk over many turns. Rejected.

---

## R5 — Subtitle captions + barge-in correction (corrected text is the single source of truth)

**Decision**: Render captions from `onMessage` only — `{ source: "ai" }` → teacher turn, `{ source: "user" }` → learner turn — which the SDK fires as **finalized** turns (not word-by-word), i.e. naturally subtitle-level (FR-018/FR-019). Wire `onAgentResponseCorrection({ original_agent_response, corrected_agent_response })` and **replace** the just-rendered teacher turn's text with `corrected_agent_response` on barge-in (FR-020/SC-008). The **same corrected text** is what gets persisted as the transcript turn (FR-022) — captions and transcript share one code path so they cannot diverge. Do **not** consume `internal_tentative_agent_response` (private/unstable; routed to `onDebug`).

**Rationale**: Verified directly against the SDK source. Using `corrected_agent_response` for both caption and transcript is the only way to honor "the caption must never show text that was cut off and never spoken" (edge case) and FR-022's "corrected text" requirement with a single source of truth. Karaoke/word-sync (`AudioAlignmentEvent`) is explicitly out of scope per the spec and the user's confirmation that subtitle-level is enough.

---

## R6 — Durable transcript schema (session-level, incremental)

**Decision**: Two new owner-scoped tables, **`live_sessions`** (one row per narration episode: lesson, owner, scenario-in-effect, status `active|ended`, conversation id, timestamps) and **`session_turns`** (ordered turns: role `teacher|learner`, kind `narration|answer|question|scenario_change`, corrected text, turn index, timestamp). Turns are **appended incrementally** as `onMessage`/correction fire (best-effort, off the speech path), so a dropped/abandoned session keeps the partial transcript already written (FR-027). Do **not** reuse 005's `qa_exchanges`/`qa_turns` — those are interruption-episode + playback-position scoped and don't model a continuous session.

**Rationale**: The transcript is the replayable record (FR-024) and must survive abandonment (FR-027); incremental append is the only way to guarantee partial preservation without an audio timeline. A `kind` discriminator lets review render narration vs. Q&A vs. a scenario change in order (FR-023, US5). Append-only (no UPDATE/DELETE policy) matches the 005 RLS pattern and the privacy posture. **One exception to pure append**: a teacher turn corrected by a *later* barge-in is updated in place to its corrected text (R5); this is the single allowed mutation and is owner-scoped — handled by writing the teacher turn only **after** a short settle window or by an idempotent upsert keyed on the conversation turn id (see data-model).

**Alternatives considered**: Persist only at session end — loses the partial transcript on a dropped connection (violates FR-027). Rejected. One flat `turns` table without a session row — loses the scenario-in-effect and per-session grouping needed for review and reproducibility. Rejected.

---

## R7 — Fallback when live is unavailable (FR-026)

**Decision** (confirmed with the user 2026-06-07): When the live-story capability can't start (agent not configured, token mint fails) or fails mid-session, surface a **clear message + a retry / try-later** affordance — no pre-rendered-playback substitution. Start failure → render the unavailable panel (message + "Try again") instead of the live-story UI, never a blank/frozen screen. Mid-session failure (`onError`/disconnect) → keep the **partial transcript already written** (R6), tell the learner the live lesson dropped, and offer **retry** (re-open a fresh session). "Making progress" (FR-026 #3) means the learner can retry the live lesson rather than being dead-ended.

**Rationale**: Keeps the live-story mode self-contained and the fallback path trivial — reuse the exact unavailable-panel pattern 005 already ships (`status === "unavailable"` → message + "Try again"), so there is no cross-mode coupling to the `<audio>` player or 005 Q&A. The partial transcript preserved on a drop (FR-027) means a retry resumes context rather than losing everything.

**Alternatives considered**:
- *Fall back to the existing pre-rendered playback + 005 live Q&A*: concrete and same-content, but couples the two modes on the lesson page and pulls the (about-to-be-legacy) pre-render path into the live experience. **Rejected per user decision** — keep the modes decoupled.
- *Text-only transcript fallback / hard error page*: weaker or violates "never a frozen/blank screen." Rejected.

---

## R8 — Bounded target length without an `<audio>` timeline (FR-005)

**Decision**: Carry the plan's target window (`targetSeconds`, derived from `estimatedDurationSeconds` clamped to `[TARGET_MIN_SECONDS, TARGET_MAX_SECONDS]`) into the narration state machine as a **beat budget**: an estimated beats-remaining derived from words-per-beat × WPM. `advanceNarration` steers toward "conclude" as the budget nears zero **once coverage is met**, and the agent is prompted to keep beats concise. Length is a target, not a hard cut (SC-002 is ≥95%, not 100%); coverage (R3) always wins over the budget if they conflict (an item still owed is taught even slightly past target).

**Rationale**: There's no media duration to measure live, so length is governed at the only deterministic boundary we have — the beat loop. Tying it to the existing config window (`config.ts` `targetMin/MaxSeconds`, default 300–600s) reuses the established tuning knob and keeps "bounded target length is a tuning parameter with a reasonable default" (spec assumption) true.

---

## R9 — Accidental/background speech and empty interruptions (FR-016/FR-017)

**Decision**: Reuse 005's proven rules. Platform VAD + STT produce an **empty/blank `user_transcript`** for a cough or background noise; the state machine treats that as `unintelligible` (no stored learner turn, no spurious answer, no spurious `setScenario`) and the agent asks the learner to repeat (prompt rule). A `clarificationStreak` counter (as in `exchange-state.ts`) offers a clean "return to the narration" escape after N consecutive unintelligibles (FR-017), so the learner is never trapped. After an exchange, `advanceNarration` resumes the narration toward remaining items (FR-015).

**Rationale**: This is exactly the empty/garbled-input guard 005 already designed and tested (`reduceExchange` `unintelligible` + `shouldOfferReturnToLesson`); porting it into `narration-state` keeps the behavior and its unit tests, satisfying SC-010 without new risk.

---

## R10 — Agent provisioning (reuse vs. new agent)

**Decision**: Provision a **dedicated "live story" agent** (new `ELEVENLABS_STORY_AGENT_ID`) configured with the **same pinned teacher voice**, native Claude (Haiku for latency), the versioned narrator/tutor/steering system prompt, and the four **client tools declared** (`advanceNarration`, `markItemTaught`, `setScenario`, `concludeLesson`). Availability check falls back cleanly to "unavailable" (→ R7 fallback) when the id/key is absent. The 005 tutor agent is left as-is for the fallback Q&A path.

**Rationale**: The narrator agent needs a materially different system prompt and a set of declared client tools that the 005 Q&A agent doesn't have; keeping them as separate agent ids avoids regressing the shipped 005 behavior and lets each prompt/tool set be tuned independently (Constitution III: prompts are versioned artifacts). The token-mint code (`lib/live-tutor/token.ts`) is voice/agent-agnostic and is **reused** unchanged.

**Alternatives considered**: One shared agent with a mode flag in dynamic variables — couples two prompts and two tool sets into one config and risks 005 regressions. Rejected for v1; can be unified later if desired.

---

## Summary of decisions

| # | Topic | Decision |
|---|---|---|
| R1 | Continuous narration | Client-tool `advanceNarration` self-continuation loop, one beat per call |
| R2 | Lesson plan source | Derive read-only from persisted `LessonScript` + `source_items`; no generator/table change |
| R3 | Coverage guarantee | Live, in the pure narration-state machine; `concludeLesson` blocked until all items covered |
| R4 | Scenario steering | Agent intent → `setScenario` → `sendContextualUpdate`, re-pinned every beat; latest wins |
| R5 | Captions + correction | `onMessage` finalized turns; `onAgentResponseCorrection` → corrected text for caption AND transcript |
| R6 | Transcript schema | New `live_sessions` + `session_turns`, incremental append; not the 005 qa tables |
| R7 | Fallback | Clear message + retry / try-later panel (modes decoupled; no pre-render substitution) |
| R8 | Length budget | Beat budget from clamped `estimatedDurationSeconds`; coverage wins over length |
| R9 | Empty/background speech | Port 005's unintelligible guard + clarification escape into narration-state |
| R10 | Agent provisioning | Dedicated story agent (`ELEVENLABS_STORY_AGENT_ID`), teacher voice, client tools; reuse token mint |
