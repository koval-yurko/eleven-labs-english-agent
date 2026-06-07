# Phase 1 Data Model: Adaptive, Interruptible Live-Narrated Lesson

**Feature**: 006-adaptive-live-story · **Date**: 2026-06-07 · **Store**: Supabase (Postgres)

Derived from the spec's Key Entities + Functional Requirements. Ownership is enforced by Row-Level Security keyed on the Auth0 subject, mirroring 002/005. This feature adds **two tables** (`live_sessions`, `session_turns`) and **reads** the existing `lessons.script` / `source_items`; it changes no existing table. The **Lesson Plan** is a derived, in-memory artifact (not persisted) — see below.

---

## Entities

### Learner
The Auth0 identity (`sub`), as in 002/005 — not a table we own. `owner_id` columns hold the `sub` and are the RLS key. Only the owning learner may read/write their sessions and turns (FR-028, SC-009).

### Lesson · SourceItem · LessonScript *(existing — read-only here)*
- `lessons.script` (`LessonScript`: `speakers`, `segments`, `coverage`, `estimatedDurationSeconds`) is the boundary artifact the **plan is derived from** (R2). The teacher voice is read from `script.speakers.teacher.voiceId` (Constitution I — same pinned voice).
- `source_items` provides the ordered teachable items (`order_index`, `normalized_text`, `teachable`) the plan must cover. The live story never mutates these.

### LessonPlan *(new — derived, NOT persisted)*
The ordered set of teachable items + story beats + bounded target length that drives narration (spec: "Lesson Plan"). Computed at session start by `derivePlan(script, items, config)` and shipped to the agent via dynamic variables (R1/R2). It is reproducible from the persisted `LessonScript`, so it is not stored.

| Field | Type | Notes |
|---|---|---|
| `lessonId` | string | the lesson it narrates |
| `items` | `PlanItem[]` | ordered teachable items: `{ sourceItemId, normalizedText, itemType }` (order from `source_items.order_index`) |
| `beats` | `PlanBeat[]` | ordered story beats: `{ index, summary, teachesItemIds: string[] }` (condensed from `script.segments`, grouped by `script.coverage`) |
| `targetSeconds` | int | `estimatedDurationSeconds` clamped to `[TARGET_MIN_SECONDS, TARGET_MAX_SECONDS]` (R8) |
| `teacherVoiceId` | string | from `script.speakers.teacher.voiceId` (informational; the agent is already provisioned with it) |

**Validation** (in `derivePlan`)
- `items` non-empty (a ready lesson always has ≥1 teachable item).
- Every `item.sourceItemId` referenced by some `beat.teachesItemIds` (every planned item appears in at least one beat) — this is the plan-time mirror of FR-004; runtime coverage is then enforced by the state machine (R3).
- `targetSeconds ≥ 1`.

### LiveSession *(new — persisted)*
One realtime narration-plus-interaction episode for a lesson (spec: "Live Session"). Holds the scenario currently in effect and groups the ordered turns.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `lesson_id` | uuid (fk → lessons) | cascade delete |
| `owner_id` | text | Auth0 `sub`; RLS key (FR-028), denormalized |
| `status` | enum `live_session_status` | `active` \| `ended` (ended = reached a natural close OR was explicitly stopped) |
| `scenario` | text null | the scenario currently in effect; null = the plan's original setting (FR-008/FR-009) |
| `elevenlabs_conversation_id` | text null | realtime conversation id, for reproducibility/debug (Constitution III, R6) |
| `created_at` | timestamptz | default now() — session start |
| `ended_at` | timestamptz null | set when status → ended |

**Validation**
- A session belongs to a lesson the caller owns (enforced in service + RLS).
- `scenario`, when set, is the **most recent** requested scenario (latest wins, FR-009); updating it overwrites.

### SessionTurn *(new — persisted)*
A single utterance within a session — teacher narration, teacher answer, learner speech, or a recorded scenario-change — captured as **corrected text**, attributed and ordered (spec: "Session Turn"; FR-021/FR-022/FR-023).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `session_id` | uuid (fk → live_sessions) | cascade delete |
| `owner_id` | text | denormalized for RLS |
| `role` | enum `session_turn_role` | `teacher` \| `learner` |
| `kind` | enum `session_turn_kind` | `narration` \| `answer` \| `question` \| `scenario_change` |
| `text` | text | corrected transcript of the utterance (R5) — learner content; logged only at `debug` (Constitution V) |
| `turn_index` | int | 0-based order within the session |
| `eleven_turn_ref` | text null | optional stable ref to the SDK turn, used to upsert a barge-in correction in place (R5/R6) |
| `created_at` | timestamptz | default now() |

**Validation**
- `(session_id, turn_index)` unique — stable ordering (FR-023).
- `text` non-empty (empty/unintelligible learner input never becomes a stored turn; it triggers clarification — FR-016, R9).
- `role`/`kind` consistency: `learner` ⇒ `kind ∈ {question}`; `teacher` ⇒ `kind ∈ {narration, answer}`; `scenario_change` is recorded as a `learner` turn (the learner requested it). Enforced in the service.

