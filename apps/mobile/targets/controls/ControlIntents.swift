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

  /// Key of the phase snapshot the Controls render from — a `LessonActivityAttributes.Phase`
  /// raw value, or absent when no lesson is running.
  ///
  /// A Live Activity gets its state pushed to it; a Control does not. `currentValue()` runs in the
  /// widget extension's process, whenever the system feels like redrawing, with no argument and no
  /// access to the app's memory — so the only way a control can know whether the lesson is held is
  /// to read it out of shared storage. This key is that storage. It is written by the app on every
  /// state push (`LessonActivityModule`) and, optimistically, by the intents below.
  static let phaseKey = "lessonPhase"

  /// Key of the current activity's id, so a relaunched app can find the card it already owns
  /// instead of requesting a second one. §2.2 of the 2026-08-18 document.
  static let activityIdKey = "lessonActivityId"

  /// The `kind` strings the two Controls register under, and the strings the app passes to
  /// `ControlCenter.shared.reloadControls(ofKind:)`. Shared constants because a typo between the
  /// two sides is silent: the control simply never redraws.
  static let pauseControlKind = "work.kovalchuk.yurii.english-tutor.control.pause"
  static let muteControlKind = "work.kovalchuk.yurii.english-tutor.control.mute"

  /// Posted after a tap so a running React Native runtime can drain the inbox immediately instead
  /// of waiting for the next foreground transition.
  ///
  /// A **Darwin** notification, not a `NotificationCenter` one, and that is the whole point: Darwin
  /// notifications cross process boundaries. The intents below are documented to `perform()` in
  /// the containing app's process, which would make an in-process post sufficient — but that is a
  /// guarantee we would be betting the feature on, and the failure mode if it ever does not hold is
  /// silent (the tap lands in the inbox and nothing wakes up to read it). This way the signal
  /// arrives whichever process ran the intent, and the inbox in App Group storage is shared by both
  /// regardless. See docs/2026-08-16-background-controls-lock-screen.md §4.3.
  static let didReceiveIntent = "work.kovalchuk.yurii.english-tutor.control-intent" as CFString

  // ── the phase snapshot ───────────────────────────────────────────────────────────────────────

  /// What the Controls read. `idle` means "no lesson is running" — which is `phase: over` and
  /// "there has never been a lesson" collapsed, because a control cannot tell them apart and
  /// should not try: both mean every toggle is off and pressing one is a no-op.
  enum Snapshot: String, Sendable {
    case live
    case muted
    case held
    case idle

    var isHeld: Bool { self == .held }
    var isMuted: Bool { self == .muted }
    /// Whether there is anything behind a press at all. Drives `.disabled(_:)` on both templates.
    var isRunning: Bool { self != .idle }
  }

  static var snapshot: Snapshot {
    guard let raw = defaults?.string(forKey: phaseKey) else { return .idle }
    switch raw {
    case LessonActivityAttributes.Phase.live.rawValue: return .live
    case LessonActivityAttributes.Phase.muted.rawValue: return .muted
    case LessonActivityAttributes.Phase.held.rawValue: return .held
    default: return .idle
    }
  }

  /// Write the truth. Called by the app on every state push, and by nothing else — the optimistic
  /// writes below go through `applyOptimistically` so the two paths stay distinguishable in a log.
  static func writeSnapshot(_ phase: LessonActivityAttributes.Phase) {
    guard let defaults else { return }
    if phase == .over {
      defaults.removeObject(forKey: phaseKey)
    } else {
      defaults.set(phase.rawValue, forKey: phaseKey)
    }
  }

  static func clearSnapshot() {
    defaults?.removeObject(forKey: phaseKey)
  }

  // ── the inbox ────────────────────────────────────────────────────────────────────────────────

  /// Record a tap. Deliberately the WHOLE of what a control does.
  ///
  /// Nothing here mutes, pauses or ends anything. The state machine lives in JavaScript, which owns
  /// the ElevenLabs SDK, the transcript marks that decide whether a resume owes a restatement, and
  /// the feature-detected reach that silences the tutor. Swift re-implementing any of that would
  /// fork the tutor wire contract `packages/shared` exists to keep singular.
  /// See docs/2026-08-16-background-controls-lock-screen.md §4.2.
  ///
  /// The one thing it does decide is **whether there is a lesson to record against**, and that is
  /// addressing rather than logic. A Control cannot be hidden — once installed it sits in Control
  /// Center and on the Lock Screen forever, including at three in the morning with no session
  /// anywhere — and a `"pause"` written then would be drained by the *next* lesson and flip it into
  /// a hold nobody asked for. So a press with no running lesson is not an event.
  ///
  /// Returns whether the press was recorded, so the caller knows not to write an optimistic phase.
  @discardableResult
  static func record(_ action: String) -> Bool {
    guard let defaults, snapshot.isRunning else { return false }
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
    return true
  }

  /// The optimistic phase write a Control's `perform()` owes before it returns.
  ///
  /// A `ControlWidgetToggle` is not a button that stays where you put it: the moment `perform()`
  /// returns, the system asks the provider's `currentValue()` what the state really is and redraws
  /// from the answer. JS is the authority on that answer, but JS is a Darwin notification and a
  /// runtime wake-up away — hundreds of milliseconds during which the toggle would visibly snap
  /// back to where it started, which reads as "the button is broken".
  ///
  /// So the intent writes what it *expects* and JS overwrites it with what actually happened, one
  /// push later. The two agree in every ordinary case; where they do not — a pause the app refused
  /// because the session had already dropped — the correction lands within the same second and the
  /// toggle settles on the truth. Guessing briefly beats stuttering always.
  ///
  /// Only ever called after `record` returned `true`, so it cannot resurrect a phase for a lesson
  /// that is not running.
  static func applyOptimistically(action: String, desired: Bool) {
    switch action {
    case "pause":
      writeSnapshot(desired ? .held : .live)
    case "mute":
      writeSnapshot(desired ? .muted : .live)
    default:
      break
    }
  }
}

