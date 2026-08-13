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
  /**
   * ElevenLabs agent connected to directly by id, with no auth — the agent's
   * `platform_settings.auth.enable_auth` is false.
   *
   * S1 ONLY. S3 replaces this with the /api/v2 conversation-token route, which returns both the
   * token and the authoritative conversation_id, and this field is deleted. See S1 §2 D11.
   */
  agentId: string;
  // S2 adds: auth0Domain, auth0ClientId, auth0Audience
  // S3 adds: apiBaseUrl, appEnv
};

/** One variant's complete definition: build-time identity plus the runtime values it ships with. */
export type VariantConfig = {
  /** Appended to the bundle identifier. */
  suffix: string;
  name: string;
  /** Deep-link scheme; Auth0's customScheme must match it (S2). Lowercase, no separators. */
  scheme: string;
  /** The subset handed to the app at runtime as `extra.env`. */
  env: MobileEnv;
};
