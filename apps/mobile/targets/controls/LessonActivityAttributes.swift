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

    /// What the session is doing. Drives the status line and the Dynamic Island glyph.
    var phase: Phase
    /// Did the app actually manage to silence the tutor's audio?
    ///
    /// `false` means the pause muted the microphone but the tutor is still audible — the escape
    /// hatch that silences it reaches through a `protected` SDK field by feature detection and is
    /// expected to break on an upgrade. On a locked screen that failure IS the experience, so the
    /// card says so rather than claiming a quiet it did not deliver. §7.6.
    var silenced: Bool

    /// The lesson title, shown when there is room for a header.
    ///
    /// **In `ContentState`, not in the attributes, and that is the structural fix for "a new card
    /// per lesson".** `ActivityAttributes` are frozen at `Activity.request` and can never be
    /// updated, so a title living there made "show a different lesson" mean "end this activity and
    /// request another one". That is §2.3 of
    /// docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md. Here it is just another
    /// field on the state already pushed on every change, so ONE activity can be re-pointed at a
    /// new lesson for the life of the install.
    var title: String
    /// The fully-formed deep link for `Start`, built on the JS side. Also `ContentState`, and for
    /// the same reason as `title`: it is per-lesson, and one activity has to be able to change
    /// lesson.
    ///
    /// A URL rather than a lesson id, because the scheme is per-variant — `englishtutordev`,
    /// `englishtutorpreview`, `englishtutor` — and Swift has no business re-deriving that. JS asks
    /// expo-linking, which already knows. Start cannot be an action on a locked device anyway (it
    /// needs a token mint, the microphone and a foreground process), so this is all it needs. §3.6.
    var deepLink: String
  }

  enum Phase: String, Codable, Hashable {
    case live
    case muted
    case held
    /// The session is gone but the card outlives it, because that is where `Start` lives. §3.6, §7.1.
    case over
  }

  /// **Deliberately empty.** Everything that used to live here — `title`, `deepLink` — is per-lesson
  /// and therefore has to be updatable, and attributes are not. An empty attributes type is what
  /// turns the activity into a singleton the app re-points, rather than a per-lesson object it has
  /// to re-create. See §2.3 of the 2026-08-18 document.
}
