// IMPORTANT: import from "@elevenlabs/react-native", never "@elevenlabs/react". The React Native
// entrypoint has module-scope side effects — it calls LiveKit's registerGlobals() (which installs
// the WebRTC polyfills and the getUserMedia shim that sets the iOS audio category to playAndRecord)
// and registers the RN session-setup strategy. Importing the web package skips all of it.
import { ConversationProvider } from "@elevenlabs/react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Appearance } from "react-native";
import { Auth0Provider } from "react-native-auth0";

import { env } from "@/env";
import { reconcileAtLaunch } from "@/lib/lesson-card";
import { TutorSessionProvider } from "@/lib/tutor-session";
import { useScheme, useTheme } from "@/theme";
import { NavProgressBar, SessionBar } from "@/ui";

/**
 * The root layout: providers, the status bar, one stack, and the progress bar above it.
 *
 * **The navigator theme is gone.** This used to build a react-navigation `Theme` from the palette
 * and install expo-router's `ThemeProvider`, so the native `Stack` headers and back chevrons took
 * the app's colours (S7 D72). There are no native headers any more — every screen draws the web's
 * `<header>` inside its own content (`ui/Screen.tsx`), and `headerShown: false` is set on all of
 * them. All the navigator still paints is the background behind a push transition, which is what
 * `contentStyle` below is for; a whole `ThemeProvider` to colour a chevron that no longer exists
 * would be scaffolding around an absence.
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §5.1, §8.1.
 */
export default function RootLayout() {
  const scheme = useScheme();
  const theme = useTheme();

  /**
   * Tell iOS which appearance the app is actually in.
   *
   * `app.config.ts` declares `userInterfaceStyle: "automatic"`, which means "this app supports both
   * appearances" — and left alone, iOS resolves that against the SYSTEM setting. The app no longer
   * follows the system: it paints from a stored preference the learner sets in the header. So a
   * phone in light mode with the app toggled to dark would draw a **light keyboard** over a dark
   * screen, along with light native alerts and share sheets. That is the same complaint
   * `theme.ts` used to make about the pre-S7 app — "it told iOS it supported both appearances and
   * then painted one" — reappearing from the other side.
   *
   * `Appearance.setColorScheme` sets `overrideUserInterfaceStyle` on the window, which is exactly
   * the missing half: the declaration stays "automatic", and this says which one is current. It has
   * to live in an effect rather than in `setScheme` so that it also runs at launch, for the
   * preference that was read synchronously at module load.
   */
  useEffect(() => {
    Appearance.setColorScheme(scheme);
  }, [scheme]);

  /**
   * End any lock-screen card left behind by a previous run of the app.
   *
   * Apple asks for exactly this and the app never did it: "when the app launches the next time,
   * check if any activities are still active … and end any Live Activity that's no longer
   * relevant". At launch every card of ours qualifies — a tutor session lives in the process, so a
   * new process means the session behind any surviving card is gone.
   *
   * Here rather than in the lesson screen, because this is the one component that mounts once per
   * process and the lesson screen is the one that mounts once per lesson. That distinction is the
   * whole of complaint 2 in
   * docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md — §2.1 and §2.7.
   *
   * Empty dependency array, and it must stay that way: this is "once per process", not "whenever
   * something changes". `reconcileAtLaunch` shares a queue with the card's other callers, so a
   * lesson screen mounting immediately afterwards is ordered behind it rather than racing it.
   */
  useEffect(() => {
    void reconcileAtLaunch();
  }, []);

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
        {/*
          The tutor session, above the router.

          It has to be here and not in the lesson screen: `useConversation` unregisters its callbacks
          when the component holding them unmounts, so a screen-owned session stopped collecting its
          transcript — and stopped being controllable — the moment the learner navigated. Mounted
          INSIDE `ConversationProvider` (it consumes the SDK context) and OUTSIDE `Stack` (so a push
          or a pop cannot touch it). See `lib/tutor-session.tsx`.
        */}
        <TutorSessionProvider>
          {/* The clock and battery. `style` names the CONTENT colour, so it is the inverse of the
              background: dark glyphs on a light screen. Without this the status bar keeps its
              light glyphs and vanishes into a white page. */}
          <StatusBar style={scheme === "light" ? "dark" : "light"} />
          <Stack
            screenOptions={{
              // Set here AND in `Screen`, deliberately: this is what stops a native header flashing
              // during the first frame of a push, before the screen's own `Stack.Screen` applies.
              headerShown: false,
              // The only colour the navigator still owns — without it a push slides the new screen in
              // over white, which reads as a flash on a dark theme.
              contentStyle: { backgroundColor: theme.bg },
            }}
          />
          {/* The way back to a lesson that is still talking. It is also the answer to the objection
              the old unmount guard raised — a live, billed session with nothing on screen saying so —
              now that navigating away no longer ends one. */}
          <SessionBar />
          {/* Last, so it paints over the navigator rather than under it — the web's `.nav-progress`
              is `position: fixed` with `z-index: 100` for the same reason. */}
          <NavProgressBar />
        </TutorSessionProvider>
      </ConversationProvider>
    </Auth0Provider>
  );
}
