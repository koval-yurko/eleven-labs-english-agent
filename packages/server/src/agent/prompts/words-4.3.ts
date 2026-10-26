/**
 * words-4.3 — `words-4.0` with the worker's TTS swapped for our local Voicebox build (a Qwen3-TTS
 * voice clone that streams its audio), over one `WS /tts/ws` session per reply. The voice is the
 * Voicebox profile "Men 1" since 2026-10-27 ("Qwen Clone Demo" before; `DEFAULT_VOICEBOX_PROFILE_ID`).
 *
 * Same lesson, same STT (Deepgram Flux), same LLM, same turn plan: a difference between 4.0 and
 * 4.3 is the voice stage and nothing else, as it is for 4.1. The profile (`voicebox`) is defined in
 * `services/voice-worker/src/tts-profiles.ts`; this module only names it. The same voice over
 * `POST /tts/stream`, one request per sentence, was compared with it on a device and retired. The
 * Voicebox server runs on one Mac; this version is served by the LiveKit Cloud worker, which reaches
 * it through the tunnel (`VOICEBOX_URL` and `VOICEBOX_API_KEY`). `words-4.4` is the same lesson served
 * by the worker on that Mac, without the tunnel. Research:
 * docs/2026-10-26-voicebox-tts-adapter-research.md in the Voice-Agent project. Withheld from the
 * learner picker by the same `CLIENT_READY` rule as 4.0.
 */
import words40 from "./words-4.0";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words40,
  version: "words-4.3",
  label: "4.3 · LiveKit — podcast lesson, Voicebox TTS (WebSocket)",
  tts: "voicebox",
};

export default version;
