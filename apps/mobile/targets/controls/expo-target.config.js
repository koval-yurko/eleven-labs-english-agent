/**
 * The lock-screen controls target — a Live Activity, not a widget on the home screen.
 *
 * `type: "widget"` is the plugin's name for the WidgetKit extension point, which is the same target
 * that hosts Live Activities; there is no separate `live-activity` type.
 *
 * `entitlements: {}` is EMPTY and must stay present. The plugin mirrors the app's
 * `com.apple.security.application-groups` into the target — but only inside `if (entitlementsJson)`,
 * so a target config with no `entitlements` key at all gets nothing mirrored AND is registered with
 * EAS carrying no entitlements, which yields a provisioning profile without the App Group. That
 * failure is invisible at build time and total at runtime: `UserDefaults(suiteName:)` returns a
 * store nobody else can see, so every intent the buttons write is read back as nothing.
 *
 * So: empty object = "yes, entitlements, take them from the app". Naming the group here instead
 * would work but would put it in two places, and a mismatch between them does not error either.
 *
 * `deploymentTarget` is 16.4 rather than the plugin's 18.0 default: 16.4 is the floor
 * `expo-modules-core` already imposes on the app, and this target must not raise it. The card is a
 * Live Activity (16.2) and the two Controls are iOS 18, gated with `@available` in
 * `LessonControls.swift` and with `if #available` in the widget bundle — so a 16.4 device gets a
 * readable card and no controls, rather than no card at all.
 *
 * The card carries no interactive buttons any more, which is why nothing here mentions 17.0:
 * buttons inside a widget or Live Activity are inactive until the device is unlocked, so they were
 * removed rather than gated. The actions live on the Controls instead, which are gated by their
 * intent's own authentication policy.
 * See docs/2026-08-16-background-controls-lock-screen.md §2 and
 * docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.1, §1.4.
 *
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: "widget",
  name: "controls",
  // Explicit, because the default is derived from the target TYPE (`…​.widget`) rather than its
  // name, and "widget" is exactly what this target is not — it never appears on a home screen.
  bundleIdentifier: ".controls",
  entitlements: {},
  displayName: "Lesson controls",
  deploymentTarget: "16.4",
  // ActivityKit for the Live Activity, AppIntents for the control intents, WidgetKit for the
  // ControlWidget types themselves.
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit", "AppIntents"],
};
