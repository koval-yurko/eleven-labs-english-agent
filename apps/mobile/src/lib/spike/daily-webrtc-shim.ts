/**
 * SPIKE ONLY — path A of docs/2026-08-27-vapi-third-voice-provider.md. NEVER MERGE.
 *
 * The four methods `@daily-co/react-native-daily-js` needs and LiveKit's fork does not have.
 *
 * ## What this is fixing
 *
 * `metro.config.js` redirects `@daily-co/react-native-webrtc` to `@livekit/react-native-webrtc` so
 * there is one WebRTC package, one `WebRTC.xcframework` and one set of ObjC classes. That fixed the
 * build. It does not fix everything, because Daily's fork is not only a fork — it ADDS things.
 *
 * `WebRTCModule+Daily.m` (171 lines, an ObjC category in Daily's fork) exports four methods that
 * exist nowhere in LiveKit's:
 *
 *     setDailyAudioMode                                  ← sets the AVAudioSession category
 *     setAudioDevice / getAudioDevice                    ← output routing
 *     enableNoOpRecordingEnsuringBackgroundContinuity    ← keeps audio alive in the background
 *
 * `react-native-daily-js/dist/index.js` reads all four off `NativeModules.WebRTCModule` as PLAIN
 * PROPERTIES while building its `nativeUtils` object:
 *
 *     setAudioMode: WebRTCModule.setDailyAudioMode,
 *     setAudioDevice: WebRTCModule.setAudioDevice,
 *     ...
 *
 * Missing properties are `undefined`, which does not throw at import — it throws later, as
 * `nativeUtils.setAudioMode is not a function`, when Daily joins a call. So without this shim the
 * build is green, the app launches, and the spike dies the moment you press Start.
 *
 * ## Why no-ops are the RIGHT answer here, not a stub
 *
 * All four are AVAudioSession concerns, and this app already has an owner for those:
 * `lib/audio-session.ts`, which exists precisely because AVAudioSession is one process-wide
 * resource and a second private owner makes lessons fail as SILENCE rather than as an error.
 *
 * §4 of the research doc lists "Daily's native layer is a third AVAudioSession owner" as a reason
 * path A looked dangerous. It turns out `react-native-daily-js`'s own iOS code
 * (`DailyNativeUtils.m`) contains no AVAudioSession references at all — every bit of that lived in
 * the fork's `WebRTCModule+Daily.m`, which we are no longer compiling. So this shim does not
 * re-create Daily's policy; it routes the one call that matters into the app's existing owner and
 * lets the other three be honest no-ops:
 *
 *   - `setDailyAudioMode`  → `ensureStarted()` + `applyVoiceLessonCategory()`. Same intent
 *                            (playAndRecord for a two-way call), asserted by the module that is
 *                            allowed to assert it.
 *   - `setAudioDevice`     → no-op. `VOICE_LESSON_CONFIG` selects `videoChat`, which already routes
 *                            to the speaker — the only route a tutor lesson wants.
 *   - `getAudioDevice`     → reports `"speaker"`, matching the above.
 *   - `enableNoOp…`        → no-op. Its job is to hold an audio unit open so iOS does not suspend
 *                            the app. This app solves that with `UIBackgroundModes: ["audio"]` plus
 *                            its own session (docs/2026-08-13-expo-s1-background-audio.md), which is
 *                            the mechanism the whole native app exists for.
 *
 * ## Ordering
 *
 * Must run BEFORE anything imports `@daily-co/react-native-daily-js`, because that module reads the
 * properties during its own initialisation. The spike screen guarantees this by `require()`-ing the
 * Vapi SDK lazily, after calling this. That is the only reason the require in `spike-vapi.tsx` is
 * lazy — do not "tidy" it into a top-level import.
 */
import { NativeModules } from "react-native";

import { applyVoiceLessonCategory, ensureStarted } from "@/lib/audio-session";

/** The four names, in one place, so the report and the install cannot drift apart. */
const REQUIRED = [
  "setDailyAudioMode",
  "setAudioDevice",
  "getAudioDevice",
  "enableNoOpRecordingEnsuringBackgroundContinuity",
] as const;

export interface ShimReport {
  /** Did `NativeModules.WebRTCModule` exist at all? If not, nothing else here matters. */
  moduleFound: boolean;
  /** Which of REQUIRED were already present — expected to be none, on LiveKit's fork. */
  present: string[];
  /** Which this shim installed. */
  installed: string[];
  /** True when the object refused the assignment (frozen / TurboModule proxy). A hard stop. */
  rejected: string[];
}

/**
 * Patch the missing methods onto the live `WebRTCModule` object.
 *
 * Assignment rather than a wrapper module, because Daily reads them off `NativeModules.WebRTCModule`
 * directly and never goes through the package we aliased. Under the New Architecture that object may
 * be an interop proxy, and a proxy that refuses new properties is a real possibility — hence
 * `rejected`, which is verified by reading the property back rather than by trusting the write.
 */
export function installDailyWebRtcShim(): ShimReport {
  const mod = (NativeModules as Record<string, Record<string, unknown> | undefined>).WebRTCModule;
  if (!mod) return { moduleFound: false, present: [], installed: [], rejected: [] };

  const report: ShimReport = { moduleFound: true, present: [], installed: [], rejected: [] };

  const impls: Record<(typeof REQUIRED)[number], (...args: never[]) => unknown> = {
    // The only one with real behaviour. Daily calls this on join with "video" or "voice"; either
    // way a two-way call needs playAndRecord, which is exactly what the app's own policy applies.
    setDailyAudioMode: () => {
      void (async () => {
        await ensureStarted();
        await applyVoiceLessonCategory();
      })();
    },
    setAudioDevice: () => undefined,
    // Daily awaits this one.
    getAudioDevice: () => Promise.resolve("speaker"),
    enableNoOpRecordingEnsuringBackgroundContinuity: () => undefined,
  };

  for (const name of REQUIRED) {
    if (typeof mod[name] === "function") {
      report.present.push(name);
      continue;
    }
    try {
      mod[name] = impls[name];
    } catch {
      report.rejected.push(name);
      continue;
    }
    // Read back rather than assume: a proxy can accept a write and discard it silently.
    if (typeof mod[name] === "function") report.installed.push(name);
    else report.rejected.push(name);
  }

  return report;
}

/** One line for the on-screen log. */
export function describeShim(r: ShimReport): string {
  if (!r.moduleFound) return "SHIM: NativeModules.WebRTCModule NOT FOUND — nothing to patch.";
  const parts = [`installed=${r.installed.length}/${REQUIRED.length}`];
  if (r.present.length) parts.push(`alreadyPresent=[${r.present.join(",")}]`);
  if (r.rejected.length) parts.push(`REJECTED=[${r.rejected.join(",")}]`);
  return `SHIM: ${parts.join(" ")}`;
}
