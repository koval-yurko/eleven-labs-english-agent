/**
 * The STT and TTS halves of the voice loop, on our own vendor keys (research doc §2 Q5).
 *
 * STT is Deepgram Flux through the V2 API. The model is `flux-general-multi` with an EN+RU hint,
 * not the English-only `flux-general-en`: learners answer in Russian, and an English-only model
 * turns a Russian answer into English-shaped garbage that Claude then replies to. Whether Flux
 * multi actually transcribes a Russian insert correctly is what `pnpm --filter voice-worker
 * stt:check` measures. `DEEPGRAM_MODEL` switches the model without a code change.
 *
 * TTS is ElevenLabs Flash v2.5, the voice family the app already uses, picked to remove one
 * unknown from the spike rather than because it is the cheapest (§2 Q5).
 */
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";

export const DEFAULT_STT_MODEL = "flux-general-multi";
/** Language hints are only accepted by `flux-general-multi`; the plugin ignores them otherwise. */
const STT_LANGUAGE_HINT = ["en", "ru"];

export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

/**
 * `keyterms` biases Flux toward words it is about to hear. The lesson's own items and their Russian
 * translations are the obvious list, and the worker has both before the learner speaks (dispatch
 * metadata). It matters most for the case `stt:check` is weakest on: one Russian word dropped into
 * an English sentence, which an unbiased model can drop silently.
 */
export function createStt(
  model = process.env.DEEPGRAM_MODEL || DEFAULT_STT_MODEL,
  keyterms: readonly string[] = [],
): deepgram.STTv2 {
  return new deepgram.STTv2({
    model,
    ...(model === "flux-general-multi" ? { languageHint: STT_LANGUAGE_HINT } : {}),
    ...(keyterms.length > 0 ? { keyterms: [...keyterms] } : {}),
  });
}

/**
 * `voiceId` comes from dispatch metadata when the lesson names one. Otherwise it is
 * `ELEVENLABS_TEACHER_VOICE_ID`, the same voice the ElevenLabs tutor speaks with today, so a
 * side-by-side comparison (L8) compares the pipeline and not two different voices.
 */
export function createTts(voiceId = process.env.ELEVENLABS_TEACHER_VOICE_ID): elevenlabs.TTS {
  return new elevenlabs.TTS({
    // The plugin defaults to ELEVEN_API_KEY; deployment uses our existing backend key name.
    apiKey: process.env.ELEVENLABS_API_KEY,
    model: process.env.ELEVENLABS_TTS_MODEL || DEFAULT_TTS_MODEL,
    ...(voiceId ? { voiceId } : {}),
  });
}
