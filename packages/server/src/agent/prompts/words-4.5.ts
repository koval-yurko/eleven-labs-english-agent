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
 *
 * The first version with `customization`: the learner may change the TTS model, the STT model and
 * the voice (docs/2026-10-30-prompt-version-customization.md). The lists are fixed here on purpose;
 * each default is what the version runs without options, so an unopened modal changes nothing.
 */
import words44 from "./words-4.4";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  ...words44,
  version: "words-4.5",
  label: "4.5 · LiveKit — podcast lesson, Voicebox STT + TTS \"Woman 2\" (Mac worker)",
  stt: "voicebox-qwen-asr-0.6b",
  tts: "voicebox-local-woman-2",
  customization: {
    fields: [
      {
        key: "voice",
        target: "tts.voice",
        kind: "select",
        label: "Voice",
        // Names from `VOICEBOX_VOICES` in services/voice-worker/src/tts-profiles.ts, which owns the ids.
        default: "woman-2",
        options: [
          { value: "woman-2", label: "Woman 2" },
          { value: "men-1", label: "Men 1" },
        ],
      },
      {
        key: "ttsModel",
        target: "tts.model",
        kind: "select",
        label: "Voice model",
        help: "Qwen3-TTS on the Mac. The model must be downloaded in Voicebox.",
        default: "1.7B",
        options: [
          { value: "1.7B", label: "Qwen3-TTS 1.7B", help: "Better voice" },
          { value: "0.6B", label: "Qwen3-TTS 0.6B", help: "Faster" },
        ],
      },
      {
        key: "sttModel",
        target: "stt.profile",
        kind: "select",
        label: "Speech recognition",
        help: "A Mac model must be downloaded in Voicebox. Deepgram needs DEEPGRAM_API_KEY on the Mac worker.",
        default: "voicebox-qwen-asr-0.6b",
        options: [
          { value: "voicebox-qwen-asr-0.6b", label: "Qwen3-ASR 0.6B (Mac)" },
          { value: "voicebox-qwen-asr-1.7b", label: "Qwen3-ASR 1.7B (Mac)" },
          { value: "voicebox-whisper-turbo", label: "Whisper large-v3 turbo (Mac)" },
          { value: "voicebox-whisper-base", label: "Whisper base (Mac)" },
          { value: "deepgram", label: "Deepgram Flux (cloud)" },
        ],
      },
    ],
  },
};

export default version;
