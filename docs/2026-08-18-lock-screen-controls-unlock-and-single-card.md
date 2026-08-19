# Lock-screen controls, part two — the buttons need an unlocked phone, and there is a card per lesson

**Date:** 2026-08-18
**Scope:** `apps/mobile`. Revises `docs/2026-08-16-background-controls-lock-screen.md` (hereafter
**the P0 doc**) on two points, one of which invalidates the surface its P2 was built on. Touches
`targets/controls/`, `modules/lesson-activity/`, `src/lib/lesson-activity-state.ts` and
`src/app/lessons/[id]/index.tsx`, and proposes moving activity ownership out of that screen into
`src/app/_layout.tsx`. iOS only. No web work, no `packages/shared` change.
**Status:** research, then built. §1–§6 are the research and are unchanged; **§7 records what was
implemented** — Q1, Q2 and Q3 on 2026-08-18, Q4 on 2026-08-19. Q3 has been exercised on a device and
works; Q4 compiles and bundles and **has not.** The P0 doc's §11 probes are still open, and so are
the seven in §5 — the device plan that replaces them is §8.
Claims are tagged `[docs]` (Apple documentation, fetched 2026-08-18), `[code]` (this repo),
`[unverified]` (needs a device).

---

## §0 The headline — one complaint is a design error, the other is a bug list

**Complaint 1 — "I have to unlock the phone to press Pause."** This is not a bug in our code. It is
Apple's documented, deliberate behaviour for every button in every widget and every Live Activity,
and no entitlement, policy or configuration turns it off `[docs]`:

> Widgets and Live Activities can include buttons and toggles to offer specific app functionality
> without launching the app. **On a locked device, buttons and toggles are inactive and the system
> doesn't perform actions unless a person authenticates and unlocks their device.**
> — *Adding interactivity to widgets and Live Activities*

So the interactive half of the P0 doc's P2 cannot work on the surface it was built on. The card
still earns its place — **reading** it needs no unlock, and the word list and the status line were
always the part only a Live Activity could do — but the three buttons have to move to a surface the
system does not gate.

**The recommendation is iOS 18 Controls** (§1.4, §1.5): a `ControlWidgetToggle` for pause and one
for mute, living in the widget extension we already have, running the intents we already wrote,
writing to the App Group inbox we already drain. Controls are gated by the intent's own
`authenticationPolicy`, which **defaults to `.alwaysAllowed`** — so unlike a widget button, a
control runs on a locked phone unless you deliberately ask it not to. It is the only surface that
can put the right word and the right symbol on *both* controls the ask names, and the only one that
touches neither the audio session nor what the app pretends to be. What it costs is an iOS 18 floor
and a one-time manual install by the learner, which §1.5 does not talk around.

Two alternatives stay documented and unbuilt: **Now Playing** (§1.7), the fallback if that manual
install turns out to be the adoption problem it might be, and **CallKit** (§1.8), which gives real
native buttons and categorically cannot render a word.

**Complaint 2 — "a new card appears for every lesson."** This one *is* ours, and it is not one bug
but seven, stacked (§2). The root of the stack is that the card is owned by
`src/app/lessons/[id]/index.tsx` — a screen that mounts, unmounts and remounts — while a Live
Activity is owned by the *system* and outlives the process. A per-screen `useRef` cannot reconcile
with a thing that survives a crash. Apple names the fix in one sentence `[docs]`:

> …the system may stop your app, or your app may crash while a Live Activity is active. **When the
> app launches the next time, check if any activities are still active**, update your app's stored
> Live Activity data, and **end any Live Activity that's no longer relevant**.
> — *Displaying live data with Live Activities*

We never do this. `cardRef` starts at `"none"` on every mount `[code, index.tsx:766]`, and the one
function that could clean up orphans refuses to run in exactly the state where orphans exist
`[code, index.tsx:856]`. §2 is that, plus six other reasons the same symptom appears.

---

## §1 The unlock gate

### 1.1 What is actually happening

Nothing in `ControlIntents.swift` runs. `perform()` is never called, the App Group inbox is never
written, the Darwin notification is never posted. The system stops the interaction at the widget
host, before our code is reached. That is why the symptom is "nothing happens until I unlock",
rather than a delayed or partial action — and it is also why no amount of instrumentation on our
side would ever have shown anything.

### 1.2 What it is **not** — rule this out before spending a build on it

The obvious first guess is `AppIntent.authenticationPolicy`, and it is wrong. Apple `[docs]`:

> Set the value of this property if you want someone to provide authentication before running the
> app intent. **The default value of this property is `alwaysAllowed`**, which allows the intent to
> run without authentication, including when the device is locked.

Our intents already have the most permissive policy available; setting it explicitly changes
nothing. `openAppWhenRun` is already `false` `[code]`, which is also correct — setting it `true`
would *guarantee* an unlock, because a foreground launch implies full device access.

Two other non-fixes, for the same reason:

- **`AudioPlaybackIntent` instead of `LiveActivityIntent`.** Both change only *which process* runs
  `perform()` `[docs]`. Neither changes whether the tap is delivered.
- **The App Group, the entitlement, the provisioning profile.** All of these are downstream of a
  `perform()` that never executes.

The one free thing worth checking first is a *device setting*, not code: **Settings → Face ID &
Passcode → Allow Access When Locked → Live Activities** `[unverified]`. It is documented as
governing whether the card is *shown* while locked, and the card is clearly shown, so this is
expected to change nothing — but it costs thirty seconds and it is the only hypothesis that would
make the rest of this section unnecessary.

### 1.3 The surfaces that do work on a locked phone

