import { ContentUnavailableView, Host } from "@expo/ui/swift-ui";
import type { SFSymbol } from "sf-symbols-typescript";

/**
 * The one empty state — S7 (D74).
 *
 * S6 proved `ContentUnavailableView` on the collection screen while every other screen still said
 * its "nothing here" in a muted `<Text>`. This wraps it once so the rest can stop.
 *
 * It also *removes* colour decisions rather than re-keying them: the SwiftUI view takes its type
 * scale, its icon tint and its secondary-label colour from the system, so it is correct in both
 * appearances without appearing in `theme.ts` at all.
 *
 * **The height is fixed on purpose.** `ContentUnavailableView` expands to fill whatever SwiftUI
 * gives it, so `matchContents` has nothing finite to measure — and every caller here is a list's
 * `ListEmptyComponent`, where a `Host` that measures to zero renders as a blank screen and one that
 * measures to infinity breaks the scroll. A stated height is the boring, predictable answer.
 * See docs/2026-08-13-expo-s0-scaffold-testflight.md §2 (D3) for the `matchContents` trap itself.
 */
export function EmptyState({
  title,
  systemImage,
  description,
  height = 260,
}: {
  title: string;
  /** An SF Symbol name — typed, so a symbol that does not exist is a compile error rather
   *  than an invisible icon at runtime. */
  systemImage: SFSymbol;
  description?: string;
  height?: number;
}) {
  return (
    <Host style={{ height }}>
      <ContentUnavailableView title={title} systemImage={systemImage} description={description} />
    </Host>
  );
}
