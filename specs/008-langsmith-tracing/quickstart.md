# Quickstart: Live-Story Telemetry Tracing (008-langsmith-tracing)

How to configure, run, and verify the improved tracing. The first run is the make-or-break
**span-capture spike** (R2); after that everything is replayable offline.

## Prerequisites

- A LangSmith account + `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` (e.g. `eleven-labs-english-agent`).
- An ElevenLabs account with the story agent (`ELEVENLABS_STORY_AGENT_ID`) and API key.
- A publicly reachable URL for the webhook: deployed staging/prod, OR an HTTPS tunnel to
  `localhost:3000` for local testing.

## Environment

```bash
# Tracing sink (soft dep — everything no-ops without the key)
LANGSMITH_API_KEY=ls__...
LANGSMITH_PROJECT=eleven-labs-english-agent
LANGSMITH_ENDPOINT=https://api.smith.langchain.com   # default; OTLP ingest is <endpoint>/otel/v1/traces

# Webhook authenticity (server-only; never to the browser — Constitution V)
ELEVENLABS_CONVAI_WEBHOOK_SECRET=whsec_...

# Sweep auth (cron)
CRON_SECRET=...
```

## Step 1 — Capture one real OTel payload (the spike, R2)

1. In the ElevenLabs dashboard, add a **post-call webhook** on the story agent:
   `{ "events": ["transcript"], "transcript_format": "opentelemetry" }`, pointing at
   `https://<your-tunnel-or-host>/api/live-story/elevenlabs/otel-webhook`.
2. Run **one** real live-story session to completion.
3. The route (in dead-drop mode for the spike) logs the raw envelope. Save it as
   `packages/live-story/tests/fixtures/otel-delivery.json`.
4. **Decision gate**: inspect the spans. Rich (per-turn LLM + TTFB, tool calls, TTS) →
   keep the verbatim OTel forward. Thin/opaque → switch the body parser to the JSON
   (`post_call_transcription`) variant and hand-build the tree (B1). Same route either way.

## Step 2 — Verify the relay renders in LangSmith (offline replay)

```bash
# Replay the captured payload through the relay without burning a session:
curl -X POST http://localhost:3000/api/live-story/elevenlabs/otel-webhook \
  -H "Content-Type: application/json" \
  -H "ElevenLabs-Signature: t=<unix>,v0=<hmac>" \
  --data @packages/live-story/tests/fixtures/otel-delivery.json
```

Then open the LangSmith project and confirm a **hierarchical waterfall** (session parent +
per-turn/per-call children) with real duration, TTFB, tool calls, and cost — not a flat node.

## Step 3 — Confirm correlation + threading

- The trace is filterable by `lessonId` and `ownerId`.
- The trace appears under the same **Thread** (`thread_id = lessonId`) as that lesson's
  generation run and any self-reported session runs.
- Send a delivery with an unknown `conversation_id` → the trace still appears, tagged
  `unmatched`, with no lesson/owner.

## Step 4 — Confirm completeness (sweep)

```bash
# Start a session, then disconnect abruptly (no ended:true). After 10 min:
curl -X POST http://localhost:3000/api/live-story/sweep -H "Authorization: Bearer $CRON_SECRET"
# => { "finalized": 1, ... }; the session is now ended with termination_reason "abandoned",
#    and shows a finalized trace (no longer perpetually "active").
```

Schedule this route (cron) in deployment so it runs automatically.

## Step 5 — Confirm graceful degradation

- Unset `LANGSMITH_API_KEY` → the webhook returns `{ status: "no_sink" }`, the sweep still
  finalizes sessions, and the live-story experience is unchanged (SC-007).
- With the webhook unconfigured, the corrected **self-reported tracer** (Tier A) still
  produces a per-turn hierarchy with real start/end times.

## Tests

```bash
pnpm test       # unit + contract: envelope parse, HMAC verify, enrichment, forwarder soft-dep,
                # repo correlation/sweep queries, Tier A session-tracer child runs
pnpm typecheck
pnpm lint
```

Live webhook delivery is the only step not covered by the suite — the captured fixture +
curl replay stand in for it in CI.
