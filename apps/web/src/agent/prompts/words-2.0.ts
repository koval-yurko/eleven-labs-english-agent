/**
 * words-2.0 — the podcast lesson, spoken by ChatGPT.
 *
 * The twin of `words-1.0`. Byte-identical prompt (`./podcast-lesson.ts`), different service, and
 * that is the whole design: with the text held constant, choosing between the two versions is
 * choosing between the two voices, and nothing else moves. Two prompts that drifted by a sentence
 * would have turned every comparison into a comparison of prompts.
 *
 * An earlier 2.0 was a pronunciation drill — the learner speaks, the model hears the actual audio,
 * and corrects how they sound. That is still the strongest reason to run this provider at all
 * (§11.1 of docs/2026-08-22-openai-realtime-second-provider.md), because a cascaded STT→LLM→TTS
 * pipeline cannot in principle hear a devoiced ending. It is deferred, not dropped: it wants a
 * version of its own, and it is a different lesson rather than a mode of this one.
 *
 * ## Why the config below is short
 *
 * OpenAI has no remote agent object — the session config IS the agent, and it is built by
 * `/api/v2/words-agent/openai-token` at credential-minting time. `llm`, `voiceId`, `ttsModelId` and
 * `additionalLanguages` configure an ElevenLabs agent and are IGNORED here (prompts/types.ts); the
 * voice is `OPENAI_REALTIME_VOICE` and the model IS the LLM, which is §11.3's loss and one of the
 * things this comparison exists to price.
 *
 * `maxTokens` is absent for the same reason as on the twin, and it bites harder here: audio output
 * spends roughly ten tokens a second, so a cap sized by eye cuts a sentence in half far sooner than
 * it looks.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-2.0",
  provider: "openai",
  // Same lesson as 1.0, so the service is the label. See the note there.
  label: "2.0 · ChatGPT — podcast lesson",
  prompt: PODCAST_LESSON_PROMPT,
  /**
   * Podcast pacing, and on this provider it is not decoration — it is what makes the lesson exist.
   *
   * Set, it selects `server_vad` with an `idle_timeout_ms`: after that much silence the server
   * commits an empty turn and provokes a response, which is the only mechanism OpenAI has for "keep
   * talking when nobody answers". Unset, the model would wait for a learner whose microphone is off,
   * forever, one paragraph into the lesson — a realtime model answers input, and silence is not
   * input. See `openAiTurnDetection` in ./index.ts.
   *
   * Three seconds because that is what the twin runs, and the comparison depends on it. It is also
   * `MIN_TURN_TIMEOUT_SECONDS`, the floor: a held pause SUSPENDS this timeout rather than pushing it
   * out (`apps/mobile/src/lib/transport/openai.ts`), and the floor is the margin that keeps the
   * suspension ahead of the timer.
   *
   * OpenAI will not accept three, though — `idle_timeout_ms` bottoms out at 5000 there — so what
   * actually reaches the session is five, raised by `OPENAI_MIN_IDLE_TIMEOUT_MS`. The two seconds
   * are the honest cost of the comparison: this side resumes into silence a beat later than the
   * twin, and that is the provider speaking, not a tuning choice.
   */
  turnTimeoutSeconds: 3,
  /**
   * The other half. In this mode it becomes `server_vad.silence_duration_ms: 1200` — more than
   * double the platform's 500 — because the learner it interrupts is composing English aloud, and a
   * half-second gap mid-sentence is normal for them. A short idle timeout without patience is a
   * tutor that talks over the person it is teaching.
   */
  turnEagerness: "patient",
};

export default version;
