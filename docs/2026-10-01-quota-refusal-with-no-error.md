# The quota refusal that arrives as nothing

_2026-10-01._ Reports `47a7f19c` and `470ddc9f`, filed 30 seconds apart from one phone. A follow-up
to `docs/2026-08-21-quota-outage-and-pause-panel.md`: same cause, one shape that doc did not cover.

---

## §1 — What happened

The ElevenLabs account ran out of credits **in the middle of a lesson**. Three conversations, read
from `GET /v1/convai/conversations/{id}`:

| conversation | duration | `metadata.error` |
|---|---|---|
| `conv_2701m3v55cmtetmbaks6ydqvr9zs` | 302 s | `dependency_error` · 1002 — This request exceeds your quota limit. |
| `conv_6201m3v5ghtge3vawf179ver3s5e` | 0 s | `call_initialization_error` · 3000 — [quota_exceeded] You've run out of credits. |
| `conv_0101m3v5gw11ebntj1wzag5rtzb7` | 0 s | `call_initialization_error` · 3000 — [quota_exceeded] You've run out of credits. |

**No code change makes a lesson connect.** The account needs topping up.

## §2 — The two shapes, and the one that was unhandled

1. **Mid-lesson** (`47a7f19c`). An `error_event` with no message → `"Server error: Unknown error"`
   → the generic server branch of `tutorErrorMessage`, which already points at credits. Four lines
   had been collected and `persist.ok` landed a second later. This worked as designed.
2. **At Start** (`470ddc9f`). The token route answered 200, the LiveKit room connected, the kickoff
   was sent — and ~100 ms later the platform closed the room as an ordinary `reason: "agent"`
   disconnect. **No `error_event`, so `onError` never fired.** `start` had just run `setError(null)`,
   and since the pause panel went (§2 of the August doc) nothing renders `pause === "ended"`. The
   screen showed `status: disconnected` and a Start button. The learner pressed it twice.

The report itself shows the gap: with no error of ours on the bus, the snapshot froze on a LiveKit
`console.error` (`Abort handler called`), which is teardown noise.

## §3 — The fixes

- **`apps/mobile/src/lib/transport/elevenlabs.ts`** — an `"agent"` disconnect before the agent's
  first turn is a refusal, not an ending. The adapter raises `transport.error` and hands the session
  `REFUSED_BEFORE_FIRST_TURN` (`lib/tutor-error.ts`), so the screen says so and offers Diagnostics.
  Credits are named as the usual cause, not asserted — the wire still says nothing.
- **`pnpm report`** — a new section, **What ElevenLabs recorded**, with the provider's status,
  duration and `metadata.error` for every conversation in the timeline (`session.claim` events), not
  only the one the report is filed under. A quota verdict is called out as such. This is the lookup
  that settled both outages by hand (`apps/web/src/lib/debug-report-verdict.ts`).
- **The operator page** (`/ops/reports/[id]`) — the same table, as a panel directly under the
  headline (added 2026-10-02). Both surfaces call `reportVerdicts`, so they cannot disagree about
  which conversations a report covers.

## §4 — Not done

- **A pre-flight on the token route.** `/v1/user/subscription` could refuse a Start with a 402
  before a room is opened. It costs a round trip on every Start to predict something the platform
  reports anyway, and it cannot cover the mid-lesson case. Worth revisiting only if the silent shape
  recurs in a form the adapter check misses.
