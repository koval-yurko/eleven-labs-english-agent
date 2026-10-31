/**
 * A learner's options for one TTS or STT profile: the `LiveKitDispatchMetadata.overrides` of that
 * stage, minus the reserved `profile` key (docs/2026-10-30-prompt-version-customization.md).
 *
 * The keys are open on purpose: each profile lists the keys it reads in `accepts`, so a new provider
 * adds its own option (a region, an instruction) in its own profile and nowhere else. A key the
 * selected profile does not read is dropped here and named in the session-start log line.
 */
import type { OptionValue } from "@tutor/shared/tutor/customization";

export type ProfileOptions = Readonly<Record<string, OptionValue>>;

/** Splits `options` into what the profile reads and what it ignores. Pure: `check.ts` runs it. */
export function splitOptions(
  accepts: readonly string[],
  options: ProfileOptions,
): { accepted: ProfileOptions; ignored: string[] } {
  const accepted: Record<string, OptionValue> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (accepts.includes(key)) accepted[key] = value;
    else ignored.push(key);
  }
  return { accepted, ignored };
}

/** A string option, or `undefined` when it is absent or of another type. */
export function stringOption(options: ProfileOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
