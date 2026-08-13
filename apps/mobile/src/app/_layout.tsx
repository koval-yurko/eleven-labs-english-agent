// IMPORTANT: import from "@elevenlabs/react-native", never "@elevenlabs/react". The React Native
// entrypoint has module-scope side effects — it calls LiveKit's registerGlobals() (which installs
// the WebRTC polyfills and the getUserMedia shim that sets the iOS audio category to playAndRecord)
// and registers the RN session-setup strategy. Importing the web package skips all of it.
import { ConversationProvider } from "@elevenlabs/react-native";
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <ConversationProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </ConversationProvider>
  );
}
