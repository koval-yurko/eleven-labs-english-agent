/**
 * A counting gate whose waiters can leave, shared by the TTS adapters that must not flood their
 * server: `qwen-tts.ts` (Model Studio's account-wide rate limit) and `voicebox-tts.ts` (a local
 * server that synthesizes one request at a time).
 *
 * A reply the learner talked over is aborted while it is still queued; it must give its place up at
 * once, or every live reply waits behind work nobody will hear (lesson d688e87d: requests sat ~19 s
 * in line behind stale ones).
 */
export class Gate {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.#free = limit;
  }
  /** Resolves true when the caller holds a slot (and must `release`), false if it was aborted first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const i = this.#waiting.indexOf(grant);
        if (i >= 0) this.#waiting.splice(i, 1);
        resolve(false);
      };
      this.#waiting.push(grant);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}
