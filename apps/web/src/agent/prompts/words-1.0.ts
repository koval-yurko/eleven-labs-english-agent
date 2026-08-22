/**
 * words-1.0 — the podcast lesson, spoken by ElevenLabs.
 *
 * ## This is a REUSED name, and that is worth knowing before reading history
 *
 * `words-1.0` originally meant the very first tutor prompt, from 2026-08-16. That prompt and the six
 * that followed it are deleted; what survives is where they arrived, which is words-1.6's text, now
 * in `./podcast-lesson.ts` and shared with `words-2.0`.
 *
 * The consequence is real and cannot be undone from here: **`lesson_sessions.agent_version` is a
 * free-text column, so rows written before this change that say `words-1.0` describe the OLD prompt
 * and now read as this one** — in the session list and in the LangSmith trace. Rows saying
 * `words-1.1` … `words-1.6` stay unambiguous, because those names are retired rather than reused.
 * If that provenance ever matters, the cut-off is this commit.
 *
 * The version string is also the ElevenLabs agent name and the lockfile key, so this does NOT create
 * a new agent: `pnpm sync:agents` sees `words-1.0` in both places and PATCHES the existing one with
 * the new config. Same agent id, different lesson.
 *
 * ## What is here and what is not
 *
 * The prompt is `PODCAST_LESSON_PROMPT`, byte-identical to the one `words-2.0` runs. Only the config
 * below differs, and it is all ElevenLabs-side: a Russian-capable TTS model, Russian as a language
 * preset, and the two turn-taking knobs that make a monologue continue into silence. Those are the
 * reason there are two versions of one lesson rather than one version with two providers.
 */
import { PODCAST_LESSON_PROMPT } from "./podcast-lesson";
import type { PromptVersion } from "./types";

const version: PromptVersion = {
  version: "words-1.0",
  provider: "elevenlabs",
  // The service is IN the label because it is the only thing the learner is choosing between: both
  // versions are the same lesson, so "1.0 versus 2.0" would be a number with nothing behind it.
  label: "1.0 · ElevenLabs — podcast lesson",
  prompt: PODCAST_LESSON_PROMPT,
  /** Russian-capable, and the reason the translation moment inside each item sounds like Russian. */
  ttsModelId: "eleven_v3_conversational",
  additionalLanguages: ["ru"],
  /**
   * The pacing knob, pinned at the floor `MIN_TURN_TIMEOUT_SECONDS` enforces.
   *
   * There is no "keep narrating" mode on a conversational agent, so this timer is literally the gap
   * between paragraphs: at the inherited 7 s it reads as "it's waiting for me to answer", at 3 s as
   * a breath. It matters more here than anywhere, because this lesson's turns are long — the gaps
   * are rare and each one has to read unambiguously.
   *
   * It cannot go lower: the mobile held pause keeps a paused lesson quiet by resetting this very
   * timer every `TUTOR_HEARTBEAT_MS` (1 s), so at 3 s a pause survives losing one ping and not two.
   * Lowering it means lowering the heartbeat first and redoing that arithmetic.
   */
  turnTimeoutSeconds: 3,
  /**
   * The other half of the same decision. A short timeout without `patient` is a tutor that resumes
   * over a learner who paused mid-sentence hunting for an English word — which, for someone
   * composing aloud, is constant. The timeout decides how fast it resumes into SILENCE; this decides
   * how easily it talks over someone. See docs/2026-08-18-podcast-mode-tutor.md §4.1.
   */
  turnEagerness: "patient",
  /**
   * No `maxTokens`, deliberately. This lesson has no per-turn sentence budget in its prompt, and a
   * ceiling with no prompt behind it does not shorten a turn — it truncates one mid-word and lets
   * TTS speak the fragment. That was words-1.4's mistake and it cost two versions to undo.
   */
};

export default version;
