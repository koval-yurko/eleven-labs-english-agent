/**
 * SERVER-ONLY. Maps an ElevenLabs post-call transcription payload into a LangSmith
 * trace so each voice lesson is observable: User/Teacher turns, any tool calls + their
 * results, and per-turn token usage.
 *
 * The tutor LLM runs INSIDE ElevenLabs convai, so these turns never pass through
 * LangChain — we build the run tree by hand with `RunTree` (no auto-tracing involved).
 * Needs only LANGSMITH_API_KEY (+ optional LANGSMITH_PROJECT). Called by
 * src/app/api/words-agent/elevenlabs-webhook/route.ts.
 *
 * Trace shape:
 *   chain "lesson <conversation_id>"            inputs: items_list, agent_id, user_id
 *     ├─ chain "User @2s"                        { message }
 *     ├─ llm   "Teacher @9s"                     { message } + usage_metadata
 *     │    └─ tool "<tool_name>"                 inputs: params, outputs: result (or error)
 *     └─ ...                                     outputs(root): summary, call_successful, cost
 *
 * See docs/2026-06-28-langsmith-tracing-observability.md (Approach B1).
 */
import { Client, RunTree } from "langsmith";
import type { TranscriptLine } from "@tutor/shared/tutor/session";
import type { TutorUsage } from "@tutor/shared/tutor/transport";

// ── Payload types (only the fields we consume; the real payload has more) ──────
// Mirrors ElevenLabs' `post_call_transcription` data object / Get-Conversation schema.

export interface TokenPrice {
  tokens?: number;
  price?: number;
}

export interface LlmUsage {
  model_usage?: Record<
    string,
    {
      input?: TokenPrice;
      input_cache_read?: TokenPrice;
      input_cache_write?: TokenPrice;
      output_total?: TokenPrice;
    }
  >;
}

export interface ToolCall {
  request_id: string;
  tool_name: string;
  params_as_json?: string;
  tool_has_been_called?: boolean;
  type?: string | null;
}

export interface ToolResult {
  request_id: string;
  tool_name: string;
  result_value?: string;
  is_error?: boolean;
  tool_latency_secs?: number;
  error_type?: string;
  raw_error_message?: string;
}

export interface TranscriptTurn {
  role: "agent" | "user";
  message: string | null;
  time_in_call_secs?: number;
  tool_calls?: ToolCall[] | null;
  tool_results?: ToolResult[] | null;
  conversation_turn_metrics?: Record<string, unknown> | null;
  llm_usage?: LlmUsage | null;
  interrupted?: boolean | null;
  agent_metadata?: Record<string, unknown> | null;
}

export interface PostCallData {
  agent_id: string;
  conversation_id: string;
  status?: string;
  user_id?: string | null;
  transcript: TranscriptTurn[];
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    cost?: number;
    termination_reason?: string;
  };
  analysis?: {
    call_successful?: string;
    transcript_summary?: string;
    evaluation_criteria_results?: Record<string, unknown>;
    data_collection_results?: Record<string, unknown>;
  };
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
    environment?: string | null;
  };
}

export interface PostCallWebhookEvent {
  type: string;
  event_timestamp?: number;
  data: PostCallData;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Tool params arrive as a JSON string; surface them as a real object for the trace inputs. */
function parseParams(json?: string): Record<string, unknown> {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw: json };
  }
}