| Surface | Works locked? | Buttons we get | Floor | Learner setup | Fit |
|---|---|---|---|---|---|
| **Live Activity `Button(intent:)`** (what we built) | **no** `[docs]` | 3, any label | iOS 17 | none | display only |
| **Now Playing** — `MPRemoteCommandCenter` | **yes** | ≤3, fixed glyphs (⏮ ⏯ ⏭) | iOS 16.4 | none | pause/resume exactly; mute badly |
| **Controls** — `ControlWidgetButton` / `ControlWidgetToggle` on the Lock Screen or in Control Center | **yes**, unless you opt into auth `[docs]` | 2 (the Lock Screen's two slots), correct icons and labels | **iOS 18** | **must add them once, by hand** | **pause and mute, correctly labelled — recommended (§1.5)** |
| **CallKit** — `CXProvider` | **yes** | the system call UI: Mute, End, speaker — **no Pause, no pixels of ours** | iOS 10 | none | mute and end exactly; word list impossible (§1.8) |

The Controls row is the one that is easy to disbelieve, so here is Apple's sentence `[docs]`:

> **For added privacy, require device authentication before a control performs its action**, as well
> as redact the text in a control when the device is locked.
> — *Creating controls to perform actions across the system*

Authentication is opt-**in** for Controls and mandatory for widget buttons. That asymmetry is the
whole of §1. A `ControlWidgetToggle` lives in the *same widget extension we already have*
(`targets/controls/`), runs the *same kind of App Intent*, and reaches the same App Group inbox —
so almost everything P2 built is reusable. What changes is where the learner presses.

### 1.4 Recommendation

**Split the card in two: the Live Activity keeps the information, and the controls move off it.**

1. **Demote the Live Activity to read-only.** Keep the words, the `+K more`, the four status
   sentences and the §7.6 disclosure — all of that reads fine on a locked phone and none of it is
   available on any other surface. Delete the three `Button(intent:)` calls from `ControlRow`
   `[code, LessonActivityView.swift]` and replace them with the state as *text*, because a button
   that does nothing until you unlock is worse than no button: it teaches the learner that the card
   is broken. The iOS 16.4 fallback branch already contains the right sentence
   (*"Open the app to pause or mute"*) — it stops being a fallback and becomes the only branch.
2. **Two iOS 18 Controls carry pause and mute. This is the primary path.** One
   `ControlWidgetToggle` per control, in the widget extension we already have, each labelled with
   the word it means and the symbol it means — `pause.fill` / `play.fill`, `mic.fill` /
   `mic.slash.fill`. Their `perform()` is `ControlChannel.record`, unchanged. §1.5 is the argument;
   §1.6 is the mechanics.
3. **The Live Activity card is where we tell them the Controls exist** — one line, once, while the
   card is showing a lesson in progress. A control nobody installed does nothing, and this is the
   only surface that can say so at the moment it matters. It is also why the card must survive
   losing its buttons rather than being deleted along with them.
4. **Now Playing is the fallback, not the plan** (§1.7). It is the only route that reaches iOS 16.4
   and the only one that needs no setup, so it stays on the table — deferred, behind a probe, and
   scoped to pause/resume alone.

The single-writer rule from the P0 doc §4.2 survives all of this unchanged and is the reason the
migration is cheap: every one of these surfaces posts an *intent* and lets JavaScript decide. Now
Playing's handler and a Control's `perform()` both do exactly what `ControlChannel.record` already
does — append to the App Group inbox, post the Darwin notification — and `drainControlIntents` /
`resolveIntents` `[code, src/lib/lesson-activity-state.ts]` do not change at all. The pure resolver
was written against a stream of taps, not against a widget, and that is now paying for itself.

### 1.5 Why Controls is the primary path

Three surfaces work on a locked phone (§1.3). Controls wins on the axis that decides this feature —
**it is the only one that can put the right word and the right symbol on both controls the ask
names.** Now Playing has one usable button and a fixed glyph vocabulary that contains no mute.
CallKit has mute and end and no pause, and no pixels of ours at all. Controls has two slots, arbitrary
`Label`s and arbitrary SF Symbols, and the learner reads `Pause lesson` and `Mute microphone` in
words.

The rest of the case is that it is the **smallest delta** of the three, by a wide margin:

- **It reuses everything P2 built.** Same widget extension (`targets/controls/`), same App Group,
  same `ControlChannel.record`, same Darwin notification, same inbox, same `drainControlIntents` and
  the same `resolveIntents` fold. The intents themselves barely change. What P2 got wrong was the
  *surface*, not the machinery — and this is the only option that keeps the machinery.
- **It touches no audio.** Now Playing depends on an unverified question about whether a
  `playAndRecord` / `voiceChat` session can present a Now Playing card at all (§1.7). CallKit hands
  the `AVAudioSession` to the system and rewrites the path S1's background audio stands on (§1.8).
  Controls risk neither. For a feature whose entire premise is "the conversation must survive the
  lock screen", not touching the audio session is worth more than it sounds.
- **It keeps the lesson a lesson.** Now Playing makes the app the system's media player — taking
  over the AirPods squeeze, the headphone button and the car steering wheel for a conversation.
  CallKit makes the lesson a phone call, with a green pill, a Recents entry and real-call
  interaction. Controls add a button and change nothing else about what the app is.
- **Its one unknown is cheap to close** (P-3), and Apple's documentation already answers it in the
  affirmative. Now Playing's unknown (P-1) has no documented answer at all, and CallKit's (P-6) is
  a question nobody has written down.

**What it costs, and this is the real trade:** iOS 18 rather than 16.4, and the learner must install
the controls **by hand, once**. That second one is the honest weakness of this recommendation — a
control nobody added is a feature nobody has, and we cannot add it for them. §1.4 item 3 is the
mitigation and it is a real one (the card can ask, at the moment the learner is looking at the card
and wishing it had buttons), but it is a prompt, not a guarantee. If adoption turns out to be the
problem, Now Playing is the answer to it — zero setup, works from 16.4 — which is exactly why §1.7
stays on the table rather than being deleted.

### 1.6 Controls, in full — and what "opt into auth" means

A **Control** (iOS 18) is a button or a toggle the *learner* installs into a system space. Three
spaces, all reachable without unlocking:

- **The Lock Screen's two bottom slots** — the ones that ship as flashlight and camera. In iOS 18
  those are editable, and a control can take either. Two slots total, and taking both means taking
  the learner's torch.
- **Control Center**, swiped down from the top-right of a locked phone (governed by Settings → Face
  ID & Passcode → Allow Access When Locked → **Control Center**, on by default). Plenty of room.
- **The Action button**, on iPhone 15 Pro and later.

Mechanically it is the same widget extension, the same App Intents framework and the same App Group
we already have. `targets/controls/` hosts it; `ControlChannel.record` is the whole of `perform()`,
exactly as it is today. What is different is only *where the learner presses*.

**"Unless you opt into auth" means the lock gate is a property you set, not a rule you obey.**
`AppIntent.authenticationPolicy` has three values `[docs]`:

| Policy | Behaviour |
|---|---|
| **`.alwaysAllowed`** — **the default** | runs at any time, **including when the device is locked** |
| `.requiresAuthentication` | the device must be unlocked; the system prompts first |
| `.requiresLocalDeviceAuthentication` | authentication on *this* device specifically |

Apple's own framing for Controls `[docs]`: *"For added privacy, **require** device authentication
before a control performs its action, as well as redact the text in a control when the device is
locked."* Requiring is the thing you do; not requiring is what happens if you write nothing.

That is the entire difference between this surface and the one P2 was built on. A Live Activity
`Button(intent:)` is gated by the **widget host**, before your intent is ever consulted — the
policy is not read, and there is no value you can set to change it (§1.2). A Control is gated by the
**intent's own policy**, which defaults open. Same framework, same extension, same `perform()`;
opposite defaults, because a widget button is something the system put in front of a stranger
holding your phone, whereas a control is something its owner deliberately installed.

So our two intents want `.alwaysAllowed` — which they already have implicitly. Writing it out
anyway is worth the line: it is the property this whole approach rests on, and a default that
load-bearing should be legible at the call site rather than inferred from documentation.

**The catches, all of them:**

- **iOS 18.** A hard floor for this surface, above the app's 16.4 and above P2's 17.0. Gated with
  `@available(iOS 18.0, *)` in the same bundle, so older devices lose nothing they have today.
- **The learner has to install it, once, by hand.** Nothing we can automate, and a control nobody
  added does nothing. The Live Activity card is the only place we can plausibly tell them it exists
  (§1.4 item 3), which is one more reason to keep the card.
- **The toggle's state comes from a `ControlValueProvider`, not from us pushing.** `currentValue()`
  is queried by the system — including **immediately after `perform()` returns** `[docs]`. Our
  `perform()` only appends to the inbox; JavaScript decides what the tap meant, milliseconds to
  seconds later. So unless `perform()` *also* writes an optimistic phase into the App Group before
  returning, the toggle will visibly snap back to its old state and then flip again when the real
  state lands. This is the same optimistic-write requirement as the P0 doc's probes #4 and #9,
  arriving on a surface where it is mandatory rather than a latency optimisation.
- **Pushing state the other way needs `ControlCenter.shared.reloadControls(ofKind:)`** `[docs]` — a
  pause pressed in-app must move the lock-screen toggle, or the two disagree the first time the
  learner uses both.
- **Text can be redacted when locked** (`privacySensitive()` plus the privacy redaction reason). We
  do not want that here — the whole point is a control that reads correctly on a locked phone — but
  it is worth knowing the mechanism exists, because a redacted control is indistinguishable from a
  broken one.
### 1.7 Now Playing — the fallback, and what it costs

The P0 doc §1 rejected Now Playing for three reasons. Two of them still stand and one has an answer:

- **"There is no mute remote command."** Still true, and still the reason not to bind mute to
  `nextTrackCommand`: a ⏭ glyph on the control that stops the microphone recording you is a privacy
  action behind a wrong icon. **So don't.** Now Playing gets pause/resume only; mute goes to a
  Control that can say `mic.slash.fill` and mean it. On iOS 17 and below, mute stays an in-app
  control — which is a real regression against the ask, and is worth stating rather than hiding.
  The mitigation available today is that **pause already mutes** (P0 doc §3.1), so a locked phone
  with only pause is not a locked phone with no privacy control; it is a locked phone whose privacy
  control also holds the line, which is the safer default of the two anyway.
- **"A transport metaphor implies a timeline and a live conversation has neither."** This one has a
  fix the P0 doc did not know about: set **`MPNowPlayingInfoPropertyIsLiveStream = true`**. The
  system then renders the card without a scrubber and without an elapsed/remaining pair. The
  objection was to a scrubber that does nothing; a live stream has no scrubber.
- **"We do not populate `MPNowPlayingInfoCenter` anywhere today."** Still true. This is now work
  rather than an argument.

The unknown that decides feasibility is **whether we can become the Now Playing app at all**
`[unverified]`. LiveKit's `registerGlobals()` puts the session into `playAndRecord`
`[code, src/app/_layout.tsx:3]`, likely with the `voiceChat` mode, and a voice-chat session is not
obviously eligible for a Now Playing card. This is probe P-1 in §5 and it is the **single
highest-value thing to test**, because a negative answer collapses the recommendation onto Controls
alone (iOS 18, learner setup required) or onto CallKit.

### 1.8 CallKit — real buttons, no UI of our own

A tutor lesson is a live two-way voice conversation. Modelled as a `CXProvider` call, the learner
gets the **system call UI on the lock screen**: native buttons that work locked, with no
authentication, no learner setup, and no configuration. It would also delete §2's problem class
outright — there is one call, so there cannot be several cards.

**But CallKit gives us zero pixels.** The call screen is the Phone app's, and the entire surface we
control is `CXProviderConfiguration`: `localizedName`, `ringtoneSound`, `iconTemplateImageData` (a
monochrome 40×40 template), plus the `CXHandle` / `localizedCallerName` strings on the call itself
`[docs]`. There is no view, no list, no SwiftUI, no extension point. A 2022 developer request to
customise or disable the CallKit call presentation is still sitting unanswered `[docs, forums
719281]`. **The word list cannot live here**, and no amount of work makes it.

**And the buttons it gives are not the ones the ask names first.** The third-party in-call grid is
mute / keypad / speaker / add call / video / contacts, plus End `[docs]`. So:

| Our control | CallKit | Note |
|---|---|---|
| Mute / unmute | **yes** — `CXSetMutedCallAction` → `provider(_:perform:)` | native toggle, correct label, correct icon |
| End | **yes** — `CXEndCallAction` | which P0 §3.5 deliberately did *not* want on the lock screen |
| **Pause / resume** | **no button** | `CXSetHeldCallAction` exists in the API, but the system UI has no discoverable Hold control for a VoIP call; it arrives when the *system* holds the call, e.g. an incoming cellular call `[unverified]` |

That is the exact inverse of Now Playing, which gives pause and not mute (§1.7). Neither surface
alone covers the ask.

**The move that makes CallKit work anyway: bind the Mute button to `holdSession`.** On a locked
phone the two controls collapse, and they collapse in CallKit's favour. A learner who presses Mute
mid-lesson and puts the phone in a pocket gets, with a true mute, a tutor that re-engages after
`turn_timeout` and monologues at a microphone that is off (P0 §3.4) — which is worse than a pause in
every respect. Our held pause *is* a mute plus the heartbeat that stops that happening. So Mute →
`holdSession`, unmute → `releaseSession`, and the rarer standalone mute (tutor keeps teaching) stays
in-app or on an iOS 18 Control where it can be labelled honestly. The system renders the toggle
state for us, and `CXCallController` can request the transaction in the other direction so an
in-app pause lights the lock-screen button.

**What it costs, with eyes open:**

- **The lesson becomes a phone call**, and everything downstream of that follows: a green pill in
  the status bar, an entry in the Phone app's Recents unless `includesCallsInRecents = false`,
  interaction with Do Not Disturb, and a real incoming call putting the lesson on hold.
- **The audio session changes owner.** CallKit activates it and the app must react in
  `provider(_:didActivate:)` instead of configuring it itself. That is precisely the code path S1's
  background audio depends on (`registerGlobals()` → `playAndRecord`,
  `docs/2026-08-13-expo-s1-background-audio.md`), so this is the highest-risk part of the change.
- **`voip` joins `audio` in `UIBackgroundModes`**, and review guideline 2.5.4 names VoIP as a
  legitimate background purpose `[docs]`. A WebRTC voice conversation qualifies on the technical
  reading; that it is a tutor rather than a person is a judgement call a reviewer makes, not one we
  can settle in advance `[unverified]`.
- **Known CallKit defects**, notably a mute button that visually deselects itself seconds after a
  tap when the app was backgrounded `[unverified, forums 707429]`.

**What it does *not* cost, correcting an earlier draft of this document:** the integration is not
a from-scratch native module. LiveKit ships an official example of exactly this pairing
(`livekit-examples/react-native-callkit`) plus `@livekit/react-native-callkeep`, and there is an
Expo module (`expo-callkit-telecom`). The documented pattern is `autoConfigure: false` so CallKeep
never touches `AVAudioSession`, then on `didActivateAudioSession` configure through
`AudioSession.setAppleAudioConfiguration` and enable the engine with
`AudioDeviceModule.setEngineAvailability` `[docs]`. That is a known road, not an unmapped one.

**So CallKit is viable and it is not the whole answer.** Its shape is: *controls yes, pixels never*.
Pairing it with the Live Activity for the word list is the obvious hybrid and turns on one unknown —
**whether a Live Activity renders on the Lock Screen at all while a CallKit call is active**, or
whether the call presentation takes the screen and the words disappear (probe P-6, §5). If the
answer is no, CallKit and "the list of words" are mutually exclusive and the ask has to choose.


---

## §2 One card, not one per lesson

Seven mechanisms produce this symptom. They are listed in the order they compound, not in order of
severity, because fixing any one alone leaves the others.

### 2.1 The ownership is per-screen; the object is per-process

`cardRef` and `pushedRef` are `useRef`s inside `lessons/[id]/index.tsx`
`[code, index.tsx:760, :766]`. Every mount starts at `"none"` / `null`. A Live Activity started by a
previous process, a previous screen, or a previous lesson is invisible to them. This is the root:
everything below is a consequence.

### 2.2 The only cleanup path refuses to run when there is something to clean up

```ts
const dismissActivity = useCallback(() => {
  if (cardRef.current === "none") return;   // index.tsx:856
  ...
  void endActivity();
}, []);
```

`endActivity()` reaches a native `end()` that already ends **every** activity, which is exactly
right `[code, LessonActivityModule.swift]`. But the JS guard above it short-circuits on
`cardRef.current === "none"` — the value it always has on a fresh process, which is precisely when
orphans from the previous process are on screen. The correct native call is sitting behind a guard
that is `true` in the only case that matters.

### 2.3 The lesson's identity is in `ActivityAttributes`, which cannot be updated

`title` and `deepLink` are static attributes `[code, LessonActivityAttributes.swift]`. ActivityKit
lets you update `ContentState` and nothing else. So `start`'s dedupe —

```swift
if let existing = Activity<LessonActivityAttributes>.activities.first {
  await existing.update(ActivityContent(state: content, staleDate: nil))
  return existing.id
}
```

— is a trap: reusing the card keeps the **previous lesson's title and the previous lesson's deep
link** while showing the new lesson's words. It is a correct dedupe that produces a wrong card, and
it is the reason "just reuse it" is not a fix on its own.

**This is the one structural change the whole section depends on: move `title` and `deepLink` out of
`LessonActivityAttributes` and into `ContentState`.** `LessonActivityAttributes` becomes an empty
marker struct. One activity can then serve every lesson for the life of the install, which is what
"one global control" actually means — not "we remember to end the old one" but "there is only ever
one, and it is retargeted."

### 2.4 `activities` is not filtered by `activityState`

Both `start` and `update` iterate `Activity<LessonActivityAttributes>.activities` without checking
`activityState` `[code, LessonActivityModule.swift]`. An activity that has ended is still tracked
until it is dismissed — up to four hours with the default policy `[docs]` — and `update()` on it is
a no-op. So `start` can "adopt" a corpse, return its id, report success, and leave the lesson
pushing state into something that will never render. Filter to `activityState == .active`
everywhere; it costs one clause and removes a whole failure family.

### 2.5 `update` fans out to *all* activities

```swift
for activity in activities { await activity.update(...) }
```

If several cards exist, every one of them shows the current lesson's state. This is why the
complaint is phrased as *"I need to remove them and find the appropriate active one"* — there is no
appropriate one to find, because the stale cards are being kept deliberately in sync with the live
one. Once §2.3 lands there is exactly one activity and the loop becomes a single addressed update
by stored id.

### 2.6 The two-minute "over" linger is a duplicate generator

`OVER_CARD_LINGER_MS = 120_000` `[code, src/lib/lesson-activity-state.ts:36]` keeps a
`phase: "over"` card alive for two minutes after a session ends, so `Start` has somewhere to live.
Start a second lesson inside that window and the old card is still there — and by §2.3 it cannot be
retargeted, and by §2.4 it may not even be updatable. Under the §2.3 fix this stops being a problem
by construction (the same single card is simply retargeted from `over` to `live`), which is a good
sign the fix is the right one. Until then, the linger has to be cancelled the moment a new session
starts, not two minutes later.

### 2.7 Nothing reconciles at launch, and nothing observes state

Two absences, both prescribed by Apple `[docs]`:

- **No launch reconcile.** Add a native `endAll()` / `reconcile()` and call it once, early, from
  `_layout.tsx` — before any lesson screen can mount. This alone fixes the reported symptom for
  every already-shipped orphan, and it is roughly ten lines.
- **No `activityStateUpdates` observation.** Today a card the learner swipes away is discovered only
  by the return value of the *next* `update` `[code, index.tsx:797-803]`. Observing
  `Activity.activityStateUpdates` turns that into a push, and lets the app forget a dismissed card
  immediately rather than at the next state change — which may be minutes away in a quiet lesson.

### 2.8 No `relevanceScore`, no `staleDate`

Neither is a fix, both are cheap insurance. `relevanceScore` decides the order of an app's cards on
the Lock Screen and which one takes the Dynamic Island `[docs]` — so if a duplicate ever does appear
again, the live one is on top instead of whichever was started first. `staleDate` makes an orphan
*look* orphaned (`isStale` flips, and the view can say so) instead of impersonating a live lesson
`[docs]`. Today both are `nil` at every call site `[code]`.

---

## §3 The change list

**Swift — `targets/controls/`**

- `LessonActivityAttributes.swift`: move `title` and `deepLink` into `ContentState`; the attributes
  struct becomes empty. (§2.3)
- `LessonActivityView.swift`: delete the three `Button(intent:)` calls; the card becomes read-only,
  and the existing iOS-16.4 text branch becomes the only branch. Add the one-line pointer at the
  Control. (§1.4)
- `ControlIntents.swift`: `ControlChannel` is **unchanged and still load-bearing** — the App Group,
  the inbox, the Darwin notification and `record()` are exactly what a Control's `perform()` needs.
  `PauseIntent` / `MuteIntent` stay; `EndIntent` goes (End was never for the lock screen — P0 §3.5 —
  and a Control has two slots, not three). Add `authenticationPolicy = .alwaysAllowed` explicitly:
  it is already the default (§1.2), but on the Control surface it is the property that decides the
  behaviour, and a default that load-bearing should be written down.
- **New** `LessonControls.swift` — **the primary deliverable of §1.** Two `ControlWidget`s
  (`@available(iOS 18.0, *)`), registered in `ControlsBundle`, each a `ControlWidgetToggle` driven by
  a `SetValueIntent`, with a `ControlValueProvider` reading the current phase out of the App Group.
  `perform()` must write an optimistic phase back into the App Group *before it returns*, or the
  toggle snaps back when the system queries `currentValue()` (§1.6).
- `expo-target.config.js`: nothing — `deploymentTarget: "16.4"` stays, the Controls are gated with
  `@available` exactly as the buttons were.

**Swift — `modules/lesson-activity/ios/`**

- `start`: adopt by stored id, filtered on `activityState == .active`; otherwise `endAll()` then
  `request`. Store the id in the App Group. (§2.2, §2.3, §2.4)
- `update`: address one activity by id, not a fan-out loop. (§2.5)
- **New** `endAll()` and `activeCount()`. (§2.7)
- **New** `observeActivityState` → an `onActivityEnded` event. (§2.7)
- **Deferred, not scheduled** — a `nowPlaying` surface: `MPNowPlayingInfoCenter` +
  `MPRemoteCommandCenter`, with `MPNowPlayingInfoPropertyIsLiveStream = true` and
  `togglePlayPauseCommand` posting `"pause"` into the same inbox. Needs `MediaPlayer` in the podspec
  `frameworks`. Build it only if Controls adoption proves to be the problem §1.5 warns it might be
  (§1.4 item 4, §1.7).

**TypeScript**

- **New** `src/lib/lesson-card.ts` — a module-scope singleton owning the card: `ensure(state)`,
  `push(state)`, `dismiss()`, `reconcileAtLaunch()`. Not a hook, not a ref, not per-screen. (§2.1)
- `src/app/_layout.tsx`: call `reconcileAtLaunch()` once. (§2.7)
- The card singleton also asks the extension to redraw its controls on every phase change, through a
  new module function wrapping `ControlCenter.shared.reloadControls(ofKind:)` — otherwise a pause
  pressed in-app leaves the lock-screen toggle showing the opposite of the truth. (§1.6)
- `src/app/lessons/[id]/index.tsx:760-803, :855-876`: delete `cardRef` / `pushedRef` and the
  start/update effect; call the singleton. `drainIntents`, `resolveIntents` and `latestControls`
  are unchanged. (§2.1)
- `src/lib/lesson-activity-state.ts`: `ActivityState` gains `title` and `deepLink` (§2.3);
  `sameActivityState` compares them; `resolveIntents` loses the `"end"` arm along with `EndIntent`,
  and `END_CONFIRM_MS` / `confirmingEnd` / `nextArmedAt` go with it. That is a real simplification —
  the two-tap confirm existed only because a lock screen has no modals.

---

## §4 Phases

**Q0 — the probes (§5).** Half a day, no code shipped. **P-3 decides §1.4**; P-1 decides whether
there is a fallback behind it.

**Q1 — one card.** All of §2, none of §1. Independently valuable, independently shippable, and it
fixes the complaint the learner will hit on every single lesson. Do this first even though it is the
second complaint.

**Q2 — the buttons come off the card.** §1.4 items 1 and 3. Small, and it stops the card lying.

**Q3 — the two Controls.** §1.4 item 2, conditional on P-3. This is the feature.

**Q4 — Now Playing**, §1.4 item 4, conditional on P-1 and on Q3 proving that manual installation is
the adoption problem it might be. Deferred by default, not scheduled.

**Q3′ — CallKit *instead of* Q3 and Q4**, if **P-3 fails** (controls do not run locked) or if the
iOS 18 floor and the manual install turn out to be unacceptable and P-1 has also failed. It is an
alternative route through §1, not an extra one: Mute → `holdSession`, End → `endWithPersist`, the
Live Activity keeps the words *if* P-6 says it can, and both Controls and Now Playing are dropped.
Bigger than Q3 and Q4 together because of the audio-session handover, and it buys no-setup native
affordances plus the End button P0 §3.5 did not want. Decide it on the probes, not in advance
(§1.8).

Deferred: the P0 doc's Dynamic Island stub, which is untouched by any of this.

---

## §5 Probes

Everything below is `[unverified]` and needs a device.

1. **P-3 — do Lock Screen Controls run locked in practice? This is the one that decides §1.4.** A
   throwaway `ControlWidgetButton` in the existing extension that writes a timestamp to the App
   Group; add it to a Lock Screen slot; lock the phone; press it; read the timestamp back. Apple's
   documentation says yes (§1.3), and the whole recommendation rests on that sentence being true on
   a device. Do this first and do it before anything else in this document.
2. **P-2 — the free one (§1.2).** Settings → Face ID & Passcode → Allow Access When Locked → Live
   Activities. Expected to change nothing; costs thirty seconds; would make §1 unnecessary if it
   does.
3. **P-1 — can this app become the Now Playing app at all?** With a lesson connected and LiveKit
   holding a `playAndRecord` / `voiceChat` session, populate `MPNowPlayingInfoCenter` and enable
   `togglePlayPauseCommand`; lock the phone. Does a Now Playing card appear, and does the handler
   fire without unlocking? Decides whether §1.7 is a real fallback or a dead one — worth knowing
   early even though it is not on the critical path.
4. **P-4 — does `Activity.activities` return the orphans at launch?** §2.7's reconcile is built on
   it. Force-quit mid-lesson, relaunch, count.
5. **P-5 — does `IsLiveStream` remove the scrubber**, and what do the ⏮/⏭ slots look like when their
   commands are disabled? Decides how much the card has to explain.
6. **P-6 — does a Live Activity render on the Lock Screen while a CallKit call is active?** Start
   any throwaway `CXProvider` call, start the existing lesson card, lock the phone. This is the
   single question that decides whether CallKit and "the list of words" can coexist (§1.8). Cheap
   to answer with `expo-callkit-telecom` and no LiveKit involvement at all — do not re-platform the
   audio session to find out.
7. **P-7 — does the CallKit Mute toggle survive backgrounding**, and does a `CXCallController`
   -requested `CXSetMutedCallAction` move the button when the learner pauses in-app? (§1.8)
8. Everything still open in the P0 doc §11, in particular **#8** (no local Swift toolchain that can
   build the bridge module). It was the highest-value item there and it is higher-value here,
   because §3 touches Swift in four files.

