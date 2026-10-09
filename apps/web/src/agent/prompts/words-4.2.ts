/**
 * words-4.2 — `words-4.1` on Qwen-Audio 3.0 TTS **Flash** instead of Plus.
 *
 * Same lesson, same STT, same LLM, same turn plan, same Qwen adapter: a difference between 4.1 and
 * 4.2 is the model and nothing else, so first-audio latency (`firstAudio` in the worker's
 * `[qwen stream …]` lines, `ttsTtfbMs` in the ledger) and the sound of the voice can be compared by
 * running the same lesson on both. The profile (`qwen-flash`) is in
 * `apps/voice-worker/src/tts-profiles.ts`; research: docs/2026-10-09-qwen-tts-latency-and-rate-limits.md.
 * Withheld from the learner picker by the same `CLIENT_READY` rule as 4.0.
 */
import words41 from "./words-4.1";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words41,
  version: "words-4.2",
  label: "4.2 · LiveKit — podcast lesson, Qwen Flash TTS (spike)",
  tts: "qwen-flash",
};

export default version;
