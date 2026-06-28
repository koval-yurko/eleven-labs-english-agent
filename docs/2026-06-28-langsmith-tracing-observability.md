# Tracing the voice tutor in LangSmith (post-call webhook bridge)

> Research note — 2026-06-28. Scope: **only** the voice tutor flow — the real
> product, the **User ↔ Teacher** conversation (`/words`). The earlier `askClaude`
> demo box is explicitly out of scope and not discussed here.
>
> Goal: see every lesson in LangSmith — User and Teacher sentences, which tools
> the agent called (and their results), timing, and token usage — by bridging
> ElevenLabs' **post-call webhook** into a LangSmith trace.
>
> **Status — IMPLEMENTED (2026-06-28, Approach B1).** Files:
> `src/app/api/words-agent/elevenlabs-webhook/route.ts` (HMAC-verified webhook),
> `src/lib/langsmith-trace.ts` (`traceConversation` payload→`RunTree` mapping),
> `src/lib/config.ts` (`webhookSecret`). Deps added: `langsmith`,
> `@elevenlabs/elevenlabs-js`. **Remaining to go live:** set `ELEVENLABS_WEBHOOK_SECRET`,
> `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT` in the deploy env, and register the webhook
> URL in the ElevenLabs workspace (see §5 / "Go live" below).

## TL;DR

- The tutor's LLM runs **inside ElevenLabs convai**, not in our app. Nothing
  about a lesson passes through our server or LangChain, so LangSmith sees
  **nothing** natively. (Architecture recap in §1.)
- The bridge: ElevenLabs fires a **`post_call_transcription` webhook** after each
  call; we host an endpoint, verify its HMAC signature, reshape the payload into
  a LangSmith **run tree**, and POST it. (§4–§5.)
- **Payload coverage is good.** The webhook/conversation payload carries: the full
  ordered **transcript** (role + message + timestamp), **`tool_calls`** and
  **`tool_results`** (with params, result, error, latency), **per-turn token
  usage + price** (`llm_usage`), timing metrics, the **dynamic variables** we sent
  (`items_list`), and an analysis block (summary + eval criteria). Field-by-field
  coverage table in §3.
- **The only real gap:** the agent's hidden chain-of-thought is not exposed (no
  vendor exposes another's). We get *what was said* and *which tools ran with what
  args/results* — which is the actionable signal. (§6.)
- **Two ways to ingest** (§5): **B1 — manual `RunTree` mapping** (full control,
  exact shape, works today — recommended) or **B2 — OpenTelemetry** via Get
  Conversation `format=opentelemetry` → LangSmith's OTLP endpoint (less mapping
  code, but a semantic-convention caveat).
- **Repo reality check:** the words agent currently defines **no tools**, so
  `tool_calls`/`tool_results` will be `null` until we add one (e.g. a dictionary
  or pronunciation-check tool). The mapping below handles tools so it's ready when
  we do.

---

## 1. Why the lesson is invisible to LangSmith (architecture)

```
Browser (WordsTutor.tsx)                 Our server                    ElevenLabs platform
  useConversation({onMessage})           /api/words-agent/             ┌────────────────────┐
        │  mic + WebSocket                 signed-url ──xi-api-key──▶  │  ConvAI agent      │
        │ ─────────────────────────────────────────────────────────▶   │  • runs the LLM    │
        │            audio + transcript turns (WS)                     │    (claude-sonnet  │
        │ ◀─────────────────────────────────────────────────────────   │     -4-6)          │
        │  onMessage({role,message})                                   │  • runs tools      │
        └──────────────                                  ┌──────── POST│  • post-call hook  │
                                                         ▼             └────────────────────┘
                                          /api/.../elevenlabs-webhook  (this is the bridge)
```

Facts from the code:

- The tutor model is set per prompt version and baked into the ElevenLabs agent by
  `src/agent/sync-agents.ts` (`llm` field, default `claude-sonnet-4-6` from
  `src/agent/prompts/types.ts`). **ElevenLabs** calls it — our app never does.
- Our only live-call role is minting a signed WS URL
  (`src/app/api/words-agent/signed-url/route.ts`).
