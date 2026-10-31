/**
 * A learner's customization (`LiveKitDispatchMetadata.overrides`, docs/2026-10-30-prompt-version-customization.md)
 * turned into what the session builds: for each stage, the profile id and that profile's options.
 *
 * The reserved key `profile` replaces the version's `stt` / `tts`; every other key is passed to the
 * selected profile, which reads only the keys in its `accepts`. The token route already validated
 * every value against the version's schema. Pure: `check.ts` runs it.
 */
import { CUSTOMIZATION_STAGES, PROFILE_KEY, type OptionValue } from "@tutor/shared/tutor/customization";
import type { LiveKitDispatchMetadata } from "@tutor/shared/tutor/livekit-wire";
import type { ProfileOptions } from "./profile-options.ts";

export interface StageChoice {
  /** The profile to build: the `profile` override, else the version's own. */
  profile: string | undefined;
  /** Every other key of the stage, for the profile to read. */
  options: ProfileOptions;
}

export interface SessionVoice {
  stt: StageChoice;
  tts: StageChoice;
  /** `stage.key=value` pairs the learner changed, for the session-start log line. */
  applied: string[];
}

const isOptionValue = (v: unknown): v is OptionValue =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

export function sessionVoice(metadata: Pick<LiveKitDispatchMetadata, "stt" | "tts" | "overrides">): SessionVoice {
  const applied: string[] = [];
  const choice = {} as Record<(typeof CUSTOMIZATION_STAGES)[number], StageChoice>;
  for (const stage of CUSTOMIZATION_STAGES) {
    const group: unknown = metadata.overrides?.[stage];
    const options: Record<string, OptionValue> = {};
    let profile: string | undefined;
    if (typeof group === "object" && group !== null) {
      for (const [key, value] of Object.entries(group)) {
        if (!isOptionValue(value)) continue;
        if (key === PROFILE_KEY) {
          if (typeof value !== "string" || value.length === 0) continue;
          profile = value;
        } else {
          options[key] = value;
        }
        applied.push(`${stage}.${key}=${String(value)}`);
      }
    }
    choice[stage] = { profile: profile ?? metadata[stage], options };
  }
  return { ...choice, applied };
}
