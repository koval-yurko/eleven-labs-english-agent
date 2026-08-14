// Types only — no runtime values, so `app.config.ts` can `import type` from here and Expo's config
// loader (which transpiles the entry config but NOT its imports) erases it before Node ever sees a
// module specifier. The values themselves live in the VARIANTS map in app.config.ts.
//
// See docs/2026-08-13-expo-s1-background-audio.md §4.2.

export type Variant = "development" | "preview" | "production";

/**
 * Every per-variant value the app reads AT RUNTIME, delivered through `extra.env`.
 *
 * Adding a field here forces all three variants to supply it — `VARIANTS` is checked against
 * `Record<Variant, VariantConfig>`, so a value that exists in preview but not in production is a
 * compile error, not a runtime surprise on the one build you cannot iterate on.
 *
 * Nothing here may be a secret: `extra` is embedded in the app manifest and readable by anyone
 * holding the .ipa. That costs nothing, because the mobile app has no secrets by construction —
 * the v2 token route exists so it never holds ELEVENLABS_API_KEY or the Supabase service-role key
 * (creation doc §3.5). A real secret does not belong in the client at all.
 */
export type MobileEnv = {
  // S1's `agentId` is GONE, deleted by S3 as planned. The app never learns an agent id: it names a
  // VERSION and `POST /api/v2/words-agent/token` resolves version → agent server-side. That seam is
  // what lets `pnpm sync:agents` retire a version without bricking installed binaries — an agent id
  // compiled into a shipped app cannot be changed without a release.

  // ── S2: Auth0 ──────────────────────────────────────────────────────────────────────────────
  /** Auth0 tenant, e.g. "your-tenant.eu.auth0.com". The server derives `iss` from the same. */
  auth0Domain: string;
  /**
   * The **Native** Auth0 application's client id — a second app beside the web Regular Web App.
   * One Native application serves all three variants; they differ only by callback URL, which the
   * SDK derives from the bundle identifier. So this value is identical across variants by design.
   */
  auth0ClientId: string;
  /**
   * The Auth0 API "Identifier" — requested via `authorize({ audience })` and matched byte-for-byte
   * against the token's `aud` claim by the server's `AUTH0_API_AUDIENCE`. It is an opaque string,
   * never fetched, and needs no DNS.
   */
  auth0Audience: string;
  /**
   * Origin the `/api/v2/*` routes are called on, with no trailing slash.
   *
   * `required()` throws rather than letting a build silently point at nothing. A LAN `http://`
   * address is not an option: App Transport Security blocks cleartext in a Release build (S2 §6).
   */
  apiBaseUrl: string;
  // No `appEnv` here, deliberately: it is the SERVER's value, returned by the token route and
  // stamped onto the conversation from there. A client-side copy could disagree with the server
  // that routes the post-call webhook, which is exactly the bug the required field exists to stop.
};

/**
 * One variant's build-time IDENTITY — committed, because it decides which app is produced.
 *
 * Values are deliberately not here: they come from the environment (`.env` locally, EAS environment
 * variables in the cloud) and are assembled in `app.config.ts`'s `readEnv()`.
 */
export type VariantIdentity = {
  /** Appended to the bundle identifier. */
  suffix: string;
  name: string;
  /** Deep-link scheme for expo-router. Separate from Auth0's callback scheme (S2 D14). */
  scheme: string;
};
