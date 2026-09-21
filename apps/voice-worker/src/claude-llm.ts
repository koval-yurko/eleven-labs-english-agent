/**
 * Our own `llm.LLM` implementation on the current `@anthropic-ai/sdk`, replacing
 * `@livekit/agents-plugin-anthropic`. See `./claude-request.ts` for why: that plugin's request
 * builder has the caching and hoisting bugs research doc §3.2 verified in its source, and this file
 * is the ~300-line adapter §3.2 and the Phase 1 task plan ask for instead.
 *
 * What this file owns that `claude-request.ts` doesn't: the network call, the streaming loop, and
 * everything about a request that ISN'T the chat-context-to-messages mapping —
 *   - `thinking: {type: "disabled"}`, always. Sonnet 5 thinks adaptively when `thinking` is
 *     omitted, which puts thinking time in front of the first spoken word (§2 Q3).
 *   - no sampling params. `temperature` 400s on Sonnet 5 for any non-default value, so this adapter
 *     never sends one — there is no `opts.temperature` to opt back into it.
 *   - `cache_read_input_tokens` / `cache_creation_input_tokens` reported into `CompletionUsage`,
 *     which `AgentSession` folds into `session.usage` and which the worker's own turn ledger
 *     (`TurnRecord`, Phase 3) reads from there.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  DEFAULT_API_CONNECT_OPTIONS,
  llm,
  type APIConnectOptions,
  type ChatContext,
  type ToolChoice,
  type ToolContextLike,
} from "@livekit/agents";

import { applyCacheControl, buildAnthropicMessages, buildMessageParams } from "./claude-request.ts";

/** Sonnet 5's API model id (see the model-id list this repo's assistant was given). Not `DEFAULT_LLM`
 *  from `apps/web/src/agent/prompts/index.ts` — that constant bakes ElevenLabs/Vapi agents and stays
 *  "claude-sonnet-4-6" for the versions already pinned to it; this worker is a new provider making
 *  its own choice per the research doc's recommendation (§0). */
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface ClaudeLLMOptions {
  model?: string;
  apiKey?: string;
  /** Overrides the client entirely — tests pass a fake here instead of a real Anthropic client. */
  client?: Anthropic;
  maxRetries?: number;
  /** Called once per request that streams to the end, with everything Claude generated for it.
   *  The turn ledger uses it for `agentText`, which a barge-in would otherwise leave truncated.
   *  `requestId` matches the framework's `llm_metrics.requestId`. */
  onCompletion?: (requestId: string, text: string) => void;
}

export class ClaudeLLM extends llm.LLM {
  readonly #model: string;
  readonly #client: Anthropic;
  readonly #onCompletion: ClaudeLLMOptions["onCompletion"];

