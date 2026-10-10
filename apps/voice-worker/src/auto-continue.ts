/**
 * Carries a chunked lesson from one chunk to the next.
 *
 * ## What it decides
 *
 * A chunked lesson (`apps/web/src/agent/prompts/podcast-lesson-chunked.ts`) ends every turn after
 * ~45 s and relies on this controller to ask for the next one — the job ElevenLabs' turn timer does
 * on that provider and nothing did on LiveKit. Everything it does is one of two moves:
 *
 *  - **prefetch**: the moment a turn's text has been written (long before it has been spoken), queue
 *    the next chunk behind it. LiveKit starts the model for a queued reply at once and plays it when
 *    the one before it ends, so the seam between chunks is no longer a model round trip — the
 *    first real lesson (2026-10-10) had one of 11 s when Claude took 10 s to start;
 *  - **fallback**: if nothing was queued ahead, ask for the next chunk a short beat after one ends.
 *
 * Both are cancelled, or never made, in every case where the learner has the floor or the lesson is
 * not the tutor's to continue:
 *
 *  - the learner is **speaking**, a reply of someone else's begins (the phone's resume message, an
 *    answer to the learner), the phone **cancels** the turn: queued work is interrupted;
 *  - the chunk was **cut**: its end does not lead to another;
 *  - the lesson is **held** (the phone's pause): a pause the tutor continued through would advance the
 *    lesson behind a muted phone; on release the controller carries on by itself;
 *  - the tutor said the lesson is **complete** (`lesson_complete`): carrying on would loop forever;
 *  - **too many in a row** without the learner saying anything (`maxRun`): a backstop against a model
 *    that never finishes, not an expected path — a full lesson is ~20 chunks;
 *  - the turn that just ended in a **tool call** (including `lesson_complete`): its follow-up text is
 *    not written yet, so a prefetched chunk would be generated without it.
 *
 * Pure but for timers and the callbacks it is handed, so `check.ts` drives it with millisecond delays.
 */

/** What `fire` returns for a reply it queued: enough to cancel it later. A LiveKit `SpeechHandle`. */
export interface QueuedReply {
  interrupt(): unknown;
}

export interface AutoContinueOptions {
  /** The fallback beat between the end of a chunk and asking for the next. */
  delayMs: number;
  /** After a pause is released: long enough for the phone's own resume message to win the race. */
  resumeDelayMs: number;
  /** Consecutive automatic continues before it stops and waits for the learner. */
  maxRun: number;
  /**
   * Ask the tutor for the next chunk. `previous` is the text of the turn just written when this is a
   * prefetch (that turn is still being spoken, so the conversation does not contain it yet) and
   * undefined for the fallback.
   */
  fire: (previous: string | undefined) => QueuedReply | void;
  /** Is the session idle right now? Checked when the fallback timer lands. */
  canFire: () => boolean;
  /** May a chunk be queued behind what is playing? (the learner is not speaking). Default: always. */
  canPrefetch?: () => boolean;
  /** Queue the next chunk while the current one is still playing. Default true. */
  prefetch?: boolean;
  log?: (message: string) => void;
}

export class AutoContinue {
  readonly #o: AutoContinueOptions;
  #timer: NodeJS.Timeout | null = null;
  /** Replies we queued that have not finished, oldest first. */
  #queued = new Set<QueuedReply>();
  /** The queued reply believed to be playing now (it is no longer "ahead" of anything). */
  #current: QueuedReply | null = null;
  /** The newest finished turn that was not yet used to queue a chunk after it. */
  #latest: string | null = null;
  #creating = false;
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

  /** True while `fire` is running: the reply it creates announces itself before `fire` returns. */
  get creating(): boolean {
    return this.#creating;
  }

  /** Replies this controller has queued and that have not finished. */
  get queuedCount(): number {
    return this.#queued.size;
  }