---

## §6 What this changes in the P0 doc

- **§1's rejection of Now Playing stands, for a reason it did not give.** It rejected the surface
  on expressiveness — one title, no mute command, an implied timeline — and never asked whether the
  alternative works while locked. The alternative does not. But Now Playing is still not the answer:
  Controls are (§1.5). Now Playing moves from "rejected outright" to "documented fallback", with
  `IsLiveStream` answering the scrubber objection and the no-mute-command objection standing exactly
  as §1 stated it (§1.7).
- **§2's floor moves from iOS 17 to iOS 18, and stops being a floor for the card.** "Interactive
  buttons inside it require iOS 17" bought a capability that does not exist. The 16.4 gate the P0
  doc argued for is still right and now protects the *card*; the controls sit behind their own
  `@available(iOS 18.0, *)` in the same bundle.
- **The Live Activity keeps exactly the job that motivated it** — the word list and the status
  line — and loses everything else. That is a narrowing, not a defeat: reading a card needs no
  unlock, and no other surface in §1.3 can render a list at all.
- **§3.5 is vindicated and extended.** End was kept off the lock screen because it is destructive
  and unconfirmable there. On a two-slot Control surface it is also unaffordable, so `EndIntent` and
  the whole two-tap confirm machinery can go.
- **§4.2's single-writer rule is untouched and is why this is affordable.** Swift decides nothing;
  it appends to an inbox. Changing which surface writes to that inbox is a change of transport, not
  of architecture, and `resolveIntents` does not move.
