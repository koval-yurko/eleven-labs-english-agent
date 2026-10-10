/**
 * Notices a reply that was written and never spoken.
 *
 * ## The failure this exists for
 *
 * Report `d2a257ee` (2026-10-02): a lesson that connected, heard the learner, got an answer from
 * Claude — and stayed silent for 115 seconds. The ElevenLabs account was out of credits, and on the
 * streaming socket that is not an error. The request is answered
 *
 *     {"audio":null,"isFinal":true,"contextId":"…"}
 *
 * which the plugin reads as a synthesis that finished cleanly with nothing in it. No `tts_error`,
 * so `AgentSession`'s own unrecoverable-error count never moves; no frames, so no TTS metrics; and
 * no committed tutor message, so the ledger never closed a turn and wrote nothing down either.
 * Every signal the worker listens to was waiting for an event the far end never sent.
 *
 * So the question is asked directly, at the one place both halves are visible: text went IN to the
 * TTS node, did audio come OUT. See docs/2026-10-02-livekit-silent-tts-on-spent-quota.md.
 *
 * ## Only a synthesis that ran to its end is judged
 *
 * A barge-in cancels the stream, and a cancelled stream with no frames yet is the learner
 * interrupting quickly, not a voice that failed. The outcome is reported after the audio loop
 * finishes on its own and from nowhere else — a cancel or a throw leaves the generator at its
 * `yield` and never reaches the report. A throw is the framework's to report, as a `tts_error`.
 *
 * Pure: plain async iterables in and out, so `check.ts` runs it without a room or a vendor.
 */
export interface SpeechOutcome {
  /** Letters and digits sent to the voice. Punctuation alone is legitimately silent. */
  speakableChars: number;
  frames: number;
}

/** There was something to say and nothing was said. */
export function isSilent(outcome: SpeechOutcome): boolean {
  return outcome.speakableChars > 0 && outcome.frames === 0;
}

export function tapSpeech(onDone: (outcome: SpeechOutcome) => void): {
  text(input: AsyncIterable<string>): AsyncIterable<string>;
  audio<F>(output: AsyncIterable<F>): AsyncIterable<F>;
} {
  let speakableChars = 0;
  let frames = 0;
  return {
    async *text(input) {
      for await (const chunk of input) {
        speakableChars += chunk.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
        yield chunk;
      }
    },
    async *audio(output) {
      for await (const frame of output) {
        frames += 1;
        yield frame;
      }
      onDone({ speakableChars, frames });
    },
  };
}
