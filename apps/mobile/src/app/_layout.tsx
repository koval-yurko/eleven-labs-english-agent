// IMPORTANT: import from "@elevenlabs/react-native", never "@elevenlabs/react". The React Native
// entrypoint has module-scope side effects — it calls LiveKit's registerGlobals() (which installs
// the WebRTC polyfills and the getUserMedia shim that sets the iOS audio category to playAndRecord)
// and registers the RN session-setup strategy. Importing the web package skips all of it.
import { ConversationProvider } from "@elevenlabs/react-native";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type Theme } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { Auth0Provider } from "react-native-auth0";

import { env } from "@/env";
import { useScheme, useTheme, type Palette } from "@/theme";

/**
 * Give the navigator our palette instead of its own — S7 (D72).
 *
 * `ThemeProvider` comes from **`expo-router`**, not `@react-navigation/native`. SDK 57's router does
 * not depend on that package at all: its navigation dependency is `standard-navigation` and it
 * *vendors* a react-navigation fork, re-exporting `ThemeProvider` / `DarkTheme` / `DefaultTheme` /
 * `useTheme` from `build/exports.d.ts`. Installing `@react-navigation/native` to get them would put
 * a second, unrelated copy of the library in the bundle and the provider would talk to a context
 * the router never reads.
 *
 * Spreading a base theme rather than writing one from scratch keeps `fonts` — a required field of
 * the navigator's `Theme`, and one with nothing to do with colour.
 */
function navTheme(scheme: "light" | "dark", palette: Palette): Theme {
  const base = scheme === "light" ? DefaultTheme : DarkTheme;
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: palette.accent, // back-chevron and header buttons
      background: palette.bg,
      card: palette.bg, // the header bar itself — flush with the screen, not a distinct band
      text: palette.text,
      border: palette.border,
      notification: palette.danger,
    },
  };
}

export default function RootLayout() {
  const scheme = useScheme();
  const palette = useTheme();
  const theme = useMemo(() => navTheme(scheme, palette), [scheme, palette]);

  return (
    <Auth0Provider
      domain={env.auth0Domain}
      clientId={env.auth0ClientId}
      // DPoP is ON by default in react-native-auth0 v5. It binds tokens to a client key pair and
      // changes the wire format: `Authorization: DPoP <token>` plus a signed `DPoP` proof header
      // per request. Our server verifies a plain Bearer JWT (lib/auth/bearer.ts), so leaving this
      // at its default would produce 401s against a token that is otherwise perfectly valid.
      // Enabling it later is a deliberate hardening task that needs server-side proof validation
      // (RFC 9449) — not something to inherit from a default.
      useDPoP={false}
    >
      <ConversationProvider>
        <ThemeProvider value={theme}>
          {/* The clock and battery. `style` names the CONTENT colour, so it is the inverse of the
              background: dark glyphs on a light screen. Without this the status bar keeps its
              light glyphs and vanishes into a white header. */}
          <StatusBar style={scheme === "light" ? "dark" : "light"} />
          <Stack screenOptions={{ headerShown: false }} />
        </ThemeProvider>
      </ConversationProvider>
    </Auth0Provider>
  );
}
