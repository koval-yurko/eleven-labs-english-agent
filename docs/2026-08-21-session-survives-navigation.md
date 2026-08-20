# A tutor session survives navigation (2026-08-21)

## 1. The complaint

> When one lesson is playing (in progress) I want to be able to navigate to other app pages —
> Words / Lessons. For now, when I navigate to another lesson and then to the same lesson again, it
> is interrupted and starts a new lesson. That is not correct. I want to keep the in-progress lesson
> if I do not click any End / Start buttons. Also, an in-progress lesson needs an indicator on the
> Lessons page.

Both halves were true, and the second one is why the first one was hard to notice as a bug: the app
had **no way to tell you a session was running**, so ending it on navigation looked less like data
loss than it was.

## 2. What was actually happening

Three separate mechanisms, all in `apps/mobile/src/app/lessons/[id]/index.tsx`:

1. **The unmount guard hung up.** It ended the session whenever the screen unmounted, with a sound
   argument: *"a live, billed, listening session running with nothing on screen saying so"* is a
   bug. Navigating away — to the collection, to another lesson, or popping back — ran it.
2. **The callbacks unregistered with it.** `useConversation` registers `onMessage` / `onDisconnect`
   / … with `ConversationProvider` and **unsubscribes on unmount**. Even without the guard, a
   screen-owned session would have kept talking into a transcript nobody was collecting.
3. **Re-entering looked like a resume and was not.** The unmount had written a pause marker; the
   remount read it back and offered Resume; Resume minted a *new* conversation and replayed a
   truncated tail into it as context. The tutor got its full system prompt back — "greet the learner
   and teach item one" — which beats a chat log delivered as background information. That is the
   repetition the learner saw. (Same failure mode as
   `docs/2026-08-16-tutor-pause-hold-the-line.md` §1, from a different direction.)

## 3. The fix: hoist the session above the router

New file: `apps/mobile/src/lib/tutor-session.tsx` — `TutorSessionProvider`, mounted in
`app/_layout.tsx` **inside** `ConversationProvider` (it consumes the SDK context) and **outside**
`Stack` (so a push or a pop cannot touch it).

Everything session-shaped moved into it *unchanged*, with its reasoning attached: the proactive
kickoff, the hidden-message filter, the per-conversation-id save guard, the carried transcript, the
resume context, the held pause and its heartbeat, the lock-screen card and the control-intent drain.
The lesson screen is now one of its views.

What ends a session, exhaustively: **End**, the tutor (`reason: "agent"`), the network
(`reason: "error"`), or pressing **Start on a different lesson**. Navigation is not on the list.

### 3.1 One session, one lesson

There is one session for the whole app and it belongs to one lesson at a time. A screen declares its
interest with `focusLesson(lessonId)`, which is **refused while a session is live** — that refusal
is the feature. Opening lesson B while A is talking leaves A's state untouched; B renders as idle
with a panel naming A and a button back to it. B's `syncMeta` is refused too, so adding a word to B
cannot re-point A's lock-screen card.

`focusLesson` is re-run on `session.lessonId` and `session.connected`, so B's claim lands by itself
the moment A's session ends.

### 3.2 Taking the session over

Pressing Start on B while A is talking is unambiguous, so it is allowed — and it is the one
navigation-shaped act that ends a conversation. The outgoing session is settled **synchronously and
explicitly** rather than left to its own `onDisconnect`:

- its transcript is persisted with its identity passed **by value** (`persistConversation`), because
  `endSession` resolves whenever LiveKit gets round to it — easily after the token mint has
  re-pointed every ref at the new conversation, which would file one lesson's transcript under
  another;
- if it was *held*, a pause marker is parked for it, so A is still waiting on the way back;
- then its refs are blanked, which makes its late `onDisconnect` a no-op instead of a hazard.

Ownership of the *state* moves before the token round trip, so the screen that pressed Start renders
"Connecting…" rather than idle for the length of a network call.

### 3.3 `owns`: whose conversation is this?

`ConversationProvider` composes every registered callback set into one, and this provider is now
mounted for the life of the app — so `app/probe.tsx`, which runs its own diagnostic session through
the same provider, would have pushed turns into a lesson's transcript, raised a card for a lesson
nobody opened, and got a second kickoff sent into its own conversation. `ownsRef` is set the instant
before `startSession` and cleared when the transport settles at `"disconnected"` outside a start;
every callback and every control reads it. The probe now also refuses to start while a lesson is
talking — a measurement taken on top of a live session measures nothing.

### 3.4 `PauseReason: "paused"` changed meaning

It used to mean "the learner pressed Pause", set by the unmount guard on the way out. A pause held
on a live line is the `held` flag; `"paused"` is now its **parked** form, written only when starting
a different lesson takes the microphone from a held one. `pauseIntentRef` is gone with the guard
that was its only writer.

## 4. Saying that a session is running

Removing the guard without answering its objection would just have shipped the bug it prevented. So
the objection is answered on three surfaces instead:

- **`ui/SessionBar`** — a floating pill over every screen: *● "Lesson title" · Return →*. Hidden on
  that lesson's own screen, which has the real controls. It navigates and does nothing else;
  pausing, muting and ending stay where the learner can see what they are deciding about.
- **The lessons list** — a badge on the row: `● In progress` or `⏸ Paused`. Two states, not one: a
  held pause is still a session — the line is open and still billed — and a learner who paused would
  reasonably read "In progress" as the pause not having taken.
- **The lock screen** — unchanged (`docs/2026-08-18-lock-screen-controls-unlock-and-single-card.md`),
  and now owned by the provider rather than by a screen that keeps unmounting.

All three read `useActiveSession()`, a deliberately **third** context carrying only
`{ lessonId, title, held }`. The full session state changes on every transcript turn; a list that
read it would redraw several times a minute to render one unchanged chip.

## 5. Checked

`pnpm --filter mobile check` — typecheck, lint, the `lesson-activity-state` property checks and the
iOS bundle all pass. (`expo-doctor` reports six Expo packages at patch versions behind the SDK's
requirement; that predates this change and touches no file in it.)
