# S1 — background audio through a screen lock (B2) · research

**Date:** created 2026-08-13 · enriched, implemented and **run** 2026-08-13 · **Status:** ✅
**PASSED.** Gate S1a green; **S1b tests A–E all passed**, uplink criterion included — a locked iPhone
keeps a live conversation in **both** directions. B2 is answered: the premise of the project holds,
and the CallKit escalation (§8 rung 3) is **not** needed. One ceiling found during testing, and it is
configuration rather than iOS: §11.

**Parents:** [build plan → S1](./2026-08-12-expo-build-plan.md) ·
[creation doc §9 B2](./2026-08-12-expo-app-creation.md) (the mechanism — **partly superseded, see §3**) ·
[S0 research](./2026-08-13-expo-s0-scaffold-testflight.md) (the build pipeline this stage rides on).

---

## 0. What the enrichment changed

The placeholder listed nine open questions. Seven were answerable from source on the day, and three
of the answers change the plan rather than confirming it.

| Placeholder question                                      | Answer                                                                                                                                       | Where        |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Is `@config-plugins/react-native-webrtc` a real blocker?  | **No.** Still 15.0.1 / `expo: ^56`, but it does three trivial things on stable APIs. Read the source.                                        | §2 D10       |
| Which LiveKit set is jointly satisfiable?                 | **2.9.8 + webrtc 137.0.3 + `livekit-client` at exactly `2.16.1`.** The binding constraint is not the one S0 identified.                      | §2 D10       |
| Is the New Architecture warning real?                     | **Stale.** Both packages are now `newArchitecture: true` in the registry `expo-doctor` reads.                                                | §2 D13       |
| Is `newArchEnabled: false` still available in SDK 57?     | **No — the escape hatch does not exist.** Removed in RN 0.82 / SDK 55. The placeholder's fallback ladder is dead.                            | §2 D13       |
| Which public agent to point at?                           | A throwaway, created by hand, outside the registry — **and its prompt and settings are part of the instrument.** Full spec: §5.3.            | §2 D11, §5.3 |
| How does the agent id reach a cloud build?                | **Committed per-variant config, not `eas env:set`** — `env.config.ts` → `extra` → a throwing accessor.                                       | §4.2         |
| Exact `app.config.ts` block                               | §4.1                                                                                                                                         | §4.1         |
| Is the 1s-`setInterval` probe still the right instrument? | Yes, with one correction: **read `max drift`, never `drift`.**                                                                               | §5.1         |
| How to read results after unlocking?                      | On-screen scrollback, and it is sufficient — **but only if no debugger is attached**, which invalidates every test.                          | §5.2, §6.1   |
| Is the **uplink** — talking to a locked phone — tested?   | Not by the original criteria. **Fixed 2026-08-13:** gate criterion 4 plus an echoing agent, because a downlink-only session passed all four. | §5.3, §7     |
| Does the mic track really exist for the whole session?    | Yes, structurally. Unchanged from creation doc §9 B2.                                                                                        | §3.1         |

