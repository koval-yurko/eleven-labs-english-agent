// IMPORTANT: import from "@elevenlabs/react-native", never "@elevenlabs/react". The React Native
// entrypoint has module-scope side effects — it calls LiveKit's registerGlobals() (which installs
// the WebRTC polyfills and the getUserMedia shim that sets the iOS audio category to playAndRecord)
// and registers the RN session-setup strategy. Importing the web package skips all of it.
import { ConversationProvider } from "@elevenlabs/react-native";
import { Stack } from "expo-router";
import { Auth0Provider } from "react-native-auth0";

import { env } from "@/env";

export default function RootLayout() {
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
        <Stack screenOptions={{ headerShown: false }} />
      </ConversationProvider>
    </Auth0Provider>
  );
}
