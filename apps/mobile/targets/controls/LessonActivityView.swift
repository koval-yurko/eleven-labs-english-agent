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
/// Laid out against a ~160 pt cap, and as of 2026-08-20 the budget is **over** it at the window the
/// JS side currently sends. The honest arithmetic, at default Dynamic Type:
///
///     24  vertical padding
///     18  header row (.footnote)
///     16  two VStack gaps (header→list, list→footer)
///    130  six .subheadline rows (6 × 20 + 5 × 2 internal spacing)
///   ----
///    188  — and 206 once "+N more" is showing
///
/// Five rows is ~166/184; four is ~144/162. So four is the only count this arithmetic supports.
/// An earlier note here claimed ~149 pt and it was wrong twice: it costed a `.subheadline` row at
/// 18 pt rather than 20, and it forgot the VStack's own spacing between children entirely.
///
/// `ACTIVITY_WORD_WINDOW` (`src/lib/lesson-activity-state.ts`) still says six, which is a decision
/// made against those wrong numbers and is pending a device measurement. Until it comes down, the
/// layout is arranged so the thing that overflows is a WORD — never the notice that says words were
/// left out. See `WordList` and
/// docs/2026-08-20-words-1.6-lock-screen-translations-and-lesson-words.md §4.4.
struct LessonActivityView: View {
  let context: ActivityViewContext<LessonActivityAttributes>

  private var state: LessonActivityAttributes.ContentState { context.state }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // Title left, status right, one line. The status used to own two lines of its own below the
      // title; those ~30 pt are what pays for a word list that carries translations, and moving it
      // up here is what makes the two asks one change rather than two competing ones.
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(state.title)
          .font(.footnote.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 4)
        Text(statusChip)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          // Higher than the title's, so a long lesson name truncates before the status does. What
          // the session is doing is the one thing on this card that cannot be guessed from
          // anywhere else on the lock screen.
          .layoutPriority(1)
      }

      // The ONE case where the chip is not enough, kept as its own line rather than folded into it.
      // `silenced == false` means the feature-detected reach that silences the tutor has broken and
      // the tutor is audible THROUGH a pause — on a locked screen that failure is the experience,
      // so the card says so rather than claiming a quiet it did not deliver (§7.6). It costs a line
      // only in a state that should never occur, and occurs only after an SDK upgrade.
      if state.phase == .held && !state.silenced {
        Text("The tutor may still be audible")
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }

      WordList(words: state.words, overflow: state.overflow, focusIndex: state.focusIndex)

      FooterRow(state: state, deepLink: state.deepLink)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .activityBackgroundTint(nil)
  }

  /// What the session is doing, in the width left over beside a lesson title.
  ///
  /// Short where the in-app status line is a sentence, and that is forced rather than chosen: the
  /// four sentences this replaces run to sixty characters and would truncate to "⏸ Paused — microph…"
  /// next to a title. The distinction those sentences carry — that pause and mute look identical
  /// from outside, and only a pause runs the heartbeat that stops the tutor re-engaging — survives
  /// in the glyphs and in the extra line above for the one case that genuinely needs prose.
  private var statusChip: String {
    switch state.phase {
    case .held:
      return "⏸ Paused"
    case .muted:
      return "🎤 Muted"
    case .live:
      return "● Listening"
    case .over:
      return "Ended"
    }
  }
}

/// One numbered word per row, each already carrying its Russian.
///
/// This was a two-column grid, which was the single biggest saving in the layout budget back when
/// a row held one word. It cannot stay one: "ephemeral — мимолётный, недолговечный" does not fit
/// half a lock-screen width, and half of what a learner wants from a glance at this card is the
/// translation. So the budget is paid for elsewhere — the status line moved onto the title row and
/// the controls hint is gone — and each word gets the full width.
///
/// The number comes from the render index rather than the payload, so it always reads 1…N however
/// the list was windowed. The `word` string is pre-joined on the JS side by `itemLine`
/// (`@tutor/shared/lesson-types`), for the same reason the window is decided there: one rule for
/// "word — перевод" in one language, rather than two that can disagree.
struct WordList: View {
  let words: [String]
  let overflow: Int
  let focusIndex: Int?

  var body: some View {
    if words.isEmpty {
      Text("No words in this lesson")
        .font(.caption)
        .foregroundStyle(.tertiary)
    } else {
      VStack(alignment: .leading, spacing: 2) {
        // ABOVE the rows, and that placement is the whole point rather than a style choice.
        //
        // Truncation is shown, never silent: a cut list that does not say it was cut reads as a
        // wrong list, and from a locked screen the learner has no way to tell the difference. Below
        // the rows this notice was the LAST element in a VStack that overflows its container — so
        // the one element guaranteed to be clipped was the one whose entire job is to disclose
        // clipping, and the invariant held only while the card happened to fit. Above them it
        // cannot be the thing that gets cut; a word can, and a missing word the header has already
        // accounted for is a smaller lie than a list that claims to be whole.
        //
        // Worded as a count rather than "+N more" because at the top it is a header, not a tail.
        if overflow > 0 {
          Text("First \(words.count) of \(words.count + overflow)")
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        ForEach(Array(words.enumerated()), id: \.offset) { index, word in
          Text("\(index + 1). \(word)")
            .font(.subheadline)
            .fontWeight(index == focusIndex ? .semibold : .regular)
            .foregroundStyle(index == focusIndex ? .primary : .secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
      }
    }
  }
}

/// The `Start` link, and nothing else.
///
/// A `Link` rather than a `Button` — links open the app, which is a thing a locked device is
/// perfectly willing to do after an unlock, and starting a lesson cannot happen without a
/// foreground process anyway. During a live session the row is empty.
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
    }
    // During a live session this row renders NOTHING, and that is the change of 2026-08-20.
    //
    // It used to carry "Add the Pause and Mute controls to your Lock Screen…" — a pointer at the
    // two Controls, which are the only surface that can act on a LOCKED device (Apple deactivates
    // every button in every Live Activity until unlock). Its own docblock called it a mitigation
    // rather than a fix, and it cost two lines of a ~160 pt card. Those two lines are now word
    // translations, which is what a learner actually looks at this card for.
    //
    // The cost, so it is inherited deliberately: a learner who has not already added the Controls
    // has no in-product path to discovering them, and no API reports whether they did. The lever if
    // that ever matters is the Now Playing surface (§1.7) — which needs no setup at all — not
    // another line of copy here.
  }
}
