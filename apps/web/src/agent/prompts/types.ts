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
  /**
   * How long the agent waits for a reply before **re-engaging the learner**, in seconds
   * (ElevenLabs range 1–30). Defaults to DEFAULT_TURN_TIMEOUT_SECONDS.
   *
   * Pinned rather than inherited because a held pause depends on it: the mobile client keeps a
   * paused conversation quiet by resetting this timer with a `user_activity` heartbeat every
   * `TUTOR_HEARTBEAT_MS`, and a platform default that moved would put the tutor back to talking
   * into an empty room. Pinning it is about determinism first — the value is ours, not inherited.
   * It also governs LIVE teaching cadence, so do not tune it for pauses alone.
   *
   * It is ALSO the podcast pacing knob — words-1.5 pins 3 s so the tutor continues on its own after
   * a short gap instead of appearing to wait — and lowering it is what makes the coupling above
   * dangerous rather than theoretical. `MIN_TURN_TIMEOUT_SECONDS` (`@tutor/shared/tutor`) is the
   * floor, enforced in `effectiveConfig`. See docs/2026-08-18-podcast-mode-tutor.md §3.
   */
  turnTimeoutSeconds?: number;
  /**
   * Hard ceiling on ONE agent turn, in LLM output tokens. Omitted from the agent body when unset,
   * which leaves the platform default of `-1` — unlimited, and what every version before words-1.4
   * ran with.
   *
   * Deliberately per-version rather than a shared default: an older version's baked agent must keep
   * behaving the way it did when it was pinned, and giving this a repo-wide default would re-PATCH
   * words-1.0 … 1.3 with a limiter they were never written against.
   *
   * This is a BACKSTOP for a prompt-level turn budget, never the budget itself — the model is cut
   * off mid-sentence when it hits this, and TTS speaks the fragment. Set it comfortably above what
   * the prompt asks for. See docs/2026-08-17-short-turns-and-chunked-pause.md §3 L2.
   */
  maxTokens?: number;
  /**
   * How readily the agent takes its turn once the learner stops speaking: `patient` waits longer,
   * `eager` jumps in at the earliest opportunity. Omitted from the agent body when unset, leaving
   * the platform default (`normal`) — which is what every version before words-1.5 runs.
   *
   * Distinct from `turnTimeoutSeconds`, and the two are set together in podcast mode: the timeout
   * decides how fast the tutor resumes into SILENCE, this decides how easily it talks over a
   * learner who is mid-sentence. A short timeout without `patient` is a tutor that interrupts.
   * See docs/2026-08-18-podcast-mode-tutor.md §4.1.
   */
  turnEagerness?: "patient" | "normal" | "eager";
  /**
   * How long a conversation may go without the learner speaking before the platform **terminates**
   * it, in seconds; `-1` disables it. Defaults to DEFAULT_SILENCE_END_CALL_TIMEOUT_SECONDS.
   *
   * A held pause is, by construction, a long silence. Left unset this is a platform default we have
   * never read; pinned to -1 it cannot hang up a paused lesson. `maxDurationSeconds` remains the
   * backstop that does.
   */
  silenceEndCallTimeoutSeconds?: number;
}