### Scenario *(value, not a table)*
`live_sessions.scenario` — the story setting currently in effect. Set initially by the plan (null = original), changeable mid-session via `setScenario` (R4); the most recent change persists for the rest of the session (FR-008/FR-009).

### Session Transcript *(view, not a table)*
The durable text record = a `LiveSession` + its ordered `SessionTurn[]`. Returned by `GET .../transcript` and reviewable in later sessions (FR-024). The replayable record in place of audio (FR-025).

---

## Relationships

```text
Learner (Auth0 sub)
  └── owns ──> Lesson (existing)
                 ├── has ──> SourceItem[] (existing, ordered)   ┐
                 ├── has ──> LessonScript (existing)            ├─ read-only → derive LessonPlan (not stored)
                 └── has ──> LiveSession[]            (new, per narration episode)
                                 ├── in effect ──> Scenario (column)
                                 └── has ──> SessionTurn[]      (new, ordered by turn_index, corrected text)
```

---

## Plan derivation (R2) — pure, read-only, not stored

`derivePlan(script: LessonScript, items: SourceItem[], { targetMinSeconds, targetMaxSeconds }) -> LessonPlan`:

1. **Items**: take `items.filter(teachable)` ordered by `order_index` → `PlanItem[]`.
2. **Beats**: walk `script.segments` in order; group consecutive segments into beats and attach `teachesItemIds` by looking up each segment id in `script.coverage` (`coverage.segmentIds → coverage.sourceItemId`). A beat with no covered item is a pure story/connective beat.
3. **Target**: `clamp(script.estimatedDurationSeconds, targetMinSeconds, targetMaxSeconds)`.
4. Assert every teachable item appears in some beat's `teachesItemIds` (plan-time coverage mirror); otherwise throw (a malformed script — the same class of failure `validateCoverage` already guards at generation time).

Isolated in `packages/generator/src/workflow/derive-plan.ts` so it stays pure and unit-testable and can later be replaced by a dedicated `planLesson` flow without changing callers.

---

## Migration `0005_live_story.sql` (shape)

```sql
CREATE TYPE live_session_status AS ENUM ('active', 'ended');
CREATE TYPE session_turn_role   AS ENUM ('teacher', 'learner');
CREATE TYPE session_turn_kind   AS ENUM ('narration', 'answer', 'question', 'scenario_change');

CREATE TABLE live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  status live_session_status NOT NULL DEFAULT 'active',
  scenario text,
  elevenlabs_conversation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX live_sessions_lesson_idx ON live_sessions (lesson_id, created_at DESC);

CREATE TABLE session_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  role session_turn_role NOT NULL,
  kind session_turn_kind NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) > 0),
  turn_index int NOT NULL,
  eleven_turn_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_index)
);
CREATE INDEX session_turns_session_idx ON session_turns (session_id, turn_index);

ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_turns ENABLE ROW LEVEL SECURITY;

-- Owner-only, keyed on Auth0 sub (same pattern as 0003_rls.sql / 0004_qa.sql).
CREATE POLICY "live_sessions owner select" ON live_sessions FOR SELECT
  USING (owner_id = auth.jwt() ->> 'sub');
CREATE POLICY "live_sessions owner insert" ON live_sessions FOR INSERT
  WITH CHECK (owner_id = auth.jwt() ->> 'sub');
-- status/scenario/ended_at are mutated by the owner during the session.
CREATE POLICY "live_sessions owner update" ON live_sessions FOR UPDATE
  USING (owner_id = auth.jwt() ->> 'sub') WITH CHECK (owner_id = auth.jwt() ->> 'sub');

CREATE POLICY "session_turns owner select" ON session_turns FOR SELECT
  USING (owner_id = auth.jwt() ->> 'sub');
CREATE POLICY "session_turns owner insert" ON session_turns FOR INSERT
  WITH CHECK (owner_id = auth.jwt() ->> 'sub');
-- A barge-in correction overwrites a teacher turn's text in place (R5/R6); owner-scoped.
CREATE POLICY "session_turns owner update" ON session_turns FOR UPDATE
  USING (owner_id = auth.jwt() ->> 'sub') WITH CHECK (owner_id = auth.jwt() ->> 'sub');
```

**Notes**
- `live_sessions` allows `UPDATE` (status → ended, scenario change, ended_at); `session_turns` allows `UPDATE` only for the **barge-in correction** of a teacher turn's text (R5) — the single permitted mutation. No `DELETE` policy: turns are otherwise append-only; cascade-delete with the lesson is the only removal path.
- `owner_id` is denormalized onto both tables so RLS never needs a join (matches `source_items` / `qa_*`).
- No new Storage bucket and **no audio column anywhere**: realtime audio is never persisted (FR-025). The text transcript is the only durable record.
- An **abandoned** session keeps its row (`status = active`, `ended_at = null`) and every turn appended before the drop — partial preservation (FR-027).
