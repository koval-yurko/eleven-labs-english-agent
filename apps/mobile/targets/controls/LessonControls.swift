import AppIntents
import SwiftUI
import WidgetKit

/// The two Lock Screen / Control Center controls — **the surface that actually works locked.**
///
/// Why these exist at all: Apple gates every button and toggle in every widget and Live Activity
/// behind device unlock, at the widget host, before an intent is ever consulted. No entitlement,
/// policy or configuration turns that off, which is why the card's three buttons are gone (§1.1,
/// §1.2). A Control is gated differently — by the intent's own `authenticationPolicy`, which
/// defaults to `.alwaysAllowed` and is written down explicitly in `ControlIntents.swift`. Same
/// extension, same App Intents, same App Group inbox; a different place the learner presses.
/// See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.4–§1.6.
///
/// What this costs, said plainly because §1.5 refuses to talk around it: iOS 18 rather than 16.4,
/// and **the learner has to add the controls by hand, once** — Apple ships no way for an app to
/// install its own control. The card carries a one-line pointer at them (`LessonActivityView`);
/// that is a mitigation, not a guarantee.
///
/// Both controls are `ControlWidgetToggle`s rather than buttons because a lock screen gives no
/// other way to see which way the switch is currently thrown, and "is the microphone live right
/// now" is exactly the question a paused learner is asking.

// ── the value provider ───────────────────────────────────────────────────────────────────────────

/// Where a control's state comes from.
///
/// `currentValue()` runs in the widget extension's process, whenever the system decides to redraw,
/// with no argument and no reach into the app's memory. So the answer has to be sitting in shared
/// storage before it is asked for — which is what `ControlChannel.phaseKey` is, written by the app
/// on every state push and optimistically by the intents. §1.6.
@available(iOS 18.0, *)
struct LessonPhaseProvider: ControlValueProvider {
  /// What the add-control sheet shows before the control is real. A live lesson, because that is
  /// the state the control is *for* — previewing it as idle would show two dead switches to
  /// someone deciding whether to install them.
  var previewValue: ControlChannel.Snapshot { .live }

  func currentValue() async throws -> ControlChannel.Snapshot {
    ControlChannel.snapshot
  }
}

// ── pause ────────────────────────────────────────────────────────────────────────────────────────

@available(iOS 18.0, *)
struct LessonPauseControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(
      kind: ControlChannel.pauseControlKind,
      provider: LessonPhaseProvider()
    ) { snapshot in
      ControlWidgetToggle(isOn: snapshot.isHeld, action: SetPauseIntent()) {
        Label(
          snapshot.isHeld ? "Paused" : "Lesson",
          systemImage: snapshot.isHeld ? "play.fill" : "pause.fill"
        )
      } valueLabel: { isPaused in
        // The value label is what the Lock Screen renders under the glyph, so it says what the
        // session IS, not what the press would do. Two different sentences, and swapping them is
        // the classic way a toggle ends up lying.
        Text(isPaused ? "Paused" : "Listening")
      }
      // Disabled rather than hidden: a control cannot be removed from the Lock Screen by the app,
      // so the honest thing when no lesson is running is a switch that visibly does nothing. The
      // intent guards this too (`ControlChannel.record` refuses when idle) — belt and braces,
      // because the two run in different processes and the snapshot can go stale between them.
      .disabled(!snapshot.isRunning)
      .tint(snapshot.isHeld ? .orange : .green)
    }
    .displayName("Pause lesson")
    .description("Pause or resume your English lesson without unlocking the phone.")
  }
}

// ── mute ─────────────────────────────────────────────────────────────────────────────────────────

@available(iOS 18.0, *)
struct LessonMuteControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(
      kind: ControlChannel.muteControlKind,
      provider: LessonPhaseProvider()
    ) { snapshot in
      ControlWidgetToggle(isOn: snapshot.isMuted, action: SetMuteIntent()) {
        Label(
          snapshot.isMuted ? "Muted" : "Microphone",
          systemImage: snapshot.isMuted ? "mic.slash.fill" : "mic.fill"
        )
      } valueLabel: { isMuted in
        Text(isMuted ? "Muted" : "Live")
      }
      // A hold already owns the microphone (§3.3), so the only thing this toggle could offer during
      // one is an unmute the app would refuse. Off during a hold, exactly as the card's mute button
      // used to hide itself.
      .disabled(!snapshot.isRunning || snapshot.isHeld)
      .tint(snapshot.isMuted ? .orange : .green)
    }
    .displayName("Mute microphone")
    .description("Mute or unmute yourself in an English lesson without unlocking the phone.")
  }
}
