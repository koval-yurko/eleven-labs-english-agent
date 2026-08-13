/**
 * A single, self-describing version of the English-words-tutor agent. The FILESYSTEM is the
 * source of truth: each version is one module under src/agent/prompts/, aggregated in ./index.ts.
 * `pnpm sync:agents` reconciles ElevenLabs to match this set (create / update / retire), and
 * records each version's live agent id in src/agent/agents.lock.json.
 *
 * The `version` string is the IDENTITY KEY — it names the EL agent and keys the lockfile.
 * Renaming a version reads as delete-then-create (a new agent id), so bump it deliberately.
 */
export interface PromptVersion {
  /** Identity key, e.g. "words-1.1". Drives the agent name and the lockfile key. */
  version: string;
  /** System prompt. May contain the {{items_list}} dynamic-variable placeholder. */
  prompt: string;
  /** One-line note shown in the UI version picker (defaults to `version`). */
  label?: string;
  /** LLM id baked into the agent. Defaults to DEFAULT_LLM (see ./index.ts). */
  llm?: string;
  /** Teacher voice id. Defaults to env ELEVENLABS_TEACHER_VOICE_ID at sync time. */
  voiceId?: string;
  /** Real-time TTS model. Defaults to DEFAULT_TTS_MODEL (see ./index.ts). */
  ttsModelId?: string;
  /** Extra languages (ISO codes, e.g. "ru") baked as language_presets.  */
  additionalLanguages?: string[];
  /**
   * Hard cap on one conversation, in seconds. Defaults to DEFAULT_MAX_DURATION_SECONDS.
   *
   * ElevenLabs' own default is 600 — ten minutes — which silently cut sessions off mid-lesson
   * until S1's testing hit it (docs/2026-08-13-expo-s1-background-audio.md §11). The API accepts
   * **60–7200** and rejects anything outside that range; the bound is undocumented and was
   * established by probing.
   *
   * It is also the cost backstop: ElevenLabs bills per minute of conversation, so this is what
   * limits a session someone walks away from without ending.
   */
  maxDurationSeconds?: number;
}
