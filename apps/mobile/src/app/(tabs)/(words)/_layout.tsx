import { Stack } from "expo-router";

/**
 * The Words tab's own navigation stack.
 *
 * Screens set their own `title` and `headerRight` through `<Stack.Screen options={…} />`, exactly as
 * they did when there was a single root stack — so this file only has to exist. Header COLOURS come
 * from the navigator theme installed in `app/_layout.tsx` (D72), which is why nothing here mentions
 * one.
 */
/**
 * This tab has no `index.tsx` — its root screen lives at `/lesson-items`, because that URL is
 * shared with the web app. Naming the anchor is what stops the router from inferring a root from
 * file order and landing the tab on `lesson-items/[id]` with no id.
 */
export const unstable_settings = { anchor: "lesson-items/index" };

export default function WordsTabLayout() {
  return <Stack screenOptions={{ headerShown: true }} />;
}
