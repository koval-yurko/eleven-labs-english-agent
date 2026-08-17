import ActivityKit
import Foundation

/// The wire contract between the app and its lock-screen card.
///
/// This file is compiled into BOTH targets — the app starts and updates the activity, the extension
/// renders it — so it must not import anything either one lacks. `ActivityKit` and `Foundation` only.
///
/// `ContentState` is pushed on every change and is `Codable` by protocol requirement, so it stays
/// small: strings the card renders, never model rows. See
/// docs/2026-08-16-background-controls-lock-screen.md §4.1.
struct LessonActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The active words of the lesson, in lesson order, already windowed by the app.
    ///
    /// The extension does NOT truncate: it renders what it is given, and `overflow` is how many were
    /// left out. Deciding the window on the JS side keeps one rule ("first N active in position
    /// order") in one language instead of two that can disagree. §5.4.
    var words: [String]
    /// How many active words did not fit the window. `0` hides the affordance entirely.
    var overflow: Int
    /// Reserved for the current-word highlight, which nothing can compute yet — the lesson runs
    /// inside the agent and no client tool reports progress. Nullable from day one so adopting it
    /// later is a JS change with no Swift edit. §5.2, §5.3.
    var focusIndex: Int?

    /// What the session is doing. Drives every control's enabled state and label.
    var phase: Phase
    /// Did the app actually manage to silence the tutor's audio?
    ///
    /// `false` means the pause muted the microphone but the tutor is still audible — the escape
    /// hatch that silences it reaches through a `protected` SDK field by feature detection and is
    /// expected to break on an upgrade. On a locked screen that failure IS the experience, so the
    /// card says so rather than claiming a quiet it did not deliver. §7.6.
    var silenced: Bool
    /// The first End tap sets this; only a second tap inside the window ends anything. A lock screen
    /// has no alerts, sheets or modals, so the button relabelling itself is the strongest
    /// confirmation available. §3.5.
    var confirmingEnd: Bool
  }

  enum Phase: String, Codable, Hashable {
    case live
    case muted
    case held
    /// The session is gone but the card outlives it, because that is where `Start` lives. Every
    /// control renders disabled here except the deep link. §3.6, §7.1.
    case over
  }

  /// The lesson title, shown when there is room for a header.
  var title: String
  /// The fully-formed deep link for `Start`, built on the JS side.
  ///
  /// A URL rather than a lesson id, because the scheme is per-variant — `englishtutordev`,
  /// `englishtutorpreview`, `englishtutor` — and Swift has no business re-deriving that. JS asks
  /// expo-linking, which already knows. Start cannot be an action on a locked device anyway (it
  /// needs a token mint, the microphone and a foreground process), so this is all it needs. §3.6.
  var deepLink: String
}
