# Quickstart: Parallelize Batch TTS Rendering

**Feature**: 004-tts-parallel-render | **Date**: 2026-06-07

How to configure, verify, and roll back the bounded-parallel TTS render. Assumes the S1
lesson-generation feature is already running.

---

## Configure the concurrency bound

Set `TTS_BATCH_CONCURRENCY` in your environment (or `.env`). Choose a value **at or under** your
ElevenLabs plan's concurrency limit:

| Plan | Concurrency limit | Suggested `TTS_BATCH_CONCURRENCY` |
|------|-------------------|-----------------------------------|
| Free | 2 | `2` (default 3 would 429 — **must lower**) |
| Starter | 3 | `3` (default) |
| Creator | 5 | `4`–`5` |
| Pro | 10 | up to `10` |
| Scale / Business | 15 | up to `15` |

```bash
# .env
TTS_BATCH_CONCURRENCY=3   # default; safe for Starter and above
```

- **Unset / invalid** (blank, non-integer, `< 1`) → falls back to the default `3` (no crash).
- **`TTS_BATCH_CONCURRENCY=1`** → fully sequential, identical to pre-feature behavior (rollback switch).
- Leave headroom below the hard limit if the live-tutor or health-check paths may run concurrently.

---

## Verify the speedup

Generate a lesson whose script splits into **more than one** batch (a real 5–10 item list; batches are
formed under `TTS_CHAR_LIMIT`, default 3000 chars).

1. Submit the list at `/lessons/new`.
2. Watch the in-progress banner on the lesson detail page — it now notes that generation can take a
   few minutes.
3. Inspect the structured logs for the run (filter by lesson id). You should see `render.batch` events
   for every batch with overlapping timestamps (they no longer run strictly back-to-back):

   ```bash
   # NDJSON logs → batches for one lesson, by start time
   grep '"event":"render.batch"' logs.ndjson | grep '<lessonId>' | jq '{batchIndex, durationMs}'
   ```

4. Compare wall-clock to a sequential baseline by setting `TTS_BATCH_CONCURRENCY=1` and regenerating
   the same list. The default-3 run of an N-batch lesson should complete materially faster
   (target ≥40% reduction for a typical 5–10 item lesson, SC-001).

---

## Verify correctness (order + equivalence)

- **Order**: play the generated lesson — segments must be in script order; the parallel render must
  sound identical to a sequential one (FR-005/FR-006).
- **Automated**: the integration test `tests/integration/render-parallel.test.ts` asserts the stitched
  bytes equal the sequential concatenation and that the in-flight cap is never exceeded. The unit test
  `tests/unit/concurrency.test.ts` covers the `mapWithConcurrency` invariants.

```bash
pnpm --filter @idiomatic/generator test    # unit + integration for this feature
pnpm typecheck && pnpm lint
```

---

## Reuse the primitive elsewhere

`mapWithConcurrency` is exported from `@idiomatic/generator`:

```ts
import { mapWithConcurrency } from "@idiomatic/generator";

const results = await mapWithConcurrency(items, async (item, i) => doWork(item), limit);
// results are input-ordered; at most `limit` run at once; the first rejection propagates.
```

Useful for future bounded fan-out (e.g. LLM-based item classification, S4 bulk regeneration).

---

## Rollback

Set `TTS_BATCH_CONCURRENCY=1` to restore strictly sequential rendering without a code change. No data
migration is involved — this feature changes only in-process scheduling.
