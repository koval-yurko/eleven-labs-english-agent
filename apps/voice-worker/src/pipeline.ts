/**
 * The STT and TTS halves of the voice loop, on our own vendor keys (research doc §2 Q5).
 *
 * STT is Deepgram Flux through the V2 API. The model is `flux-general-multi` with an EN+RU hint,
 * not the English-only `flux-general-en`: learners answer in Russian, and an English-only model
 * turns a Russian answer into English-shaped garbage that Claude then replies to. Whether Flux
 * multi actually transcribes a Russian insert correctly is what `pnpm --filter voice-worker
 * stt:check` measures. `DEEPGRAM_MODEL` switches the model without a code change.
 *
 * TTS is Deepgram Aura-2 (≈ $0.03 per 1k characters against $0.05 for ElevenLabs Flash). An Aura-2
 * voice IS the model name, and every one is English-only: a Russian translation inside an item is
 * not spoken in Russian. `DEEPGRAM_TTS_MODEL` picks another voice without a code change.
 */
import * as deepgram from "@livekit/agents-plugin-deepgram";

export const DEFAULT_STT_MODEL = "flux-general-multi";
/** Language hints are only accepted by `flux-general-multi`; the plugin ignores them otherwise. */
const STT_LANGUAGE_HINT = ["en", "ru"];

export const DEFAULT_TTS_MODEL = "aura-2-asteria-en";

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
 * The voice is the model, so the lesson's `voiceId` (an ElevenLabs voice id) is deliberately not
 * used here: passing it as a Deepgram model name would be rejected.
 */
export function createTts(model = process.env.DEEPGRAM_TTS_MODEL || DEFAULT_TTS_MODEL): deepgram.TTS {
  // The plugin captures DEEPGRAM_API_KEY when it is imported; passing it keeps the key a Cloud
  // secret provisioned after import (and the offline check) works.
  return new deepgram.TTS({ model, apiKey: process.env.DEEPGRAM_API_KEY });
}
