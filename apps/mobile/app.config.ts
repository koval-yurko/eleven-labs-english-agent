import type { ExpoConfig } from "expo/config";

// Type-only, therefore erased before Node loads this file. A relative import of a .ts module with
// runtime VALUES does not work here: Expo's config loader transpiles this entry file and nothing
// else, so such an import resolves to raw TypeScript and fails with "Unexpected token 'export'".
import type { MobileEnv, Variant, VariantIdentity } from "./env.types";

// ── Identity: committed on purpose ───────────────────────────────────────────────────────────
// One EAS project ("English Tutor", slug english-tutor), three identities. This is build-time
// identity rather than configuration: it decides WHICH app is produced, and a build that silently
// ships under the wrong bundle id is the expensive failure. Nothing here is environment data.
// See docs/2026-08-13-expo-s0-scaffold-testflight.md §2 (D7).
const VARIANTS = {
  development: { suffix: "-dev", name: "English Tutor (Dev)", scheme: "englishtutordev" },
  preview: { suffix: "-preview", name: "English Tutor (Preview)", scheme: "englishtutorpreview" },
  production: { suffix: "", name: "English Tutor", scheme: "englishtutor" },
} satisfies Record<Variant, VariantIdentity>;

// ── Values: never committed ──────────────────────────────────────────────────────────────────
// Every runtime value comes from the environment:
//   local run + local build → apps/mobile/.env  (gitignored; .env.example documents the full set)
//   EAS build               → EAS environment variables, selected by each build profile's
//                             `environment` field in eas.json
//
// `satisfies Record<keyof MobileEnv, string>` is what keeps this honest: adding a field to
// MobileEnv is a compile error until it is given a variable name here. The LIST of what the app
// depends on therefore still lives in code and is reviewable, even though the values do not.
//
// The EXPO_PUBLIC_ prefix is a statement of fact rather than a convention: these values are
// embedded in the app manifest and readable by anyone holding the .ipa. Keeping them out of the
// repo is reasonable hygiene, but it is not confidentiality — an Auth0 Native client id is a public
// client by design (PKCE, no secret). Real secrets never reach a client at all, which is why the
// token route exists (docs/2026-08-12-expo-app-creation.md §3.5).
const ENV_VARS = {
  auth0Domain: "EXPO_PUBLIC_AUTH0_DOMAIN",
  auth0ClientId: "EXPO_PUBLIC_AUTH0_CLIENT_ID",
  auth0Audience: "EXPO_PUBLIC_AUTH0_AUDIENCE",
  apiBaseUrl: "EXPO_PUBLIC_API_BASE_URL",
} as const satisfies Record<keyof MobileEnv, string>;

/**
 * Read the runtime values out of the environment.
 *
 * A missing variable becomes "" and warns rather than throwing, so a build is never blocked by a
 * value the current stage has not reached yet — `apiBaseUrl` before the server is deployed, for
 * instance. The guarantee is moved rather than lost: `src/env.ts` throws on first USE of an empty
 * value, naming the variable. Warn at build time, fail at use time.
 */
function readEnv(variantKey: Variant): MobileEnv {
  const entries = Object.entries(ENV_VARS) as [keyof MobileEnv, string][];
  const env = {} as Record<keyof MobileEnv, string>;
  const missing: string[] = [];

  for (const [field, name] of entries) {
    const value = process.env[name]?.trim() ?? "";
    if (!value) missing.push(name);
    env[field] = value;
  }

  if (missing.length > 0) {
    console.warn(
      `[app.config] APP_VARIANT=${variantKey}: not set — ${missing.join(", ")}. ` +
        `Local builds read apps/mobile/.env (copy .env.example); EAS builds read EAS environment ` +
        `variables via the profile's "environment" field. Unset values throw on first use.`,
    );
  }
  return env;
}

// Unset means production, deliberately: `npx testflight` and `expo prebuild` set nothing, and a
// build that silently ships under a -dev identity is the expensive failure. An unrecognised value
// is a hard stop rather than a fallback.
const key = (process.env.APP_VARIANT ?? "production") as Variant;
if (!(key in VARIANTS)) {
  throw new Error(
    `Unknown APP_VARIANT: ${key}. Expected one of ${Object.keys(VARIANTS).join(", ")}, or unset for production.`,
  );
}
const variant = VARIANTS[key];

const bundleIdentifier = `work.kovalchuk.yurii.english-tutor${variant.suffix}`;
// ── The App Group ────────────────────────────────────────────────────────────────────────────
// The one channel between the app and its lock-screen extension, and therefore named in exactly
// one place. It is per-variant because the bundle identifier is: a dev build sharing a container
// with a preview build would let one write intents the other drains.
//
// This value must ALSO exist on the Apple Developer portal and be attached to both bundle ids.
// A group that is declared here but not registered there does not error — `UserDefaults(suiteName:)`
// returns a private store and every cross-process read comes back nil, forever.
// The `group.${bundleIdentifier}` SHAPE is load-bearing, not cosmetic: `ControlChannel.appGroup`
// in targets/controls/ControlIntents.swift re-derives this name from each binary's own bundle id
// rather than reading it from a plist, because the extension's Info.plist is its own and cannot
// carry a per-variant value. Change the shape here and the Swift derivation must change with it.
// See docs/2026-08-16-background-controls-lock-screen.md §9.
const appGroup = `group.${bundleIdentifier}`;

