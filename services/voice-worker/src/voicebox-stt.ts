/**
 * Voicebox (our custom build `0.6.0-custom.1`, on the same Mac) as a LiveKit `stt.STT`: streaming
 * speech-to-text over `WS /stt/ws`. A Node port of the Python plugin `voicebox_livekit.VoiceboxSTT`
 * (voicebox repo, branch `custom/main`, `integrations/livekit/voicebox_livekit/stt.py`); research and
 * the differences: docs/2026-10-30-livekit-voicebox-plugins-node.md.
 *
 * One stream is one socket: `start` → `ready`, then PCM16 little-endian mono 16 kHz as binary frames.
 * The server's own VAD opens and closes segments and answers per segment with `speech_start`,
 * `interim` (the full segment text so far, never a delta), `final` and `speech_end`. They map to the
 * framework's START_OF_SPEECH, INTERIM_TRANSCRIPT, FINAL_TRANSCRIPT and END_OF_SPEECH.
 *
 * The one thing the Python plugin does that this one cannot: there, the session's VAD flushes the
 * stream at the end of speech (`manual_flush=True`) and the plugin closes the segment at once with
 * `end_segment`. `@livekit/agents` 1.9.1 for Node never flushes an STT stream, so the server VAD
 * decides alone (500 ms of silence), and `final` lands that long plus one decode after the learner
 * stops. A flush from any other caller still goes out as `end_segment`.
 *
 * Reachable only from a worker on the Mac: the tunnel's API-key gate lets `/tts/*` through and
 * nothing else, so a LiveKit Cloud worker gets 403 here even with a key.
 *
 * Every stream logs `[voicebox stt …]` lines to the worker's stdout: segment counts and timing,
 * never the learner's words.
 */
import { randomUUID } from "node:crypto";
import {
  type APIConnectOptions,
  APIConnectionError,
  APIStatusError,
  APITimeoutError,
  type AudioBuffer,
  mergeFrames,
  stt,
} from "@livekit/agents";
import { AudioFrame, AudioResampler } from "@livekit/rtc-node";
import WebSocket from "ws";

/** The server works at 16 kHz; sending it that avoids a second resample there. */
const SAMPLE_RATE = 16000;
/**
 * How long `start` may wait for `ready`. The first stream after the app starts loads the model
 * (seconds, more for a large one); `prewarm()` pays that during the greeting instead.
 */
const READY_TIMEOUT_MS = 60_000;

export interface VoiceboxSttOptions {
  /** Server origin, e.g. `http://127.0.0.1:17493`. */
  url: string;
  /** Voicebox STT model, e.g. `qwen-asr-0.6B`. Absent = the default of the app's capture settings. */
  model?: string;
  /** ISO code. Absent = the model detects it per segment (learners answer in English and Russian). */
  language?: string;
  /** Ask for interim text; the server says in `ready` whether the model can make it. */
  interim: boolean;
  /** How often the server refreshes the interim text of the open segment. */
  interimIntervalMs: number;
  /** The server closes a segment this long even without a pause. */
  maxSegmentS: number;
  /** `voxtral-realtime-4B` only: a multiple of 80 from 80 to 1200, or 2400. Absent = server default. */
  delayMs?: number;
}

export const VOICEBOX_STT_DEFAULTS = {
  interim: true,
  interimIntervalMs: 500,
  maxSegmentS: 30,
} as const;

interface VoiceboxSttMessage {
  type?: string;
  message?: string;
  segment_id?: number;
  text?: string;
  language?: string | null;
  start_s?: number | null;
  end_s?: number | null;
  capabilities?: Record<string, unknown>;
}

function parse(data: WebSocket.RawData): VoiceboxSttMessage {
  try {
    return JSON.parse(data.toString()) as VoiceboxSttMessage;
  } catch {
    return {};
  }
}

const languageCode = (language: string | null | undefined) => (language ?? "") as stt.SpeechData["language"];

