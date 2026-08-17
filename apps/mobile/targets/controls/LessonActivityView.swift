import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The lock-screen card.
///
/// Laid out against a ~160 pt cap, which six words and three buttons do not fit at full size. The
/// compressions, in the order docs/2026-08-16-background-controls-lock-screen.md §5.4 chose them:
/// no header, a two-column word grid, and icon-only buttons except where a label is load-bearing.
/// Measured budget: ~32 (status) + ~51 (grid) + 44 (buttons) + padding.
struct LessonActivityView: View {
  let context: ActivityViewContext<LessonActivityAttributes>

  private var state: LessonActivityAttributes.ContentState { context.state }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(statusLine)
        .font(.footnote)
        .foregroundStyle(.secondary)
        // Two lines, because the §7.6 sentence is long and truncating it would hide exactly the
        // thing it exists to disclose.
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)

      WordGrid(words: state.words, overflow: state.overflow, focusIndex: state.focusIndex)

      ControlRow(context: context)
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

/// Three controls, always in the same order so a control never moves under a thumb already reaching
/// for it: the session verb, the pause verb, the microphone.
struct ControlRow: View {
  let context: ActivityViewContext<LessonActivityAttributes>

  private var state: LessonActivityAttributes.ContentState { context.state }
  private var isOver: Bool { state.phase == .over }
  private var isHeld: Bool { state.phase == .held }
  private var isMuted: Bool { state.phase == .muted }

  var body: some View {
    HStack(spacing: 10) {
      if isOver {
        // Start is not End's inverse and cannot be an action: starting needs a conversation token,
        // the microphone, and a foreground process, none of which a locked screen has. So it opens
        // the app and the learner presses the real Start there. A Link, never a Button. §3.6.
        Link(destination: URL(string: context.attributes.deepLink) ?? URL(string: "about:blank")!) {
          Label("Start", systemImage: "arrow.up.forward.app.fill")
            .font(.subheadline.weight(.medium))
            .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.bordered)
      } else if #available(iOS 17.0, *) {
        // End keeps its label through both states. It is the one button whose meaning a glyph
        // cannot carry — a bare ◼ next to a live confirm window is how a lesson gets ended by
        // accident — and the confirm state needs words by definition.
        Button(intent: EndIntent()) {
          Text(state.confirmingEnd ? "End lesson?" : "End")
            .font(.subheadline.weight(state.confirmingEnd ? .semibold : .regular))
            .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.bordered)
        .tint(state.confirmingEnd ? .red : nil)

        Button(intent: PauseIntent()) {
          Image(systemName: isHeld ? "play.fill" : "pause.fill")
            .frame(maxWidth: .infinity, minHeight: 40)
        }
        .buttonStyle(.bordered)

        // Hidden during a hold, not disabled: the pause already owns the microphone, so the only
        // thing this button could offer there is an unmute the app would have to refuse.
        if !isHeld {
          Button(intent: MuteIntent()) {
            Image(systemName: isMuted ? "mic.slash.fill" : "mic.fill")
              .frame(maxWidth: .infinity, minHeight: 40)
          }
          .buttonStyle(.bordered)
          .tint(isMuted ? .orange : nil)
        }
      } else {
        // iOS 16.4–16.x: `Button(intent:)` does not exist, so the card is a read-only display
        // rather than nothing at all. Saying where the controls are beats showing dead buttons.
        Text("Open the app to pause or mute")
          .font(.caption)
          .foregroundStyle(.tertiary)
          .frame(maxWidth: .infinity, minHeight: 40)
      }
    }
  }
}
