# Phase 1 Data Model: Lesson Generation

**Feature**: 002-lesson-generation · **Date**: 2026-06-06 · **Store**: Supabase (Postgres + Storage)

Derived from the spec's Key Entities and Functional Requirements. Ownership is enforced by Row-Level Security keyed on the Auth0 subject (research R7).

---

## Entities

### Learner
Represented by the Auth0 identity; **not a table we own** — `owner_id` columns hold the Auth0 subject (`sub`). Each Learner owns 0..N Lessons; no Learner may access another's data (FR-019, SC-005).

### Lesson
One generated lesson owned by exactly one Learner (FR-018, FR-019). Carries generation status, the structured script, and reproducibility metadata (Constitution III).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `owner_id` | text | Auth0 `sub`; RLS key (FR-019) |
| `status` | enum `lesson_status` | `pending` → `generating` → `ready` \| `failed` (R6) |
| `requested_item_count` | int | raw entries submitted |
| `accepted_item_count` | int | teachable items (≤ 20, R1) |
| `skipped_item_count` | int | unteachable/duplicate entries (FR-006) |
| `target_duration_seconds` | int | bounded ~300–600 (FR-012) |
| `audio_duration_seconds` | int null | measured after render (SC-003) |
| `script` | jsonb null | LessonScript (contracts/lesson-script.schema.json); set when `ready` |
| `error_reason` | text null | set when `failed` (FR-016) |
| `model_id` | text null | generation model + version (Constitution III) |
| `prompt_version` | text null | versioned prompt set used |
| `generation_input` | jsonb | raw submitted list, for reproducibility |
| `created_at` | timestamptz | library ordering / disambiguation (FR-020) |
| `updated_at` | timestamptz | status transitions |

**Validation**
- `accepted_item_count` ≤ 20 (R1); a row is only created when ≥ 1 teachable item exists (FR-004/FR-007 reject before insert).
- `script` non-null ⟺ `status = ready`; `error_reason` non-null ⟺ `status = failed`.
- Every accepted item must appear in `script` coverage map (FR-009) — enforced by generator validation (R2) before status flips to `ready`.

### SourceItem
A single submitted unit and its teachability outcome (FR-001–FR-003, FR-006).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `lesson_id` | uuid (fk → lessons) | cascade delete |
| `owner_id` | text | denormalized for RLS |
| `raw_text` | text | as submitted |
| `normalized_text` | text | trimmed/normalized; dedupe key within lesson (FR-003) |
| `item_type` | enum `item_type` | `word` \| `sentence` \| `idiom` |
| `teachable` | boolean | (FR-002) |
| `skip_reason` | enum `skip_reason` null | `non_english` \| `gibberish` \| `not_discrete` \| `duplicate` (R9) |
| `order_index` | int | submission order |
| `covered` | boolean | set true when referenced by script coverage map (FR-009) |

**Validation**
- `teachable = false` ⟺ `skip_reason` is non-null.
- `(lesson_id, normalized_text)` unique among `teachable = true` rows (dedupe, FR-003).
- For `teachable = true` rows in a `ready` lesson, `covered = true` (SC-002).

### LessonAudio
The rendered, persisted, replayable audio artifact (FR-018, FR-014).

| Field | Type | Notes |
|---|---|---|
| `id` | uuid (pk) | |
| `lesson_id` | uuid (fk → lessons) | one current asset per lesson |
| `owner_id` | text | denormalized for RLS |
| `storage_path` | text | Supabase Storage object path (private bucket) |
| `mime_type` | text | e.g. `audio/mpeg` |
| `duration_seconds` | int | measured (SC-003) |
| `created_at` | timestamptz | |

**Validation**
- Exists only for `ready` lessons. Audio bytes live in a **private** Storage bucket; access is via short-lived signed URL minted server-side for the owner only (FR-019, Constitution V).

---

## Relationships

```text
Learner (Auth0 sub)
   1 │ owns
     ▼
  Lesson ──1:N── SourceItem
     │
     └──1:1── LessonAudio   (present only when status = ready)
```

The **structured LessonScript** (stored as `lessons.script` jsonb, schema in `contracts/`) is the boundary artifact between the Lesson Generator subsystem and the Player/web app — they share it, not internal state (Constitution: subsystem independence).

---

## Lesson status state machine (R6)

```text
            submit (≥1 teachable item)
   (none) ───────────────────────────► pending
                                          │ generation run starts
                                          ▼
                                      generating
                                     ┌────┴────┐
                          success    │         │   error
                                     ▼         ▼
                                   ready      failed
                                                │ retry (FR-016)
                                                ▼
                                            generating
```

- Empty / no-teachable / oversized submissions never create a `pending` row — they are rejected at the API with messaging (FR-004, FR-005, FR-007).
- `ready` is terminal for success; `failed` is recoverable via retry.

---

## Row-Level Security (privacy — FR-019, SC-005)

Every owned table (`lessons`, `source_items`, `lesson_audio`) has RLS enabled with policies of the form:

```sql
-- read/list/playback: owner only
USING (owner_id = auth.jwt() ->> 'sub')
-- insert: owner stamps their own id
WITH CHECK (owner_id = auth.jwt() ->> 'sub')
```

The Supabase Storage bucket for audio is **private**; objects are namespaced by `owner_id/lesson_id` and served only through server-minted signed URLs. The service-role key is server-only and never shipped to the browser (Constitution V).

---

## Indexing notes

- `lessons (owner_id, created_at desc)` — library listing (FR-020).
- `source_items (lesson_id, order_index)` — ordered item display & skip report.
- `lesson_audio (lesson_id)` — playback lookup.