- The client transcript (`WordsTutor.tsx` `onMessage` → `setLines`) is display-only
  and discarded on unmount.

So the lesson never touches LangChain. The **post-call webhook** is the one
authoritative, server-side, tool-call-inclusive record we can capture — which is
why it's the foundation of this whole approach.

---

## 2. What a LangSmith trace is (just enough)

A **trace** is a tree of **runs**. Each run has: `name`; `run_type` (`chain` =
orchestration, `llm` = a model turn, `tool` = a tool call); `inputs`/`outputs`
(where the *sentences* live); `start_time`/`end_time`; optional `error`, `tags`,
`metadata`, and token `usage`. Nested runs render as a waterfall you can expand —
exactly the "what was said / what tool ran / how long / how many tokens" view we
want. The job below is to turn one webhook payload into one such tree.

For non-LangChain data we build runs ourselves with **`RunTree`** (low-level,
explicit) — see §5. Only `LANGSMITH_API_KEY` is needed for `RunTree`; the
`LANGSMITH_TRACING` env switch only governs the *automatic* LangChain path, which
we are not using here.

---

## 3. The data source: post-call webhook payload (verified)

Configured in ElevenLabs **workspace → webhooks** as a `post_call_transcription`
webhook; ElevenLabs POSTs after it finishes post-call analysis. The payload
(verified against current docs):

```jsonc
{
  "type": "post_call_transcription",
  "event_timestamp": 1739537297,
  "data": {
    "agent_id": "xyz",
    "conversation_id": "abc",
    "status": "done",
    "user_id": "user123",
    "transcript": [
      {
        "role": "agent",                       // "agent" | "user"
        "message": "Hey there angelo...",       // the sentence
        "time_in_call_secs": 0,
        "tool_calls": null,                      // populated when the agent calls a tool
        "tool_results": null,
        "feedback": null,
        "conversation_turn_metrics": null,       // timing, e.g. convai_llm_service_ttfb
        "llm_usage": null                        // per-turn tokens + price (see below)
        // also possible per turn: interrupted, original_message, source_medium,
        //                         llm_override, agent_metadata
      }
      // ...one object per turn, in order
    ],
    "metadata": {
      "start_time_unix_secs": 1739537297,
      "call_duration_secs": 22,
      "cost": 296,
      "termination_reason": "",
      "feedback": { "overall_score": null, "likes": 0, "dislikes": 0 },
      "charging": { "dev_discount": true },
      "deletion_settings": { /* ... */ }
    },
    "analysis": {
      "evaluation_criteria_results": {},          // per-agent LLM-graded success criteria
      "data_collection_results": {},              // structured extraction from transcript
      "call_successful": "success",
      "transcript_summary": "The conversation begins with..."
    },
    "conversation_initiation_client_data": {
      "dynamic_variables": { "user_name": "angelo" },  // ← our items_list lands here
      "conversation_config_override": { "agent": { "language": "en" }, "tts": { "voice_id": null } },
      "custom_llm_extra_body": {},
      "branch_id": null,
      "environment": null
    }
  }
}
```

### 3a. `tool_calls[]` — each entry (from the Get-Conversation schema)

| field | type | meaning |
| --- | --- | --- |
| `request_id` | string | correlates a call to its result |
| `tool_name` | string | which tool the agent invoked |
| `params_as_json` | string | the arguments (JSON string) → trace **inputs** |
| `tool_has_been_called` | boolean | whether it actually executed |
| `type` | enum | `system` \| `webhook` \| `client` \| `mcp` \| `workflow` \| `api_integration_*` |
| `tool_details` | object\|null | integration-specific metadata |

### 3b. `tool_results[]` — each entry

| field | type | meaning |
| --- | --- | --- |
| `request_id` | string | matches the originating `tool_call` |
| `tool_name` | string | |
| `result_value` | string | the tool's output → trace **outputs** |
| `is_error` | boolean | → set the run's `error` |
| `tool_latency_secs` | number | → run duration |
| `error_type` / `raw_error_message` | string | error detail |
| `is_blocked`, `dynamic_variable_updates`, `type` | — | extra context |

