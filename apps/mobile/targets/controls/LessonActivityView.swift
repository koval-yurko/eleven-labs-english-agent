import ActivityKit
import SwiftUI
import WidgetKit

/// The lock-screen card — **read-only, deliberately.**
///
/// It used to carry three `Button(intent:)`s. They are gone, and not because they misbehaved:
/// Apple gates buttons and toggles in every widget and Live Activity behind device unlock, at the
/// widget host, before the intent runs. A button that needs the phone unlocked to pause a lesson is
/// worse than no button, because it looks like it works. The actions moved to two Controls
/// (`LessonControls.swift`), which are gated by the intent's own authentication policy instead.
/// See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.1, §1.4.
///
/// What is left is what only a Live Activity could ever do and what needed no unlock in the first
/// place: **reading**. The words of the lesson and one sentence saying what the session is doing.
///
/// Laid out against a ~160 pt cap. Without the button row there is room for the header the original
/// budget had to drop (§5.4).
struct LessonActivityView: View {
  let context: ActivityViewContext<LessonActivityAttributes>

  private var state: LessonActivityAttributes.ContentState { context.state }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(state.title)
          .font(.footnote.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 8)
      }

      Text(statusLine)
        .font(.footnote)
        .foregroundStyle(.secondary)
        // Two lines, because the §7.6 sentence is long and truncating it would hide exactly the
        // thing it exists to disclose.
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)

      WordGrid(words: state.words, overflow: state.overflow, focusIndex: state.focusIndex)

      FooterRow(state: state, deepLink: state.deepLink)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .activityBackgroundTint(nil)
  }

  /// The same four sentences the in-app status line uses, and for the same reason: pause and mute
  /// look identical from outside — both stop the learner being heard — and what separates them is
  /// invisible. Only a pause runs the heartbeat that stops the tutor re-engaging.
  private var statusLine: String {
    switch state.phase {
    case .held:
      return state.silenced
        ? "⏸ Paused — microphone muted, the tutor is waiting"
        : "⏸ Paused — microphone muted, but the tutor may still be audible"
    case .muted:
      return "🎤 Muted — the tutor keeps going; unmute to answer"
    case .live:
      return "● Listening — just talk to interrupt"
    case .over:
      return "This lesson has ended"
    }
  }
}

/// Two words per row. A full-width row per word wastes most of its width on vocabulary items and
/// costs ~17 pt each; the grid puts six words in three rows and is the single biggest saving in the
/// layout budget.
struct WordGrid: View {
  let words: [String]
  let overflow: Int
  let focusIndex: Int?

  private var columns: [GridItem] {
    [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)]
  }

  var body: some View {
    if words.isEmpty {
      Text("No words in this lesson")
        .font(.caption)
        .foregroundStyle(.tertiary)
    } else {
      LazyVGrid(columns: columns, alignment: .leading, spacing: 3) {
        ForEach(Array(words.enumerated()), id: \.offset) { index, word in
          Text(word)
            .font(.subheadline)
            .fontWeight(index == focusIndex ? .semibold : .regular)
            .foregroundStyle(index == focusIndex ? .primary : .secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        // Truncation is shown, never silent: a cut list that does not say it was cut reads as a
        // wrong list, and the learner has no way to tell the difference from a locked screen.
        if overflow > 0 {
          Text("+\(overflow) more")
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
      }
    }
  }
}

/// The one row that is still interactive, and it is a `Link` rather than a `Button` in both of its
/// states — links open the app, which is a thing a locked device is perfectly willing to do after
/// an unlock, and neither of these actions can happen without a foreground process anyway.
struct FooterRow: View {
  let state: LessonActivityAttributes.ContentState
  let deepLink: String

  private var url: URL { URL(string: deepLink) ?? URL(string: "about:blank")! }

  var body: some View {
    if state.phase == .over {
      // Start is not End's inverse and cannot be an action: starting needs a conversation token,
      // the microphone, and a foreground process, none of which a locked screen has. So it opens
      // the app and the learner presses the real Start there. §3.6.
      Link(destination: url) {
        Label("Start", systemImage: "arrow.up.forward.app.fill")
          .font(.subheadline.weight(.medium))
          .frame(maxWidth: .infinity, minHeight: 36)
      }
      .buttonStyle(.bordered)
    } else {
      // The pointer at the Controls. It is here because Apple gives an app no way to install its
      // own control, so the only lever left is telling the learner the controls exist and where —
      // and this card is the one surface guaranteed to be in front of them mid-lesson.
      //
      // Honest about being a mitigation rather than a fix: if adoption is the problem §1.5 warns it
      // might be, this line is not what will save it. The Now Playing fallback (§1.7) is.
      Text("Add the Pause and Mute controls to your Lock Screen to use them without unlocking")
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)
    }
  }
}
