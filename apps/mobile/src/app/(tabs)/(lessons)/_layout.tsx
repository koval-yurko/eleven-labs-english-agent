import { Stack } from "expo-router";

/**
 * The Lessons tab's own navigation stack.
 *
 * Screens set their own `title` and `headerRight` through `<Stack.Screen options={…} />`, exactly as
 * they did when there was a single root stack — so this file only has to exist. Header COLOURS come
 * from the navigator theme installed in `app/_layout.tsx` (D72), which is why nothing here mentions
 * one.
 */
/**
 * Stated rather than inferred: `index` would be chosen anyway, but the sibling tab has to declare
 * one and a pair that disagree about whether the rule is worth writing down is worse than either.
 */
export const unstable_settings = { anchor: "index" };

export default function LessonsTabLayout() {
  return <Stack screenOptions={{ headerShown: true }} />;
}
