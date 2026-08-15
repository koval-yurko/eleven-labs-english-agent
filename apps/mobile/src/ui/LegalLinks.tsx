import * as WebBrowser from "expo-web-browser";
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { env } from "@/env";
import { useTheme } from "@/theme";
import { type Palette } from "@tutor/shared/theme";
import { Button } from "./Button";
import { space } from "./tokens";

/**
 * Privacy and Support — the web's two public pages, opened rather than reimplemented.
 *
 * These are the only pages the web has that this app does not, and they are the one gap the port
 * deliberately closes with a link instead of a screen. `apps/web/src/app/{privacy,support}/page.tsx`
 * are static prose, exempted from the Auth0 gate in `proxy.ts` because App Store Connect requires a
 * support URL and a privacy URL it can reach without a session (S7 §5.3).
 *
 * Copying that prose into two native screens would put the app's *policy* in two places, and
 * CLAUDE.md's test answers this one cleanly: a wrong sentence in a privacy policy **is** fixable by
 * deploying the web app alone, so it belongs on the server and the client should reach it over
 * HTTP. A native copy would also be the version that quietly goes stale, since the App Store links
 * to the web one either way.
 *
 * `openBrowserAsync` is an SFSafariViewController — it keeps the learner inside the app, and it
 * costs no dependency (`expo-web-browser` is already here for the Auth0 flow).
 *
 * See docs/2026-08-15-web-design-parity-on-mobile.md §8.7.
 */
export function LegalLinks() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  function open(path: "/privacy" | "/support") {
    // Fire-and-forget: a browser that fails to open is not worth an error state on a settings row.
    void WebBrowser.openBrowserAsync(`${env.apiBaseUrl}${path}`, {
      // Match the app rather than flashing the system default before the page paints.
      toolbarColor: theme.bg,
      controlsColor: theme.accent,
    });
  }

  return (
    <View style={styles.row}>
      <Button variant="inline" label="Privacy" onPress={() => open("/privacy")} />
      <Button variant="inline" label="Support" onPress={() => open("/support")} />
    </View>
  );
}

const makeStyles = (_t: Palette) =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", gap: space.navGap, marginTop: space.row },
  });