  constructor(opts: ClaudeLLMOptions = {}) {
    super();
    this.#model = opts.model ?? DEFAULT_MODEL;
    this.#onCompletion = opts.onCompletion;
    if (opts.client) {
      this.#client = opts.client;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ClaudeLLM: ANTHROPIC_API_KEY is required, whether as an option or an env var");
      }
      this.#client = new Anthropic({ apiKey, maxRetries: opts.maxRetries ?? 3 });
    }
  }

  label(): string {
    return "tutor.ClaudeLLM";
  }

  override get model(): string {
    return this.#model;
  }

  override get provider(): string {
    return "anthropic";
  }

  protected override async _prewarmImpl(signal: AbortSignal): Promise<void> {
    await this.#client.models.list({ limit: 1 }, { signal });
  }

  chat({
    chatCtx,
    toolCtx: toolCtxInput,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
    toolChoice,
  }: {
    chatCtx: ChatContext;
    toolCtx?: ToolContextLike;
    connOptions?: APIConnectOptions;
    parallelToolCalls?: boolean;
    toolChoice?: ToolChoice;
    extraKwargs?: Record<string, unknown>;
  }): llm.LLMStream {
    const parts = applyCacheControl(buildAnthropicMessages(chatCtx.items));
    const toolCtx = llm.toToolContext(toolCtxInput);
    const tools: Anthropic.Tool[] = [];
    if (toolCtx) {
      for (const [name, tool] of llm.sortedToolEntries(toolCtx)) {
        tools.push({
          name,
          description: tool.description ?? "",
          input_schema: tool.parameters
            ? (llm.toJsonSchema(tool.parameters, false) as Anthropic.Tool["input_schema"])
            : { type: "object", properties: {} },
        });
      }
    }

    let anthropicToolChoice: Anthropic.ToolChoice | undefined;
    if (tools.length > 0 && toolChoice) {
      if (toolChoice === "required") anthropicToolChoice = { type: "any" };
      else if (toolChoice === "none") tools.length = 0;
      else if (typeof toolChoice === "object" && toolChoice.type === "function") {
        anthropicToolChoice = { type: "tool", name: toolChoice.function.name };
      }
    }

    const requestParams = buildMessageParams({ model: this.#model, parts, tools, toolChoice: anthropicToolChoice });

    return new ClaudeLLMStream(this, this.#client, requestParams, chatCtx, toolCtx, connOptions, this.#onCompletion);
  }
}

class ClaudeLLMStream extends llm.LLMStream {
  readonly #client: Anthropic;
  readonly #requestParams: Anthropic.MessageCreateParamsStreaming;
  readonly #onCompletion: ClaudeLLMOptions["onCompletion"];

  constructor(
    llmInst: ClaudeLLM,
    client: Anthropic,
    requestParams: Anthropic.MessageCreateParamsStreaming,
    chatCtx: ChatContext,
    toolCtx: llm.ToolContext | undefined,
    connOptions: APIConnectOptions,
    onCompletion: ClaudeLLMOptions["onCompletion"],
  ) {
    super(llmInst, { chatCtx, toolCtx, connOptions });
    this.#client = client;
    this.#requestParams = requestParams;
    this.#onCompletion = onCompletion;
  }

  protected override async run(): Promise<void> {
    let retryable = true;
    let requestId = "";
    let toolCallId: string | undefined;
    let toolName: string | undefined;
    let toolRawArgs = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;
    let text = "";

    try {
      const stream = await this.#client.messages.create(this.#requestParams, {
        timeout: this.connOptions.timeoutMs,
      });
      for await (const event of stream) {
        if (event.type === "message_start") {
          requestId = event.message.id;
          inputTokens = event.message.usage.input_tokens;
          outputTokens = event.message.usage.output_tokens;
          cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0;
          cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
        } else if (event.type === "message_delta") {
          outputTokens = event.usage.output_tokens;
        } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolCallId = event.content_block.id;
          toolName = event.content_block.name;
          toolRawArgs = "";
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          if (event.delta.text) {
            text += event.delta.text;
            this.queue.put({ id: requestId, delta: { role: "assistant", content: event.delta.text } });
            retryable = false;
          }
        } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
          toolRawArgs += event.delta.partial_json;
        } else if (event.type === "content_block_stop" && toolCallId) {
          this.queue.put({
            id: requestId,
            delta: {
              role: "assistant",
              toolCalls: [llm.FunctionCall.create({ callId: toolCallId, name: toolName ?? "", args: toolRawArgs })],
            },
          });
          toolCallId = undefined;
          toolName = undefined;
          toolRawArgs = "";
          retryable = false;
        }
      }
      const promptTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
      this.queue.put({
        id: requestId,
        usage: {
          completionTokens: outputTokens,
          promptTokens,
          totalTokens: promptTokens + outputTokens,
          promptCachedTokens: cacheReadTokens,
          cacheCreationTokens,
        },
      });
      this.#onCompletion?.(requestId, text);
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        if (e.status === 408) {
          throw new APITimeoutError({ message: e.message, options: { retryable } });
        }
        throw new APIStatusError({
          message: e.message,
          options: {
            statusCode: e.status ?? 0,
            body: e.error,
            retryable: retryable && (e.status === 429 || (e.status ?? 0) >= 500),
          },
        });
      }
      throw new APIConnectionError({
        message: e instanceof Error ? e.message : String(e),
        options: { retryable },
      });
    }
  }
}
