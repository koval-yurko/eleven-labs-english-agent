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
}
