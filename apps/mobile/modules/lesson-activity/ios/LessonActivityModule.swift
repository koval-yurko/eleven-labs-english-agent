import ActivityKit
import CoreFoundation
import ExpoModulesCore
import Foundation
import WidgetKit

/// The app-side half of the lock-screen surfaces: one card, two controls, and the taps that come
/// back from them.
///
/// Everything here is transport. No decision about what a tap MEANS is taken in Swift — the state
/// machine lives in JavaScript, which owns the ElevenLabs SDK and the transcript marks a resume
/// depends on. See docs/2026-08-16-background-controls-lock-screen.md §4.2.
///
/// Every helper below is `static` and every async closure is free of `self`. That is a requirement,
/// not a style: `AsyncFunction`'s concurrent overload takes a `@Sendable` closure, ExpoModulesCore
/// builds under Swift 6, and capturing a non-`Sendable` module instance in one is a compile error.
public class LessonActivityModule: Module {

  public func definition() -> ModuleDefinition {
    Name("LessonActivity")

    Events("onControlIntent")

    /// Live Activities exist from iOS 16.2, and the learner may also have switched them off for
    /// this app in Settings. Both are the same answer to the caller: do not bother pushing state.
    Function("isAvailable") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    /// Whether the two Controls can exist at all. iOS 18, and only on a build that shipped them.
    ///
    /// It does NOT report whether the learner has actually installed them — Apple exposes
    /// `ControlCenter.currentControls()` for that, but it is asynchronous, throwing, and answers a
    /// question the app cannot act on anyway (there is no API to add a control on someone's
    /// behalf). The card's pointer is shown on capability, not on adoption.
    Function("areControlsSupported") { () -> Bool in
      if #available(iOS 18.0, *) { return true }
      return false
    }

    /// How many of our activities the system still considers on-screen.
    ///
    /// `.active` and `.stale` both count: a stale activity is one whose `staleDate` has passed, and
    /// it is still sitting on the lock screen looking like a lesson. `.ended` and `.dismissed` do
    /// not — those are gone or going, and adopting one would push state into an animation.
    AsyncFunction("activeCount") { () -> Int in
      guard #available(iOS 16.2, *) else { return 0 }
      return LessonActivityModule.adoptable().count
    }

    /// Start the card, or adopt the one that is already there.
    ///
    /// Must be called from the foreground — iOS refuses to START an activity from the background,
    /// though it will happily let us update one. The caller does this on the Start tap, which is a
    /// foreground tap by construction.
    ///
    /// **Adoption, not re-creation, is the fix for "a new card per lesson".** `title` and
    /// `deepLink` moved into `ContentState`, so an activity started for yesterday's lesson is a
    /// perfectly good home for today's — it just needs a push. Any surplus activities found
    /// alongside it are ended here rather than left to accumulate, which is the only place in the
    /// app that can see them at all: `Activity.activities` is the system's list, not ours, and it
    /// survives crashes, force-quits and reinstalls of the JS bundle. §2.2–§2.5.
    ///
    /// Returns the activity id, or `nil` when no card was created. The caller keys its "is there a
    /// card" state off this value rather than off the call having been made, so a refusal leaves it
    /// free to try again rather than pushing updates at nothing.
    AsyncFunction("start") { (state: [String: Any]) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      guard let content = LessonActivityModule.decode(state) else { return nil }

      let live = LessonActivityModule.adoptable()
      if let adopted = live.first {
        await adopted.update(ActivityContent(state: content, staleDate: nil))
        // Everything else of ours is a duplicate by definition — there is one lesson at a time.
        for surplus in live.dropFirst() {
          await surplus.end(nil, dismissalPolicy: .immediate)
        }
        ControlChannel.defaults?.set(adopted.id, forKey: ControlChannel.activityIdKey)
        return adopted.id
      }

      do {
        let activity = try Activity.request(
          attributes: LessonActivityAttributes(),
          content: ActivityContent(state: content, staleDate: nil)
        )
        ControlChannel.defaults?.set(activity.id, forKey: ControlChannel.activityIdKey)
        return activity.id
      } catch {
        // A refusal is not exceptional — activities can be disabled per-app in Settings, the system
        // caps how many may be live, and the lesson must carry on regardless.
        return nil
      }
    }

    /// Push new state into the one card. The controls are refreshed separately — see `publishPhase`.
    ///
    /// Addressed, not fanned out: the previous version updated every activity it could find, which
    /// meant a duplicate card was not merely orphaned but kept alive and in sync, indistinguishable
    /// from the real one. §2.5.
    ///
    /// `false` means there was nothing to reach. The caller uses that to stop pushing rather than
    /// assuming the card it started is still there.
    AsyncFunction("update") { (state: [String: Any]) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard let content = LessonActivityModule.decode(state) else { return false }

      let live = LessonActivityModule.adoptable()
      guard let target = live.first else {
        ControlChannel.defaults?.removeObject(forKey: ControlChannel.activityIdKey)
        return false
      }
      await target.update(ActivityContent(state: content, staleDate: nil))
      for surplus in live.dropFirst() {
        await surplus.end(nil, dismissalPolicy: .immediate)
      }
      ControlChannel.defaults?.set(target.id, forKey: ControlChannel.activityIdKey)
      return true
    }

    /// End every activity of ours, whatever state it is in, and clear the shared snapshot.
    ///
    /// Deliberately "every", not "the one we remember". This is the function that cleans up after a
    /// crash, a force-quit, or a build that stored its id somewhere this one no longer reads — the
    /// cases where our bookkeeping is exactly what cannot be trusted. Apple names this as the thing
    /// to do at launch: check what is still active and end what is no longer relevant.
    AsyncFunction("end") { () -> Void in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<LessonActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      ControlChannel.clearSnapshot()
      ControlChannel.defaults?.removeObject(forKey: ControlChannel.activityIdKey)
      ControlChannel.defaults?.removeObject(forKey: ControlChannel.inboxKey)
      LessonActivityModule.reloadControls()
      // All three surfaces go together. A Now Playing card outliving its session is worse than a
      // stale Live Activity: it has a real ▶ button and no way to say the lesson is over.
      if #available(iOS 13.0, *) { NowPlayingSurface.clear() }
    }

    /// Tell the two Controls what the session is doing, and ask Control Center to redraw them.
    ///
    /// **Separate from the card on purpose.** A control's state is pulled, not pushed: the system
    /// calls `currentValue()` in the extension's process whenever it chooses, so the answer has to
    /// be sitting in App Group storage first. Routing that write through the card's start/update
    /// would tie it to a card that may not exist — Live Activities are switchable off per app in
    /// Settings, and the controls have to keep working when they are off. Two surfaces, one fact,
    /// and the fact is published whether or not either surface is available. §1.6.
    ///
    /// It also serves the paths that change phase without touching the card at all: a pause pressed
    /// *inside* the app must not leave the lock-screen toggle showing the opposite of the truth.
    Function("publishPhase") { (phase: String) -> Void in
      ControlChannel.writeSnapshot(
        LessonActivityAttributes.Phase(rawValue: phase) ?? .over
      )
      LessonActivityModule.reloadControls()
    }

    /// Populate the Now Playing card and enable its transport buttons.
    ///
    /// The third surface, and the only one that needs no setup from the learner at all — see
    /// `NowPlayingSurface` for what it carries, what it deliberately does not, and why it does not
    /// touch the audio session. §1.4 item 4, §1.7.
    ///
    /// The subtitle arrives already formatted from JS rather than being composed here: the card's
    /// equivalent sentence lives in the widget extension because the extension renders with no JS
    /// available, but this surface is drawn by the app, so its copy belongs where all the other
    /// app-side copy is.
    Function("publishNowPlaying") { (title: String, subtitle: String, held: Bool) -> Void in
      guard #available(iOS 13.0, *) else { return }
      NowPlayingSurface.publish(title: title, subtitle: subtitle, held: held)
    }

    Function("clearNowPlaying") { () -> Void in
      guard #available(iOS 13.0, *) else { return }
      NowPlayingSurface.clear()
    }

    /// The intent inbox, drained and cleared in one call.
    ///
    /// Returned rather than acted on: which tap means what depends on state only JavaScript holds.
    /// §4.3.
    Function("drainIntents") { () -> [[String: Any]] in
      guard let defaults = ControlChannel.defaults else { return [] }
      let inbox = defaults.array(forKey: ControlChannel.inboxKey) as? [[String: Any]] ?? []
      defaults.removeObject(forKey: ControlChannel.inboxKey)
      return inbox
    }

    // A Darwin observer, so the signal arrives whichever process ran the intent (§4.3). Darwin
    // notifications carry no payload, which suits this exactly: the event means "there is something
    // in the inbox", and JS drains it. One delivery path for taps instead of two that can disagree —
    // and the inbox is the one that survives the app not having been running at all.
    OnStartObserving {
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      CFNotificationCenterAddObserver(
        center,
        Unmanaged.passUnretained(self).toOpaque(),
        { _, observer, _, _, _ in
          guard let observer else { return }
          let module = Unmanaged<LessonActivityModule>.fromOpaque(observer).takeUnretainedValue()
          // The C callback can arrive on any thread; the event has to leave from the main one.
          DispatchQueue.main.async { module.sendEvent("onControlIntent") }
        },
        ControlChannel.didReceiveIntent,
        nil,
        .deliverImmediately
      )
    }

    OnStopObserving {
      CFNotificationCenterRemoveObserver(
        CFNotificationCenterGetDarwinNotifyCenter(),
        Unmanaged.passUnretained(self).toOpaque(),
        CFNotificationName(ControlChannel.didReceiveIntent),
        nil
      )
    }
  }