/** Mono 16-bit PCM as the bytes the server reads. Frames from the stream are already 16 kHz. */
function pcmBytes(frame: AudioFrame): Buffer {
  if (frame.channels === 1) return Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  const mono = new Int16Array(frame.samplesPerChannel);
  for (let i = 0; i < frame.samplesPerChannel; i += 1) {
    let sum = 0;
    for (let c = 0; c < frame.channels; c += 1) sum += frame.data[i * frame.channels + c]!;
    mono[i] = Math.round(sum / frame.channels);
  }
  return Buffer.from(mono.buffer);
}

/** Batch input can be at any rate; the stream's own frames are resampled by the framework. */
function to16k(frame: AudioFrame): AudioFrame {
  if (frame.sampleRate === SAMPLE_RATE) return frame;
  const resampler = new AudioResampler(frame.sampleRate, SAMPLE_RATE, frame.channels);
  try {
    return mergeFrames([...resampler.push(frame), ...resampler.flush()]);
  } finally {
    resampler.close();
  }
}

export class VoiceboxSTT extends stt.STT {
  label = "voicebox.STT";
  readonly opts: VoiceboxSttOptions;
  #serverCapabilities: Record<string, unknown> | undefined;

  constructor(opts: VoiceboxSttOptions) {
    // `interimResults` follows the server's `ready`, once the first stream has one.
    super({ streaming: true, interimResults: false });
    this.opts = { ...opts, url: opts.url.replace(/\/+$/, "") };
  }

  override get model(): string {
    return this.opts.model ?? "default";
  }

  override get provider(): string {
    return "voicebox";
  }

  /** The `capabilities` of the last `ready` (undefined before the first stream). */
  get serverCapabilities(): Record<string, unknown> | undefined {
    return this.#serverCapabilities;
  }

  startMessage({ vad = true }: { vad?: boolean } = {}): Record<string, unknown> {
    const { model, language, interim, interimIntervalMs, maxSegmentS, delayMs } = this.opts;
    return {
      type: "start",
      sample_rate: SAMPLE_RATE,
      vad,
      interim,
      interim_interval_ms: interimIntervalMs,
      max_segment_s: maxSegmentS,
      ...(model ? { model } : {}),
      ...(language ? { language } : {}),
      ...(delayMs !== undefined ? { delay_ms: delayMs } : {}),
    };
  }

