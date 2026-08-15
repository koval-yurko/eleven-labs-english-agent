import { Tabs } from "expo-router/js-tabs";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import type { ColorValue } from "react-native";

import { useTheme } from "@/theme";

// `tabBarIcon` hands back a `ColorValue`, not a string — it can be a platform colour object rather
// than a hex. `tintColor` takes the same type, so this passes it straight through instead of
// narrowing it to what our palette happens to use today.
function TabIcon({
  name,
  color,
  size,
}: {
  name: SymbolViewProps["name"];
  color: ColorValue;
  size: number;
}) {
  return <SymbolView name={name} tintColor={color} style={{ width: size, height: size }} />;
}

/**
 * The tab bar — S7 (D73). Two top-level destinations, which is exactly what a tab bar is for.
 *
 * Until now the collection was reached by a "Words" button in the lessons header (S6 D65), which
 * made one of the app's two halves feel like a detail of the other.
 *
 * **`Tabs`, not `expo-router/unstable-native-tabs`.** Both ship in SDK 57, and the native one is
 * genuinely nicer — a real `UITabBarController`, SF Symbol icons, badges, a bottom accessory. But
 * `unstable-` in an import path is the maintainer saying the API will move, and this is the chrome
 * every screen in the app hangs off. It is the obvious post-v1 upgrade; it is not a thing to take
 * on the stage whose gate is the word "shippable".
 *
 * The import path is `expo-router/js-tabs`: expo-router 57.0.13 deprecated the root re-export of
 * `Tabs` in favour of the subpath. Same stable component, and it moved under us during S7's own
 * dependency upgrade (D78) — which is a small argument for the choice above.
 *
 * Each tab is a route GROUP with its own `<Stack>`, so pushing a lesson or a word keeps the tab bar
 * on screen and gives each tab an independent back stack. Parenthesised segments do not appear in
 * the URL, so every existing href — `/`, `/lessons/:id`, `/lesson-items` — is unchanged.
 */
export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerShown: false, // each tab's own Stack draws the header
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.bg, borderTopColor: theme.border },
      }}
    >
      <Tabs.Screen
        name="(lessons)"
        options={{
          title: "Lessons",
          tabBarIcon: (p) => <TabIcon name="bubble.left.and.bubble.right" {...p} />,
        }}
      />
      <Tabs.Screen
        name="(words)"
        options={{
          title: "Words",
          tabBarIcon: (p) => <TabIcon name="character.book.closed" {...p} />,
        }}
      />
    </Tabs>
  );
}
