# Data Model: Parallelize Batch TTS Rendering

**Feature**: 004-tts-parallel-render | **Date**: 2026-06-07

This feature changes **process scheduling**, not persisted data. There is no Postgres/Storage schema
change and no new persisted entity. The "entities" below are in-process/config shapes and the
behavioral invariants of the render path.

---

## Config: `GeneratorConfig.ttsBatchConcurrency`

A new field on the existing `GeneratorConfig` (`packages/generator/src/config.ts`).

| Attribute | Value |
|-----------|-------|
| Field | `ttsBatchConcurrency: number` |
| Env var | `TTS_BATCH_CONCURRENCY` |
| Default | `3` |
| Validation | Integer `>= 1`. Absent / blank / non-integer / `< 1` / `NaN` → falls back to default `3` (sanitize, do **not** throw). |
| Meaning | Max number of ElevenLabs Text-to-Dialogue batch syntheses in flight at once for one lesson render. |
| Tuning | Set at/under the active ElevenLabs plan concurrency limit (Free 2 · Starter 3 · Creator 5 · Pro 10 · Scale/Business 15). `1` = fully sequential (rollback). |

Flows: `loadGeneratorConfig(env)` → `GeneratorConfig.ttsBatchConcurrency` →
`ElevenLabsOptions.batchConcurrency` (built in `apps/web/lib/generation/deps.ts`) → consumed inside
`ElevenLabsTtsAdapter.renderDialogue`.

---

## Config: `ElevenLabsOptions.batchConcurrency`

A new field on the existing `ElevenLabsOptions` (`packages/generator/src/adapters/elevenlabs.ts`),
carrying the sanitized bound to the adapter alongside `modelId` / `bitrate` / voice ids.

| Attribute | Value |
|-----------|-------|
| Field | `batchConcurrency: number` |
| Source | `GeneratorConfig.ttsBatchConcurrency` (already sanitized) |
| Consumed by | `renderDialogue` — passed as the `limit` to `mapWithConcurrency` |

---

## Utility: `mapWithConcurrency<T, R>`

New first-party primitive (`packages/generator/src/utils/concurrency.ts`), exported from the package
public API (`packages/generator/src/index.ts`).

**Signature**:

```ts
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]>
```

**Invariants**:

| ID | Invariant |
|----|-----------|
| C1 | Results are returned in **input order**: `result[i]` is `await mapper(items[i], i)`, regardless of completion order. |
| C2 | At no instant are more than `max(1, limit)` mapper invocations in flight. |
| C3 | The **first** mapper rejection causes the returned promise to reject with that error; no new mapper invocations start after a rejection is observed. |
| C4 | Empty `items` → resolves to `[]` without invoking `mapper`. |
| C5 | `limit` is clamped to `>= 1` internally (a caller passing `0`/negative still runs, sequentially). |
| C6 | The utility itself performs no logging and has no ElevenLabs/TTS coupling (reusable for any async map). |

**State (transient, per call)**:
- `nextIndex` — shared cursor; each idle worker claims `nextIndex++` until `>= items.length`.
- `results[]` — pre-sized output array written positionally.
- `failed` — once set by the first rejection, workers stop claiming new items.

---

## Behavioral contract: `renderDialogue` (changed internals, same output)

The render path's observable output and invariants. Only the *scheduling* of the batch loop changes.

| ID | Invariant | Maps to |
|----|-----------|---------|
| RD1 | Batches are produced by the unchanged `batchUnderLimit(inputs, ttsCharLimit)`; batch **count and contents are identical** to today. | Assumptions (batch splitting unchanged) |
| RD2 | Batches render via `mapWithConcurrency(batches, renderOne, batchConcurrency)`; up to `batchConcurrency` in flight. | FR-001, FR-002 |
| RD3 | Stitched bytes = `concatBytes(results)` in **batch index order** → byte-equivalent to the prior sequential render for the same script. | FR-005, FR-006, SC-003 |
| RD4 | `durationSeconds` is computed from total byte length and bitrate, unchanged. | FR-006 |
| RD5 | Any batch synthesis rejection propagates out of `renderDialogue` (fail-fast); no partial `RenderedAudio` is returned/persisted. | FR-007 |
| RD6 | A `render.batch` log event is emitted for **every** batch (interleaving allowed), carrying `batchIndex`, `batchCount`, `chars`, `durationMs`. | FR-010 |
| RD7 | A single-batch script behaves identically to today (one in-flight task; no added latency). | FR-012, SC-004 |

`RenderedAudio` output shape is unchanged: `{ bytes: Uint8Array, mimeType: "audio/mpeg", durationSeconds: number }`.

---

## UI state (no new data)

The in-progress lesson view (`apps/web/app/lessons/[id]/page.tsx`) already derives a boolean from the
existing `lesson.status ∈ {pending, generating}` to show the in-progress banner. This feature only
extends the **copy** inside that existing conditional; no new field, prop, or client state.
