/**
 * The prompt-version registry — the FILESYSTEM source of truth for the English-words-tutor
 * agents. Add a version: create a sibling `words-X.Y.ts` module and import it into PROMPT_VERSIONS
 * below. Remove a version: delete its module + drop it from the array, then run `pnpm sync:agents`
 * (it will retire the corresponding ElevenLabs agent). See ../sync-agents.ts and ../agents.lock.json.
 */
import type { PromptVersion } from "./types";
import words10 from "./words-1.0";
import words11 from "./words-1.1";
import words12 from "./words-1.2";

export type { PromptVersion } from "./types";

/** Defaults baked into the agent when a version doesn't override them. */
export const DEFAULT_LLM = "claude-sonnet-4-6";
export const DEFAULT_TTS_MODEL = "eleven_v3_conversational";

/**
 * All prompt versions, OLDEST → NEWEST. The last entry is the UI default. The order here also
 * drives the version picker; it is the canonical ordering (the lockfile is an unordered map).
 */
export const PROMPT_VERSIONS: PromptVersion[] = [words10, words11, words12];

/** The full agent config baked into ElevenLabs for one version (after applying defaults). */
export interface EffectiveAgentConfig {
  version: string;
  /** EL agent display name — also how `sync` identifies a managed agent. */
  name: string;
  prompt: string;
  llm: string;
  voiceId: string | undefined;
  ttsModelId: string;
  additionalLanguages: string[];
}

/** Resolve a version's full baked agent config, applying env/constant defaults (sync-time). */
export function effectiveConfig(
  v: PromptVersion,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveAgentConfig {
  return {
    version: v.version,
    name: `english-words-tutor (${v.version})`,
    prompt: v.prompt,
    llm: v.llm ?? env.LIVE_STORY_LLM?.trim() ?? DEFAULT_LLM,
    voiceId: v.voiceId ?? env.ELEVENLABS_TEACHER_VOICE_ID?.trim() ?? undefined,
    ttsModelId: v.ttsModelId ?? env.LIVE_STORY_TTS_MODEL?.trim() ?? DEFAULT_TTS_MODEL,
    additionalLanguages: v.additionalLanguages ?? [],
  };
}

export function findVersion(version: string): PromptVersion | undefined {
  return PROMPT_VERSIONS.find((v) => v.version === version);
}
