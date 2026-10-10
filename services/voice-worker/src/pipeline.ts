/**
 * The STT and TTS halves of the voice loop, on our own vendor keys (research doc §2 Q5).
 *
 * STT is Deepgram Flux through the V2 API. The model is `flux-general-multi` with an EN+RU hint,
 * not the English-only `flux-general-en`: learners answer in Russian, and an English-only model
 * turns a Russian answer into English-shaped garbage that Claude then replies to. Whether Flux
 * multi actually transcribes a Russian insert correctly is what `pnpm --filter voice-worker
 * stt:check` measures. `DEEPGRAM_MODEL` switches the model without a code change.
 *
 * TTS lives in `./tts-profiles.ts`: a version names a profile (Deepgram Aura-2 by default, Qwen),
 * so this file is the STT half only.
 */
import * as deepgram from "@livekit/agents-plugin-deepgram";

export const DEFAULT_STT_MODEL = "flux-general-multi";
/** Language hints are only accepted by `flux-general-multi`; the plugin ignores them otherwise. */
const STT_LANGUAGE_HINT = ["en", "ru"];

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