const config: ExpoConfig = {
  name: variant.name,
  slug: "english-tutor", // one EAS project — never varies
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: variant.scheme, // deep links; separate from Auth0's callback scheme (S2 D14)
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier,
    icon: "./assets/expo.icon",
    // Required by @bacons/apple-targets, which warns without it and produces a controls extension
    // Xcode cannot sign. Identity, not a secret: the same team id eas.json already commits under
    // submit.production, and readable from any shipped .ipa.
    appleTeamId: "4FWU8YBV4X",
    // Mirrored automatically into the controls target by @bacons/apple-targets, which is why the
    // target's own config does not repeat it. `targets/controls/expo-target.config.js` explains why
    // repeating it would be worse than not.
    entitlements: {
      "com.apple.security.application-groups": [appGroup],
    },
    infoPlist: {
      // Export compliance: nothing beyond standard HTTPS. Without it every upload lands in App
      // Store Connect as "Missing Compliance". A legal declaration — see the S0 doc §5.
      ITSAppUsesNonExemptEncryption: false,
      // S1. The SDK triggers the OS prompt itself from AudioSession.configureAudio(); there is no
      // pre-flight permission call, so a denial surfaces as a session error rather than a prompt.
      NSMicrophoneUsageDescription: "Used to talk with your English tutor.",
      // The whole point of S1 — see docs/2026-08-13-expo-s1-background-audio.md. Without this iOS
      // suspends the app seconds after the screen locks and the conversation dies mid-sentence.
      UIBackgroundModes: ["audio"],
      // The lock-screen controls (docs/2026-08-16-background-controls-lock-screen.md). Without this
      // key `Activity.request` throws at runtime with no build-time warning.
      NSSupportsLiveActivities: true,
    },
    // S7 (D69). Expo does NOT generate PrivacyInfo.xcprivacy — this key is the only way to get one,
    // and a build without the required reason codes is rejected by an automated email minutes after
    // upload, before any human review. Apple's tooling does not reliably read the manifests that
    // static CocoaPods dependencies ship, so the app must REPEAT what its dependencies declare.
    //
    // Every code below was read out of an installed PrivacyInfo.xcprivacy, not guessed:
    //   FileTimestamp  0A2A.1, 3B52.1 ← expo-file-system   C617.1 ← react-native core, Folly, glog
    //   DiskSpace      E174.1, 85F4.1 ← expo-file-system
    //   SystemBootTime 35F9.1         ← expo-device, react-native/react/timing, boost
    //   UserDefaults   CA92.1         ← expo-constants, expo-system-ui, react-native core
    //
    // This is a snapshot of an installed tree, not a law. expo-sqlite, expo-crypto, the two LiveKit
    // packages and react-native-auth0 currently ship no manifest at all. Re-run
    //   find apps/mobile/node_modules -name PrivacyInfo.xcprivacy
    // after any dependency upgrade and widen the union if it grew.
    // See docs/2026-08-13-expo-s7-ship.md §5.2.
    privacyManifests: {
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryFileTimestamp",
          NSPrivacyAccessedAPITypeReasons: ["0A2A.1", "3B52.1", "C617.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryDiskSpace",
          NSPrivacyAccessedAPITypeReasons: ["E174.1", "85F4.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime",
          NSPrivacyAccessedAPITypeReasons: ["35F9.1"],
        },
        {
          NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults",
          NSPrivacyAccessedAPITypeReasons: ["CA92.1"],
        },
      ],
    },
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      { backgroundColor: "#208AEF", image: "./assets/images/splash-icon.png", imageWidth: 76 },
    ],
    // S1, in the order the official ElevenLabs Expo example lists them. The LiveKit plugin is a
    // no-op on iOS (it only writes Android manifest meta-data); the WebRTC one fills in Info.plist
    // usage strings we already set, and disables bitcode, which no longer exists on Xcode 26. Both
    // are kept for fidelity with the reference configuration rather than for what they do.
    "@livekit/react-native-expo-plugin",
    "@config-plugins/react-native-webrtc",
    // SPIKE ONLY — path A of docs/2026-08-27-vapi-third-voice-provider.md. Daily's plugin, which
    // @vapi-ai/react-native needs because its SDK is a Daily wrapper.
    //
    // Note what sits directly above it: `@config-plugins/react-native-webrtc` is already here for
    // LiveKit. Two WebRTC config plugins in one list is the shape of the whole problem — see §12.
    // This plugin peers `expo: ^55` and we are on 57, which is its own smell.
    //
    // NEVER MERGE. This branch exists to be built once and thrown away.
    "@daily-co/config-plugin-rn-daily-js",
    // S2. `domain` only — NO customScheme, deliberately. Without one the plugin registers
    // `{bundleIdentifier}.auth0` as the callback scheme, which is already unique per variant (the
    // bundle id is) and keeps OAuth callbacks out of the same namespace as the app's own
    // expo-router deep links. See docs/2026-08-13-expo-s2-auth0-bearer.md §2 D14.
    //
    // On iOS the domain is only written into the Android manifest by this plugin, so an unset value
    // does not affect the iOS callback scheme — which is derived from the bundle identifier.
    ["react-native-auth0", { domain: process.env.EXPO_PUBLIC_AUTH0_DOMAIN ?? "" }],
    // S8. Generates the `controls` widget extension from targets/controls/ at prebuild, and — the
    // part that is easy to miss — registers it under
    // `extra.eas.build.experimental.ios.appExtensions` so EAS signs the second bundle id without
    // the credentials file having to be restructured by hand.
    "@bacons/apple-targets",
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: {
    eas: { projectId: "6a38b3eb-8751-43eb-bb09-860d58ec4a68" },
    // The whole per-variant object, never spread key by key — src/env.ts reads it back as one
    // shape. See docs/2026-08-13-expo-s2-auth0-bearer.md §3.2.
    env: readEnv(key),
  },
};

export default config;
