/**
 * The worker entrypoint: Deepgram Flux STT → our Claude adapter → ElevenLabs Flash TTS, with the
 * turn-taking plan from dispatch metadata and a per-turn ledger. Driven by `lk agent console`
 * (voice, laptop mic) or `lk agent console --text` (research doc §4 L3), and by `lk agent dev`
 * once a room dispatches it.
 *
 * The VAD and the turn detector are the session's own defaults. With LiveKit credentials the
 * detector runs on LiveKit Inference. Without them it falls back to the local `v1-mini` model,
 * which is enough for `console` but is NOT what Phase 4 measures.
 *
 * The worker is prompt-agnostic (research doc §1): it never imports `apps/web`, so it has no
 * lesson to teach until something hands it dispatch metadata. In production that is the token
 * route's `RoomAgentDispatch.metadata` (Phase 3, not built yet). Until then, `loadDispatchMetadata`
 * below reads a fixture — see its own docblock for how to generate one from the real prompt.
 */
import "./env.ts";

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cli, defineAgent, ServerOptions, voice, type JobContext } from "@livekit/agents";
import { ParticipantKind } from "@livekit/rtc-node";
import { KICKOFF_MESSAGE, type TranscriptLine } from "@tutor/shared/tutor/session";
import {
  LIVEKIT_AGENT_NAME,
  LIVEKIT_LIFECYCLE,
  LIVEKIT_RPC,
  LIVEKIT_STREAM,
  decodeWireMessage,
  type LiveKitDispatchMetadata,
  type TurnRecord,
} from "@tutor/shared/tutor/livekit-wire";

import { Backend, LEDGER_BATCH_SIZE } from "./backend.ts";
import { ClaudeLLM, DEFAULT_MODEL } from "./claude-llm.ts";
import { createStt, createTts } from "./pipeline.ts";
import { saveWordsTool } from "./save-words-tool.ts";
import { TurnLedger } from "./turn-ledger.ts";
import { DEFAULT_TURN_PLAN, turnHandlingFor } from "./turn-plans.ts";

/**
 * A lesson to run when nothing real dispatched one — every field here is fake and none of it ships.
 * The Phase 1 manual walkthrough is supposed to run against the REAL prompt (task plan: "fed the
 * real prompt and a real item list shaped like dispatch metadata"), which this is not: it exists so
 * `tsx src/agent.ts dev` has something to say before you've generated a real fixture.
 *
 * To test against the real `words-4.0` prompt instead, from `apps/web/`:
 *   pnpm dispatch:fixture > ../voice-worker/.local/dispatch.json
 * then run the worker with `DISPATCH_METADATA_FILE=.local/dispatch.json`. See
 * `apps/web/scripts/livekit-dispatch-fixture.ts` for what it builds and why it has to live there
 * (only `apps/web` may import the prompt registry).
 */
const DEV_FALLBACK_METADATA: LiveKitDispatchMetadata = {
  conversationId: "dev-console",
  version: "dev-fixture",
  instructions:
    "You are testing a new voice pipeline, not teaching a real lesson. Greet the tester in one " +
    "sentence, mention that this is the LiveKit spike's Phase 1 fallback fixture (not the real " +
    "words-4.0 prompt), then ask what they'd like to try — a pause, a Russian phrase, or a normal " +
    "back-and-forth. Keep every reply to two or three sentences.",
};

/**
 * Was this job DISPATCHED for a real lesson, or is it a console run against a fixture?
 *
 * The distinction decides who opens the lesson. A dispatched job has a phone in the room whose
 * session sends the kickoff itself; a console run has nobody, so the worker must. Read from the
 * job's own metadata rather than from who is in the room, because participants arrive on their own
 * schedule and "is anyone here yet" is a race where this is a fact.
 */
function isDispatched(jobMetadata: string): boolean {
  return jobMetadata.length > 0;
}

function loadDispatchMetadata(jobMetadata: string): LiveKitDispatchMetadata {
  if (jobMetadata) return JSON.parse(jobMetadata) as LiveKitDispatchMetadata;
  const fixturePath = process.env.DISPATCH_METADATA_FILE;
  if (fixturePath) return JSON.parse(readFileSync(fixturePath, "utf8")) as LiveKitDispatchMetadata;
  return DEV_FALLBACK_METADATA;
}