// ── the intents ────────────────────────────────────────────────────────────────────────────────

/// Pause, as a Control toggle.
///
/// `SetValueIntent` rather than a plain `AppIntent` because a `ControlWidgetToggle` needs to say
/// which way it was thrown, not merely that it was touched. The value is used for the optimistic
/// write only — the inbox still carries the untyped `"pause"` that JS folds as a toggle, so a batch
/// of presses replayed after a background relaunch collapses the same way it always did (three
/// presses is one flip, not three). §7.7.
@available(iOS 18.0, *)
struct SetPauseIntent: SetValueIntent {
  static var title: LocalizedStringResource = "Pause or resume the lesson"

  /// **The property this whole feature turns on.** `.alwaysAllowed` is already the default, and it
  /// is written down anyway: on a widget or Live Activity button the system gates the press before
  /// an intent is ever consulted, so the default is invisible there; on a Control it is the
  /// property that decides whether a locked phone can pause a lesson. A default that load-bearing
  /// should not be inferred from its absence. See §1.2 and §1.6 of
  /// docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md.
  static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

  /// `openAppWhenRun` is deliberately absent — it defaults to `false`, and `true` would defeat the
  /// point: the press must not drag the learner into the app to do something the app can already
  /// do from the background.
  @Parameter(title: "Paused")
  var value: Bool

  func perform() async throws -> some IntentResult {
    if ControlChannel.record("pause") {
      ControlChannel.applyOptimistically(action: "pause", desired: value)
    }
    return .result()
  }
}

/// Mute, as a Control toggle. Same shape as `SetPauseIntent`, same reasoning.
@available(iOS 18.0, *)
struct SetMuteIntent: SetValueIntent {
  static var title: LocalizedStringResource = "Mute or unmute the microphone"
  static var authenticationPolicy: IntentAuthenticationPolicy { .alwaysAllowed }

  @Parameter(title: "Muted")
  var value: Bool

  func perform() async throws -> some IntentResult {
    if ControlChannel.record("mute") {
      ControlChannel.applyOptimistically(action: "mute", desired: value)
    }
    return .result()
  }
}