- **§7.1's "a stale activity outliving its session"** was named as the worst failure mode and
  handled with a `phase: "over"` state. §2 is that same failure arriving through a door the P0 doc
  did not check: not one stale card with disabled buttons, but several live-looking ones, because
  ownership was per-screen and reconciliation at launch was never written.

---

## §7 What was built — branch `worktree-lock-screen-controls`

Q1, Q2 and Q3 of §4, in one pass. Q4 (Now Playing) and Q3′ (CallKit) remain unbuilt and unscheduled,
exactly as §1.4 item 4 and §1.8 leave them.

**Q3 was built ahead of P-3 rather than behind it, and that is a deliberate change to §4.** The
probe as written was a throwaway `ControlWidgetButton` in the extension that writes a timestamp to
the App Group. The real controls are that probe, only useful if it passes — they cost about the same
to write, they typecheck against the iOS 18.2 SDK on this machine (which the throwaway would also
have had to), and everything they are built on is shared with Q1/Q2 anyway. If P-3 fails on a device
the deletion is two files and a bundle entry. Running the throwaway first would have bought a day's
delay and no information the real thing does not give.

### Q4 — Now Playing, built 2026-08-19

§4 leaves Q4 "deferred by default, not scheduled", conditional on P-1 and on Q3 proving that manual
installation is the adoption problem it might be. It was built anyway, and the reason is the
sentence §1.5 refuses to talk around: **Apple gives an app no way to install its own control**, so a
learner who never opens Settings never gets one, and no amount of pointing at it from the card
changes that. Now Playing has the exactly complementary trade — it appears by itself with no setup
and can only ever carry pause. Neither surface makes the other redundant:

