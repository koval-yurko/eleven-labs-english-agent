# Observing an OpenAI lesson: why not the sideband

Stage 5 of [the second-provider work](./2026-08-22-openai-realtime-second-provider.md). **Status:
BUILT 2026-08-22, not yet verified against a real lesson.**

## 1. The problem

Every ElevenLabs lesson becomes a LangSmith trace. ElevenLabs POSTs a signed post-call webhook
carrying the transcript, tool calls, per-turn token usage and a cost figure, and
`api/words-agent/elevenlabs-webhook` turns it into one trace (`docs/2026-06-28-langsmith-tracing-observability.md`).

**OpenAI has no equivalent.** No post-call webhook, no post-call transcript endpoint — the request
for one is still open on their forum as of 2026-08-22. So a `words-2.0` lesson would be stored in
Postgres and invisible everywhere else, at exactly the moment we most want to compare it against
words-1.6 and find out what it costs.

## 2. The option the research doc named, and why it lost

§9 of the parent document proposed the **sideband WebSocket**: OpenAI supports two connections to
one realtime session, so our backend can open `wss://api.openai.com/v1/realtime?call_id=…` with the
account key and watch the whole conversation server-side. It reproduces the webhook's role and can
carry tools and `session.update` besides.

It was built into the plan and it is not being built. Four reasons, in order of how fatal they are:

1. **A lesson outlives the function.** `maxDurationSeconds` for a tutor session is **1800 s**. On
   Vercel, `maxDuration` is 300 s by default, 800 s GA on Pro/Enterprise with Fluid compute, and
   1800 s only in **beta** — so the sideband would be plan-gated, beta-gated, and sitting exactly on
   the limit rather than under it. OpenAI's own session ceiling is **60 minutes**, which is past the
   beta maximum outright.
2. **It drops on silence, and our pause is silence.** Multiple reports of the sideband closing after
   roughly a minute of quiet. The held pause (`docs/2026-08-16-tutor-pause-hold-the-line.md`) is a
   long silence *by construction* — that is the entire feature — so reconnect logic would not be an
   edge case, it would be the normal path.
3. **It bills half an hour of function wall-clock per lesson** to learn things the transcript write
   path already carries.
4. **It needs the `call_id`, which only the client knows.** The id is minted at SDP exchange, so
   there would be a new authenticated route, and a race in which the first seconds of every call
   happen before the server attaches.

None of that is a flaw in OpenAI's design. The sideband is built for server-authoritative agents —
tools, business logic, an app server that is a participant. This app's server is not a participant:
it mints a credential and receives a transcript.

## 3. What is being built instead

**The transcript write path already exists, already runs on every disconnect, and already carries
everything a trace needs.** `POST /api/v2/lessons/session` now also files a LangSmith trace, for
non-ElevenLabs providers only.

```
phone: onTurn / onUsage  →  POST /api/v2/lessons/session  →  Postgres row (as before)
                                                          └→ after() → LangSmith trace (new)
```

One function invocation at the end of a lesson, against thirty minutes of held socket. And it
composes with what is already there rather than beside it: the same route, the same body, the same
`sanitizeTranscript` bounds, the same idempotent upsert.

### 3.1 Cost, which is the point

A trace that only carried the transcript would duplicate the Postgres row. What makes it worth
having is **what the lesson cost**, and §10 of the parent document is still arithmetic rather than
measurement — the open question that decides whether this provider ships at all.

So `TutorUsage` was added to the transport contract and the OpenAI adapter fills it from
`response.done`. It carries the audio and cached splits, not just totals, because that is where the
money is: audio tokens bill at several times the text rate, and cached input — most of a long
lesson, since every turn re-sends the conversation — bills at roughly a hundredth. A total alone is
a number nobody can turn back into money.

The trace's `estimated_cost_usd` is named an estimate because it is our arithmetic over a rate card
that moves. The rates live in one place and are env-overridable, so a stale number is a config
change rather than a deploy.

**ElevenLabs raises no usage events**, and that is a platform fact rather than an omission: it bills
per minute and reports its token breakdown only in the webhook, with better numbers than its SDK
exposes. Synthesising a worse copy client-side would give every lesson two sources of truth.

### 3.2 Weaker than the webhook, stated plainly

- **No per-turn usage or timing.** The transport contract carries neither a turn id nor a timestamp,
  so usage is summed onto the root run instead of attached to the turn that spent it.
- **A client that dies before it posts leaves no trace.** The stored transcript is protected from
  that by the journal, which replays on next focus; the trace rides along with it, so it is
  recovered in the same case — but a force-quit that loses the journal loses the trace too.
- **Duplicate posts.** The root run id is derived from the `conversationId` (a real UUID for this
  provider), so a retry or a journal replay PATCHES one trace rather than filing a second. Child
  runs still get fresh ids, so a genuine duplicate shows as repeated turns inside one trace —
  visibly odd rather than two half-records.

## 4. When the sideband becomes right

It is the correct tool the moment the server needs to be a **participant** rather than a witness:

- server-side tools the tutor can call mid-lesson (looking a word up, marking an item practised);
- changing `session.instructions` in flight, which is how an adaptive lesson would be built;
- a transcript that has to survive the phone being destroyed mid-sentence.

Nothing in the app wants any of those today. The first one that does should reopen this document
rather than work around it — and by then Vercel's 1800 s ceiling may be GA, which removes the worst
of the four objections above.

## 5. What is not verified

Nothing here has run against a real lesson. Specifically unknown:

- whether `response.done` carries the usage fields this code reads (the shape is read defensively
  field by field, so a change zeroes the cost rather than throwing — which is its own risk);
- whether the estimate is close to the invoice;
- whether one trace per lesson is actually what LangSmith ends up holding, or whether journal
  replays produce visible duplication in practice.

The first `words-2.0` lesson answers all three, and it is the same lesson that has to answer whether
the prompt is any good.
