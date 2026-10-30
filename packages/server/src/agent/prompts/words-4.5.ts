/**
 * words-4.5 — `words-4.4` with the STT swapped: the worker on the Mac listens through Voicebox's
 * own `/stt/ws` (STT profile `voicebox-qwen-asr-0.6b`: Qwen3-ASR 0.6B, Voicebox `0.6.0-custom.1`)
 * instead of Deepgram Flux, and speaks with the Voicebox voice "Woman 2" instead of "Men 1" (TTS
 * profile `voicebox-local-woman-2`). To try another Voicebox model, name another `voicebox-*` STT
 * profile from `services/voice-worker/src/stt-profiles.ts` in a new version.
 *
 * Same lesson, same LLM, same worker (`tutor-local`). A difference between 4.4 and 4.5 is the STT
 * and the voice. The whole voice loop except Claude then runs on the Mac.
 * Only the Mac worker can serve it: the tunnel lets `/tts/*` through and not `/stt/*`. Research:
 * docs/2026-10-30-livekit-voicebox-plugins-node.md.
 */
import words44 from "./words-4.4";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words44,
  version: "words-4.5",
  label: "4.5 · LiveKit — podcast lesson, Voicebox STT + TTS \"Woman 2\" (Mac worker)",
  stt: "voicebox-qwen-asr-0.6b",
  tts: "voicebox-local-woman-2",
};

export default version;
