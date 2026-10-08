/**
 * words-4.1 — `words-4.0` with the worker's TTS swapped for Alibaba Qwen-Audio TTS.
 *
 * Same lesson, same STT (Deepgram Flux), same LLM, same turn plan: a difference between 4.0 and
 * 4.1 is the voice stage and nothing else. The profile (`qwen`) is defined in
 * `apps/voice-worker/src/tts-profiles.ts`; this module only names it. Research and the secrets it
 * needs: docs/2026-10-08-livekit-tts-candidates-qwen-gemini.md. Withheld from the learner picker by
 * the same `CLIENT_READY` rule as 4.0.
 */
import words40 from "./words-4.0";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words40,
  version: "words-4.1",
  label: "4.1 · LiveKit — podcast lesson, Qwen TTS (spike)",
  tts: "qwen",
};

export default version;