  /**
   * A socket that has sent `start` and got `ready`. A server `error` instead of `ready` (unknown
   * model, model not downloaded, bad option) fails the same way on a retry, so it is not retryable.
   */
  async open(message: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<WebSocket> {
    const url = `${this.opts.url.replace(/^http/, "ws")}/stt/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const timeout = (ms: number, message: string) => setTimeout(() => fail(new APITimeoutError({ message })), ms);
      let timer = timeout(timeoutMs, `Voicebox STT: no connection within ${timeoutMs}ms`);
      const onAbort = () => fail(new APIConnectionError({ message: "Voicebox STT: aborted while connecting", options: { retryable: false } }));
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        ws.removeAllListeners();
        ws.on("error", () => undefined);
        ws.close();
        reject(error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      ws.on("error", (error) => fail(new APIConnectionError({ message: `Voicebox STT: cannot reach ${url} (${error.message})` })));
      // The upgrade was refused: 403 from the tunnel gate, or an app without /stt/ws (before 0.6.0).
      ws.once("unexpected-response", (_req, res) =>
        fail(
          new APIStatusError({
            message: `Voicebox STT WebSocket upgrade refused: HTTP ${res.statusCode}`,
            options: { statusCode: res.statusCode ?? 0, retryable: false },
          }),
        ),
      );
      ws.once("open", () => {
        clearTimeout(timer);
        timer = timeout(READY_TIMEOUT_MS, `Voicebox STT sent no ready within ${READY_TIMEOUT_MS}ms`);
        ws.send(JSON.stringify(message));
      });
      ws.once("close", (code) => fail(new APIConnectionError({ message: `Voicebox STT closed before ready (${code})` })));
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const reply = parse(data);
        if (reply.type === "ready") {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          ws.removeAllListeners();
          // A socket error with nobody listening must not crash the worker.
          ws.on("error", () => undefined);
          this.#onReady(reply);
          resolve(ws);
        } else if (reply.type === "error") {
          fail(
            new APIStatusError({
              message: `Voicebox STT refused start: ${reply.message}`,
              options: { statusCode: 400, retryable: false },
            }),
          );
        } else {
          fail(new APIConnectionError({ message: `Voicebox STT: expected ready, got ${reply.type}` }));
        }
      });
    });
  }

  #onReady(message: VoiceboxSttMessage): void {
    const caps = message.capabilities ?? {};
    this.#serverCapabilities = caps;
    this.updateCapabilities({ interimResults: Boolean(caps.interim_results) && this.opts.interim });
  }

  /**
   * Loads the model while the learner is still being greeted: one stream that only starts and ends.
   * A failure only logs; the first real stream then finds out for itself.
   */
  override prewarm(): void {
    const t0 = Date.now();
    this.open(this.startMessage(), 10_000)
      .then((ws) => {
        console.log(`[voicebox stt] warm: ${this.model} ready in ${Date.now() - t0}ms`);
        ws.send(JSON.stringify({ type: "end" }));
        ws.close();
      })
      .catch((error: unknown) => {
        console.log(`[voicebox stt] warmup failed after ${Date.now() - t0}ms: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  /** Batch: all the audio as one segment on the same socket, no server VAD, the finals joined. */
  protected async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
    const frame = to16k(mergeFrames(buffer));
    const ws = await this.open(this.startMessage({ vad: false }), 10_000, abortSignal);
    const texts: string[] = [];
    let detected: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => resolve();
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        const done = (error?: Error) => {
          abortSignal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const message = parse(data);
          if (message.type === "final") {
            if (message.text) texts.push(message.text);
            detected = message.language ?? detected;
          } else if (message.type === "error") {
            done(new APIStatusError({ message: `Voicebox STT: ${message.message}`, options: { statusCode: 500, retryable: false } }));
          } else if (message.type === "end") {
            done();
          }
        });
        ws.once("close", () => done());
        ws.send(pcmBytes(frame));
        ws.send(JSON.stringify({ type: "end" }));
      });
    } finally {
      ws.close();
    }
    return {
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [
        {
          language: languageCode(detected ?? this.opts.language),
          text: texts.join(" "),
          startTime: 0,
          endTime: frame.samplesPerChannel / SAMPLE_RATE,
          confidence: 1,
        },
      ],
    };
  }

  stream(options?: { connOptions?: APIConnectOptions }): VoiceboxSpeechStream {
    return new VoiceboxSpeechStream(this, options?.connOptions);
  }
}

/**
 * One live recognition: audio frames out as binary, a framework flush as `end_segment`, the end of
 * input as `end`; the server's segment events back as speech events. A server `error` after `ready`
 * concerns one segment (a decode failed) and the stream stays open for the next one.
 */
export class VoiceboxSpeechStream extends stt.SpeechStream {
  label = "voicebox.SpeechStream";
  readonly #owner: VoiceboxSTT;
  #speaking = false;

  // No parameter properties: `node` strips types natively (`lk agent console`) and rejects them.
  constructor(owner: VoiceboxSTT, connOptions?: APIConnectOptions) {
    // The sample rate makes the base class resample every pushed frame to 16 kHz.
    super(owner, SAMPLE_RATE, connOptions);
    this.#owner = owner;
  }

