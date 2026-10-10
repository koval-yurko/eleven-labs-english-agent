/**
 * Keeps TTS synthesis a few seconds ahead of playback instead of as far ahead as the text allows.
 *
 * LiveKit's sentence adapter calls `synthesize()` for every sentence the instant it appears, and
 * only holds back the *forwarding* of audio. A 3,000-token answer therefore became ~30 requests at
 * once (lesson d688e87d, 2026-10-08): the reply after it waited ~19 s in line, the rate limit was a
 * constant danger, and everything synthesized past the point where the learner interrupted was
 * billed and thrown away.
 *
 * The pacer models playback without hearing it: audio plays at 1x, so `queuedUntil` is the wall-clock
 * moment at which everything admitted so far would finish playing. A chunk is admitted when that
 * moment is no more than `lookaheadMs` away — far enough ahead that the next chunk's ~3 s of request
 * latency never opens a gap, near enough that an interruption wastes a few chunks, not a monologue.
 * Waiters are served in order, and one that is aborted leaves the line at once.
 *
 * Pure but for the clock: `check.ts` runs it with real, millisecond-scale timers.
 */
export class Pacer {
  readonly #lookaheadMs: number;
  #queuedUntil = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(lookaheadMs: number) {
    this.#lookaheadMs = lookaheadMs;
  }

  /** Milliseconds of admitted audio not yet played, as far as this model can tell. */
  get aheadMs(): number {
    return Math.max(0, this.#queuedUntil - Date.now());
  }

  /**
   * Resolves with how long the caller waited, or -1 if it was aborted first (it then owes nothing).
   * On admission the chunk's `estimatedSecs` of audio is counted as queued; `settle` corrects it.
   */
  admit(signal: AbortSignal, estimatedSecs: number): Promise<number> {
    const turn = this.#tail.then(async () => {
      const start = Date.now();
      while (!signal.aborted) {
        const excess = this.aheadMs - this.#lookaheadMs;
        if (excess <= 0) {
          this.#queuedUntil = Math.max(this.#queuedUntil, Date.now()) + estimatedSecs * 1000;
          return Date.now() - start;
        }
        await sleep(Math.min(excess, 500), signal);
      }
      return -1;
    });
    this.#tail = turn.catch(() => undefined);
    return turn;
  }

  /** Swaps a chunk's estimate for what it really produced (0 if it failed or was cut short). */
  settle(estimatedSecs: number, actualSecs: number): void {
    this.#queuedUntil = Math.max(Date.now(), this.#queuedUntil + (actualSecs - estimatedSecs) * 1000);
  }

  /** The reply was cut: whatever was queued will never be heard, so the next reply starts clean. */
  reset(): void {
    this.#queuedUntil = Date.now();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