/**
 * Phase 2's ledger sink: one JSON line per turn in `.local/ledger/<conversationId>.jsonl`
 * (gitignored), plus a one-line summary on stdout. Phase 3 replaces this with batched POSTs to
 * `/api/v2/livekit/session-end`. The record shape stays the same.
 */
function ledgerSink(conversationId: string): (record: TurnRecord) => void {
  const dir = fileURLToPath(new URL("../.local/ledger/", import.meta.url));
  mkdirSync(dir, { recursive: true });
  const file = `${dir}${conversationId}.jsonl`;
  return (record) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
    console.log(
      `[ledger] #${record.seq} e2e=${record.e2eLatencyMs}ms eot=${record.endOfTurnDelayMs}ms ` +
        `ttft=${record.llmTtftMs}ms ttfb=${record.ttsTtfbMs}ms in=${record.inputTokens} ` +
        `cacheRead=${record.cacheReadTokens} cacheWrite=${record.cacheWriteTokens} out=${record.outputTokens}` +
        (record.preemptiveAttempts ? ` preemptive=${record.preemptiveAttempts}` : "") +
        (record.interrupted ? " interrupted" : "") +
        (record.errors.length ? ` errors=${record.errors.join(",")}` : ""),
    );
  };
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    await ctx.connect();
    const metadata = loadDispatchMetadata(ctx.job.metadata);
    const dispatched = isDispatched(ctx.job.metadata);
    const model = metadata.llm ?? DEFAULT_MODEL;
    const startedAtMs = Date.now();

    /**
     * Null in a console run, which is the whole difference between "a lesson" and "a walkthrough":
     * no grant and no `API_BASE_URL` means nothing is written to the backend, the ledger stays in
     * `.local/`, and the tutor is not given a tool that could not work anyway.
     */
    const backend = Backend.from(metadata.grant);
    const transcript: TranscriptLine[] = [];
    const pendingTurns: TurnRecord[] = [];
    const localLedger = ledgerSink(metadata.conversationId);

    const ledger = new TurnLedger({
      model,
      startedAtMs,
      onRecord: (record) => {
        localLedger(record);
        if (!backend) return;
        pendingTurns.push(record);
        if (pendingTurns.length >= LEDGER_BATCH_SIZE) {
          // Fire and forget, and the array is drained BEFORE the await so a turn recorded while
          // this is in flight joins the next batch rather than this one twice.
          void backend.postLedgerBatch(pendingTurns.splice(0, pendingTurns.length));
        }
      },
    });

    const agent = new voice.Agent({
      instructions: metadata.instructions,
      llm: new ClaudeLLM({ model, onCompletion: (id, text) => ledger.completion(id, text) }),
      tools: backend ? { add_words_to_collection: saveWordsTool(backend) } : {},
    });
    const session = new voice.AgentSession({
      stt: createStt(),
      tts: createTts(metadata.voice),
      turnHandling: turnHandlingFor(metadata.turnPlan),
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, ({ metrics }) => {
      if (metrics.type !== "llm_metrics") return;
      ledger.llmCall({
        requestId: metrics.requestId,
        cancelled: metrics.cancelled,
        ttftMs: metrics.ttftMs,
        promptTokens: metrics.promptTokens,
        promptCachedTokens: metrics.promptCachedTokens,
        cacheCreationTokens: metrics.cacheCreationTokens,
        completionTokens: metrics.completionTokens,
        model: metrics.metadata?.modelName,
      });
    });
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
      if (item.type !== "message" || (item.role !== "user" && item.role !== "assistant")) return;
      const text = item.textContent ?? "";
      ledger.message({
        role: item.role,
        text,
        interrupted: item.interrupted,
        createdAtMs: item.createdAt,
        metrics: item.metrics,
      });
      /**
       * The transcript the session-end route stores. Built from the same committed items the ledger
       * sees, so the two cannot disagree about what was said — and `timeInCallSecs` uses the ledger's
       * own clock, which is what makes a stored line line up with the turn that produced it.
       */
      if (text) {
        transcript.push({
          role: item.role === "assistant" ? "agent" : "user",
          text,
          timeInCallSecs: Math.round((item.createdAt - startedAtMs) / 1000),
        });
      }
    });
    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, ({ functionCalls }) => {
      ledger.toolsExecuted(functionCalls.map((c) => c.name));
    });
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, ({ resumed }) => {
      ledger.falseInterruption(resumed);
    });
    session.on(voice.AgentSessionEventTypes.Error, ({ error }) => {
      // The interruption detector's error IS the Error; every other kind wraps one in `.error`.
      const cause = error instanceof Error ? error : error.error;
      ledger.error(`${error.type.replace(/_error$/, "")}:${cause.name}${error.recoverable ? "" : " (fatal)"}`);
    });

    /**
     * The phone's controls, registered BEFORE the session starts.
     *
     * `say` and `cancelTurn` arrive as RPC; `context` cannot, because a 20-turn Cyrillic resume
     * lands on the 15 KiB RPC ceiling (research doc §2 Q6), so it arrives as a text stream. The
     * names come from the wire contract — three processes have to agree on them.
     */
    ctx.room.localParticipant?.registerRpcMethod(LIVEKIT_RPC.SAY, async (data) => {
      const { text } = decodeWireMessage(data.payload);
      session.generateReply({ userInput: text });
      return "";
    });
    ctx.room.localParticipant?.registerRpcMethod(LIVEKIT_RPC.CANCEL_TURN, async () => {
      session.interrupt();
      return "";
    });
    ctx.room.registerTextStreamHandler(LIVEKIT_STREAM.CONTEXT, (reader) => {
      void (async () => {
        const text = (await reader.readAll()).trim();
        if (!text) return;
        /**
         * Added as a `system` item, which the request builder turns into a `[lesson app] …`
         * USER-role marker rather than a system directive (`claude-request.ts`). And no reply is
         * generated: a context note tells the tutor what happened, it does not ask it to speak.
         */
        const chatCtx = agent.chatCtx.copy();
        chatCtx.addMessage({ role: "system", content: text });
        await agent.updateChatCtx(chatCtx);
      })();
    });

    await session.start({ agent, room: ctx.room });
    console.log(
      `[worker] lesson ${metadata.conversationId} (${metadata.version}) on ${model}, ` +
        `turn plan ${metadata.turnPlan ?? `${DEFAULT_TURN_PLAN} (default)`}` +
        (backend ? "" : " — no grant, writing nothing back"),
    );

    /**
     * `tutor.ready`, and the lesson does not exist for the phone until this lands: its adapter
     * announces `connected` from this RPC and from nothing else, because a room can be connected
     * with no tutor in it. Sent to whoever is in the room that is not another agent.
     */
    const listeners = [...ctx.room.remoteParticipants.values()].filter(
      (p) => p.kind !== ParticipantKind.AGENT,
    );
    for (const p of listeners) {
      void ctx.room.localParticipant
        ?.performRpc({ destinationIdentity: p.identity, method: LIVEKIT_LIFECYCLE.READY, payload: "" })
        .catch((e: unknown) => console.error(`[worker] tutor.ready → ${String(e)}`));
    }

    /**
     * **The worker opens the lesson only when nobody else will.** A dispatched lesson has a phone
     * in it, and that phone's session sends the kickoff itself the instant it sees `connected`
     * (`opensUnprompted: false`). Doing it here as well would start the lesson twice — two opening
     * monologues over each other. A console run has no phone, so this is the only kickoff there is.
     */
    if (!dispatched) session.generateReply({ userInput: KICKOFF_MESSAGE });

    /**
     * The final write, and the signal that separates a goodbye from a crash. `tutor.ending` is what
     * tells the phone this was a clean end: its ABSENCE before the agent leaves is what the adapter
     * reads as `onEnd("error")`, so it must be sent before the room is left, never after.
     */
    ctx.addShutdownCallback(async () => {
      for (const p of listeners) {
        await ctx.room.localParticipant
          ?.performRpc({
            destinationIdentity: p.identity,
            method: LIVEKIT_LIFECYCLE.ENDING,
            payload: "",
          })
          .catch(() => {
            // The phone may already be gone — that is the learner hanging up, not a failure.
          });
      }
      if (!backend) return;
      await backend.postSessionEnd({
        turns: pendingTurns.splice(0, pendingTurns.length),
        lines: transcript,
        version: metadata.version,
        durationSecs: Math.round((Date.now() - startedAtMs) / 1000),
      });
    });
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: LIVEKIT_AGENT_NAME }));
}
