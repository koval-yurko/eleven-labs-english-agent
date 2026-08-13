import type { ExpoConfig } from "expo/config";

// Type-only, therefore erased before Node loads this file. A relative import of a .ts module with
// runtime values does NOT work here: Expo's config loader transpiles this entry file and nothing
// else, so the import would resolve to raw TypeScript and fail with "Unexpected token 'export'".
// That is why the values below are inline rather than in their own module.
import type { Variant, VariantConfig } from "./env.types";

// One EAS project ("English Tutor", slug english-tutor), three identities — and the per-variant
// runtime values that ship with each of them.
//
// THIS MAP IS THE ANSWER to "which values does the app depend on, and what are they in each
// environment?" — a question you should be able to answer from a checkout, not by logging into the
// EAS dashboard. That is why no value here comes from `eas env:set` or an `EXPO_PUBLIC_*` variable.
// See docs/2026-08-13-expo-s0-scaffold-testflight.md §2 (D7) and
// docs/2026-08-13-expo-s1-background-audio.md §4.2.
//
// `satisfies` rather than a type annotation, so the literal types survive for `variant.scheme`
// while every variant is still forced to supply every field.
const VARIANTS = {
  development: {
    suffix: "-dev",
    name: "English Tutor (Dev)",
    scheme: "englishtutordev",
    env: { agentId: "agent_6101kzxdc7esesarwx8x8d9716xr" },
  },
  preview: {
    suffix: "-preview",
    name: "English Tutor (Preview)",
    scheme: "englishtutorpreview",
    env: { agentId: "agent_6101kzxdc7esesarwx8x8d9716xr" },
  },
  production: {
    suffix: "",
    name: "English Tutor",
    scheme: "englishtutor",
    // Deliberately empty: no publicly-connectable agent ever ships to production. A production
    // build that reaches the probe screen throws at first use, by design — see src/env.ts.
    env: { agentId: "" },
  },
} satisfies Record<Variant, VariantConfig>;

// Unset means production, deliberately: `npx testflight` and `expo prebuild` set nothing, and a
// build that silently ships under a -dev identity is the expensive failure. An unrecognised value
// is a hard stop rather than a fallback.
const key = (process.env.APP_VARIANT ?? "production") as Variant;
if (!(key in VARIANTS)) {
  throw new Error(
    `Unknown APP_VARIANT: ${key}. Expected one of ${Object.keys(VARIANTS).join(", ")}, or unset for production.`,
  );
}
const variant = VARIANTS[key as keyof typeof VARIANTS];

const config: ExpoConfig = {
  name: variant.name,
  slug: "english-tutor", // one EAS project — never varies
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: variant.scheme, // deep links; Auth0's customScheme must match this (S2)
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: `work.kovalchuk.yurii.english-tutor${variant.suffix}`,
    icon: "./assets/expo.icon",
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
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: {
    eas: { projectId: "6a38b3eb-8751-43eb-bb09-860d58ec4a68" },
    // The whole per-variant object, never spread key by key — src/env.ts reads it back as one
    // shape. See docs/2026-08-13-expo-s1-background-audio.md §4.2.
    env: variant.env,
  },
};

export default config;
