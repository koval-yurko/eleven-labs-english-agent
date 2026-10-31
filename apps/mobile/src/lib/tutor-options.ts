import Storage from "expo-sqlite/kv-store";

import type { CustomizationValues } from "@tutor/shared/tutor/customization";
import { emit } from "@/lib/diagnostics";

/**
 * The learner's customization of each tutor version, remembered on this device — the twin of
 * `tutor-preference.ts`, which remembers WHICH version. Research and decisions (device storage, Q1):
 * docs/2026-10-30-prompt-version-customization.md.
 *
 * One key per version, `pref:tutor-options:<version>`, holding the values that differ from the
 * version's defaults as JSON. Stored raw and validated on the way out by the caller
 * (`resolveCustomization`), so a value a later schema no longer offers falls back to the default
 * and nothing here needs a migration. The API validates again before the worker sees anything.
 *
 * Every function swallows its errors, for the reason `tutor-preference.ts` gives: a convenience must
 * not break the lesson it serves.
 */

const keyFor = (version: string) => `pref:tutor-options:${version}`;

/** The stored values for `version`, unvalidated; `{}` when nothing is stored or the read fails. */
export async function readTutorOptions(version: string): Promise<CustomizationValues> {
  try {
    const raw = await Storage.getItem(keyFor(version));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as CustomizationValues) : {};
  } catch {
    return {};
  }
}

/** Remember `values` for `version`; an empty object removes the key ("Reset to defaults"). */
export async function writeTutorOptions(version: string, values: CustomizationValues): Promise<void> {
  try {
    if (Object.keys(values).length === 0) await Storage.removeItem(keyFor(version));
    else await Storage.setItem(keyFor(version), JSON.stringify(values));
  } catch (e) {
    emit({
      level: "warn",
      code: "pref.write_failed",
      message: e instanceof Error ? e.message : String(e),
      data: { version, options: JSON.stringify(values) },
    });
  }
}
