/**
 * words-4.3 — `words-4.1` (Qwen-Audio 3.0 Plus) with the lesson delivered in chunks.
 *
 * Same STT, same LLM, same TTS, same turn plan as 4.1; what differs is the pacing. The prompt asks
 * for ~45-second chunks of one thread each (`./podcast-lesson-chunked.ts`) and `autoContinue` has the
 * worker ask for the next chunk when one ends and the learner is silent, until the tutor calls
 * `lesson_complete`. The point: the opening used to be 4–5 minutes the learner cut off after ~15 s,
 * so almost everything generated was wasted and the first reply felt long. Compare 4.1 against 4.3
 * on the same lesson: seconds to the first audio, how often the opening is interrupted, and the
 * `out=` tokens per interrupted reply in the worker's `[ledger]` lines.
 *
 * Research: docs/2026-10-10-chunked-podcast-turns.md. Withheld from the learner picker by the same
 * `CLIENT_READY` rule as 4.0.
 */
import { PODCAST_LESSON_CHUNKED_PROMPT } from "./podcast-lesson-chunked";
import words41 from "./words-4.1";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words41,
  version: "words-4.3",
  label: "4.3 · LiveKit — podcast lesson in chunks, Qwen TTS (spike)",
  prompt: PODCAST_LESSON_CHUNKED_PROMPT,
  autoContinue: true,
};

export default version;
