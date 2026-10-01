# LiveKit: the ready timeout was shorter than a cold start

Debug report `327f1b26` (2026-10-01, preview build 1.0.0 (1), iPhone 14 Pro, `words-4.0`). The
learner's note: _"Is it Agent still not deployed?"_

## What the report shows

The token minted (200 in 742 ms), the phone joined `lesson-c9b91f51-…`, and 16.7 s later the
session ended with "The tutor never joined the lesson." No `transport.agent_joined` in between and
no transcript. It is the same shape as report `27c60661` from 2026-09-25, when there really was no
worker (`2026-09-20-livekit-spike-task-plan.md`, Phase 3) — which is why it read as "not deployed".

## It is deployed. It was asleep.

`lk agent status` on 2026-10-01:

| Version | Commit | Status | Replicas | Deployed |
|---|---|---|---|---|
| `8GpYnni8dviE` | `a0e34f5` | Sleeping | 0 / 1 / 1 | 2026-09-26 07:26 UTC |

`lk agent logs` answered: _"The agent has shut down due to inactivity. It will automatically start
again when a new session begins."_ The project is on LiveKit's Build plan, where production scales
to zero once the last session ends; [LiveKit documents](https://docs.livekit.io/deploy/agents/)
"up to 10 to 20 seconds of delay before the agent joins the room" for the session that wakes it.

Measured against the sleeping production agent with `lk dispatch create --agent-name tutor` into an
empty room (no grant, nobody to talk to, so no backend write and no LLM/TTS spend):

| State | Dispatch → agent in the room |
|---|---|
| Sleeping | ~19 s |
| Running | ~1 s |

The cold figure is an upper bound from one wake: the first probe's room was closed early by a
detection mistake in the probe script, and a second dispatch 13 s after the waking one was joined
6 s later. Either way it is past 15 s, and `tutor.ready` is later still — the worker runs
`session.start` (STT, TTS, turn detector) between joining and reporting ready.

`AGENT_READY_TIMEOUT_MS` in `apps/mobile/src/lib/transport/livekit.ts` was 15 s. So the first
lesson after any idle stretch failed by construction, the failed attempt woke the worker, and the
retry connected. `2026-09-25-livekit-completion-checklist.md` had already recorded one instance of
this ("no `tutor.ready` within 45 seconds; retry succeeded without a code change") without naming
the cause.

## The change

- `AGENT_READY_TIMEOUT_MS` is 45 s. It stays a hard failure — a lesson with no tutor has nothing to
  say — it just no longer fires inside a normal wake.
- The wait is now a number in the report: `transport.connect` "joined the room, waiting for the
  tutor" when the room is up, and `waitedMs` on `transport.agent_joined` and on a new
  `transport.connected` for this provider. A cold start, a slow `session.start` and a missing worker
  were indistinguishable in `327f1b26`; they are three different timelines now.
- The timeout says which failure it was: "The tutor never joined the lesson." (nothing was
  dispatched or woken) vs "The tutor joined but never became ready." (the worker started and stuck).

This is a mobile change, so it reaches the learner with the next build, not with a backend deploy.

## Not done, on purpose

- **The learner still sees "Connecting…" for ~20 s on a cold start.** Correct, but unexplained. A
  "waking the tutor" hint after a few seconds is the cheap follow-up.
- **Removing the cold start** needs either a paid LiveKit plan (production keeps a warm replica) or
  pre-waking the agent when the lesson screen opens, which spends Build-plan agent minutes on
  lessons that never start. Neither is a code fix for this report.
- The one 45 s miss in the checklist is unexplained and may recur as a real timeout. With `waitedMs`
  in the timeline, the next one will show whether the worker joined at all.
