/** The phone↔worker wire contract for the LiveKit provider: RPC method and text-stream topic
 *  names, payload codecs with size guards, dispatch metadata, and the per-turn ledger shape.
 *
 *  Pure — no LiveKit SDK, no npm package. Both the phone (`apps/mobile/src/lib/transport/livekit.ts`,
 *  Phase 3) and the worker (`apps/voice-worker/`) compile against this module; it is the contract
 *  between them, not a client for either. See
 *  docs/2026-09-11-livekit-claude-diy-provider.md §1, §2 Q6, §3.2, §5.2 and
 *  docs/2026-09-20-livekit-spike-task-plan.md Phase 1.
 */
import type { TutorCapabilities } from "./transport";

/**
 * The worker's LiveKit agent name. Three things must agree on it byte-for-byte: the worker's
 * `ServerOptions.agentName`, `apps/voice-worker/livekit.toml`, and the token route's
 * `RoomAgentDispatch.agentName` (Phase 3). One constant here instead of three hand-typed strings
 * (research doc §10.1). Setting an agent name turns off automatic dispatch, so a room only gets a
 * tutor when the token route asks for one by this name.
 */
export const LIVEKIT_AGENT_NAME = "tutor";

/**
 * RPC methods the phone calls on the worker's agent participant.
 *
 * Both map to a `TutorTransportControls` method (`say`, `cancelTurn`) — see the Q6 table. Neither
 * carries a payload large enough to risk the 15 KiB cap on its own; `context()` does, which is why
 * it is a stream topic instead (`LIVEKIT_STREAM` below).
 */
export const LIVEKIT_RPC = {
  SAY: "tutor.say",
  CANCEL_TURN: "tutor.cancel",
} as const;
export type LiveKitRpcMethod = (typeof LIVEKIT_RPC)[keyof typeof LIVEKIT_RPC];

/**
 * Text-stream topics. `CONTEXT` carries `context()` — never RPC, because `formatResumeContext`
 * keeps 20 turns × 400 chars (`./session.ts`) and Cyrillic is 2 bytes/char in UTF-8, so a resume
 * can reach ~16 KB and overflow `RPC_PAYLOAD_MAX_BYTES`. Text streams have no size limit.
 */
export const LIVEKIT_STREAM = {
  CONTEXT: "tutor.context",
  /**
   * **LiveKit's own topic, not ours** — the only name in this module we did not choose. The agents
   * framework publishes committed learner and tutor lines on it, so the phone subscribes rather
   * than the worker forwarding them a second time. Named here so the adapter reads a constant
   * beside the ones it does own, and so the day LiveKit renames it is a one-line change.
   *
   * Segments arrive interim-then-final; only `lk.transcription_final` ones are turns.
   */
  TRANSCRIPTION: "lk.transcription",
} as const;
export type LiveKitStreamTopic = (typeof LIVEKIT_STREAM)[keyof typeof LIVEKIT_STREAM];

/**
 * Lifecycle signals the worker sends, outside the RPC/stream pair above.
 *
 * `READY` answers the race every provider has hit first (Q6): `connected` fires only once the
 * agent participant has joined AND reported ready, whether that is this RPC or a participant
 * attribute — Phase 3 decides which. `ENDING` is what turns a worker crash into `onEnd("error")`:
 * its ABSENCE before the agent leaves the room is the signal, not its presence.
 */
export const LIVEKIT_LIFECYCLE = {
  READY: "tutor.ready",
  ENDING: "tutor.ending",
} as const;

/**
 * LiveKit RPC payloads are capped at 15 KiB (research doc §2 Q6). This is the routing decision
 * that keeps `context()` off RPC — see `channelForBytes`.
 */
export const RPC_PAYLOAD_MAX_BYTES = 15 * 1024;

export type WireChannel = "rpc" | "stream";

/** Which channel a payload of this exact byte size must travel over. */
export function channelForBytes(byteLength: number): WireChannel {
  return byteLength > RPC_PAYLOAD_MAX_BYTES ? "stream" : "rpc";
}