### 3c. `llm_usage` (per turn) — token usage **is** available

`llm_usage.model_usage` maps model name → `{ input, input_cache_read,
input_cache_write, output_total }`, and each of those is `{ tokens, price }`. So
we can attach real token counts (and cost) to each agent turn's `llm` run. (This
corrects an earlier draft that claimed token usage was unavailable — it is.)

> Note: the headline webhook example renders `tool_calls`/`tool_results`/`llm_usage`
> as `null` because that sample call used no tools; the **Get Conversation** API
> (`GET /v1/convai/conversations/:id`) returns the full populated schema, and the
> docs state the webhook payload is converging on that same shape. If a field is
> ever missing from the webhook, fetch the conversation by id to enrich it (§5,
> step 5).

### 3d. Coverage check — does the payload carry everything we want to trace?

| What we want to see | Payload source | Covered? |
| --- | --- | --- |
| User sentences | `transcript[].message` where `role:"user"` | ✅ |
| Teacher sentences | `transcript[].message` where `role:"agent"` | ✅ |
| Turn order / timing | `transcript[].time_in_call_secs`, `conversation_turn_metrics` | ✅ |
| Which tool the agent called + args | `tool_calls[].tool_name` / `params_as_json` | ✅ |
| Tool result / error / latency | `tool_results[].result_value` / `is_error` / `tool_latency_secs` | ✅ |
| Token usage + cost per turn | `transcript[].llm_usage`, `metadata.cost` | ✅ |
| The lesson's items list | `conversation_initiation_client_data.dynamic_variables` (`items_list`) | ✅ |
| Which prompt version/agent | `agent_id` (+ per-turn `agent_metadata.version_id`) | ✅ |
| Pass/fail + summary | `analysis.*` | ✅ |
| Agent's hidden reasoning (chain-of-thought) | — | ❌ not exposed |

**Conclusion: the payload covers every trace element we need except hidden
reasoning** (which is unavailable by design). Proceed.

---

## 4. Mapping a payload → a LangSmith run tree

Target shape (one trace per conversation):

```
chain  "lesson <conversation_id>"                       ← root
  inputs : { items_list, agent_id, user_id }
  outputs: { call_successful, transcript_summary, cost, duration_secs }
  ├─ chain "User @2s"          inputs/outputs: { message }            (role:"user")
  ├─ llm   "Teacher @9s"       inputs:{ context }, outputs:{ message }, usage:{tokens} (role:"agent")
  │    └─ tool "<tool_name>"   inputs:{ params }, outputs:{ result }, error?      (if that turn called a tool)
  └─ ...                                                                          (one node per turn, in order)
```

Design choices:
- **Agent turns → `run_type: "llm"`** so token usage renders natively and they
  read as model outputs. **User turns → `run_type: "chain"`** (plain events).
- **Tool calls nest under the agent turn that issued them**, matched
  `tool_calls[i].request_id` ↔ `tool_results[j].request_id`.
- Use a **deterministic trace id derived from `conversation_id`** so webhook
  retries are idempotent (re-POST updates the same trace instead of duplicating).
- Stamp `metadata`: `{ agent_id, version_id, environment, conversation_id }` and
  tag with the prompt version for filtering in the UI.

---

## 5. Approach B1 — webhook → `RunTree` (recommended)

Full control, exact shape, no dependence on ElevenLabs' OTEL semantics. Works today.

**Wiring summary**
1. New route `src/app/api/words-agent/elevenlabs-webhook/route.ts` (public — webhooks
   are unauthenticated; the HMAC signature *is* the auth).
2. Add `ELEVENLABS_WEBHOOK_SECRET` to `src/lib/config.ts` (server-only, like the
   existing `ELEVENLABS_API_KEY`).
3. Add `langsmith` as a direct dependency (already transitively in the lockfile at
   0.3.87) and set `LANGSMITH_API_KEY` (+ `LANGSMITH_PROJECT=idiomatic`).
4. Register the deployed URL in ElevenLabs **workspace → webhooks** as a
   `post_call_transcription` webhook; copy the shared secret into the env var.
