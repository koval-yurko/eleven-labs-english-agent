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
 * `deploymentTarget` is 16.4 rather than the plugin's 18.0 default and rather than 17.0: 16.4 is the
 * floor `expo-modules-core` already imposes on the app, and this target must not raise it. The
 * interactive buttons need 17.0 and are gated with `if #available` inside the view, so a 16.4 device
 * gets a readable card without buttons instead of no card at all.
 * See docs/2026-08-16-background-controls-lock-screen.md §2.
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
  // ActivityKit for the Live Activity itself, AppIntents for the buttons inside it.
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit", "AppIntents"],
};