/** Collapse ElevenLabs' per-model token breakdown into LangSmith's usage_metadata shape. */
function toUsageMetadata(usage?: LlmUsage | null) {
  const models = usage?.model_usage ? Object.values(usage.model_usage) : [];
  let input = 0;
  let output = 0;
  for (const m of models) {
    input +=
      (m.input?.tokens ?? 0) +
      (m.input_cache_read?.tokens ?? 0) +
      (m.input_cache_write?.tokens ?? 0);
    output += m.output_total?.tokens ?? 0;
  }
  if (input === 0 && output === 0) return undefined;
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** Drop undefined/null entries so the trace metadata stays readable. */
function clean(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

// ── Mapping ────────────────────────────────────────────────────────────────────

/**
 * Push one conversation to LangSmith as a single trace. Resolves once all runs are
 * flushed to the API (important on serverless: the function may be frozen right after
 * the HTTP response, before background batches send). Throws on a hard failure.
 */
export async function traceConversation(
  data: PostCallData,
  opts: { projectName?: string } = {},
): Promise<void> {
  const client = new Client();
  const init = data.conversation_initiation_client_data;

  const root = new RunTree({
    name: `lesson ${data.conversation_id}`,
    run_type: "chain",
    client,
    project_name: opts.projectName ?? process.env.LANGSMITH_PROJECT,
    inputs: clean({
      items_list: init?.dynamic_variables,
      agent_id: data.agent_id,
      user_id: data.user_id,
    }),
    extra: {
      metadata: clean({
        conversation_id: data.conversation_id,
        status: data.status,
        environment: init?.environment,
      }),
    },
  });
  await root.postRun();

  try {
    for (const turn of data.transcript ?? []) {
      const isAgent = turn.role === "agent";
      const at = turn.time_in_call_secs != null ? ` @${turn.time_in_call_secs}s` : "";

      const turnRun = await root.createChild({
        name: `${isAgent ? "Teacher" : "User"}${at}`,
        run_type: isAgent ? "llm" : "chain",
        inputs: { message: turn.message ?? "" },
        extra: {
          metadata: clean({
            time_in_call_secs: turn.time_in_call_secs,
            interrupted: turn.interrupted,
            conversation_turn_metrics: turn.conversation_turn_metrics,
            ...turn.agent_metadata,
          }),
        },
      });
      await turnRun.postRun();

      // Tool calls the agent made on this turn → nested tool runs, matched by request_id.
      for (const call of turn.tool_calls ?? []) {
        const result = (turn.tool_results ?? []).find((r) => r.request_id === call.request_id);
        const toolRun = await turnRun.createChild({
          name: call.tool_name,
          run_type: "tool",
          inputs: parseParams(call.params_as_json),
          extra: { metadata: clean({ request_id: call.request_id, tool_type: call.type }) },
        });
        await toolRun.postRun();
        await toolRun.end(
          result?.is_error
            ? { error: result.raw_error_message || result.error_type || "tool error" }
            : { outputs: { result: result?.result_value ?? null } },
        );
        await toolRun.patchRun();
      }

      const outputs: Record<string, unknown> = { message: turn.message ?? "" };
      const usage = isAgent ? toUsageMetadata(turn.llm_usage) : undefined;
      if (usage) outputs.usage_metadata = usage;
      await turnRun.end({ outputs });
      await turnRun.patchRun();
    }

    await root.end({
      outputs: clean({
        call_successful: data.analysis?.call_successful,
        transcript_summary: data.analysis?.transcript_summary,
        evaluation_criteria_results: data.analysis?.evaluation_criteria_results,
        cost: data.metadata?.cost,
        duration_secs: data.metadata?.call_duration_secs,
      }),
    });
    await root.patchRun();
  } catch (err) {
    // Surface the failure on the root run so a partial trace isn't silently orphaned.
    await root.end({ error: err instanceof Error ? err.message : String(err) });
    await root.patchRun();
    throw err;
  } finally {
    // Force-flush: don't let the serverless function exit with batches still queued.
    await client.awaitPendingTraceBatches();
  }
}

// ── Client-reported lessons (OpenAI Realtime) ────────────────────────────────

/**
 * Per-1M-token list prices for `gpt-realtime-2.1`, **as of 2026-08-22**, used only to put an
 * estimate on a trace.
 *
 * Overridable by env because a rate card changes and a hardcoded number that has quietly gone stale
 * is worse than no number — the estimate is labelled as one in the trace for the same reason. There
 * is no ElevenLabs equivalent here: that platform bills per minute and reports its own `cost` in the
 * post-call webhook, which `traceConversation` above passes straight through.
 */
const RATES_PER_MTOK = {
  input: Number(process.env.OPENAI_REALTIME_PRICE_INPUT ?? 32),
  cachedInput: Number(process.env.OPENAI_REALTIME_PRICE_CACHED_INPUT ?? 0.4),
  output: Number(process.env.OPENAI_REALTIME_PRICE_OUTPUT ?? 64),
};

function estimateCostUsd(usage: TutorUsage): number {
  // `inputTokens` includes the cached ones, so the uncached remainder is what pays full price.
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const dollars =
    (uncachedInput * RATES_PER_MTOK.input +
      usage.cachedInputTokens * RATES_PER_MTOK.cachedInput +
      usage.outputTokens * RATES_PER_MTOK.output) /
    1_000_000;
  return Math.round(dollars * 10_000) / 10_000;
}

/** LangSmith wants a UUID for a run id; `conversationId` is one for the providers we mint it for. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientLesson {
  conversationId: string;
  lessonId: string;
  agentVersion: string;
  provider: string;
  ownerId: string;
  lines: TranscriptLine[];
  usage?: TutorUsage;
}

/**
 * Push a lesson to LangSmith from the transcript the CLIENT reported.
 *
 * ## Why this exists beside `traceConversation`
 *
 * ElevenLabs POSTs a signed post-call webhook carrying the transcript, tool calls, per-turn token
 * usage and a cost figure. **OpenAI has neither a post-call webhook nor a post-call transcript
 * endpoint** — the request for one is still open on their forum — so the client is the only witness
 * to a finished realtime lesson, and this is the only place its record can come from.
 *
 * The alternative was a SIDEBAND WebSocket: the server attaching to the live call with
 * `wss://api.openai.com/v1/realtime?call_id=…` and watching it end to end. It was rejected, and the
 * reasoning is in docs/2026-08-22-openai-lesson-observability.md — briefly: it needs a function that
 * outlives a 30-minute lesson (beta-gated, Pro-plan-only, and still short of OpenAI's own 60-minute
 * ceiling), it drops after about a minute of silence when a held pause is a long silence by
 * construction, and it bills half an hour of function wall-clock per lesson to learn what the
 * transcript write path already carries.
 *
 * ## What is weaker than the webhook, stated plainly
 *
 * Per-TURN usage and timing are not here — the transport contract carries neither a turn id nor a
 * timestamp, so usage is summed onto the root instead of attached to the turn that spent it. And a
 * client that dies before it posts leaves no trace at all, where a webhook would still have fired.
 * The stored transcript is protected from that by the journal; the trace is not, and a missing trace
 * is the smaller loss.
 *
 * Best-effort by contract: every caller runs it in `after()` and swallows failures. An observability
 * write must never be able to fail a transcript write.
 */
export async function traceClientLesson(
  lesson: ClientLesson,
  opts: { projectName?: string } = {},
): Promise<void> {
  const client = new Client();
  const root = new RunTree({
    // Deterministic, so a retry or a journal replay PATCHES the same trace rather than filing a
    // second one for the same lesson. Child runs still get fresh ids, so a genuine duplicate post
    // shows as repeated turns inside one trace — visibly odd, rather than two half-records.
    ...(UUID.test(lesson.conversationId) ? { id: lesson.conversationId } : {}),
    name: `lesson ${lesson.conversationId}`,
    run_type: "chain",
    client,
    project_name: opts.projectName ?? process.env.LANGSMITH_PROJECT,
    inputs: clean({
      lesson_id: lesson.lessonId,
      agent_version: lesson.agentVersion,
      provider: lesson.provider,
      user_id: lesson.ownerId,
    }),
    extra: {
      metadata: clean({
        conversation_id: lesson.conversationId,
        provider: lesson.provider,
        agent_version: lesson.agentVersion,
        environment: process.env.APP_ENV?.trim(),
        // So a reader knows the transcript came from the phone rather than from the platform, and
        // can weigh a missing tail accordingly.
        source: "client",
      }),
    },
  });
  await root.postRun();

  try {
    for (const line of lesson.lines) {
      const isAgent = line.role === "agent";
      const at = line.timeInCallSecs != null ? ` @${line.timeInCallSecs}s` : "";
      const turn = await root.createChild({
        name: `${isAgent ? "Teacher" : "User"}${at}`,
        run_type: isAgent ? "llm" : "chain",
        inputs: { message: line.text },
      });
      await turn.postRun();
      await turn.end({ outputs: { message: line.text } });
      await turn.patchRun();
    }

    const usage = lesson.usage;
    await root.end({
      outputs: clean({
        turns: lesson.lines.length,
        // Summed, not per-turn — see the docblock. `usage_metadata` is the shape LangSmith reads for
        // its own token accounting; the rest is the audio/cached split, which is where the money is.
        usage_metadata: usage
          ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            }
          : undefined,
        input_audio_tokens: usage?.inputAudioTokens,
        output_audio_tokens: usage?.outputAudioTokens,
        cached_input_tokens: usage?.cachedInputTokens,
        // An ESTIMATE, and named one: it is our arithmetic over a rate card that can move, not a
        // figure the platform reported.
        estimated_cost_usd: usage ? estimateCostUsd(usage) : undefined,
      }),
    });
  } catch (e) {
    await root.end({ error: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    await root.patchRun();
    await client.awaitPendingTraceBatches();
  }
}