5. (Optional) If a needed field is `null` in the webhook, fetch
   `GET /v1/convai/conversations/:conversation_id` with `xi-api-key` to enrich.

**Route sketch** (illustrative — not yet created):

```ts
// src/app/api/words-agent/elevenlabs-webhook/route.ts
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { RunTree } from "langsmith";

const PROJECT = process.env.LANGSMITH_PROJECT ?? "idiomatic";

export async function POST(req: Request) {
  // 1) Verify HMAC. Header is `elevenlabs-signature`; constructEvent checks the
  //    signature + timestamp and parses the body. Reject anything that fails.
  const raw = await req.text();
  const sig = req.headers.get("elevenlabs-signature");
  const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  let evt;
  try {
    evt = await client.webhooks.constructEvent(raw, sig!, process.env.ELEVENLABS_WEBHOOK_SECRET!);
  } catch {
    return new Response("bad signature", { status: 401 });
  }
  if (evt.type !== "post_call_transcription") return Response.json({ ok: true });

  const d = evt.data;

  // 2) Root run — one trace per conversation. Derive id from conversation_id so
  //    webhook retries are idempotent.
  const root = new RunTree({
    name: `lesson ${d.conversation_id}`,
    run_type: "chain",
    project_name: PROJECT,
    inputs: {
      items_list: d.conversation_initiation_client_data?.dynamic_variables,
      agent_id: d.agent_id,
      user_id: d.user_id,
    },
    extra: { metadata: { conversation_id: d.conversation_id, status: d.status } },
  });
  await root.postRun();

  // 3) One child per turn, in order; tools nest under the agent turn that called them.
  for (const t of d.transcript) {
    const isAgent = t.role === "agent";
    const turn = await root.createChild({
      name: `${isAgent ? "Teacher" : "User"} @${t.time_in_call_secs}s`,
      run_type: isAgent ? "llm" : "chain",
      inputs: { message: t.message },
      extra: {
        metadata: { time_in_call_secs: t.time_in_call_secs, ...t.agent_metadata },
        // attach per-turn tokens so LangSmith shows usage on the llm run
        ...(t.llm_usage ? { usage_metadata: toUsage(t.llm_usage) } : {}),
      },
    });
    await turn.postRun();

    // 4) Tool calls on this turn → tool grandchildren, matched by request_id.
    for (const call of t.tool_calls ?? []) {
      const res = (t.tool_results ?? []).find((r) => r.request_id === call.request_id);
      const tool = await turn.createChild({
        name: call.tool_name,
        run_type: "tool",
        inputs: safeJson(call.params_as_json),
      });
      await tool.postRun();
      tool.end({
        outputs: res ? { result: res.result_value } : undefined,
        error: res?.is_error ? (res.raw_error_message || "tool error") : undefined,
      });
      await tool.patchRun();
    }

    turn.end({ outputs: { message: t.message } });
    await turn.patchRun();
  }

  // 5) Close the root with the analysis + cost summary.
  root.end({
    outputs: {
      call_successful: d.analysis?.call_successful,
      transcript_summary: d.analysis?.transcript_summary,
      cost: d.metadata?.cost,
      duration_secs: d.metadata?.call_duration_secs,
    },
  });
  await root.patchRun();

  return Response.json({ ok: true });
}

// helpers: safeJson(params_as_json) → object; toUsage(llm_usage) → {input_tokens, output_tokens, total_tokens}
```

**Operational notes**
- **Respond fast (2xx) then trace** — webhooks expect a quick ack. If mapping is
  slow, ack first and do the LangSmith POSTs in the background (or a queue); a
  failed trace must not cause ElevenLabs to retry-storm.
- **Idempotency** — derive run ids from `conversation_id` (+ turn index) so retries
  upsert rather than duplicate.
- **Vercel** — the route must be public; do not put it behind Auth0 middleware.
- **No tools yet** — until the words agent declares a tool, the `tool_calls` loop
  is a no-op; the transcript + usage still trace fully.

---

## 6. Approach B2 — OpenTelemetry (lower-code, with a caveat)

