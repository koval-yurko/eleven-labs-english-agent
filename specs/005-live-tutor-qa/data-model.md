# Phase 1 Data Model: Live, Interruptible Q&A

**Feature**: 005-live-tutor-qa · **Date**: 2026-06-07 · **Store**: Supabase (Postgres)

Derived from the spec's Key Entities and Functional Requirements. Ownership is enforced by Row-Level Security keyed on the Auth0 subject, mirroring 002 (research R9). This feature adds **two tables** and **reads** the existing `lessons.script` / `source_items`; it changes no existing table.

---

## Entities

### Learner
The Auth0 identity (`sub`), as in 002 — not a table we own. `owner_id` columns hold the `sub` and are the RLS key. Only the owning learner may read/write their exchanges (FR-018, SC-006/007).

### Lesson · SourceItem · LessonScript *(existing — read-only here)*
- `lessons.script` (`LessonScript`: `speakers`, `segments`, `coverage`, `estimatedDurationSeconds`) grounds the live answer and drives **current-item resolution** (R3).
- `source_items` provides the `SourceItem` an exchange is anchored to (the "relevant item"). The live tutor never mutates these.

### QaExchange *(new)*
One interruption-to-resume episode within a lesson (spec: "Q&A Exchange"). Anchored to the lesson and the relevant item; ordered within the lesson.

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `lesson_id` | uuid (fk → lessons) | cascade delete |
| `owner_id` | text | Auth0 `sub`; RLS key (FR-018), denormalized |
| `source_item_id` | uuid (fk → source_items) null | the relevant item active at interruption (R3); null only if no item resolvable (e.g. pre-first-item) |
| `interruption_position_seconds` | numeric(8,3) | exact lesson `<audio>` position to resume from (FR-003/FR-010) |
| `exchange_index` | int | 0-based order of this exchange within the lesson (FR-013) |
| `elevenlabs_conversation_id` | text null | the realtime conversation id, for reproducibility/debug (Constitution III, R9) |
| `created_at` | timestamptz | default now() |

**Validation**
- `interruption_position_seconds` ≥ 0 (and SHOULD be ≤ lesson `audio_duration_seconds` when known).
- `(lesson_id, exchange_index)` unique — stable ordering of exchanges (FR-013).
- `source_item_id`, when present, MUST belong to the same `lesson_id` (enforced in the service / by fk + app check).

### QaTurn *(new)*
A single utterance within an exchange — a learner question or a tutor answer — captured as text, in order (spec: "Exchange Turn"; FR-011).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `exchange_id` | uuid (fk → qa_exchanges) | cascade delete |
| `owner_id` | text | denormalized for RLS |
| `role` | enum `qa_turn_role` | `learner` \| `tutor` |
| `text` | text | transcript of the utterance (learner content — private; logged only at `debug`, Constitution V) |
| `turn_index` | int | 0-based order within the exchange |
| `created_at` | timestamptz | default now() |

**Validation**
- `(exchange_id, turn_index)` unique — stable ordering within an exchange.
- `text` non-empty (empty/unintelligible learner input never becomes a stored learner turn; it triggers clarification instead — FR-014).
- A captured exchange has ≥ 1 turn.

### Interruption Point *(value, not a table)*
`qa_exchanges.interruption_position_seconds` — the precise lesson position captured at interruption and used to resume (FR-003/FR-010). Lives on the exchange.

---

## Relationships

```text
Learner (Auth0 sub)
  └── owns ──> Lesson (existing)
                 ├── has ──> SourceItem[] (existing)
                 └── has ──> QaExchange[]            (new, ordered by exchange_index)
                                 ├── anchored to ──> SourceItem  (relevant item, R3)
                                 └── has ──> QaTurn[]            (new, ordered by turn_index)
```

---

## Current-item resolution (R3) — not stored, computed client-side

Given the lesson `LessonScript` and the `<audio>.currentTime` at interruption:

1. Compute per-segment start offsets by distributing `estimatedDurationSeconds` across `segments` proportional to each segment's `text.length`.
2. Pick the segment whose `[start, nextStart)` window contains `currentTime`.
3. Map that `segment.id` to the `coverage` entry referencing it → `coverage.sourceItemId`.
4. If the position falls in a gap or before the first covered segment, use the **most recently active** covered item (spec assumption); if none yet, `source_item_id = null`.

This resolver is isolated in `apps/web/lib/live-tutor/current-item.ts` so it can later be replaced by precise persisted timings without changing callers.

---

## Migration `0004_qa.sql` (shape)

```sql
CREATE TYPE qa_turn_role AS ENUM ('learner', 'tutor');

CREATE TABLE qa_exchanges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  source_item_id uuid REFERENCES source_items (id) ON DELETE SET NULL,
  interruption_position_seconds numeric(8,3) NOT NULL CHECK (interruption_position_seconds >= 0),
  exchange_index int NOT NULL,
  elevenlabs_conversation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lesson_id, exchange_index)
);
CREATE INDEX qa_exchanges_lesson_idx ON qa_exchanges (lesson_id, exchange_index);

CREATE TABLE qa_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id uuid NOT NULL REFERENCES qa_exchanges (id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  role qa_turn_role NOT NULL,
  text text NOT NULL CHECK (length(btrim(text)) > 0),
  turn_index int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exchange_id, turn_index)
);
CREATE INDEX qa_turns_exchange_idx ON qa_turns (exchange_id, turn_index);

ALTER TABLE qa_exchanges ENABLE ROW LEVEL SECURITY;
ALTER TABLE qa_turns ENABLE ROW LEVEL SECURITY;

-- Owner-only, keyed on Auth0 sub (same pattern as 0003_rls.sql)
CREATE POLICY "qa_exchanges owner select" ON qa_exchanges FOR SELECT
  USING (owner_id = auth.jwt() ->> 'sub');
CREATE POLICY "qa_exchanges owner insert" ON qa_exchanges FOR INSERT
  WITH CHECK (owner_id = auth.jwt() ->> 'sub');
CREATE POLICY "qa_turns owner select" ON qa_turns FOR SELECT
  USING (owner_id = auth.jwt() ->> 'sub');
CREATE POLICY "qa_turns owner insert" ON qa_turns FOR INSERT
  WITH CHECK (owner_id = auth.jwt() ->> 'sub');
```

**Notes**
- No `UPDATE`/`DELETE` policies: exchanges/turns are append-only in v1 (cascade-delete with the lesson is the only removal path).
- `owner_id` is denormalized onto both tables so RLS never needs a join (matches `source_items`/`lesson_audio`).
- No new Storage bucket: live answer audio is ephemeral in v1 (R9); only text persists.