  /// The activities the system still shows. See `activeCount` for why `.stale` is one of them.
  @available(iOS 16.2, *)
  private static func adoptable() -> [Activity<LessonActivityAttributes>] {
    Activity<LessonActivityAttributes>.activities.filter {
      $0.activityState == .active || $0.activityState == .stale
    }
  }

  private static func reloadControls() {
    guard #available(iOS 18.0, *) else { return }
    ControlCenter.shared.reloadControls(ofKind: ControlChannel.pauseControlKind)
    ControlCenter.shared.reloadControls(ofKind: ControlChannel.muteControlKind)
  }

  /// JS objects arrive as `[String: Any]`; `ContentState` is `Codable`. Round-tripping through JSON
  /// is what keeps the field list in one place — the Swift struct — rather than in a hand-written
  /// mapping that drifts the first time a field is added.
  ///
  /// `focusIndex` is `Int?` and arrives as `NSNull` when JS sends `null`, which
  /// `JSONSerialization` handles; a missing key would decode as nil too.
  private static func decode(_ state: [String: Any]) -> LessonActivityAttributes.ContentState? {
    guard JSONSerialization.isValidJSONObject(state),
      let data = try? JSONSerialization.data(withJSONObject: state)
    else { return nil }
    return try? JSONDecoder().decode(LessonActivityAttributes.ContentState.self, from: data)
  }
}
