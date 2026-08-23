import type { TutorProviderId } from "@tutor/shared/tutor/transport";

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
  /**
   * Which service runs this version. Defaults to `"elevenlabs"` — every version predating the
   * second provider omits it and must keep meaning exactly what it meant.
   *
   * **A version belongs to ONE provider** (§13 Q1 of
   * docs/2026-08-22-openai-realtime-second-provider.md, settled 2026-08-22). Not because dual
   * configs are hard, but because the versions are genuinely different lessons: an ElevenLabs
   * version is written for a cascaded STT→LLM→TTS pipeline that reads a transcript, an OpenAI one
   * for a model that hears the learner's actual voice and can correct pronunciation (§11.1). A
   * shared prompt would be written for neither.
   *
   * The knock-on effects, all of which the compiler or `sync:agents` will hold you to:
   *   - only `"elevenlabs"` versions are provisioned as agents and appear in `agents.lock.json`;
   *   - `llm`, `voiceId`, `ttsModelId`, `additionalLanguages`, `maxDurationSeconds` and
   *     `silenceEndCallTimeoutSeconds` are ElevenLabs agent settings and are IGNORED for an OpenAI
   *     version — that provider's session is configured by the token route, not baked anywhere;
   *   - `maxTokens` carries across as `max_output_tokens`;
   *   - **`turnTimeoutSeconds` and `turnEagerness` carry across too**, as the two halves of
   *     `audio.input.turn_detection` (`openAiTurnDetection` in ./index.ts). They used to be listed
   *     above as ignored, and that stopped being true the moment an OpenAI version wanted podcast
   *     pacing: the question each one asks — *how long a silence before the tutor takes the floor
   *     back* and *how readily does it take it* — is about the LESSON, not about a vendor.
   *
   * Changing an existing version's provider retires its ElevenLabs agent on the next sync. That is
   * a delete-then-create in everything but name, so bump the version instead.
   */
  provider?: TutorProviderId;
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
   * dangerous rather than theoretical. `MIN_TURN_TIMEOUT_SECONDS` (`@tutor/shared/tutor/session`) is the
   * floor, enforced in `effectiveConfig`. See docs/2026-08-18-podcast-mode-tutor.md §3.
   *
   * **On an OpenAI version this field means the same thing and switches the mode.** Set, it selects
   * `server_vad` with `idle_timeout_ms` — the server commits an empty turn after that much silence
   * and provokes a response, which is that provider's only "keep talking" mechanism. UNSET, it
   * selects `semantic_vad`, where the tutor waits for the learner indefinitely. There is no
   * platform default to inherit here, which is why an OpenAI version must leave it out to mean
   * "wait" rather than pinning a number. See `openAiTurnDetection` in ./index.ts.
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
   *
   * **On an OpenAI version it carries across in whichever mode `turnTimeoutSeconds` selected**: as
   * `semantic_vad.eagerness` (patient → low, normal → medium, eager → high, unset → auto) when the
   * tutor waits, and as a `server_vad.silence_duration_ms` when it does not. Same question, two
   * vocabularies. See `openAiTurnDetection` in ./index.ts.
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