/**
 * Exact UTF-8 byte length of a string, WITHOUT `TextEncoder` — deliberately, matching
 * `debug/report.ts`'s `sizeOf` precedent for the same reason (this module ships to the phone too,
 * and cannot assume the polyfill). Unlike that cap, this one is not a generous soft bound: routing
 * a 16 KB Cyrillic resume onto RPC because a `.length` proxy under-counted it 2× is exactly the bug
 * this module exists to prevent, so the count here is exact, not approximate.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) continue;
    if (code > 0xffff) i++; // consumed a low surrogate too
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Which channel this text must travel over, right now, given its actual UTF-8 size. */
export function channelForText(text: string): WireChannel {
  return channelForBytes(utf8ByteLength(text));
}

/** A single text payload sent over an RPC or a stream — `say()`'s kickoff/resume message, or
 *  `context()`'s note. One envelope for both, since both are "some text the worker should act on". */
export interface TutorWireMessage {
  text: string;
}

export function encodeWireMessage(msg: TutorWireMessage): string {
  return JSON.stringify(msg);
}

/** Throws on structurally invalid input — the caller is this repo's own two ends of the wire, not
 *  an untrusted network boundary, so a throw (not a null return) is the right failure mode: a
 *  malformed payload here is a bug in the sender, and the caller should not be able to ignore it. */
export function decodeWireMessage(raw: string): TutorWireMessage {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).text !== "string"
  ) {
    throw new Error(`decodeWireMessage: not a TutorWireMessage: ${raw.slice(0, 100)}`);
  }
  return { text: (parsed as { text: string }).text };
}

/**
 * The capability set every LiveKit lesson runs with (research doc §2 Q6's closing paragraph).
 * Exported so a check can instantiate `createFakeTransport({capabilities: LIVEKIT_CAPABILITIES})`
 * and exercise the held-pause cross-product against the exact combination this provider ships,
 * rather than only the generic sweep over every possible combination.
 */
export const LIVEKIT_CAPABILITIES: TutorCapabilities = {
  silenceOutput: true,
  userActivity: false,
  cancelTurn: true,
  responseCorrection: false,
  opensUnprompted: false,
};

/**
 * What the token route puts in LiveKit's dispatch metadata (`RoomAgentDispatch.metadata`), and what
 * the worker reads to build its session — the shape named in research doc §1. The worker is
 * prompt-agnostic and never imports `apps/web`, so this is the only place "what a lesson is" crosses
 * from the backend to the worker process.
 *
 * `turnPlan`, `voice` and `grant` are Phase 2/3 concerns (turn-taking presets, TTS choice, the
 * per-lesson MCP write grant — open question 1 in the task plan). Phase 1 is text-only against a
 * fixture, not a real token route, so they are optional here rather than added later as a breaking
 * change.
 */
export interface LiveKitDispatchMetadata {
  conversationId: string;
  version: string;
  /** `config.prompt.replaceAll("{{items_list}}", formatItemsList(items))` — built server-side. */
  instructions: string;
  llm?: string;
  turnPlan?: "patient" | "normal" | "eager";
  voice?: string;
  /** HMAC grant over `{conversationId, ownerId, exp}` — undesigned (open question 1). Absent in
   *  Phase 1, which skips `add_words_to_collection` entirely rather than exercise the old
   *  `ANONYMOUS` path. */
  grant?: string;
}

/**
 * One record per completed turn (research doc §5.2), built from LiveKit's per-message metrics and
 * the Claude adapter's own usage reporting. Posted in batches during the lesson and in full at the
 * end, to `/api/v2/livekit/session-end` (Phase 3) — this module only names the shape both ends agree
 * on, since the worker never imports the route that stores it.
 */
export interface TurnRecord {
  seq: number;
  /** Same clock as `TranscriptLine.timeInCallSecs`. */
  atSecs: number;
  userText: string;
  /** What Claude generated. */
  agentText: string;
  /** What actually played before any barge-in. */
  agentHeardText: string;
  interrupted: boolean;
  falseInterruptionResumed: boolean;
  // latency, ms
  endOfTurnDelayMs: number;
  transcriptionDelayMs: number;
  llmTtftMs: number;
  ttsTtfbMs: number;
  /** Learner stopped → first tutor audio. */
  e2eLatencyMs: number;
  // Claude
  model: string;
  /** Billed requests thrown away by preemptive generation. */
  preemptiveAttempts: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  toolCalls: string[];
  /** e.g. "llm:400 prefill", "stt:reconnect", "tts:timeout". */
  errors: string[];
}