| | Setup required | Pause | Mute | iOS floor |
| --- | --- | --- | --- | --- |
| Controls | one-time, manual, in Settings | yes | yes | 18 |
| Now Playing | none | yes | never (no such command) | 13 |

Together: everybody gets pause without unlocking, and the learner who spent thirty seconds in
Settings also gets mute. Building it also *is* probe P-1 and P-5, on the same reasoning that built
Q3 ahead of P-3 — the real surface answers the question the throwaway would have, and costs about
the same.

**Files:** `modules/lesson-activity/ios/NowPlayingSurface.swift` (new — `MPNowPlayingInfoCenter`
population, `MPRemoteCommandCenter` wiring, everything but play/pause/toggle explicitly disabled),
two `Function`s on `LessonActivityModule`, `MediaPlayer` in the podspec, `publishNowPlaying` /
`clearNowPlaying` in the module's TypeScript, `nowPlayingSubtitle` in `lesson-activity-state.ts`, and
`publishSurfaces` in `lesson-card.ts` — which is now the one place all three surfaces are written,
before and independently of the card.

**Three things it deliberately does not do.** No mute command, because there is no
`MPRemoteCommand` for muting and binding one to `nextTrackCommand` would put a privacy action behind
a ⏭ glyph (§1.7); the mitigation is that a pause already mutes. No scrubber, via
`MPNowPlayingInfoPropertyIsLiveStream` plus `changePlaybackPositionCommand.isEnabled = false`. And
**no change to the audio session** — whether a LiveKit `playAndRecord` voice-chat session can become
the Now Playing app at all is the open question, and re-platforming the audio session to force a
yes would be a far larger change than the one being tested. It publishes and lets iOS decide.

