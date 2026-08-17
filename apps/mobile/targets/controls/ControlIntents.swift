import AppIntents
import CoreFoundation
import Foundation

#if canImport(ActivityKit)
  import ActivityKit
#endif

/// The App Group, derived from the running binary's own bundle identifier.
///
/// Derived rather than configured, and that is the whole point: this file is compiled into BOTH
/// binaries, so one rule evaluated in two processes cannot disagree. A configured value could —
/// the extension's `Bundle.main` is its OWN bundle, so an Info.plist key set on the app is simply
/// absent here, and a plist cannot carry a per-variant value anyway (the group differs across dev,
/// preview and production because the bundle id does).
///
/// The derivation, both sides:
///
///     app         work.kovalchuk.yurii.english-tutor-dev            → group.work…-dev
///     extension   work.kovalchuk.yurii.english-tutor-dev.controls   → group.work…-dev
///
/// It stays true as long as `appGroup` in app.config.ts is `group.${bundleIdentifier}` and the
/// target's `bundleIdentifier` is `.controls`. Both are one line, and both say so.
///
/// Getting this wrong does not raise: `UserDefaults(suiteName:)` returns a store nobody else can
/// see, and every cross-process read comes back nil forever.
enum ControlChannel {
  /// The suffix the controls extension appends to the app's bundle identifier — see
  /// `targets/controls/expo-target.config.js`, which is where it is set.
  private static let extensionSuffix = ".controls"

  static var appGroup: String {
    guard let bundleId = Bundle.main.bundleIdentifier else { return "" }
    let appBundleId =
      bundleId.hasSuffix(extensionSuffix)
      ? String(bundleId.dropLast(extensionSuffix.count))
      : bundleId
    return "group.\(appBundleId)"
  }

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

  /// Key of the intent inbox — an array of `["action": String, "at": Double]`.
  static let inboxKey = "controlIntents"

  /// Posted after a tap so a running React Native runtime can drain the inbox immediately instead
  /// of waiting for the next foreground transition.
  ///
  /// A **Darwin** notification, not a `NotificationCenter` one, and that is the whole point: Darwin
  /// notifications cross process boundaries. `LiveActivityIntent` is documented to `perform()` in
  /// the containing app's process, which would make an in-process post sufficient — but that is a
  /// guarantee we would be betting the feature on, and the failure mode if it ever does not hold is
  /// silent (the tap lands in the inbox and nothing wakes up to read it). This way the signal
  /// arrives whichever process ran the intent, and the inbox in App Group storage is shared by both
  /// regardless. See docs/2026-08-16-background-controls-lock-screen.md §4.3.
  static let didReceiveIntent = "work.kovalchuk.yurii.english-tutor.control-intent" as CFString

  /// Record a tap. Deliberately the WHOLE of what a button does.
  ///
  /// Nothing here mutes, pauses or ends anything. The state machine lives in JavaScript, which owns
  /// the ElevenLabs SDK, the transcript marks that decide whether a resume owes a restatement, and
  /// the feature-detected reach that silences the tutor. Swift re-implementing any of that would
  /// fork the tutor wire contract `packages/shared` exists to keep singular.
  /// See docs/2026-08-16-background-controls-lock-screen.md §4.2.
  static func record(_ action: String) {
    guard let defaults else { return }
    var inbox = defaults.array(forKey: inboxKey) as? [[String: Any]] ?? []
    inbox.append(["action": action, "at": Date().timeIntervalSince1970 * 1000])
    // A cap, because an inbox that only ever grows is a memory leak with a lock screen attached.
    // Old entries are worthless anyway: the drain discards anything stale.
    defaults.set(Array(inbox.suffix(16)), forKey: inboxKey)
    // `deliverImmediately: true` — the app may be in the background holding a WebRTC session, and a
    // coalesced notification would arrive after the moment the tap was meant to affect.
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(didReceiveIntent),
      nil,
      nil,
      true
    )
  }
}

@available(iOS 17.0, *)
struct PauseIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Pause or resume the lesson"
  /// `openAppWhenRun: false` is the point of the whole design — the tap must not drag the learner
  /// out of the lock screen to do something the app can already do from the background.
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    ControlChannel.record("pause")
    return .result()
  }
}

@available(iOS 17.0, *)
struct MuteIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Mute or unmute the microphone"
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    ControlChannel.record("mute")
    return .result()
  }
}

/// End is the one control that is not idempotent, so it is the one that does not fire on first tap.
///
/// This intent records `"end"` exactly like the others — it does NOT decide anything. Whether a
/// given tap is the first (arm the confirm) or the second (actually end) is resolved in JavaScript
/// against the timestamps in the inbox, so that two taps replayed together after a background
/// relaunch collapse to one end, and a confirm armed ten minutes ago resolves to none. §3.5, §7.7.
@available(iOS 17.0, *)
struct EndIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "End the lesson"
  static var openAppWhenRun: Bool = false

  func perform() async throws -> some IntentResult {
    ControlChannel.record("end")
    return .result()
  }
}