  /**
   * A turn's text is complete (its audio may be far from finished). Queue the next chunk behind it,
   * unless something says not to. `toolCalls` is how many tool calls the turn ended in.
   */
  turnWritten(text: string, toolCalls: number): void {
    if (this.#o.prefetch === false) return;
    if (this.#blocked() || toolCalls > 0) {
      this.#latest = null;
      return;
    }
    this.#latest = text;
    this.#tryPrefetch();
  }

  /** Someone else's reply began (the phone's resume, an answer to the learner): ours are moot. */
  speechStarted(): void {
    this.#clearTimer();
    this.#cancelQueued("another reply began");
  }

  /**
   * A reply finished — ours or anyone's. Whatever we had queued next is what plays now; and only a
   * reply that played to its end leads to another, if nothing is queued after it.
   */
  speechEnded(naturally: boolean, reply?: QueuedReply): void {
    if (reply) {
      this.#queued.delete(reply);
      if (this.#current === reply) this.#current = null;
    }
    this.#current ??= this.#queued.values().next().value ?? null;
    if (naturally && this.#queued.size === 0) this.#schedule(this.#o.delayMs);
    else this.#tryPrefetch();
  }

  /** The learner is speaking: they have the floor, and the run of automatic chunks is over. */
  learnerSpoke(): void {
    this.#clearTimer();
    this.#cancelQueued("the learner spoke");
    this.#run = 0;
  }

  /** The phone cancelled the turn: nothing is to be asked for on its behalf. */
  cancelled(): void {
    this.#clearTimer();
    this.#cancelQueued("the phone cancelled the turn");
  }

  hold(): void {
    this.#held = true;
    this.#clearTimer();
    this.#cancelQueued("held");
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
    this.#clearTimer();
    this.#cancelQueued("the lesson is complete", true);
    this.#o.log?.("the tutor called lesson_complete: no further chunks");
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#cancelQueued("disposed");
  }

  /** Queued replies that are waiting behind something that is playing. */
  get #ahead(): number {
    return this.#queued.size - (this.#current && this.#queued.has(this.#current) ? 1 : 0);
  }

  #tryPrefetch(): void {
    if (this.#latest === null || this.#blocked() || this.#ahead > 0) return;
    if (this.#o.canPrefetch && !this.#o.canPrefetch()) return;
    if (this.#run >= this.#o.maxRun) {
      this.#o.log?.(`stopped after ${this.#run} chunks in a row with no word from the learner`);
      return;
    }
    const previous = this.#latest;
    this.#latest = null;
    this.#clearTimer();
    this.#launch(previous);
  }

  #blocked(): boolean {
    return this.#held || this.#complete || this.#disposed;
  }

  #clearTimer(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  /**
   * Interrupt what we queued. `keepPlaying` spares the reply that is speaking right now: the tutor
   * calling `lesson_complete` is inside that very reply, delivering its goodbye, and cutting it
   * would drop the goodbye (found in a text-mode run: the lesson never reported finished).
   */
  #cancelQueued(why: string, keepPlaying = false): void {
    this.#latest = null;
    let n = 0;
    for (const reply of [...this.#queued]) {
      if (keepPlaying && reply === this.#current) continue;
      try {
        void reply.interrupt();
      } catch {
        // already finished or gone
      }
      this.#queued.delete(reply);
      n += 1;
    }
    if (!keepPlaying) this.#current = null;
    if (n > 0) this.#o.log?.(`dropped ${n} queued chunk${n === 1 ? "" : "s"}: ${why}`);
  }

  #launch(previous: string | undefined): void {
    this.#run += 1;
    this.#creating = true;
    try {
      const reply = this.#o.fire(previous);
      if (reply) this.#queued.add(reply);
    } finally {
      this.#creating = false;
    }
  }

  #schedule(delayMs: number): void {
    this.#clearTimer();
    if (this.#blocked()) return;
    if (this.#run >= this.#o.maxRun) {
      this.#o.log?.(`stopped after ${this.#run} chunks in a row with no word from the learner`);
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#blocked() || this.#queued.size > 0) return;
      if (!this.#o.canFire()) {
        this.#o.log?.("not continuing: the session is busy");
        return;
      }
      this.#launch(undefined);
    }, delayMs);
    this.#timer.unref();
  }
}