**One decision §1.7 did not specify.** `pauseCommand` and `playCommand` are directional, but the
inbox carries untyped toggles. A `pause` arriving for a session that is already held would flip it
back to live — the button would resume the lesson it was pressed to pause. So the handlers reconcile
the direction against the published snapshot and record nothing when the press changes nothing. That
is the same class of decision as `ControlChannel.record`'s "is there a lesson at all" guard: it asks
whether the press changes anything, never what the change should mean.

**Now Playing is cleared, never lingered.** The Live Activity survives its session because
`phase: "over"` turns it into a link (§3.6, §7.1). A Now Playing card has a real ▶ button and no way
to say the lesson ended, so a lingering one is a button that lies.

### The files

| File | What changed |
| --- | --- |
| `targets/controls/LessonActivityAttributes.swift` | `title` and `deepLink` moved into `ContentState`; `confirmingEnd` deleted; the attributes struct is now empty. §2.3 |
| `targets/controls/ControlIntents.swift` | `ControlChannel` gains the phase snapshot (`phaseKey`, `Snapshot`, `writeSnapshot`), the stored activity id, and the two control `kind` strings. `record` returns a `Bool` and refuses when no lesson is running. `PauseIntent`/`MuteIntent`/`EndIntent` (all `LiveActivityIntent`) deleted; `SetPauseIntent`/`SetMuteIntent` (`SetValueIntent`, `authenticationPolicy = .alwaysAllowed`) added. |
| `targets/controls/LessonControls.swift` | **New.** `LessonPhaseProvider`, `LessonPauseControl`, `LessonMuteControl`. |
| `targets/controls/ControlsBundle.swift` | Both controls registered behind `if #available(iOS 18.0, *)`; the Dynamic Island reads `context.state.title`; `ControlRow` gone from the expanded region. |
| `targets/controls/LessonActivityView.swift` | The three `Button(intent:)`s deleted. The card gains a title header (the button row's 44 pt bought it) and a `FooterRow` that is either the `Start` link or the one-line pointer at the controls. |
| `targets/controls/expo-target.config.js` | Comments only — the iOS 17 reasoning it recorded is no longer true. |
| `modules/lesson-activity/ios/LessonActivityModule.swift` | `start` adopts an existing activity and ends surplus ones; `update` addresses one instead of fanning out; both filter on `activityState == .active \|\| .stale`. New `activeCount`, `areControlsSupported`, `publishPhase`. `end` clears the snapshot, the stored id and the inbox. |
| `modules/lesson-activity/ios/LessonActivity.podspec` | `WidgetKit` added to `s.frameworks` for `ControlCenter`. |
| `modules/lesson-activity/src/LessonActivity.ts` | `start` loses its `title`/`deepLink` arguments; `ControlAction` loses `"end"`; `publishPhase`, `areControlsSupported`, `activeActivityCount` added. |
| `src/lib/lesson-card.ts` | **New.** The module-scope singleton: `ensureCard`, `pushCard`, `dismissCard`, `reconcileAtLaunch`, a one-lane promise queue, and the linger timer. §2.1, §2.7 |
| `src/lib/lesson-activity-state.ts` | `ActivityState` gains `title`/`deepLink` and `sameActivityState` compares them; `END_CONFIRM_MS`, `nextArmedAt`, `confirmingEnd` and the `"end"` arm of `resolveIntents` deleted; `resolveIntents` drops its `armedAt`/`now` parameters. |
| `src/app/_layout.tsx` | `reconcileAtLaunch()` in a `[]` effect. |
| `src/app/lessons/[id]/index.tsx` | `cardRef`, `pushedRef`, `endArmedAtRef`, `confirmingEnd` and the linger effect deleted; the card block is now `ensureCard`/`pushCard` plus a `cardRequestedRef` that decides which. The in-app **End session** button is untouched. |
| `check.ts` | The End/confirm cases deleted; cases added for the `title`/`deepLink` diff, which is what makes one activity serve every lesson. |

### Three decisions §3 did not specify

**The phase snapshot is published independently of the card.** §3 had `start`/`update` write it.
That ties the controls — the surface that actually works locked — to a Live Activity the learner can
switch off in Settings, and would have left the toggles frozen at whatever the last successful card
push said. `publishPhase` is its own native function, called from `ensureCard`/`pushCard` before the
card work is even queued.

**`observeActivityState` / `onActivityEnded` was not built.** Its job — never keep pushing at a card
the learner swiped away, never resurrect one — is done by `updateActivity` already returning `false`
plus a `gone` latch in the singleton that only `ensureCard` clears. The native observer would have
had to capture the module instance inside a `Task`, which is the one shape this file's header
warns is a Swift 6 compile error, for information the return value already carries. `activeCount()`
was built, because the launch reconcile wants a number it can log.

**A press with no running lesson is dropped in Swift, by `ControlChannel.record`.** A control cannot
be hidden — once installed it is on the Lock Screen at three in the morning with no session anywhere
— and a `"pause"` recorded then would be drained by the *next* lesson and flip it into a hold nobody
asked for. This is the one thing Swift now decides, and it is addressing rather than logic: it asks
"is there anything to record against", not "what should this mean". §4.2's single-writer rule is
otherwise untouched.

### What is verified and what is not

Verified on this machine: `pnpm --filter mobile typecheck`, `lint`, `check:logic` and `bundle` all
pass. The whole extension — including every iOS 18 Controls API — typechecks with
`swiftc -typecheck -target arm64-apple-ios16.4 -sdk iPhoneOS18.2.sdk`, and so does the ActivityKit
half of the app module against a stub with `ExpoModulesCore` removed. `expo-doctor` fails on five
pre-existing Expo patch-version drifts, unrelated to any of this.

Not verified, and this is the whole of §5: **nothing has run on a device.** P-3 in particular —
whether a Lock Screen control actually performs its intent on a locked phone — is now answered by
building and pressing this, not by a throwaway. P-1 (Now Playing) is untouched and stays the
fallback. The P0 doc's probe #8 remains the blocker for compiling the bridge module locally: Xcode
here ships Swift 6.0.3 and the prebuilt `ExpoModulesCore` was built with 6.3.1, so
`LessonActivityModule.swift` is parse-checked rather than type-checked and its first real
compilation will be on EAS.

---

## §8 The device test plan

§5 lists probes — questions the research could not answer. This is the different thing: an ordered
list of what to press on a real phone now that §7 is built. Everything here is manual; the repo has
no device harness and this feature could not use one anyway (its whole subject is what iOS does when
nobody is looking).

### Before the first run — two things that will otherwise waste an afternoon

**Delete the app before installing this build.** `LessonActivityAttributes` changed shape: `title`
and `deepLink` left the attributes and `confirmingEnd` is gone. A Live Activity started by the
*previous* build is typed by the *previous* attributes, so `Activity<LessonActivityAttributes>.activities`
may not return it at all — which means `reconcileAtLaunch` cannot see it and cannot end it, and a
card from the old build could sit on the lock screen until iOS's 12-hour cap retires it. That is a
one-time migration artefact, not a bug in §2, but it will look exactly like the bug in §2 if the
first test is run over the top of an old install.

**Add the two controls by hand, once.** Settings → Control Center (or long-press the Lock Screen →
Customize → the bottom-corner slot), find *Pause lesson* and *Mute microphone* under the app. They do
not appear until the app has been launched at least once after install. Put at least one of them in
a **Lock Screen corner slot**, not only in Control Center — the whole of T1 is about the Lock Screen.

### T0 — the gate

**T0. Does a Lock Screen control run on a locked phone?** (P-3, and it decides §1.4 outright.)
Start a lesson, lock the phone, press the *Pause lesson* control from the Lock Screen slot without
authenticating. Expected: audio stops, the control's value label flips to "Paused", and no unlock
prompt appears.

If this fails, stop. Nothing else in §1 matters, and the branch is a Q1/Q2 branch (one card, no
buttons) plus two dead files. Run P-1 next and go to Q4, or reconsider Q3′.

### Complaint 1 — the unlock

| # | Test | Expected |
| --- | --- | --- |
| T1 | Locked: press *Pause*, then press it again | Pauses, then resumes. The tutor is silent while held. |
| T2 | Locked: press *Mute*, then again | Microphone mutes and unmutes; the tutor keeps talking through both. |
| T3 | Press *Pause* and watch the control **without** pressing anything else | It must not flash to "Paused" and snap back to "Listening". A snap-back means the optimistic write in `perform()` is not landing before `currentValue()` is queried. |
| T4 | Pause **in the app**, then look at the Lock Screen control | Shows "Paused". This is the `publishPhase` → `reloadControls` path; if it lags, the toggle is lying about the microphone. |
| T5 | While the session is held, look at the *Mute* control | Disabled. A hold already owns the microphone. |
| T6 | No lesson running at all: press either control | Both disabled and nothing recorded. Then start a lesson — it must begin *live*, not held. A lesson that starts paused means `ControlChannel.record`'s guard is not firing. |
| T7 | Lock, press *Pause* three times quickly, unlock | One flip, not three. This is `resolveIntents` folding the batch. |
| T8 | Force-quit the app mid-lesson, lock, press *Pause* twice, relaunch | The presses collapse to a no-op and nothing crashes. The inbox is the only delivery path and it survives the process. |
| T9 | Live Activities **off** for the app in Settings, then run a lesson | No card, but both controls still work. This is the reason `publishPhase` is not a side effect of the card push. |
| T10 | Read the card mid-lesson on a locked phone | Title, status line and words are legible and nothing is clipped. Also the answer to the P0 doc's probe #3 (how many words fit) now that the button row is gone — if seven or eight fit, `ACTIVITY_WORD_WINDOW` is the constant to change. |

### Complaint 2 — one card

| # | Test | Expected |
| --- | --- | --- |
| T11 | Lesson A → back → lesson B → back → lesson C, each with a session | **Exactly one card on the Lock Screen at any moment.** This is the complaint, verbatim. |
| T12 | Lesson A running, navigate back, open lesson B, start it, lock | One card, showing **B's** title and B's words. The activity was re-pointed, not replaced (§2.3). |
| T13 | Tap *Start* on the lingering card of a finished lesson | Opens the app on that lesson. Confirms `deepLink` survived the move into `ContentState` and that the per-variant scheme is right. |
| T14 | Force-quit mid-lesson, relaunch, look at the Lock Screen | The orphan card is gone within a second or two of launch. This is `reconcileAtLaunch`, and it is also P-4. |
| T15 | Same as T14, but check `cardDebugState().orphansAtLaunch` | ≥ 1. If it reports 0 while a card was visibly there, `Activity.activities` is not returning orphans and §2.7's whole premise needs revisiting — see the "delete the app first" note before believing this result. |
| T16 | Swipe the card away mid-lesson, then add a word to the lesson | It must **not** come back. A swipe is a decision (the `gone` latch). |
| T17 | Continue that same session after T16, then end it and start a new one | The new session gets a card. Only `ensureCard` clears the latch. |
| T18 | End the session and leave the phone alone | The card lingers ~2 minutes offering *Start*, then disappears. |
| T19 | End the session and return to the app | The card goes immediately. |
| T20 | Background and foreground the app ten times mid-lesson | Still one card, and no drift in the status line. |
| T21 | Rotate through lesson → home → lesson quickly, twice | Still one card. The remount path goes through `ensureCard`, which adopts. |

### Now Playing (T26–T34) — and this is probe P-1

**T26 is the gate for this surface, exactly as T0 was for the Controls.** If no card appears, the
answer to P-1 is no, everything below is moot, and `NowPlayingSurface` is two files to delete.

| # | Test | Expected |
| --- | --- | --- |
| T26 | Start a lesson, lock the phone, **without having installed any control** | A Now Playing card appears with the lesson title. If it does not, P-1 is answered no — a LiveKit voice-chat session cannot become the Now Playing app, and the Controls are the only locked-phone surface there is. |
| T27 | Press ⏸ on it, locked | The lesson pauses and the button becomes ▶. No unlock prompt. |
| T28 | Press ▶ | Resumes. |
| T29 | Look at the card carefully | **No scrubber, no elapsed/remaining pair, no ⏭/⏮.** A visible scrubber means `IsLiveStream` did not take; visible skip glyphs mean the `isEnabled = false` loop did not run. This is also P-5. |
| T30 | Pause in the app, then look at the card | Shows ▶, not ⏸. |
| T31 | Pause **from the Now Playing card**, then look at the *Control* | Also shows Paused. Both surfaces read the same snapshot; if they disagree, `publishSurfaces` is not being called on that path. |
| T32 | With the session already held, press ⏸ again (or squeeze AirPods twice) | Nothing happens and nothing is queued. When you unlock, the session must still be held — not resumed. This is the directional reconcile. |
| T33 | End the session | The Now Playing card disappears immediately, while the Live Activity lingers ~2 min offering *Start*. They are supposed to differ. |
| T34 | Pinch/squeeze a connected headphone mid-lesson | Toggles pause. `togglePlayPauseCommand` is what that sends. |

If T26 passes, the **combined** claim worth checking once: a phone with **no controls installed at
all** can still pause a lesson from the Lock Screen. That is the sentence §1.5 could not promise.

### Regressions — things that must not have moved

| # | Test | Expected |
| --- | --- | --- |
| T22 | The in-app **End session** button | Still ends and still persists the transcript. It is the only End now. |
| T23 | Pause in-app while the tutor is mid-sentence | The tutor goes silent, and the card's status line says whether it managed to (`silenced`). If it says "may still be audible", that is the §7.6 disclosure working, not a new bug. |
| T24 | Resume after a pause where the learner had muted themselves first | They come back muted, not unmuted (`wasMutedRef`, §3.3). |
| T25 | Dynamic Island, expanded | Shows the lesson title — it reads `context.state.title` now, not the attributes. |

### The two cheap side-questions

**P-2, thirty seconds:** Settings → Face ID & Passcode → Allow Access When Locked → Live Activities.
Toggle it and re-run T1 with the *card's* surface in mind. Expected to change nothing — the buttons
are gone either way — but it is the setting §1.2 ruled out on documentation alone, and a device
disagreeing with it would be worth knowing.

**P-1, only if T0 fails:** the Now Playing probe as §5 describes it. It is the fallback, and there is
no reason to spend a build on it while T0 is unanswered.

### What a failure most likely means

- **A control press does nothing, at all, ever, even unlocked.** Suspect the App Group before
  anything else: `UserDefaults(suiteName:)` returns a store nobody else can see rather than failing,
  so a provisioning profile without the group is silent and total. Test it by pressing a control
  with the app in the *foreground* — if even that does not reach `drainIntents`, it is the
  entitlement, not the lock screen.
- **The toggle snaps back.** The optimistic write (T3). `perform()` must have written the phase
  before it returns.
- **The toggle is right but the action does not happen.** The inbox is landing and the fold is
  wrong, or the screen is not mounted to drain it. Check whether the lesson screen is still mounted
  — the drain lives there, and a control pressed with the app on a different screen has nothing
  listening until the lesson screen comes back.
- **Two cards.** Read `cardDebugState()` first, and check the "delete the app before installing"
  note above before concluding §2 did not work.
