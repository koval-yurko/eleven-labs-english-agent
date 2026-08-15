import { View } from "react-native";

import { Muted } from "./Text";
import { space } from "./tokens";

/**
 * "Nothing here yet."
 *
 * This replaces `@expo/ui`'s `ContentUnavailableView`, and it is a **downgrade taken on purpose**.
 * The SwiftUI view was the better piece of design: it takes its type scale, its icon tint and its
 * secondary-label colour from the system, so it was correct in both appearances without appearing
 * in the token table at all. What it could not be is the same as the web, which says its "nothing
 * here" in one line of muted prose — no illustration, no icon, no fixed 260pt block.
 *
 * Since parity is the brief, the web wins and this is twelve lines instead of a dependency.
 * `docs/2026-08-15-web-design-parity-on-mobile.md` §10.1 records the argument, because it is the
 * one call in this port where the native version was better on its own terms.
 */
export function EmptyState({ children }: { children: string }) {
  return (
    <View style={{ paddingVertical: space.row }}>
      <Muted>{children}</Muted>
    </View>
  );
}
