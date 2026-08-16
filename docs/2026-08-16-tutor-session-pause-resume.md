# Pause / resume — the parked path

**Date:** 2026-08-16
**Scope:** `apps/mobile/src/app/lessons/[id]/index.tsx`, `apps/mobile/src/lib/session-journal.ts`,
`packages/shared/src/tutor.ts`, and the post-call webhook in `apps/web`. No web UI work.
**Status:** **built 2026-08-16, then demoted the same day.** Hanging up and resuming as a new
conversation is no longer what the Pause **button** does — it holds the line open instead
(`docs/2026-08-16-tutor-pause-hold-the-line.md`). Everything described here is still live as the
**involuntary floor**: what happens when something *takes* the line rather than when the learner
puts it down.

Claims are tagged `[typings]` (read out of the pinned SDK in `node_modules`), `[docs]` (ElevenLabs
documentation) or `[code]` (this repo).

---

## §1 What this document is for

Two things, both needed while working on pause:

1. **The record of the parked path** — the states, the storage, the copy (§4, §5). It is reached by a
   dropped connection, the agent's own 30-minute cap, a crash, and by navigating away from a held
   pause. None of those are going away, so none of this code is.
2. **The diagnosis of why resuming a *new* conversation repeats itself** (§2). That is the reason the
   button moved, and it is the constraint every future improvement to this path has to beat.

The design of the *held* pause — mute + `user_activity` heartbeat — and everything that goes with it
(the SDK surface, the timeout facts, the cost model, the probes) lives in
`docs/2026-08-16-tutor-pause-hold-the-line.md`. It is not repeated here.

---

## §2 Why reconnect-and-replay repeats itself `[code]`

Reported after real use of the shipped button:

> I have a lot of repetition, so I resume not from exact same state.

Not a defect in the code below — the mechanism showing its price. Five things compound:

| # | Cause | Where |
|---|---|---|
| 1 | The system prompt is a **script from the top** — *"Greet in one sentence and lay out the plan … start teaching the first item without waiting to be asked"* — re-injected **in full** on every resume, where it outweighs one line of resume instruction | `apps/web/src/agent/prompts/words-1.3.ts` |
| 2 | `{{items_list}}` is re-injected **whole**, with nothing marking which items are already taught | `formatItemsList`, `packages/shared/src/tutor.ts` |
| 3 | The tail arrives as a `contextual_update` — documented as *non-interrupting background information*, i.e. explicitly the weaker signal against the prompt in (1) `[docs]` | `formatResumeContext` → `sendContextualUpdate` |
| 4 | Only `RESUME_CONTEXT_TURNS = 20` turns at 400 chars survive; the opening of a long lesson is gone | `packages/shared/src/tutor.ts` |
| 5 | What is carried is **dialogue**, never **lesson state** — nothing says which item was in progress, which are finished, what the learner got wrong | the whole design |

Nothing recovers this on the platform side: there is no cross-conversation memory in the Agents API
`[docs]`. Two conversations of the same learner know nothing about each other except what the client
puts in front of them.

**The conclusion:** the fidelity of a resume is bounded by the state we hand over, and today that is
a truncated chat log handed to an agent that has been told to start the lesson. Prompt tweaking
narrows this; it cannot close it. Anything that reconnects will repeat to some degree — which is why
the button now holds the line, and why the fix for *this* path is carried lesson state
(`…-hold-the-line.md` §6), not better wording.

---

## §3 The platform constraint that forces a new conversation `[typings]` + `[docs]`

There is no "hold" state and no reopening in the Agents API:

- `POST /v1/convai/conversation/token` takes an `agent_id` and mints a **new** `conversation_id`;
  `ConversationsGetWebrtcTokenRequest` is `{ agentId, participantName?, branchId?, environment? }` —
  there is no conversation to continue.
- `ConversationsClient` exposes `getSignedUrl, getWebrtcToken, list, get, delete, getSipMessages`.
  Nothing resumes.
- Our token route (`apps/web/src/app/api/v2/words-agent/token/route.ts`) treats the returned
  `conversation_id` as the row key and refuses to invent one — so **every resume is a new row in
  `lesson_sessions`**, exactly as a drop-recovery has always been.

So continuity across a hang-up is a *prompting* problem, not an API capability. `formatResumeContext`
is that prompt, and §2 is what it costs.

---

## §4 What is built

Four files. No new route, no new table, no schema change — the parked pause rides the drop-recovery
path that already existed.

### 4.1 `packages/shared/src/tutor.ts`

- **`PAUSE_RESUME_MESSAGE`** — the hidden kickoff for a resumed *pause*, beside `RESUME_MESSAGE`.
  Separate constants because the difference is spoken aloud: `RESUME_MESSAGE` says "we got cut off",
  which is a small lie to tell someone who put the lesson down on purpose.
- **`ResumeCause = "interrupted" | "paused"`** and `formatResumeContext(lines, cause =
  "interrupted")`. Only the preamble changes; `"paused"` tells the tutor not to remark on the gap.
  The default keeps the web's single-argument call site behaving identically.
- **`HIDDEN_KICKOFF_MESSAGES`** is the list every transcript writer filters on. Adding a hidden
  message means adding it here — see §4.2.

### 4.2 `apps/web` — the webhook filter

`apps/web/src/app/api/words-agent/elevenlabs-webhook/route.ts` filtered
`t.message === KICKOFF_MESSAGE` — only the first constant — so `RESUME_MESSAGE` reached the stored
history as a learner turn (*"We got cut off. Pick up exactly where we stopped…"*) whenever the
webhook wrote last. It now imports `HIDDEN_KICKOFF_MESSAGES` and matches with `.includes()`, like
both client filters. **Any new hidden message must join that array or it will leak the same way.**

