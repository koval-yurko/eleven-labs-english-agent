import { Host, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, multilineTextAlignment } from "@expo/ui/swift-ui/modifiers";
import { KICKOFF_MESSAGE } from "@tutor/shared/tutor";
import Constants from "expo-constants";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

/**
 * S0's whole product surface. Two things are on trial here, both of them infrastructure:
 *
 *  1. Metro resolving `@tutor/shared/tutor` — the SUBPATH, not the barrel. The barrel would pass
 *     via exports["."] even with exports["./*"] broken, and every real screen uses the subpath.
 *  2. Expo UI (D3) rendering through a `Host` — it is a native module, so linking it in a cloud
 *     build is proven here rather than at S6.
 *
 * The bundle identifier is on screen so a TestFlight install can be checked against D7 by eye.
 * See docs/2026-08-13-expo-s0-scaffold-testflight.md §7.
 */
export default function HomeScreen() {
  const bundleId = Constants.expoConfig?.ios?.bundleIdentifier ?? "unknown";

  return (
    <SafeAreaView style={styles.screen}>
      {/* A Host needs explicit dimensions or matchContents — D3. */}
      <Host style={styles.host}>
        <VStack spacing={16}>
          <Text
            modifiers={[
              font({ size: 13, weight: "semibold", design: "monospaced" }),
              foregroundStyle({ type: "hierarchical", style: "secondary" }),
            ]}
          >
            @tutor/shared/tutor
          </Text>
          <Text
            modifiers={[font({ size: 20, weight: "medium" }), multilineTextAlignment("center")]}
          >
            {KICKOFF_MESSAGE}
          </Text>
          <Text
            modifiers={[
              font({ size: 12, design: "monospaced" }),
              foregroundStyle({ type: "hierarchical", style: "tertiary" }),
            ]}
          >
            {bundleId}
          </Text>
        </VStack>
      </Host>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  host: { flex: 1, paddingHorizontal: 24 },
});