**The one thing that must not be re-derived** is why track presence matters:
[react-native-webrtc#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467) —
with no audio track and nothing transmitting, iOS suspends after ~40s; with at least one track
present, even a muted one, it does not. Track _existence_ holds the app, not audio content. That is
researched and settled. S1 exists because a mechanism being right does not prove our stack is.

---

## 1. Inputs from S0 — filled in

All of these come from [S0 §9](./2026-08-13-expo-s0-scaffold-testflight.md#9-what-s0-hands-to-s1).

- **Installed:** Expo SDK **57.0.12**, RN **0.86.2**, React **19.2.3**. `expo-doctor` 20/20.
  TypeScript in `apps/mobile` is `~6.0.3` (a major ahead of web/shared — independent trees).
- **Device:** iOS **26.4**, and it is the **only** device tested. Nothing in S1 is gated by OS
  version on this handset; iOS 16.4–18 behaviour is unobserved and stays unobserved after S1.
- **EAS project id** `6a38b3eb-8751-43eb-bb09-860d58ec4a68`, in `extra.eas.projectId` by hand.
- **Bundle id for this stage:** `work.kovalchuk.yurii.english-tutor-preview` (S1 measures on
  `preview`, per D9 — see D12 below for why `development` is not the instrument).
- **`unstable_enablePackageExports` was not needed**; there is no `metro.config.js` at all. Leave it
  that way — a hand-written Metro config is the classic way to break a working monorepo.
- **Turnaround: 5 minutes**, queue to installable artifact, no Apple processing on this path.
- **Ad-hoc profiles embed device UDIDs.** A new or reset handset needs `eas device:create` **and a
  rebuild**, not a reinstall.
- **`eas.json` needs no work at this stage.** Its per-profile `env` map already carries
  `APP_VARIANT`, and §4.2 deliberately routes every other value through committed code rather than
  EAS-hosted variables — so the `environment` field and `eas env:set` are not used at all.
- **The local release-build command is still unconfirmed:** `pnpm native && pnpm device:release`
  (`expo prebuild --clean --platform ios` then `expo run:ios --device --configuration Release`).
  S0 never ran it; the device install came from a cloud build. Note it obeys `APP_VARIANT`, and
  `apps/mobile/.env` sets `APP_VARIANT=development`, so it produces the **`-dev`** identity locally.

---

## 2. Decisions — settled 2026-08-13

### D10 — the dependency set, and the real reason for it ✅

**Install exactly this:**

```bash
# SDK-versioned — let Expo pick
npx expo install expo-dev-client @config-plugins/react-native-webrtc @livekit/react-native-expo-plugin

# NOT SDK-versioned, and the versions are the decision — pin them, no carets
pnpm --filter mobile add @elevenlabs/react-native@1.2.18 \
  @livekit/react-native@2.9.8 \
  @livekit/react-native-webrtc@137.0.3 \
  livekit-client@2.16.1
```

Plus a **fourth pin, which only surfaced on install** — in `pnpm-workspace.yaml`:

```yaml
overrides:
  "@livekit/react-native>@livekit/components-react": 2.9.19
```

Then, before building anything:

```bash
pnpm --filter mobile why livekit-client   # MUST show exactly one version: 2.16.1
pnpm --filter mobile peers check          # only the known `expo: ^56` warning should remain
```

**S0 identified the right conflict and the wrong cause, and the cause changes the answer.** S0 read
the declared peers — `@elevenlabs/react-native@1.2.18` peers `@livekit/react-native: ^2.9.2` **and**
`@livekit/react-native-webrtc: ^137.0.2`, while `@livekit/react-native@2.10.0+` requires webrtc
`^144` — and concluded that 137 and 144 are different libwebrtc binaries, so the pin is a
native-linkage question. Reading the actual code says otherwise on both halves:

**What ElevenLabs actually touches across that boundary is stable.** `@elevenlabs/react-native`
reaches past the public API into two private surfaces —
`NativeModules.LivekitReactNativeModule.createVolumeProcessor(pcId, trackId)` /
`createMultibandVolumeProcessor(options, pcId, trackId)` (`src/nativeVolume.ts`), and
`mediaStreamTrack._peerConnectionId`, a private field of `@livekit/react-native-webrtc`. Both were
diffed between the two candidate sets:

| Private surface                                    | 2.9.8 / webrtc 137.0.3                                        | 2.12.0 / webrtc 144.1.2 |
| -------------------------------------------------- | ------------------------------------------------------------- | ----------------------- |
| `LiveKitReactNativeModule.swift` volume processors | `@objc(createVolumeProcessor:trackId:)`                       | identical               |
| `MediaStreamTrack._peerConnectionId`               | `_peerConnectionId: number`, set from `info.peerConnectionId` | identical               |

So the scary-sounding libwebrtc major bump does not, by itself, break the thing ElevenLabs depends
on.

**The binding constraint is `livekit-client`, and S0 did not see it.**
`@elevenlabs/client@1.17.0` — pulled in by `@elevenlabs/react-native` via `@elevenlabs/react` —
declares `livekit-client` as a **hard dependency at an exact version: `2.16.1`**. Not a peer, not a
range.

| Set                            | LiveKit RN peers `livekit-client` | vs ElevenLabs' exact `2.16.1` | Result                      |
| ------------------------------ | --------------------------------- | ----------------------------- | --------------------------- |
| `@livekit/react-native@2.9.8`  | `^2.15.8`                         | satisfied                     | **one copy in the tree** ✅ |
| `@livekit/react-native@2.12.0` | `^2.19.0`                         | not satisfied                 | **two copies** ❌           |

Two copies of `livekit-client` means two `Room` classes, two `RoomEvent` enums and two
`WebRTCConnection` identities in one process — under `nodeLinker: hoisted` one wins the top slot and
the other sits nested, silently. Nothing throws; things simply stop matching. That is the failure
class this repo already writes rules against, and it is a far better reason to pin than "different
libwebrtc binaries".

It also **corrects S0's recommendation of `livekit-client@^2.15.4`**: a caret range resolves to
2.21.0 today, which does not satisfy ElevenLabs' exact pin, and produces the duplicate this decision
exists to prevent. The version must be written as `2.16.1`, exact.

**The set has four members, not three — found by installing it (2026-08-13).** `@livekit/react-native@2.9.8`
depends on `@livekit/components-react: ^2.9.17`, which today resolves to **2.9.24**, and that peers
`livekit-client: ^2.20.1`. The peer range moved under the caret after 2.9.8 shipped:

| `@livekit/components-react` | peers `livekit-client` | accepts 2.16.1?                          |
| --------------------------- | ---------------------- | ---------------------------------------- |
| 2.9.17                      | `^2.15.14`             | yes                                      |
| 2.9.18 – 2.9.19             | `^2.16.0`              | **yes — 2.9.19 is the newest that does** |
| 2.9.20                      | `^2.17.2`              | no                                       |
| 2.9.21                      | `^2.18.2`              | no                                       |
| 2.9.23 – 2.9.24             | `^2.20.1`              | no                                       |

This is not cosmetic and not deferrable: `@livekit/react-native/src/hooks.ts` imports
`@livekit/components-react` at **module scope**, so it loads the moment the ElevenLabs SDK imports
the package — every session goes through it. Each peer bump in that table tracked a real new
`livekit-client` API, so running 2.9.24 against 2.16.1 invites a `TypeError` at exactly the moment
the stage is trying to measure iOS. A **scoped** override (`parent>child`) fixes the resolution
without touching anything else in the workspace.

**What we give up by pinning to 2.9.8, stated honestly** — LiveKit's 2.11/2.12 line is precisely
about the machinery S1 measures (§3.2). If B2 fails on 2.9.8, moving to 2.12.0 is the second rung of
the escalation ladder (§8), and it is entered with eyes open about the duplicate-client hazard.

**`@config-plugins/react-native-webrtc@15.0.1` is not a risk.** Re-checked on the day: still 15.0.1,
still `expo: ^56`, no 16.x. Its entire source is three things — `withInfoPlist` setting
`NSCameraUsageDescription` / `NSMicrophoneUsageDescription` **only if not already set**,
`config.ios.bitcode = false` (a no-op on Xcode 26, where bitcode no longer exists), and a list of
Android permissions (out of scope, iOS-only per D2). It uses `withInfoPlist`,
`createRunOncePlugin` and `AndroidConfig.Permissions.withPermissions` — APIs stable for many SDK
majors. **The `expo: ^56` peer is a release-labelling formality, not a constraint.** pnpm warns; the
prebuild will work.

Two consequences worth writing down rather than rediscovering:

1. Because it only fills in a **missing** `NSMicrophoneUsageDescription`, the string we set in
   `app.config.ts` (§4.1) survives. Ours wins.
2. It **injects `NSCameraUsageDescription`** — a camera usage string for an app with no camera. Keep
   it at S1 anyway, for fidelity with the official ElevenLabs reference configuration: this is the
   stage where an unexplained deviation costs a misdiagnosis. Record it as a known, removable wart —
   on iOS the plugin contributes literally nothing we do not already declare ourselves, so **dropping
   it entirely is a safe S7 cleanup** if App Review or the privacy manifest objects.

**`@livekit/react-native-expo-plugin` does nothing on iOS** unless passed
`ios.enableMultitaskingCameraAccess`. Its iOS value is autolinking the native module, which comes
from the package being installed, not from the `plugins` entry. Include the entry anyway (the
reference config has it, and Android is a later question); do not expect it to explain any iOS
behaviour.

### D11 — the agent: a throwaway public agent, outside the registry ✅

S1 connects with `startSession({ agentId })` and no auth — no token route until S3. The agent is
therefore **created by hand in the ElevenLabs dashboard**: not a module in
`apps/web/src/agent/prompts/`, not an entry in `agents.lock.json`, nothing for `pnpm sync:agents` to
reconcile. A publicly connectable agent inside the committed registry the web app reads is a
different and worse thing than a publicly connectable throwaway.

Its id is declared **in the repo**, per variant, in `apps/mobile/env.config.ts` (§4.2) — not passed
through a CLI and not read from `.env`. It is not a secret (anything the client holds is public by
definition), and `agents.lock.json` already establishes that agent ids belong in the repo.

**Its prompt and its settings are part of the instrument, not decoration** — §5.3 specifies both in
full. One setting there, `silence_end_call_timeout`, can end test B from the server and make it look
like an iOS suspension; it is the highest-leverage detail in the stage.

### D12 — every build in this stage is `preview`; the development profile is not exercised ✅

**Decided by the user on 2026-08-13.** S1 builds, runs and measures **only** the `preview` profile.
The `development` profile is not built, not gated and not part of the handoff.

**Why this is the right call and not just a shortcut.** A `preview` build is a Release
configuration with the JS bundle embedded and Hermes-compiled — which is the _correct instrument_
for B2, not a compromise (D9). A dev-client build is actively the wrong one, for two independent
reasons: its Metro connection drops on backgrounding and manufactures false B2 failures (creation
doc §7), and it is the configuration most likely to have a debugger attached, which **prevents iOS
from suspending the app at all** (§6.1) — that does not weaken the test, it deletes it while still
printing a pass. So a development build could never have contributed a measurement; it could only
have contributed a second way for gate S1a to fail.

**The consequence, stated plainly.** The 5-minute cloud loop is the _only_ loop in this stage. Every
probe-screen iteration costs a build. That is a real cost and it is accepted: the probe screen is
~100 lines of `Text` and a scrollback, and it is worth less than the risk of measuring on the wrong
build.

**`expo-dev-client` is still installed** (the user's earlier call, and the install list in D10 keeps
it) so that S2 onward has the option without another prebuild. It is simply **never built and never
verified here** — whether the `development` profile produces a working dev client is an open
question S1 hands forward untouched (§12), exactly as S0 handed it to S1.

### D13 — the New-Architecture fallback ladder no longer exists ✅

The placeholder's plan was: if LiveKit fails on the New Architecture, set `newArchEnabled: false`,
and if that is gone, pin to an older SDK. **Both halves are now wrong.**

**`newArchEnabled: false` cannot be set.** The option to disable the New Architecture was removed in
**React Native 0.82**; the property is silently ignored, and Expo SDK 55 (RN 0.83) shipped with the
Legacy Architecture removed outright rather than deprecated. RN 0.81 / SDK 54 were the last versions
that honoured it — **three SDK majors back**, not one. "Pin to SDK 56" would not help either, because
56 is also New-Architecture-only. There is no configuration escape hatch, at any SDK we would
plausibly ship.

**And it is very unlikely to be needed.** The `expo-doctor` warning the placeholder anticipated reads
its data from the React Native Directory, and that data has moved since 2026-08-12:

| Package                        | `newArchitecture` | Note                                                                             |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------- |
| `@livekit/react-native`        | **true**          | "Currently supported through the compatibility layer for legacy native modules." |
| `@livekit/react-native-webrtc` | **true**          | same                                                                             |

([livekit#255](https://github.com/livekit/client-sdk-react-native/issues/255) is closed and was about
the metadata, not the capability.) So the expected S1a outcome is **no warning at all**; if
`expo-doctor` still prints one, suspect a stale local cache before suspecting the packages.

**What "through the compatibility layer" costs us.** These are legacy bridge modules running under
the interop layer in bridgeless mode, not Fabric/TurboModule-native ones. That is supported in RN
0.86 and is exactly how `NativeModules.LivekitReactNativeModule` and `NativeEventEmitter` keep
working for ElevenLabs' volume processors. It is also a dependency on a compatibility path that RN
will eventually retire — **a real medium-term risk to record, and not S1's problem.** If it is ever
removed, both LiveKit packages must ship real TurboModules or we do not ship.

**The revised ladder is in §8**, and its rungs are LiveKit versions and audio configuration, not
architecture flags.

---

## 3. The mechanism, corrected for the version we install

**Creation doc §9 B2 describes 2.12.0's mechanism, and we are installing 2.9.8's.** The conclusion it
reaches is unchanged; the machinery under it is not the machinery it describes. This section is the
correction, and it is the thing to reason from during the stage.

### 3.1 What the ElevenLabs SDK does — read from source, not docs

`@elevenlabs/react-native@1.2.18`'s React Native entrypoint (`src/index.react-native.ts`) is short
enough to state exactly:

```ts
registerGlobals();                       // at module scope, on import

async function reactNativeSessionSetup(options) {
  if (options.connectionType === "websocket" || options.signedUrl) throw …;   // WebRTC only

  await AudioSession.configureAudio({
    android: { preferredOutputList: ["speaker"], audioTypeOptions: AndroidAudioTypePresets.communication },
    ios: { defaultOutput: "speaker" },   // ← the ONLY iOS option it sets
  });
  await AudioSession.startAudioSession();

  const connection = await createConnection(options);
  …
  detach: async () => { … finally { await AudioSession.stopAudioSession(); } }
}
```

Three facts follow, all load-bearing:

1. **The SDK never sets an audio category.** On iOS it passes `defaultOutput: "speaker"` and nothing
   else — `AudioConfiguration.ios` has no other field at 2.9.8. Whatever category the session ends up
   in comes from LiveKit, not from ElevenLabs.
2. **WebSocket is rejected outright** on React Native. `connectionType: "webrtc"` is not a preference
   we are choosing, it is the only option — which retroactively justifies B3 being about WebRTC
   parity rather than a transport choice.
3. **The mic track exists for the whole session** — unchanged and still the reason B2 should pass.
   The SDK enables the microphone on `RoomEvent.SignalConnected`, before `room.connect()` resolves,
   and never mutes it. Per #1467, that track's existence is what keeps iOS from suspending us.

Also worth noting for later stages: `connection.getRoom()` exists, so the LiveKit `Room` **is**
reachable from app code if a fallback needs it (§8 rung 1 depends on this).

### 3.2 What `registerGlobals()` does — and how 2.9.8 and 2.12.0 differ

This is the correction. Both versions default `autoConfigureAudioSession: true`, and both end up at
`playAndRecord`. They get there by completely different routes:

**2.9.8 — a one-shot `getUserMedia` shim.** `registerGlobals()` calls `iosCategoryEnforce()`, which
monkey-patches `global.navigator.mediaDevices.getUserMedia`:

```ts
global.navigator.mediaDevices.getUserMedia = async (constraints) => {
  if (constraints.audio) {
    await AudioSession.setAppleAudioConfiguration({ audioCategory: "playAndRecord" });
  }
  return await getUserMediaFunc(constraints);
};
```

Category `playAndRecord`, **no `audioCategoryOptions`, no `audioMode`**, applied **once**, just
before mic acquisition, and never re-applied. The only lifecycle-aware alternative at 2.9.8 is
`useIOSAudioManagement(room, …)` — a React **hook** that watches `RoomEvent` track counts and calls
`setAppleAudioConfiguration` as they change. **The ElevenLabs SDK does not call it**, and nothing
calls it for us.

**2.12.0 — native, engine-driven, continuous.** `registerGlobals()` calls `setupIOSAudioManagement()`,
which configures and activates the session **natively from the audio engine's lifecycle, with no
JavaScript per transition**, defaulting to:

```ts
{ audioCategory: 'playAndRecord',
  audioCategoryOptions: ['allowBluetooth', 'mixWithOthers'],
  audioMode: preferSpeakerOutput ? 'videoChat' : 'voiceChat' }
```

2.11.0 moved Apple platforms to an AVAudioEngine-based audio device module; 2.12.0 added the static
`IOSAudioSessionPolicy` and deprecated the `onConfigureNativeAudio` callback as unsafe — it runs
inside the engine's lifecycle callbacks while native code blocks on the result.

**Why this matters for exactly what S1 measures.** "No JavaScript per transition" is not a
refactoring detail when the question is what happens to a **backgrounded** app: the JS thread is the
first thing iOS throttles. 2.9.8's category is set once while the app is in the foreground and then
persists, which is very likely fine — but it is a weaker guarantee than the version the creation doc
described, and the difference is invisible until you background the app.

**So the honest prediction for S1 is narrower than "expected: it holds".** The category will be
`playAndRecord` and the mic track will exist, which is the #1467 condition, so **A/B/D are expected
to pass**. What is genuinely unknown at 2.9.8 is whether anything re-establishes the session after an
_interruption_ (test **E**), because the only re-application path in that version is a hook nobody
calls. E is where this version choice is most likely to show up.

---

## 4. Configuration

### 4.1 `app.config.ts`

Additions to the existing file (S0 §2 D7's variant machinery is unchanged and not repeated):

```ts
  ios: {
    bundleIdentifier: `work.kovalchuk.yurii.english-tutor${variant.suffix}`,
    icon: "./assets/expo.icon",
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      // S1 additions:
      NSMicrophoneUsageDescription: "Used to talk with your English tutor.",
      UIBackgroundModes: ["audio"], // the whole point — see creation doc §9 B2
    },
  },
  plugins: [
    "expo-router",
    ["expo-splash-screen", { … }],
    // S1 additions — order follows the official ElevenLabs Expo example:
    "@livekit/react-native-expo-plugin",
    "@config-plugins/react-native-webrtc",
  ],
```

- **`expo-dev-client` needs no `plugins` entry** — it autolinks.
- `NSMicrophoneUsageDescription` is set by us on purpose even though the WebRTC plugin would supply a
  default: the plugin's fallback string is generic, and ours is what a reviewer reads (D10).
- **No mic pre-flight and no permission-request call.** The SDK triggers the OS prompt itself via
  `AudioSession.configureAudio()` / `startAudioSession()`, and the official example ships no explicit
  request. A denial therefore surfaces as a **session error, not a prompt** — the probe screen's
  error copy must name that case explicitly or the first run looks like a connection failure.
- **Do not add `expo-keep-awake`.** On web it holds the screen on; here, locking the screen is the
  measurement. Keeping the screen awake would produce the exact false pass the gate forbids.

### 4.2 Environment values live in the codebase, per variant

**`EXPO_PUBLIC_AGENT_ID` is not delivered by CLI, and no value in this project ever will be.**
`eas env:set` puts a value into EAS-hosted state that nobody can read from a checkout, which turns
"which values does the app depend on, and what are they in preview versus production?" into a
question you answer by logging into a dashboard and trusting your memory. This stage sets the
pattern instead, and every later stage's values — Auth0 domain/client id/audience (S2), the API base
URL and `app_env` (S3) — land in the same map.

**One map, in `app.config.ts`, extending the `VARIANTS` map D7 already put there.** Per-variant
identity and per-variant values are the same question, so they are the same table:

```ts
import type { Variant, VariantConfig } from "./env.types";

const VARIANTS = {
  development: {
    suffix: "-dev", name: "English Tutor (Dev)", scheme: "englishtutordev",
    env: { agentId: "agent_6101kzxdc7esesarwx8x8d9716xr" },
  },
  preview: {
    suffix: "-preview", name: "English Tutor (Preview)", scheme: "englishtutorpreview",
    env: { agentId: "agent_6101kzxdc7esesarwx8x8d9716xr" },
  },
  production: {
    suffix: "", name: "English Tutor", scheme: "englishtutor",
    // No publicly-connectable agent ever ships to production. A production build that reaches the
    // probe screen throws at first use, by design.
    env: { agentId: "" },
  },
} satisfies Record<Variant, VariantConfig>;

  extra: {
    eas: { projectId: "6a38b3eb-8751-43eb-bb09-860d58ec4a68" },
    env: variant.env, // the whole per-variant object; never spread key by key
  },
```

**Why the values are inline rather than in their own module — this was tried and does not work.**
An `env.config.ts` next to `app.config.ts`, imported relatively, fails: Expo's config loader
transpiles **only the entry config file**, so `import { ENV } from "./env.config"` reaches Node as a
plain `require` of raw TypeScript.

```text
Cannot find module './env.config'                    # without an extension
Unexpected token 'export'   at compileSourceTextModule  # with "./env.config.ts"
```

**Type-only** imports are fine, because the transpiler erases them before Node sees anything — which
is why `env.types.ts` (types and nothing else) works and a value module does not.

**`apps/mobile/env.types.ts`** holds `Variant`, `MobileEnv` (the runtime subset) and `VariantConfig`
(identity + `env`). `satisfies Record<Variant, VariantConfig>` is what enforces the guarantee, and
it is a real one — verified by deleting a field:

```text
app.config.ts(31,5): error TS2741: Property 'agentId' is missing in type '{}'
                     but required in type 'MobileEnv'.
```

`satisfies` rather than a type annotation, so `variant.scheme` keeps its literal type for S2's Auth0
plugin.

**`apps/mobile/src/env.ts` is the only place the app reads it:**

```ts
import Constants from "expo-constants";
import type { MobileEnv } from "../env.types";

const raw = Constants.expoConfig?.extra?.env as Partial<MobileEnv> | undefined;

/** Required, never defaulted — the same rule `appEnv` follows on the server (CLAUDE.md). */
function required<K extends keyof MobileEnv>(key: K): NonNullable<MobileEnv[K]> {
  const value = raw?.[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing env value "${String(key)}" for this build. …`);
  }
  return value as NonNullable<MobileEnv[K]>;
}

// Getters, not eager reads: an import-time throw in React Native is a white screen with no
// message, while a throw at first use lands in the error boundary carrying that text.
export const env = {
  get agentId() {
    return required("agentId");
  },
};
```

`Constants.expoConfig.extra` is confirmed as the SDK 57 accessor (`Constants.manifest` is the
deprecated one), and the docs state plainly that config values are embedded at build time.

**The whole chain, with nothing hidden in a dashboard:**

```text
eas.json build profile  →  env.APP_VARIANT  →  VARIANTS[variant].env  (app.config.ts)
                                            →  extra.env
                                            →  Constants.expoConfig.extra.env
                                            →  src/env.ts  (throws if missing)
```

`eas.json` therefore needs **no** `environment` field and **no** `eas env:set` — the `env` map it
already carries (`APP_VARIANT` per profile, from S0/D7) is the only thing EAS has to know. Local
builds get the same value from `apps/mobile/.env`'s `APP_VARIANT=development`, so `.env` stays a
one-line file about _identity_, never about _values_.

**Where `extra` is actually resolved, and the trap that follows.** It is **not** written by
`expo prebuild`. `expo-constants` installs a script phase in the **Pods** project
(`get-app-config-ios.sh` → `getAppConfig.js`) that re-runs the app config during the **Xcode build**
and writes the result into `EXConstants.bundle`. Two consequences:

- Searching the generated `ios/` directory for a value from `extra` finds **nothing**, and that is
  correct rather than a bug.
- `APP_VARIANT` must be set in the **Xcode build** environment, not only at prebuild time. On EAS
  the profile's `env` covers the whole job, so it cannot go wrong. **Locally it can:** the bundle
  identifier is baked into the Xcode project at _prebuild_ time while `extra.env` is resolved at
  _build_ time, so `APP_VARIANT=preview npx expo prebuild` followed by a plain `pnpm device:release`
  (which reads `APP_VARIANT=development` from `.env`) produces a **preview app carrying development
  values**. Prebuild and build with the same variant, or use EAS.

**Three rules that keep this honest:**

1. **No `process.env` override path.** Not for local experiments, not "just this once". A value that
   can come from two places is a value you will one day misread — the same reasoning as `appEnv`
   being required rather than defaulted. To point at a different agent, edit the map; it is
   committed, and that is the feature.
2. **Nothing secret goes in here, ever.** `extra` is embedded in the app manifest and readable by
   anyone holding the `.ipa` — exactly as public as `EXPO_PUBLIC_*` was. This costs us nothing
   because the mobile app has no secrets by construction (creation doc §3.5: the token route exists
   so the app never holds `ELEVENLABS_API_KEY` or the service-role key). If a genuine secret ever
   appears, it does not belong in the client at all, and EAS environment variables would still be
   the wrong answer.
3. **Values are baked in at build time.** Changing the map requires a rebuild, not a restart — which
   at 5 minutes a build (D12) is worth knowing before you change one and wonder why nothing happened.

## 5. The instrument

### 5.1 The suspension probe

`useSuspensionProbe` from [build plan appendix A](./2026-08-12-expo-build-plan.md#appendix-a--the-suspension-probe)
is unchanged and correct: a 1s `setInterval` increments `ticks` while wall-clock elapsed is read
independently; when iOS suspends the app the timer stops and the clock does not, so
`wall − ticks` is the number of seconds iOS took away.

**Read `max drift`, never `drift`** — the gate already says this; here is the reason. On resume,
either iOS fires nothing that was missed (drift stays permanently elevated at the gap) or the
runtime coalesces a catch-up burst (drift collapses back toward zero within seconds). Both are
plausible and it does not matter which happens, because `maxDrift` is latched at the first tick after
resume in either case. A screen showing only live `drift`, read a few seconds after unlocking, can
show ~0 after a full suspension.

**Establish the noise floor before trusting any locked number.** Run the probe for 3 minutes in the
**foreground**, untouched, on a `preview` build, and record `max drift`. Expect well under 0.5s;
whatever it actually is, that is the floor, and it is what makes "0.4s" and "2.9s" meaningfully
different readings rather than two ways of saying "passed". Do this once, first, and write it into
appendix B.

The screen shows `status`, `AppState`, `drift`, `max drift`, and a **timestamped scrollback** of
status changes, `AppState` transitions, transcript lines and errors. Two additions to the appendix-A
sketch:

- **Timestamp transcript lines with wall-clock time**, not relative time. Gate criterion 4 is
  "transcript lines timestamped _during_ the locked window are present", and you can only check that
  against the wall clock you locked the phone by.
- **Log `conversationId` from `onConnect` and flag anything not matching `/^conv_/`.** This is a free
  early look at the B3 hazard (creation doc §9 B3): WebRTC _derives_ the id and falls back to
  `room_${Date.now()}` when `room.name` is empty. Costs one line here; S3 is where it is fixed.

### 5.2 Reading the result

**On-screen scrollback is sufficient, and no log shipping is needed.** The two possible outcomes are
both readable after unlocking:

- iOS **suspended** the app → JS state survives, and the scrollback shows the gap directly.
- iOS **terminated** the app → you unlock to a fresh app with an empty scrollback, which is itself an
  unambiguous result (and a worse failure than suspension).

So resist the temptation to add file logging or a log-shipping route. It is another moving part in
the stage whose entire purpose is having as few as possible.

### 5.3 The test agent — what to create in ElevenLabs, and its exact configuration

Per D11 this agent is created **by hand**, lives nowhere in `apps/web/src/agent/prompts/`, and is
never written to `agents.lock.json`. That is also mechanically safe: `sync-agents.ts` only ever
touches agents recorded in the lockfile — its "orphan" case means a _lockfile entry whose prompt file
was deleted_, not an ElevenLabs agent the lockfile has never heard of. A hand-made agent is invisible
to `pnpm sync:agents` and cannot be retired or deleted by it.

#### Why its prompt is the instrument, not decoration

The agent has to make **both directions** observable through a locked screen, because they fail
independently.

**Downlink — an agent that never stops talking.** With an ordinary tutor prompt the only way to check
audibility is to talk to a locked phone and hope it answers: a subjective yes/no, taken under the
exact conditions where you can see nothing. An agent that counts out loud without stopping turns your
ear into a second, independent clock. Lock at "twelve", unlock three minutes later, and the number
you hear should be near 190. A **gap** in the count localises _when_ audio stopped, which the drift
number alone cannot — drift says how much time was taken, the count says when. It also makes test
**C** readable: the agent keeps counting whether or not we transmit, so muting our mic tests track
presence without silencing the thing we are listening for.

**Uplink — an agent that echoes back what it heard.** This is the half a naive design misses, and
missing it produces a **false pass**. If iOS keeps playback alive but kills microphone capture while
the screen is locked, a counting agent simply keeps counting: audio audible ✓, transcript lines
present ✓, `status` connected ✓, drift low ✓ — a green gate on a session you cannot talk to. For a
language tutor that session is worthless, so this cannot be left to inference. Make the agent repeat
what it heard, and one spoken word then yields **an audible confirmation, a `user:` transcript line
and an `agent:` transcript line**, all timestamped — and all three are absent if the uplink is dead.
That is what gate criterion 4 (§7) is written against.

**The prompt:**

```text
You are a test signal, not a tutor. From the moment the conversation starts, count upward out loud —
"one", "two", "three" — at roughly one number per second, and never stop.

Whenever the user says anything at all, immediately interrupt your counting and say "heard" followed
by the exact words you heard, then resume counting from the number you had reached. Never skip this,
however short or unclear what they said was.

Do not ask questions, do not comment on anything, do not offer help, and never end the call.
```

The echo repeats the **content**, not an acknowledgement noise, on purpose: "heard alpha" proves the
audio reached ASR intact, whereas "mm-hm" would prove only that something tripped the agent's turn
detection. The resumed count then proves the session survived the exchange instead of restarting.

**It must contain no `{{placeholders}}` of any kind.** The tutor prompts interpolate `{{items_list}}`
and depend on `dynamic_variable_placeholders` being registered on the agent; S1 calls
`startSession({ agentId })` with **no** `dynamicVariables`, so any `{{…}}` left in this prompt fails
the session at connect time and looks exactly like a network fault.

#### The configuration, field by field

API field paths, so this is reproducible rather than a dashboard memory. Names match the
`conversation_config` body `sync-agents.ts` already posts to `/v1/convai/agents`.

| Field                                                   | Value                             | Why it matters here                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                  | `s1-suspension-probe (throwaway)` | Names it out of the tutor family at a glance; the word _throwaway_ is the deletion reminder.                                                                                                                                                                                                                                                      |
| `platform_settings.auth.enable_auth`                    | **`false`**                       | **The setting that makes the stage possible.** `true` requires a signed URL; `false` permits direct connection by agent id, which is all S1 has. Dashboard: the agent's **Security** tab.                                                                                                                                                         |
| `platform_settings.auth.allowlist`                      | **empty**                         | Allowlists match on hostname. A native client sends no `Origin`, so a non-empty allowlist has nothing to match and becomes a way to fail for a reason that looks like iOS.                                                                                                                                                                        |
| `conversation_config.agent.prompt.prompt`               | the prompt above                  | —                                                                                                                                                                                                                                                                                                                                                 |
| `conversation_config.agent.prompt.llm`                  | the cheapest/fastest available    | The content is counting. Model quality contributes nothing; latency contributes to a steady cadence.                                                                                                                                                                                                                                              |
| `conversation_config.agent.first_message`               | **`"One."`** — non-empty          | **The opposite of the tutor agents**, which use `""` on purpose and begin on the kickoff contextual update. S1 has no kickoff logic, so an empty first message means an agent that waits silently and a test that measures nothing.                                                                                                               |
| `conversation_config.agent.language`                    | `en`                              | —                                                                                                                                                                                                                                                                                                                                                 |
| `conversation_config.agent.dynamic_variables`           | **unset**                         | Mirrors the prompt having no placeholders. Do not copy the tutor agents' `dynamic_variable_placeholders` block.                                                                                                                                                                                                                                   |
| `conversation_config.tts.voice_id`                      | any clear voice                   | Reuse `ELEVENLABS_TEACHER_VOICE_ID` if convenient; nothing depends on it.                                                                                                                                                                                                                                                                         |
| `conversation_config.tts.model_id`                      | a low-latency (flash) model       | A steady one-per-second cadence is what you time by ear.                                                                                                                                                                                                                                                                                          |
| `conversation_config.turn.silence_end_call_timeout`     | **verify it is `-1`**             | `-1` is the documented default and means _disabled_. Any positive value ends the call from the **server** after that much user silence — which is exactly test B (lock, then 3 minutes of silence), and the app would faithfully report a disconnect that had nothing to do with iOS. **The single setting that can silently invalidate a test.** |
| `conversation_config.conversation.max_duration_seconds` | default `600` is fine             | Every test is a fresh ≤3-minute session, so 10 minutes is ample. Know the number anyway, so a session dying at exactly 10:00 in an exploratory run is not read as a B2 failure.                                                                                                                                                                   |
| `conversation_config.turn.turn_timeout`                 | default `7` is fine               | "Maximum wait before re-engaging." Close to inert for an agent told never to stop talking — but record whether it audibly interrupts the count, and raise it if it does.                                                                                                                                                                          |
| tools                                                   | **none, especially `end_call`**   | An agent that can hang up is an agent that can end your test and let you attribute it to iOS.                                                                                                                                                                                                                                                     |

#### Before running a single test

- [ ] Connect once from the **foreground** and confirm the agent starts counting on its own, with no
      user turn. That one check proves `first_message`, `enable_auth: false` and the empty allowlist
      together.
- [ ] **In the same foreground session, say "alpha" and confirm three things happen:** you hear
      "heard alpha", a green `you: alpha` line appears in the scrollback, and the count resumes. This
      is the uplink instrument itself — if it does not work with the screen on, a locked-screen
      failure later tells you nothing about iOS.
- [ ] Confirm `silence_end_call_timeout` reads `-1`.
- [ ] Confirm no `{{` appears anywhere in the prompt.
- [ ] Put the agent id into `apps/mobile/env.config.ts` for both `development` and `preview` (§4.2),
      leave `production` empty, and rebuild. It is not a secret, and `agents.lock.json` already sets
      the precedent that agent ids belong in the repo.
- [ ] Add the id to §12's handoff list as a **deletion** item — S3 replaces it with a private agent
      behind the token route, and a publicly connectable agent left alive after that is a loose end
      nobody will remember.

## 6. Measurement procedure

### 6.1 Two rules that decide whether the numbers mean anything

**1. No debugger. Ever.** Xcode's debugger prevents the system from suspending your app: run from
Xcode, background the app, and it keeps executing where it would otherwise have been suspended. This
is the failure mode that produces a confident, fully green, completely meaningless result. Therefore:

- **Prefer the `preview` cloud build for every measurement.** Installed from a link, launched from
  the home screen, no debugger is even possible. This is why D9's "S1 runs on preview" is not just a
  convenience.
- If you do measure from `pnpm device:release`, **force-quit the app after it installs and relaunch
  it from the home screen** before starting. `expo run:ios` launching the app for you is the exact
  situation to avoid.

**2. Release configuration, not a dev client.** D12. A dev client's Metro connection drops on
background and manufactures false negatives, on top of the debugger problem.

### 6.2 Order of operations

1. **S1a — `preview` build.** App launches; a **foreground** conversation completes with audio both
   directions and a rendered transcript line, and the agent starts counting on its own (§5.3). A
   crash here is a New Architecture or build problem, **not** a B2 result (§8).
2. **Noise floor.** 3 minutes foreground, untouched, record `max drift` (§5.1).
3. **S1b tests A–E**, in order, each on a `preview` build, each from a cold launch from the home
   screen. Run **A first** — if it fails the rest are academic.

There is no development-build step. Every build in this stage is `preview` (D12).

### 6.3 The tests

Methods and what each isolates come from
[build plan → Gate S1b](./2026-08-12-expo-build-plan.md#gate-s1b--b2-itself) and are fixed. What is
added here is what to watch and how to read it.

| #     | Setup                                                                                                                                                                                         | Watch                                                                                                                                                                                                                                                       | Isolates                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **A** | Start, talk until the agent replies, note the count and wall time, lock. **Then say one distinct word roughly every 30s: "alpha", "bravo", "charlie", "delta", "echo".** Unlock at **3 min**. | Both directions. Downlink: the count you hear while locked, and each "heard …" reply. Uplink: after unlocking, how many of the five produced a `user:` line and a matching `agent:` line, all timestamped inside the window. Then `max drift` and `status`. | The headline question — **two halves that fail independently** |
| **B** | Start, lock immediately, say nothing for **3 min**.                                                                                                                                           | Whether the count continues unbroken; whether a disconnect is ours or the agent's (§5.3).                                                                                                                                                                   | An idle-but-open session                                       |
| **C** | Start, mute, lock **2 min**.                                                                                                                                                                  | The count only. **Criterion 4 is deliberately suspended here** — we muted on purpose, so zero `user:` lines is the expected result, not a failure.                                                                                                          | Whether track _presence_ alone holds us (#1467)                |
| **D** | Start, swipe to the home screen (do not lock), wait **2 min**.                                                                                                                                | Same criteria.                                                                                                                                                                                                                                              | Backgrounding vs locking — different suspension paths          |
| **E** | Trigger Siri or take a call mid-session, then return.                                                                                                                                         | Whether audio resumes on its own, wedges, or errors. **This is where 2.9.8's one-shot category is most exposed** (§3.2).                                                                                                                                    | Interruption recovery; informs the pause UI                    |

`AppState` transitions are an **observation, not an assumption** — record what lock, app-switch and
Siri actually produce (the sequences differ, and D's whole point is that backgrounding and locking
are different paths). The scrollback captures them; copy them into §12.

**The alpha–echo method exists so the uplink is countable rather than remembered.** Five distinct
words, spoken at known times into a phone you cannot see, become five checkable rows in the
scrollback after unlocking. Five of five is a solid uplink. Two of five is a partial failure, and
worth more investigation than either a clean pass or a clean fail. Zero of five **with the count
still audible** is the false-pass case criterion 4 was written for, and it is a **fail**.

B and D use A's criteria and both include criterion 4 — in B, say the five words during the otherwise
silent window; in D, speak to the app while it is backgrounded. C failing is expected, harmless (we
never mute in the real product) and confirms the #1467 mechanism.

---

## 7. Gate (fixed, not renegotiable)

**S1a** — app launches; a **foreground** conversation completes with audio both directions and a
rendered transcript line. A crash here is a New Architecture / build problem, **not** a B2 result.

**S1b test A** passes when all **five** hold:

- [ ] `status` stayed `connected` throughout
- [ ] **`max drift` < 3s** ← the one that matters
- [ ] **Downlink:** agent audio audible **while the screen was locked**
- [ ] **Uplink:** every word spoken into the locked phone produced an audible "heard …" reply **and**
      a `user:` transcript line, timestamped inside the locked window (§6.3, the alpha–echo method)
- [ ] Transcript lines timestamped _during_ the locked window are present

**Criterion 4 was added on 2026-08-13, and it strengthens the gate rather than renegotiating it.**
Test A's method always said "keep talking", but the pass criteria only checked what came _out_ of the
phone. Every one of the other four can be satisfied by a downlink-only session — iOS keeping playback
alive while microphone capture is dead would be a green gate on a tutor you cannot speak to. A voice
tutor that cannot hear the learner has not passed anything.

Record the **number**, not pass/fail — 0.4s and 2.9s both pass and say very different things about
headroom. Results table: [build plan appendix B](./2026-08-12-expo-build-plan.md#appendix-b--s1b-results).

**A session still reporting `connected` after a 40-second lock is not a pass if drift shows 40s.**

**"Passes only with the screen awake-but-dimmed" is not a pass.**

---

## 8. If it fails — the revised ladder

D13 removed the architecture rungs. What is left is ordered by cost, and the first two are hours
rather than days.

| Rung | Symptom                                                       | Action                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | **S1a crashes / never connects**                              | Not a B2 result. Check `pnpm why livekit-client` shows one copy (D10); check the two config plugins applied; rebuild `--clean`. Architecture flags are **not** available (D13) — do not chase them.                                                                                                                                                                                                      |
| 1    | Suspends, or wedges after an interruption (**E**)             | The category is being set once and never re-applied (§3.2). At 2.9.8 the lifecycle-aware path exists but nobody calls it: get the `Room` via `connection.getRoom()` and call `useIOSAudioManagement(room, true)`. This is the cheapest real fix. Hours.                                                                                                                                                  |
| 2    | Still suspends with the category demonstrably `playAndRecord` | Move to `@livekit/react-native@2.12.0` + webrtc `144.1.2` + `livekit-client@^2.19.0` for the native engine-driven session management and `setupIOSAudioManagement(true, policy)`. **This creates the two-copy `livekit-client` hazard (D10) — verify `Room` identity and `RoomEvent` handling explicitly, and expect ElevenLabs' private-API use to be the thing that breaks.** A day, plus uncertainty. |
| 3    | Audio is configured correctly and iOS still suspends          | **CallKit** (`expo-callkit-telecom`). Larger integration, its own App Review surface, buys the lock-screen call UI. **Re-estimate S4 before committing** — this branch could turn 4.5–7 weeks into something longer and deserves an explicit go/no-go. Do not build it preemptively.                                                                                                                     |

**Escalate to cost, not to build.** Rung 3 is a project decision, not a technical next step.

---

## 9. Implementation — built 2026-08-13, statically verified

Everything below is in the repo. **Nothing has run on a device**, which is the entire remaining
question; §6 is the procedure and §7 the gate.

### What was built

| File                                            | What it is                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/mobile/env.types.ts`                      | `Variant`, `MobileEnv`, `VariantConfig` — types only, so `app.config.ts` can import them (§4.2)                                      |
| `apps/mobile/app.config.ts`                     | `VARIANTS` extended with per-variant `env`; plugins; `NSMicrophoneUsageDescription`; `UIBackgroundModes`                             |
| `apps/mobile/src/env.ts`                        | the single reader — `required()`, throwing, never defaulting                                                                         |
| `apps/mobile/src/hooks/use-suspension-probe.ts` | the drift measurement (appendix A, corrected — see below)                                                                            |
| `apps/mobile/src/hooks/use-event-log.ts`        | the newest-first timestamped scrollback, with `you` and `agent` as separate kinds                                                    |
| `apps/mobile/src/app/_layout.tsx`               | `ConversationProvider`, imported from `@elevenlabs/react-native` for its module-scope side effects                                   |
| `apps/mobile/src/app/index.tsx`                 | the probe screen: status / AppState / elapsed / drift / **max drift** / mic / **you-agent turn counts**, start-end, mute, scrollback |
| `pnpm-workspace.yaml`                           | the scoped `@livekit/components-react` override (§2 D10)                                                                             |

**The scrollback separates the two directions.** `you:` lines render green and bold, `agent:` lines
plain, and the stats grid carries a `you / agent turns` count. That is not cosmetics: a locked-screen
session where iOS kept playback alive and killed microphone capture produces agent lines and **zero**
you lines, while `status`, drift and audibility all look healthy. The one number that falls to zero
had to be the most visible thing on a screen you are reading for the first time after unlocking.

**Two implementation notes worth keeping.** The appendix-A probe called `setState` in the effect
body to reset between runs, which `react-hooks/set-state-in-effect` rejects; the rewrite keeps
`ticks`/`max` in the effect closure and writes state only from timer callbacks, so each run starts
clean with no reset step to forget and a stale `maxDrift` cannot leak into the next run's verdict.
And `_layout.tsx` must import from **`@elevenlabs/react-native`**, never `@elevenlabs/react` — the
RN entrypoint's module scope is what calls `registerGlobals()` and registers the RN session-setup
strategy (§3.1, §3.2).

### What the checks proved

| Check                                         | Result                                                                                                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm why livekit-client`                     | **exactly one copy, 2.16.1** — D10's whole reason for the pin holds                                                                                                 |
| `pnpm peers check`                            | only `expo: ^56` from `@config-plugins/react-native-webrtc` remains, as predicted                                                                                   |
| `pnpm typecheck` / `pnpm lint` (all packages) | clean; exhaustiveness verified by deleting `agentId` and watching TS2741 fire                                                                                       |
| **`npx expo-doctor`**                         | **20/20, no New Architecture warning at all** — **D13's prediction confirmed**                                                                                      |
| **`npx expo prebuild --platform ios` + pods** | **succeeded on SDK 57** — **D10's read of `@config-plugins/react-native-webrtc` confirmed**                                                                         |
| Generated `Info.plist`                        | `UIBackgroundModes: ["audio"]` ✓, our `NSMicrophoneUsageDescription` survived the plugin ✓, and the plugin injected `NSCameraUsageDescription` exactly as predicted |
| `Podfile.lock`                                | `livekit-react-native 2.9.8`, `livekit-react-native-webrtc 137.0.3`, `WebRTC-SDK 137.7151.09` — the pinned set reached native                                       |
| `pnpm bundle` (`expo export --platform ios`)  | 4.3 MB Hermes bundle containing `LivekitReactNativeModule`                                                                                                          |

The generated `ios/` directory was **deleted afterwards** rather than kept: it had been prebuilt for
`preview` while `.env` says `development`, and leaving that mismatch on disk is the trap described at
the end of §4.2. `pnpm native` regenerates it consistently when a local build is wanted.

### Three source checks made before spending a build cycle

Each of these would have cost a 5-minute build plus a full test run to discover on the device.

- **Callbacks fire even though `startSession` is called with arguments.** `useConversation` registers
  them through `useRegisterCallbacks` (`useConversation.js`), separately from the session config, and
  `startSession` merges `{...hookDefaults, ...options}` after stripping `CALLBACK_KEYS` from the
  defaults only. Had it worked the other way, the scrollback would have been empty and the whole
  instrument silently dead.
- **`user_transcript` is handled in `BaseConversation.js`** — the transport-agnostic base — and emits
  `onMessage({ role: "user", … })`. So gate criterion 4 works on **WebRTC**, not only on the
  WebSocket transport the web app has proven in production.
- **`expo-dev-launcher` declares `"debugOnly": true`** for Apple, so Expo autolinking excludes it
  from Release builds entirely. **This retires most of D12's stated cost:** a `preview` build does
  not contain the dev client at all, so it is not a candidate cause for an S1a crash. The one thing
  installing it added to the release build is an `NSLocalNetworkUsageDescription` string from its
  config plugin — the same class of harmless wart as the WebRTC plugin's `NSCameraUsageDescription`.

### What this does not tell us

Every check above is static. None of them says whether audio survives a locked screen, whether the
session reconnects after a Siri interruption, or whether `onConnect` reports a `conv_*` id — those
need the device, a `preview` build, and no debugger (§6.1).

### Unrelated pre-existing issue, found while checking

`pnpm lint` **at the repo root** fails with `Command "eslint" not found` even though
`pnpm -r lint` passes and all three packages lint clean. Verified against a stashed, clean tree:
**this predates S1 and is not caused by it.** Worth a one-line fix, but not in this stage's scope.

---

## 10. Result — B2 is answered

**Tests A–E all passed**, including the uplink criterion added the same day. The session survives a
locked screen, the agent stays audible, and **speech into a locked phone reaches the agent and is
answered** — which is the half that would have made a "pass" worthless for a tutor.

What this closes:

- **B2 is no longer a risk.** The mechanism reasoned about in creation doc §9 B2 holds on our actual
  stack: SDK 57 / RN 0.86, `@livekit/react-native@2.9.8` with its one-shot `getUserMedia` category
  shim (§3.2), `UIBackgroundModes: ["audio"]`, on iOS 26.4.
- **The escalation ladder (§8) was not needed at any rung.** No `useIOSAudioManagement` fallback, no
  move to LiveKit 2.12.0, and — the expensive one — **no CallKit**. S4's estimate stands as written.
- **Test E passed**, which was the outcome §3.2 flagged as least certain: 2.9.8 sets the audio
  category once and never re-applies it, so interruption recovery was the place that version choice
  was most exposed. It recovered anyway.

**One caveat on the record.** All of this is one device, iOS 26.4 (S0 §9). iOS 16.4–18 behaviour
remains unobserved, and the probe screen is kept precisely so this is re-runnable when that changes.

⚠️ **The numbers were not captured.** The gate says to record the actual `max drift` per test, because
0.4s and 2.9s both pass and say very different things about headroom — and appendix B in the build
plan is the table for it. The pass is recorded; the margins are not, so nothing here says how much
headroom we have. Worth capturing on the next run of the probe.

---

## 11. Found while testing — the 600-second ceiling is ours, not Apple's

**Symptom:** the agent disconnected at exactly 600 seconds. That is
`conversation_config.conversation.max_duration_seconds`, whose default is 600 — flagged in §5.3
precisely so a session dying at 10:00 would not be misread as a B2 failure. It is a server-side
config limit and has nothing to do with iOS suspension.

**The real bounds, from the API rather than the docs.** ElevenLabs' published documentation does not
state a maximum, and neither does the OpenAPI schema (`integer`, `default: 600`, no `maximum`). The
API itself does, on rejection:

```text
Max duration in seconds has to be between 60 and 7200 seconds.
```

So: **60 s minimum, 7200 s (2 hours) maximum, 600 s default.** Established by PATCHing the throwaway
S1 agent — 3600 ✅, 7200 ✅, 86400 ✗ — which also left that agent at 7200 so long probe runs are not
cut short.

**Every tutor agent is on the 600 s default, and nothing in the repo sets it.** Audited via the API
on 2026-08-13:

| Agent     | `max_duration_seconds` | `enable_auth` |
| --------- | ---------------------- | ------------- |
| words-1.0 | 600                    | false         |
| words-1.1 | 600                    | false         |
| words-1.2 | 600                    | false         |
| words-1.3 | 600                    | false         |

`agentBody()` in `apps/web/src/agent/sync-agents.ts` writes only `agent`, `tts` and
`language_presets` — there is no `conversation` or `turn` block at all, so the registry does not
manage these fields and the dashboard is the only place they exist. **A real lesson is therefore cut
off at ten minutes**, on web today and on mobile at S4.

### Resolved 2026-08-13 — `maxDurationSeconds` is now a registry field, set to 1800

**Two functions had to change, not one.** `hashConfig()` hashed
`version / prompt / llm / voiceId / ttsModelId / additionalLanguages`. A field added to `agentBody()`
but not to the hash would never trigger a PATCH — `pnpm sync:agents` would report "unchanged" while
the agent kept the old value, which is exactly the silent-drift failure the lockfile exists to
prevent. Both were changed together, and `agentBody()`'s new `conversation` block carries a comment
pointing at the hash for the next person.

| Change                                      | Where                                              |
| ------------------------------------------- | -------------------------------------------------- |
| `maxDurationSeconds?: number` (per version) | `prompts/types.ts`                                 |
| `DEFAULT_MAX_DURATION_SECONDS = 1800`       | `prompts/index.ts`, applied by `effectiveConfig()` |
| `conversation.max_duration_seconds`         | `sync-agents.ts` → `agentBody()`                   |
| the same field in the config hash           | `sync-agents.ts` → `hashConfig()`                  |

**Why 1800 and not the 7200 maximum.** Thirty minutes clears any realistic lesson, and the value is
also the **cost backstop**: ElevenLabs bills per minute of conversation, so this is what bounds a
session the learner walked away from without ending. Taking the maximum because it exists would turn
a forgotten tab into two hours of billed audio.

**Applied and verified.** `pnpm sync:agents` updated all four agents in place (ids unchanged, so
history and analytics survive); the API now reports `max_duration_seconds: 1800` for words-1.0
through words-1.3 with prompts and LLM untouched; and a re-run of `pnpm sync:agents:plan` reports
**"nothing to do"**, which is the check that the hash and the body actually agree.

**Per-session override is not a shortcut here.** `max_duration_seconds` carries
`"x-convai-client-override": true` in the schema, but the agents have
`platform_settings.overrides.conversation_config_override.conversation.max_duration_seconds = false`
(the default), and the JS SDK's typed `overrides` does not expose the field either. Setting it on the
agent is the practical route.

### `enable_auth: false` on the tutor agents — reviewed, and kept, deliberately

All four tutor agents are publicly connectable by agent id. This was raised on 2026-08-13 and the
decision is to **leave it as is**; it is recorded here so it reads as a choice rather than an
oversight, and it is not to be re-raised.

The context that made it a reasonable call: the web app never sends an agent id to the browser —
`lessons/[id]/page.tsx` maps `versions` to `{version, label}` and drops `agentId` before it reaches
`LessonTutor`, which connects by `signedUrl`. The ids are committed in `agents.lock.json`, so the
exposure is bounded by repo access.

---

## 12. What S1 hands to S2

Record these when the gate is decided, green or red.

- [ ] **The verdict and the numbers** — appendix B filled in for A–E, plus the foreground noise floor.
      Numbers, not ticks.
- [ ] **Which LiveKit rung we ended on** (2.9.8 as installed / `useIOSAudioManagement` added / 2.12.0
      / CallKit), and whether `pnpm why livekit-client` still shows exactly one copy.
- [ ] **Confirmation that `pnpm native && pnpm device:release` works** — S0 never ran it, and S2 will
      want a local loop for the Auth0 callback round-trip.
- [ ] **The `development` profile and dev client are still unbuilt and unverified** (D12) —
      `expo-dev-client` is installed but was never exercised. S2 inherits this untouched, exactly as
      S1 inherited it from S0, and should build it before depending on a fast local loop.
- [ ] **`apps/mobile/env.config.ts` as it stands** — the committed list of what the app depends on
      per variant (§4.2). S2 adds the three Auth0 fields to `MobileEnv`, which forces all three
      variants to supply them.
- [ ] **The observed `AppState` sequences** for lock / app-switch / Siri — S4's session UI is written
      against these, and they are cheap to record now and expensive to guess later.
- [ ] **Whether `onConnect`'s `conversationId` matched `/^conv_/`** and what it was when it did not.
      This is B3's hazard seen for free; S3 acts on it.
- [ ] **Whether `expo-doctor` printed the New-Architecture warning** — D13 predicts it will not.
      If it did, that prediction was wrong and S2 should not inherit it as settled.
- [ ] **The three bundle identifiers and their schemes** (S0 §2 D7) — S2 needs all three callback
      URLs, comma-separated in one Auth0 Native application:
      `englishtutordev://{domain}/ios/work.kovalchuk.yurii.english-tutor-dev/callback`,
      `englishtutorpreview://…-preview/callback`, `englishtutor://…english-tutor/callback`.
      S2's `react-native-auth0` plugin entry must read `variant.scheme`, never a literal.
- [ ] **The throwaway agent's id and its settings** — S3 replaces it with a real private agent via the
      token route; leaving a public agent connectable after that is a loose end, so note it for
      deletion.

---

## Sources

- **Read directly from published package sources on 2026-08-13** (the basis for §2 D10 and §3):
  `@elevenlabs/react-native@1.2.18` (`src/index.react-native.ts`, `src/nativeVolume.ts`),
  `@elevenlabs/client@1.17.0` (its exact `livekit-client: 2.16.1` dependency),
  `@livekit/react-native@2.9.8` and `@2.12.0` (`src/index.tsx`, `src/audio/AudioSession.ts`,
  `src/audio/AudioManager.ts`, `ios/LiveKitReactNativeModule.swift`),
  `@livekit/react-native-webrtc@137.0.3` and `@144.1.2` (`src/MediaStreamTrack.ts`),
  `@config-plugins/react-native-webrtc@15.0.1` (`build/withWebRTC.js`, `withPermissions.js`,
  `withBitcodeDisabled.js`), `@livekit/react-native-expo-plugin@1.0.2` (`plugin/src/index.ts`).
- [react-native-webrtc#1467](https://github.com/react-native-webrtc/react-native-webrtc/issues/1467)
  — track presence, not audio content, is what keeps iOS from suspending after ~40s.
- [livekit/client-sdk-react-native#255](https://github.com/livekit/client-sdk-react-native/issues/255)
  — closed; was about `expo-doctor` metadata, not capability.
- [React Native Directory API](https://reactnative.directory/api/libraries?search=livekit) — both
  LiveKit packages now `newArchitecture: true`, "supported through the compatibility layer for
  legacy native modules" (D13).
- [React Native 0.82 — A New Era](https://reactnative.dev/blog/2025/10/08/react-native-0.82) and
  [Expo — React Native's New Architecture](https://docs.expo.dev/guides/new-architecture/) — the
  Legacy Architecture is removed; `newArchEnabled: false` is silently ignored from 0.82 on (D13).
- [Apple / Radius Networks — debugging iOS apps in the background](https://developer.radiusnetworks.com/2014/11/07/debugging-ios-in-background.html)
  — the debugger prevents suspension; run from the home screen to observe real behaviour (§6.1).
- [ElevenLabs — Expo / React Native integration guide](https://elevenlabs.io/docs/eleven-agents/guides/integrations/expo-react-native)
  — the reference plugin list and `startSession({ agentId })` shape (it documents neither
  `UIBackgroundModes` nor versions; §4.1 adds both).
- [Expo — EAS environment variables](https://docs.expo.dev/eas/environment-variables/) —
  `eas env:set`, visibility levels and the `environment` field on a build profile. Read, then
  **deliberately not used**: §4.2 explains why committed per-variant config beats dashboard state.
- [ElevenLabs — agent authentication](https://elevenlabs.io/docs/agents-platform/customization/authentication)
  (`platform_settings.auth.enable_auth`, allowlists) and
  [create-agent API reference](https://elevenlabs.io/docs/api-reference/agents/create)
  (`conversation_config.turn.silence_end_call_timeout` default `-1`,
  `conversation_config.conversation.max_duration_seconds` default `600`,
  `conversation_config.turn.turn_timeout` default `7`) — §5.3.
- In-repo: `apps/web/src/agent/sync-agents.ts` — the `conversation_config` body shape, and the fact
  that its prune/orphan logic only ever touches agents listed in `agents.lock.json` (§5.3).
- In-repo: `docs/2026-08-12-expo-app-creation.md` §7 (scaffold), §9 B2 (mechanism — see §3 for what
  is superseded) and §9 B3 (the `conversation_id` hazard) ·
  `docs/2026-08-12-expo-build-plan.md` S1 + appendices A and B ·
  `docs/2026-08-13-expo-s0-scaffold-testflight.md` §2 (D7–D9) and §9.