  protected async run(): Promise<void> {
    const streamId = randomUUID().slice(0, 8);
    const log = (message: string) => console.log(`[voicebox stt ${streamId}] ${message}`);
    const t0 = Date.now();
    // Scoped to this attempt: a sender parked in `input.next()` would otherwise survive into a
    // retry and steal its frames (the same trap the Deepgram plugin documents).
    const attempt = new AbortController();
    const signal = AbortSignal.any([this.abortSignal, attempt.signal]);
    const ws = await this.#owner.open(this.#owner.startMessage(), 10_000, signal);
    log(`ready in ${Date.now() - t0}ms (${this.#owner.model}, interim ${this.#owner.capabilities.interimResults})`);
    // Server times count from the first sample sent on this socket; `startTimeOffset` is where that
    // socket starts in the framework's audio clock (it grows across retries).
    const offset = this.startTimeOffset;
    const wallStart = Date.now();
    let inputEnded = false;
    let segments = 0;
    let speechEndAt: number | undefined;
    let sender: Promise<void> = Promise.resolve();

    const speechData = (message: VoiceboxSttMessage): stt.SpeechData => ({
      language: languageCode(message.language ?? this.#owner.opts.language),
      text: message.text ?? "",
      startTime: (message.start_s ?? 0) + offset,
      endTime: (message.end_s ?? 0) + offset,
      confidence: 1,
    });
    const put = (event: stt.SpeechEvent) => {
      if (!this.queue.closed) this.queue.put(event);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          this.abortSignal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => finish();
        this.abortSignal.addEventListener("abort", onAbort, { once: true });

        ws.on("message", (data, isBinary) => {
          if (isBinary) return;
          const message = parse(data);
          const requestId = String(message.segment_id ?? "");
          switch (message.type) {
            case "speech_start":
              this.#speaking = true;
              put({ type: stt.SpeechEventType.START_OF_SPEECH, requestId });
              break;
            case "interim":
              if (message.text) put({ type: stt.SpeechEventType.INTERIM_TRANSCRIPT, requestId, alternatives: [speechData(message)] });
              break;
            case "final":
              segments += 1;
              log(
                `segment ${requestId}: final ${message.text?.length ?? 0} chars, lang=${message.language ?? "-"}` +
                  (speechEndAt === undefined ? "" : ` ${Date.now() - speechEndAt}ms after speech_end`),
              );
              if (message.text) put({ type: stt.SpeechEventType.FINAL_TRANSCRIPT, requestId, alternatives: [speechData(message)] });
              break;
            case "speech_end":
              speechEndAt = Date.now();
              if (this.#speaking) {
                this.#speaking = false;
                put({
                  type: stt.SpeechEventType.END_OF_SPEECH,
                  requestId,
                  ...(typeof message.end_s === "number" ? { speechEndTime: wallStart + message.end_s * 1000 } : {}),
                });
              }
              break;
            case "error":
              log(`server error on a segment (the stream goes on): ${message.message}`);
              break;
            case "end":
              finish();
              break;
            default:
              log(`unexpected message: ${data.toString().slice(0, 200)}`);
          }
        });
        ws.on("close", (code) => {
          if (inputEnded || this.abortSignal.aborted) finish();
          else finish(new APIConnectionError({ message: `Voicebox STT socket closed unexpectedly (${code})` }));
        });
        ws.on("error", (error) => finish(new APIConnectionError({ message: `Voicebox STT socket error: ${error.message}` })));

        sender = (async () => {
          const iterator = this.input[Symbol.asyncIterator]();
          while (true) {
            const next = await iterator.next({ signal: attempt.signal });
            if (next.done) break;
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (next.value === VoiceboxSpeechStream.FLUSH_SENTINEL) ws.send(JSON.stringify({ type: "end_segment" }));
            else ws.send(pcmBytes(next.value));
          }
          inputEnded = true;
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" }));
        })();
        sender.catch((error: unknown) => {
          if (!attempt.signal.aborted) finish(error instanceof Error ? error : new Error(String(error)));
        });
      });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${segments} segments`);
    } finally {
      attempt.abort();
      await sender.catch(() => undefined);
      // A stream that ends inside speech must not leave the session in "user speaking".
      if (this.#speaking) {
        this.#speaking = false;
        put({ type: stt.SpeechEventType.END_OF_SPEECH });
      }
      ws.close();
    }
  }
}