ElevenLabs can emit OTLP directly: **`GET /v1/convai/conversations/:id?format=opentelemetry`**
returns an OTLP-compatible trace payload (`otlp_traces`) with the same structure as
the webhook. LangSmith natively ingests OTLP at:

```
OTEL_EXPORTER_OTLP_ENDPOINT = https://api.smith.langchain.com/otel   (append /v1/traces for traces only)
OTEL_EXPORTER_OTLP_HEADERS  = x-api-key=<LANGSMITH_API_KEY>,Langsmith-Project=idiomatic
# EU/APAC/AWS have regional hosts: eu. / apac. / aws. .api.smith.langchain.com
```

Flow: webhook fires → our route fetches the conversation with
`format=opentelemetry` → forwards `otlp_traces` to the LangSmith OTEL endpoint.
Almost no mapping code.

**Caveat (why this is the *secondary* option):** LangSmith renders LLM-specific
fields (tokens, model, messages) best when spans follow the **OpenLLMetry / GenAI
semantic conventions**. ElevenLabs' OTLP span attributes may not match those
conventions one-to-one, so turns/tools could land as generic spans with attributes
in nonstandard keys — readable, but not the clean llm/tool waterfall B1 produces.
Validate the rendering on one real conversation before committing. If it looks
good, B2 is much less code; if not, B1 gives a guaranteed shape.

---

## 7. Gaps & limits (be explicit)

- **No hidden chain-of-thought / reasoning tokens.** We see the agent's *spoken*
  turns and its *tool* activity, not its internal deliberation. This is a hard
  vendor boundary, not a config gap.
- **Post-call, not live.** The webhook fires after analysis completes, so traces
  appear seconds-to-minutes after a lesson ends (fine for review/eval; not a live
  monitor — ElevenLabs' real-time monitoring WS is the live view if needed).
- **Tools must exist to be traced.** Today there are none on the words agent.
- **Webhook field maturity.** A given field may be `null` in the webhook while
  populated via the Get Conversation API; enrich by id when needed (§5 step 5).

---

## 8. Recommendation & next steps

1. **Build B1** — the webhook → `RunTree` route. It's the authoritative,
   tool-inclusive, full-control path and works today. Concretely:
   - `src/lib/config.ts`: add `ELEVENLABS_WEBHOOK_SECRET`.
   - add `src/app/api/words-agent/elevenlabs-webhook/route.ts` (HMAC verify → map → POST).
   - `langsmith` as a direct dep; set `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT`.
   - register the webhook in the ElevenLabs workspace; do one test call; confirm the
     trace tree in LangSmith.
2. **Evaluate B2** on one conversation in parallel — if ElevenLabs' OTLP renders
   cleanly in LangSmith, switch to it to delete mapping code.
3. **Then layer evals** — with lessons in LangSmith, use the `langsmith-dataset`
   and `langsmith-evaluator` skills to score e.g. "did the Teacher cover every item
   in `items_list`?" The `analysis.evaluation_criteria_results` block can seed those.

---

## Sources

- [ElevenLabs — Post-call webhooks (payload + HMAC `constructEvent`)](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks)
- [ElevenLabs — Get conversation details (full transcript / tool_calls / tool_results / llm_usage / `format=opentelemetry`)](https://elevenlabs.io/docs/api-reference/conversations/get)
- [ElevenLabs — Conversation analysis (evaluation criteria, data collection)](https://elevenlabs.io/docs/agents-platform/customization/agent-analysis)
- [ElevenLabs — Real-time monitoring (live view alternative)](https://elevenlabs.io/docs/agents-platform/guides/realtime-monitoring)
- [LangSmith — Annotate code: `traceable` / `RunTree`](https://docs.langchain.com/langsmith/annotate-code)
- [LangSmith TypeScript SDK (`RunTree`)](https://github.com/langchain-ai/langsmith-sdk/blob/main/js/README.md)
- [LangSmith — Trace with OpenTelemetry (OTLP endpoint + headers)](https://docs.langchain.com/langsmith/trace-with-opentelemetry)
- [Introducing OpenTelemetry support for LangSmith](https://blog.langchain.com/opentelemetry-langsmith/)
</content>
