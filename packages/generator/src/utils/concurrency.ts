/**
 * Bounded-concurrency async map (004-tts-parallel-render, contracts/concurrency.md §1).
 *
 * Runs `mapper` over `items` with at most `limit` invocations in flight at once, returning
 * results in **input order** regardless of completion order. The first rejection propagates
 * and no further work is started (already-started mappers are left to settle; there is no
 * cancellation token). A first-party primitive on purpose — Constitution IV (build the glue),
 * reusable beyond TTS (e.g. parallel item classification, S4 bulk regeneration).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  // Clamp: invalid / non-positive / NaN limits fall back to 1; never exceed the item count.
  const floored = Math.floor(limit);
  const safeLimit = Number.isFinite(floored) && floored >= 1 ? floored : 1;
  const workers = Math.min(safeLimit, items.length);

  let next = 0;
  let failed = false;
  let failureError: unknown;

  const run = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failureError = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => run()));
  if (failed) throw failureError;
  return results;
}
