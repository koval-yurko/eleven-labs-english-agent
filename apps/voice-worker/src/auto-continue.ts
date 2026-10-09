/**
 * Carries a chunked lesson from one chunk to the next.
 *
 * ## What it decides
 *
 * A chunked lesson (`apps/web/src/agent/prompts/podcast-lesson-chunked.ts`) ends every turn after
 * ~45 s and relies on this controller to ask for the next one — the job ElevenLabs' turn timer does
 * on that provider and nothing did on LiveKit. After a chunk **ends naturally** and the learner says
 * nothing, `fire()` is called once, after a short beat. Everything else is a reason NOT to:
 *
 *  - the chunk was **cut** (the learner spoke over it, the phone cancelled the turn): the learner has
 *    the floor, the next thing is theirs;
 *  - the lesson is **held** (the phone's pause): a pause the tutor continued through would advance the
 *    lesson behind a muted phone; on release the controller carries on by itself;
 *  - the tutor said the lesson is **complete** (`lesson_complete`): carrying on would loop forever;
 *  - **too many in a row** without the learner saying anything (`maxRun`): a backstop against a model
 *    that never finishes, not an expected path — a full lesson is ~20 chunks;
 *  - `canFire()` says the session is busy at the moment the timer lands (a reply is already being
 *    generated, the learner has just started to speak).
 *
 * Pure but for timers and the callbacks it is handed, so `check.ts` drives it with millisecond delays.
 */
export interface AutoContinueOptions {
  /** The beat between the end of a chunk and asking for the next. */
  delayMs: number;
  /** After a pause is released: long enough for the phone's own resume message to win the race. */
  resumeDelayMs: number;
  /** Consecutive automatic continues before it stops and waits for the learner. */
  maxRun: number;
  /** Ask the tutor for the next chunk. */
  fire: () => void;
  /** Is the session idle right now? Checked when the timer lands, not when it is set. */
  canFire: () => boolean;
  log?: (message: string) => void;
}

export class AutoContinue {
  readonly #o: AutoContinueOptions;
  #timer: NodeJS.Timeout | null = null;
  #held = false;
  #complete = false;
  #disposed = false;
  #run = 0;

  constructor(options: AutoContinueOptions) {
    this.#o = options;
  }

  /** Consecutive automatic continues since the learner last spoke. */
  get run(): number {
    return this.#run;
  }

  get completed(): boolean {
    return this.#complete;
  }

  /** The tutor began a reply (any reply): whatever was about to be asked for is moot. */
  speechStarted(): void {
    this.#clear();
  }

  /** A reply finished. Only one that played to its end leads to another. */
  speechEnded(naturally: boolean): void {
    if (naturally) this.#schedule(this.#o.delayMs);
  }

  /** The learner is speaking: they have the floor, and the run of automatic chunks is over. */
  learnerSpoke(): void {
    this.#clear();
    this.#run = 0;
  }

  /** The phone cancelled the turn: nothing is to be asked for on its behalf. */
  cancelled(): void {
    this.#clear();
  }

  hold(): void {
    this.#held = true;
    this.#clear();
    this.#o.log?.("held: not continuing while the learner is paused");
  }

  release(): void {
    if (!this.#held) return;
    this.#held = false;
    this.#o.log?.("released: continuing");
    this.#schedule(this.#o.resumeDelayMs);
  }

  /** The tutor finished the lesson. */
  complete(): void {
    this.#complete = true;
    this.#clear();
    this.#o.log?.("the tutor called lesson_complete: no further chunks");
  }

  dispose(): void {
    this.#disposed = true;
    this.#clear();
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(delayMs: number): void {
    this.#clear();
    if (this.#held || this.#complete || this.#disposed) return;
    if (this.#run >= this.#o.maxRun) {
      this.#o.log?.(`stopped after ${this.#run} chunks in a row with no word from the learner`);
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#held || this.#complete || this.#disposed) return;
      if (!this.#o.canFire()) {
        this.#o.log?.("not continuing: the session is busy");
        return;
      }
      this.#run += 1;
      this.#o.fire();
    }, delayMs);
    this.#timer.unref();
  }
}
