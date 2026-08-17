import ActivityKit
import CoreFoundation
import ExpoModulesCore
import Foundation

/// The app-side half of the lock-screen card: start it, push state into it, end it, and forward the
/// taps that come back.
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

    /// Must be called from the foreground — iOS refuses to START an activity from the background,
    /// though it will happily let us update one. The caller does this on the Start tap, which is a
    /// foreground tap by construction.
    ///
    /// Returns the activity id, or `nil` when no card was created. The caller keys its "is there a
    /// card" state off this value rather than off the call having been made, so a refusal leaves it
    /// free to try again rather than pushing updates at nothing.
    AsyncFunction("start") { (title: String, deepLink: String, state: [String: Any]) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      guard let content = LessonActivityModule.decode(state) else { return nil }
      // Idempotent: a second start while a card is live updates it instead of stacking a duplicate,
      // which is what a fast double-tap or a remount would otherwise produce.
      if let existing = Activity<LessonActivityAttributes>.activities.first {
        await existing.update(ActivityContent(state: content, staleDate: nil))
        return existing.id
      }
      do {
        let activity = try Activity.request(
          attributes: LessonActivityAttributes(title: title, deepLink: deepLink),
          content: ActivityContent(state: content, staleDate: nil)
        )
        return activity.id
      } catch {
        // A refusal is not exceptional — activities can be disabled per-app in Settings, the system
        // caps how many may be live, and the lesson must carry on regardless.
        return nil
      }
    }

    AsyncFunction("update") { (state: [String: Any]) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard let content = LessonActivityModule.decode(state) else { return false }
      let activities = Activity<LessonActivityAttributes>.activities
      for activity in activities {
        await activity.update(ActivityContent(state: content, staleDate: nil))
      }
      return !activities.isEmpty
    }

    AsyncFunction("end") { () -> Void in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<LessonActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    /// The intent inbox, drained and cleared in one call.
    ///
    /// Returned rather than acted on: which tap means what depends on state only JavaScript holds,
    /// and End in particular is resolved against timestamps there (a first tap arms a confirm, a
    /// second inside the window ends the session). §3.5, §7.7.
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
