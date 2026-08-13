import type { ExpoConfig } from "expo/config";

// One EAS project ("English Tutor", slug english-tutor), three identities.
// See docs/2026-08-13-expo-s0-scaffold-testflight.md §2 (D7).
const VARIANTS = {
  development: { suffix: "-dev", name: "English Tutor (Dev)", scheme: "englishtutordev" },
  preview: { suffix: "-preview", name: "English Tutor (Preview)", scheme: "englishtutorpreview" },
  production: { suffix: "", name: "English Tutor", scheme: "englishtutor" },
} as const;

// Unset means production, deliberately: `npx testflight` and `expo prebuild` set nothing, and a
// build that silently ships under a -dev identity is the expensive failure. An unrecognised value
// is a hard stop rather than a fallback.
const key = process.env.APP_VARIANT ?? "production";
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
    },
  },
  plugins: [
    "expo-router",
    [
      "expo-splash-screen",
      { backgroundColor: "#208AEF", image: "./assets/images/splash-icon.png", imageWidth: 76 },
    ],
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
  extra: { eas: { projectId: "6a38b3eb-8751-43eb-bb09-860d58ec4a68" } },
};

export default config;
