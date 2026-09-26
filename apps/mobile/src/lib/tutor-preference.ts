import Storage from "expo-sqlite/kv-store";

import { emit } from "@/lib/diagnostics";

/**
 * The one tutor choice the device remembers between lessons.
 *
 * Filed as feedback from the phone (debug report `9158f95b`): *"want to keep my selection about
 * prompt/agent version I selected … so I do not need to have the same selection for each lesson"*.
 * Before this, `focusLesson` cleared the session's `version` on every move and the picker fell
 * back to the registry default, so a learner who prefers one tutor re-picked it on every lesson.
 *
 * ## One value, not one per lesson
 *
 * A single "last chosen" version, device-wide. The alternative — a version remembered per lesson —
 * was considered and rejected: it does not answer the complaint, because a lesson that has never
 * been started still has nothing stored and still opens on the default, and the complaint is about
 * NEW lessons. It also makes the picker's value depend on invisible per-lesson history, so
 * "why is this one on 2.0" stops having a readable answer.
 *
 * ## It stores the version, never the provider
 *
 * Picking a version IS picking a provider (§13 Q1/Q2 of
 * docs/2026-08-22-openai-realtime-second-provider.md), and the mapping lives on the server. Storing
 * the provider beside it would freeze today's mapping onto the device: a version moved to another
 * service by `pnpm sync:agents` would then run on the stack the phone remembered, not the one the
 * registry names.
 *
 * ## It is a HINT, and `tutor-version.ts` is where it is allowed to lose
 *
 * A stored version can name an agent that no longer exists — a retired prompt, a build that sat on
 * a phone across two deploys. The offered list from `/api/v2/agent-versions` is the authority, so
 * the preference is applied only when it is still in that list. `resolveTutorVersion` makes that
 * check, which is why nothing here needs to be migrated when a version is retired.
 *
 * `expo-sqlite/kv-store`, matching `session-journal.ts`: first-party, AsyncStorage-shaped, and the
 * same package the deferred SQLite mirror will use.
 */

const KEY = "pref:tutor-version";

/**
 * Every function swallows its errors, for the reason `session-journal.ts` spells out: this is a
 * convenience, and a convenience that can break the thing it serves is worse than no convenience.
 * A device whose storage is wedged picks tutors exactly as it did before this file existed.
 */
export async function readPreferredVersion(): Promise<string | null> {
  try {
    const raw = await Storage.getItem(KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    // Silent, unlike the write below. A failed read is indistinguishable from "nothing stored
    // yet", which is the overwhelmingly common case on a first launch — reporting it would put a
    // line in every new install's first report that means nothing.
    return null;
  }
}

/** Remember this version as the one to offer next time. Best effort. */
export async function writePreferredVersion(version: string): Promise<void> {
  try {
    await Storage.setItem(KEY, version);
  } catch (e) {
    // Worth a line, unlike the read: the learner made a choice and it will not stick, and the
    // symptom — "it keeps forgetting" — is the exact complaint this file was written for.
    emit({
      level: "warn",
      code: "pref.write_failed",
      message: e instanceof Error ? e.message : String(e),
      data: { version },
    });
  }
}
