# Contract: `mapWithConcurrency` + render scheduling

**Feature**: 004-tts-parallel-render | **Date**: 2026-06-07

The generator package (`@idiomatic/generator`) is a workspace library consumed by `apps/web`. Its
public surface is the `exports` from `packages/generator/src/index.ts`. This feature adds **one** new
public export and changes the **internal** scheduling of `renderDialogue` without changing its
signature or output shape. Those are the two boundaries documented here.

---

## 1. Public utility: `mapWithConcurrency<T, R>`

### Signature

```ts
export function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]>;
```

### Guarantees (the contract callers may rely on)

1. **Order**: the resolved array is index-aligned to `items` — `out[i]` is the result of
   `mapper(items[i], i)` — independent of the order in which mappers settle.
2. **Bound**: at no point are more than `max(1, limit)` mapper calls in flight simultaneously.
3. **Fail-fast**: the returned promise rejects with the **first** error any mapper throws/rejects;
   once a rejection is observed, no further `mapper` calls are started. (Already-started calls are not
   cancelled — the runtime has no cancellation token for an in-flight ElevenLabs request.)
4. **Empty**: `items.length === 0` resolves to `[]` and never calls `mapper`.
5. **Purity**: the utility logs nothing and has no domain coupling; it is safe to reuse for any
   bounded async map (e.g. future item classification, S4 bulk regeneration).

### Test obligations (Vitest unit — `tests/unit/concurrency.test.ts`)

| Case | Assertion |
|------|-----------|
| Order under shuffled timing | mappers that resolve out of order still yield input-ordered results (C1). |
| Cap never exceeded | instrument a live counter inside the mapper; observed max concurrency `=== min(limit, items.length)` (C2). |
| First rejection propagates | one mapper rejects → call rejects with that error; later items' mappers are not all invoked (C3). |
| Empty list | `[]` in → `[]` out, mapper never called (C4). |
| Degenerate limit | `limit = 0` / negative runs sequentially (clamped to 1), still correct & ordered (C5). |
| Single item | one item, any limit → one call, `[result]` (sanity). |

---

## 2. Behavioral contract: `ElevenLabsTtsAdapter.renderDialogue`

### Signature (unchanged)

```ts
renderDialogue(
  script: LessonScript,
  ttsCharLimit: number,
  logger?: Logger,
): Promise<RenderedAudio>;
```

The new bound is supplied at construction via `ElevenLabsOptions.batchConcurrency` (not a new
argument). `RenderedAudio` is unchanged: `{ bytes: Uint8Array; mimeType: "audio/mpeg"; durationSeconds: number }`.

### Guarantees

1. **Output equivalence**: for any given `script` + `ttsCharLimit`, the returned `bytes`,
   `mimeType`, and `durationSeconds` are equivalent to the prior sequential renderer (FR-006).
2. **Bounded parallelism**: batches render with at most `batchConcurrency` syntheses in flight (FR-002).
3. **Order**: stitched audio concatenates batches in `batchUnderLimit` order regardless of completion
   order (FR-005).
4. **Fail-fast**: any batch synthesis failure rejects `renderDialogue` with no partial result (FR-007).
5. **Observability**: exactly one `render.batch` event per batch is emitted via the injected logger,
   carrying `batchIndex`, `batchCount`, `chars`, `durationMs`; ordering of entries is not guaranteed
   (FR-010).

### Test obligations (Vitest integration — `tests/integration/render-parallel.test.ts`)

Uses a fake/stubbed `textToDialogue.convert` (no live key), returning deterministic per-batch bytes.

| Case | Assertion |
|------|-----------|
| Multi-batch stitch equals sequential | render a script forced into N>1 batches; resulting `bytes` equal a sequential concatenation of the same per-batch outputs in index order (Guarantee 1/3). |
| Bound honored | a convert stub tracking in-flight count never observes more than `batchConcurrency` concurrent calls (Guarantee 2). |
| Per-batch events | a capturing logger records exactly `batchCount` `render.batch` events, one per `batchIndex 0..N-1` (Guarantee 5). |
| Batch failure | one batch's convert rejects → `renderDialogue` rejects; no `RenderedAudio` returned (Guarantee 4). |
| Single batch unchanged | a one-batch script renders identically and emits one `render.batch` (FR-012). |

---

## 3. Configuration contract

| Env var | Type | Default | Invalid input behavior |
|---------|------|---------|------------------------|
| `TTS_BATCH_CONCURRENCY` | integer `>= 1` | `3` | absent / blank / non-integer / `< 1` → default `3` (no throw) |

`loadGeneratorConfig` exposes the sanitized value as `GeneratorConfig.ttsBatchConcurrency`. Documented
in `.env.example` with the per-plan guidance (Free tier must set `2`).