### 4.3 `apps/mobile/src/lib/session-journal.ts` — the parked marker

`PausedSessionEntry` + `writePauseMarker` / `readPauseMarker` / `clearPauseMarker`, under
`paused:<lessonId>` in the same `expo-sqlite/kv-store` as the journal, and best-effort in the same
way (a storage failure must never break ending a session).

**A separate key, not a flag on the journal**, because the two mean opposite things: a journal is a
transcript *the server may not have* — insurance, cleared the moment it does — while a marker is a
transcript the server already took and the learner intends to continue. Folding them together would
make "clear the journal after saving", the one line that keeps the recovery card honest, also throw
away the pause. The marker carries its own `lines` rather than reading them back from
`LessonDetailResponse.sessions`, so the restore needs no network, makes no assumption about which
fetch lands first, and still works when the save that preceded it failed.

### 4.4 `apps/mobile/src/app/lessons/[id]/index.tsx`

- `PauseReason` is `"paused" | "dropped" | "ended" | "recovered"`, each with its own `PAUSE_COPY`.
  `"paused"` is the only one that is an intent rather than an accident, so it neither apologises nor
  explains — it says only what the learner cannot see, that the conversation was saved.
- **`pauseIntentRef`** — "this session is being hung up while the learner considered it paused".
  `onDisconnect` reads it once and parks instead of treating it as an ordinary End. The SDK reports
  `reason: "user"` for both teardowns, so intent cannot be read off the transport. **Only the unmount
  guard sets it now** — navigating away from a held pause must end the call (a live, billed,
  listening session behind no UI is the bug that guard exists to prevent) and the lesson should still
  be waiting on return.
- Intent **wins over** `reason` in `onDisconnect`, so a connection that dies moments after the tap
  still reads as *Paused* rather than *The session dropped*.
- `resumeContextRef` is `{ lines, cause }` — one ref, not a pair, because a cause that can drift out
  of sync with its lines eventually describes the wrong conversation, out loud.
- The kickoff effect picks `PAUSE_RESUME_MESSAGE` vs `RESUME_MESSAGE` off `cause`. **Resume is
  `start()`, unchanged** — the same call the card and the drop card make.
- The mount effect checks two things in order: a **journal** (crash — push it to the server, show
  *"ended unexpectedly"*, and clear any marker, because both existing means the save at pause time
  failed and the unsaved copy is the one that must land), otherwise a **marker** (restore `carried`,
  arm the context, show the card — nothing to push, it is already saved).
- `start()` and `dismissPause()` clear the marker, so a spent or declined pause is not offered again
  at the next mount.

---

## §5 UI as built

The session verb keeps the left slot, the pause verb the right one, and the status line sits on its
own row below — it used to be third in the button row, where two buttons leave it no width.

```
 connected, live    [ End session ]        [ Pause ]
                    ● listening — just talk to interrupt

 connected, held    [ End session ]        [ Resume ]        ← the held pause, not this document
                    ⏸ paused — microphone muted, the tutor is waiting

 parked             [ Start conversation ] [ Resume ]
                    ⏸ paused — resume when you're ready

 idle               [ Start conversation ]
                    status: disconnected
```

- **The right slot is empty, never disabled**, when there is nothing to pause and nothing paused.
- **The status line is derived, not raw.** A parked pause is `disconnected` at the transport, so
  printing the status would say *status: disconnected* next to a Resume button.
- **The parked card is a plain `Panel`.** `tone="warn"` stays for the three accidents; `paused`
  renders plain, because a warning border around the learner's own decision says something went
  wrong. Title *"Paused"*, CTA *"Resume session"*, secondary *"Start fresh instead"* (`dismissPause`,
  which also clears the marker).
- **The transcript reads as one conversation.** Resuming moves the previous turns into `carried` and
  renders them above the new ones, so the learner sees one lesson even though the server holds two
  rows.
- **Never auto-pause on background.** A locked screen mid-sentence is the scenario the native app
  exists to keep alive.

---

## §6 What is left on this path

1. **Carry lesson state, not a chat log** — the fix for §2, designed in
   `docs/2026-08-16-tutor-pause-hold-the-line.md` §6: a `{{lesson_state}}` dynamic variable (which
   lands in the *system prompt*, at the same strength as the instruction it must override) plus a
   `RESUMING` branch in a new prompt version. Until that exists, every parked resume repeats.
2. **Does a parked pause expire?** A marker can sit for a week, and resuming into a two-day-old
   context is odd. Cheap answer: markers older than ~24 h restore the card as *"Continue this
   lesson"* rather than *"Resume"* — same mechanism, honest copy.
3. **The word list edited during a pause applies on resume**, mechanically — `items_list` is baked at
   `startSession`. The panel says *"Changes apply to your next conversation"*, which is true and
   currently reads as if it means the opposite. One line of copy.

---

## Sources

- [Client to server events — `contextual_update` is non-interrupting background information](https://elevenlabs.io/docs/agents-platform/customization/events/client-to-server-events)
- [Conversation flow](https://elevenlabs.io/docs/agents-platform/customization/conversation-flow)

In-repo: `docs/2026-08-16-tutor-pause-hold-the-line.md` (the held pause — design, facts and probes),
`docs/2026-08-13-expo-s3-conversation-token.md` (the authoritative `conversation_id`),
`docs/2026-08-13-expo-s4-tutor-screen.md` (the drop-recovery machine this path extends).
