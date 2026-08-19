import Foundation
import MediaPlayer

/// The third lock-screen surface: the Now Playing card and its transport buttons.
///
/// **Why it exists when the Controls already work.** The Controls are the recommendation (§1.4) and
/// they carry both actions, but they have one weakness the research refused to talk around: Apple
/// gives an app no way to install its own control, so a learner who never opens Settings never gets
/// one. Now Playing has the opposite trade — it appears by itself, with no setup at all, and it can
/// only ever carry pause. Between them: everybody gets pause without unlocking, and the learner who
/// spent thirty seconds in Settings also gets mute.
/// See docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md §1.4 item 4, §1.7.
///
/// **What it deliberately does not do.**
///
/// *No mute command.* There is no `MPRemoteCommand` for muting, and binding it to
/// `nextTrackCommand` would put a privacy action behind a ⏭ glyph — a button that stops recording
/// you, wearing the icon for "skip". Mute stays on the Control that can say `mic.slash.fill` and
/// mean it. The mitigation is that **a pause already mutes** (P0 doc §3.1), so a locked phone with
/// only pause is not a locked phone with no privacy control.
///
/// *No scrubber.* `MPNowPlayingInfoPropertyIsLiveStream` is the answer to the P0 doc's objection
/// that "a transport metaphor implies a timeline and a live conversation has neither" — the system
/// renders a live stream with no scrubber and no elapsed/remaining pair.
///
/// *No change to the audio session.* LiveKit's `registerGlobals()` puts the session into
/// `playAndRecord`, and whether a voice-chat session is even eligible to become the Now Playing app
/// is the open question this file exists to answer on a device (probe P-1). Re-platforming the
/// audio session to force the answer would be a much larger and much riskier change than the one
/// being tested, so this does not touch it: it populates the info centre and lets iOS decide.
@available(iOS 13.0, *)
enum NowPlayingSurface {

  /// Publish, or re-publish, what the lesson is doing.
  ///
  /// `playbackState` is set as well as `nowPlayingInfo`, and both matter: the info centre draws the
  /// card, and the playback state is what decides whether the button is ▶ or ⏸. Setting one without
  /// the other is how a paused session ends up with a pause button.
  static func publish(title: String, subtitle: String, held: Bool) {
    onMain {
      registerCommands()
      MPNowPlayingInfoCenter.default().nowPlayingInfo = [
        MPMediaItemPropertyTitle: title,
        MPMediaItemPropertyArtist: subtitle,
        MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        // The whole of the answer to "a transport metaphor implies a timeline". §1.7.
        MPNowPlayingInfoPropertyIsLiveStream: true,
        MPNowPlayingInfoPropertyPlaybackRate: held ? 0.0 : 1.0,
      ]
      MPNowPlayingInfoCenter.default().playbackState = held ? .paused : .playing
    }
  }

  static func clear() {
    onMain {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      MPNowPlayingInfoCenter.default().playbackState = .stopped
    }
  }

  /// Wire the transport buttons, exactly once.
  ///
  /// A `static let` rather than a mutable `registered` flag: a lazy static in Swift is initialised
  /// once, thread-safely, and cannot be reset — which is the requirement, because `addTarget` is
  /// additive and a second registration would fire every handler twice.
  private static let commandsRegistered: Void = {
    let center = MPRemoteCommandCenter.shared()

    // Toggle is what a headphone pinch and an AirPods squeeze send, and it carries no opinion about
    // which direction it means — which is exactly what the inbox wants.
    center.togglePlayPauseCommand.isEnabled = true
    center.togglePlayPauseCommand.addTarget { _ in
      ControlChannel.record("pause") ? .success : .noSuchContent
    }

    // The Lock Screen and Control Center send the DIRECTIONAL commands instead, and a direction has
    // to be reconciled against what is already true before it becomes a toggle. Without this, a
    // `pause` arriving for a session that is already held would flip it back to live — the button
    // would resume the lesson it was pressed to pause.
    //
    // This is the same class of decision as `ControlChannel.record`'s "is there a lesson at all"
    // guard, and the same defence: it asks whether the press changes anything, never what the
    // change should mean. The fold in `resolveIntents` still owns that. §4.2.
    center.pauseCommand.isEnabled = true
    center.pauseCommand.addTarget { _ in perform(desiredHold: true) }

    center.playCommand.isEnabled = true
    center.playCommand.addTarget { _ in perform(desiredHold: false) }

    // Everything else is switched off so the card renders as a live stream with one button rather
    // than a transport bar with dead glyphs. `changePlaybackPosition` in particular must go: an
    // enabled scrubber on a live conversation is the P0 doc's original objection, restored.
    for unused in [
      center.nextTrackCommand,
      center.previousTrackCommand,
      center.seekForwardCommand,
      center.seekBackwardCommand,
      center.skipForwardCommand,
      center.skipBackwardCommand,
      center.changePlaybackPositionCommand,
      center.stopCommand,
    ] {
      unused.isEnabled = false
    }
  }()

  private static func registerCommands() { _ = commandsRegistered }

  private static func perform(desiredHold: Bool) -> MPRemoteCommandHandlerStatus {
    let snapshot = ControlChannel.snapshot
    guard snapshot.isRunning else { return .noSuchContent }
    // Already where the press wants it. Reporting success rather than recording a no-op press keeps
    // the button responsive without putting anything in the inbox for the fold to cancel out.
    guard snapshot.isHeld != desiredHold else { return .success }
    guard ControlChannel.record("pause") else { return .noSuchContent }
    ControlChannel.applyOptimistically(action: "pause", desired: desiredHold)
    return .success
  }

  /// `MPRemoteCommandCenter` registration and `MPNowPlayingInfoCenter` writes both want the main
  /// thread; an Expo `Function` runs on whichever thread JS is on.
  private static func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread {
      work()
    } else {
      DispatchQueue.main.async(execute: work)
    }
  }
}
