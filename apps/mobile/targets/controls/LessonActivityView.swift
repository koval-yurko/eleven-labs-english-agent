import ActivityKit
import SwiftUI
import WidgetKit

/// The lock-screen card — **reading first, with one glyph that is not.**
///
/// It used to carry three `Button(intent:)`s and they were removed, not because they misbehaved:
/// Apple gates buttons and toggles in every widget and Live Activity behind device unlock, at the
/// widget host, before the intent runs. A button that needs the phone unlocked to pause a lesson is
/// worse than no button, because it looks like it works. The actions moved to two Controls
/// (`LessonControls.swift`), which are gated by the intent's own authentication policy instead.
/// See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.1, §1.4.
///
/// **One of them is back, on purpose and with its eyes open.** `MuteButton` sits in the header row
/// as a bare glyph. It is still subject to the same unlock gate — it does nothing on a locked screen
/// — so it is a convenience for the card's UNLOCKED lives (Notification Centre, a banner in the
/// hand, the lock screen after Face ID) and explicitly not a replacement for the Mute Control. Its
/// docblock says so at length; nothing here should be read as the gate having been solved.
///
/// The rest is what only a Live Activity could ever do and what needed no unlock in the first
/// place: **reading**. The words of the lesson and one sentence saying what the session is doing.
/// Tapping the card opens the lesson — `.widgetURL`, which is what the `Start` button became.
///
/// Laid out against a ~160 pt cap, and as of 2026-08-20 the budget is **over** it at the window the
/// JS side currently sends. The honest arithmetic, at default Dynamic Type:
///
///     24  vertical padding
///     20  header row (.footnote text, 20 pt mute glyph frame)
///      8  one VStack gap (header→list) — the footer is gone, so there is only one now
///    130  six .subheadline rows (6 × 20 + 5 × 2 internal spacing)
///   ----
///    182  — and 200 once "+N more" is showing
///
/// Removing `Start` bought back a row's worth (~44 pt) in the one phase that showed it, and the
/// mute glyph costs ~2 pt in the phases that do; the live-session budget above is otherwise what it
/// was.
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
      // Title left, mute in the middle, status right — one line. The status used to own two lines of
      // its own below the title; those ~30 pt are what pays for a word list that carries
      // translations, and moving it up here is what makes the two asks one change rather than two
      // competing ones.
      //
      // `.center` rather than `.firstTextBaseline`: the middle slot is a glyph now, and an SF Symbol
      // baseline-aligned against a `.footnote` sits visibly low against a `.caption` beside it.
      HStack(alignment: .center, spacing: 8) {
        Text(state.title)
          .font(.footnote.weight(.medium))
          .lineLimit(1)
        Spacer(minLength: 4)
        MuteButton(phase: state.phase)
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
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    // What the `Start` button used to be, minus the button. Tapping ANYWHERE on the card opens the
    // lesson — which is all `Start` ever did (it was a `Link`, never an action: starting needs a
    // conversation token, the microphone and a foreground process, none of which a locked screen
    // has). As a whole-card link it costs no vertical space, works in every phase rather than only
    // in `over`, and matches what a learner already expects a lock-screen card to do when tapped.
    // `deepLink` therefore stays load-bearing even though no visible control names it. §3.6.
    .widgetURL(URL(string: state.deepLink))
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

/// Mute/unmute, on the card, as a bare glyph.
///
/// **Read the caveat before trusting this button.** Apple deactivates every `Button` and `Toggle`
/// in every widget and Live Activity until the device is unlocked — at the widget host, before the
/// intent is consulted, with no entitlement or policy that turns it off. That is exactly why the
/// card's three original buttons were removed in favour of the two Controls
/// (`LessonControls.swift`), whose `authenticationPolicy` the app *does* control. See
/// docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.1–§1.4.
///
/// So this glyph is a convenience for the **unlocked** states of the card — the Notification Centre,
/// the pulled-down lock screen after Face ID, the banner while the phone is in hand — and it is
/// deliberately NOT the answer to "mute without unlocking". That answer is still the Mute Control.
/// Nothing regressed by adding it: on a locked screen it renders inert, which is the same as the
/// space it occupies being empty.
///
/// It shares the Controls' plumbing rather than growing its own. `SetMuteIntent` writes the untyped
/// `"mute"` into the App Group inbox and JS folds it as a toggle, so a press here and a press on the
/// Control are indistinguishable downstream — one state machine, one wire contract.
///
/// Shown only in `live`/`muted`. A hold already owns the microphone (§3.3), so during one the only
/// thing this could offer is an unmute the app would refuse; `over` has no session to mute.
struct MuteButton: View {
  let phase: LessonActivityAttributes.Phase

  var body: some View {
    // `SetMuteIntent` is iOS 18 (it is a Control intent first) and `Button(intent:)` inside a Live
    // Activity is iOS 17, so one gate covers both. A 16.4 device gets the card with no glyph, which
    // is the state it was in before this existed.
    if #available(iOS 18.0, *), phase == .live || phase == .muted {
      let muted = phase == .muted
      Button(intent: intent(desired: !muted)) {
        Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
          .font(.footnote)
          .foregroundStyle(muted ? Color.orange : Color.secondary)
          // The glyph is ~13 pt; the frame is what makes it a target rather than a decoration, and
          // it costs the header row nothing — the row is already the height of its text.
          .frame(width: 28, height: 20)
          .contentShape(Rectangle())
      }
      // `.plain` because `.bordered` would draw a capsule the width of the title's truncation
      // budget. Icon only, as asked: the phase word beside it already says which way it is thrown.
      .buttonStyle(.plain)
      .accessibilityLabel(muted ? "Unmute the microphone" : "Mute the microphone")
    }
  }

  /// `SetValueIntent` carries which way the switch was thrown, for the optimistic phase write the
  /// Controls depend on. The inbox entry is still the untyped `"mute"`, so this value never decides
  /// what actually happens — JS does, one push later. See `ControlIntents.swift`.
  @available(iOS 18.0, *)
  private func intent(desired: Bool) -> SetMuteIntent {
    // `let`, not `var`: `@Parameter` wraps reference-backed storage, so assigning through it does
    // not mutate the struct. The compiler says so as a warning; taking it at its word.
    let intent = SetMuteIntent()
    intent.value = desired
    return intent
  }
}
