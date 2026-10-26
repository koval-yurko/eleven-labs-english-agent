/**
 * Voicebox (a local Qwen3-TTS voice clone, our custom build `0.5.1-custom.1`) as a LiveKit
 * `tts.TTS`. Output is raw PCM16 little-endian, 24 kHz mono, sent as the model makes it. Two
 * transports (docs/2026-10-26-voicebox-tts-adapter-research.md in the Voice-Agent project):
 *
 * - `ws` (profile `voicebox`, phase 2): `{ streaming: true }`. A reply is ONE `WS /tts/ws` session: Claude's
 *   text goes out as it is written, the server starts each sentence as soon as it is complete, and
 *   audio comes back on the same socket. The protocol says a reply is over only with `end`, which
 *   also closes the socket, so a socket carries one reply. `qwen-socket-pool.ts` keeps the next one
 *   open and already `start`ed (2–6 ms locally; the TLS and upgrade through the tunnel are the cost
 *   it hides). Barge-in is `cancel` and a close: the server stops the sentence it is making.
 * - `http` (phase 1, no profile since 2026-10-26): `{ streaming: false }`, so the session wraps it in `tts.StreamAdapter`, which
 *   cuts the reply into sentences and calls `synthesize()` once per sentence: one `POST /tts/stream`.
 *
 * The server synthesizes ONE request at a time (one GPU lock), and the StreamAdapter starts every
 * sentence of a reply at once. Left alone, a long reply would park ~100 requests on that lock, and
 * when the learner talks over the tutor the 0.5.1-custom.1 server still runs each aborted one up to
 * its first chunk: 4 of them pushed the next reply's first audio from 0.32 s to 1.56 s (measured
 * 2026-10-26; the voicebox branch now skips them, but an installed app may predate that). So at most
 * `MAX_IN_FLIGHT` requests are open: the one playing and the next one, already queued on the server.
 * The rest wait here, and an aborted sentence leaves without the server ever seeing it.
 *
 * The server must be reachable from the worker: a local worker (`pnpm --filter voice-worker dev`)
 * reaches `127.0.0.1:17493`; a LiveKit Cloud worker needs the Cloudflare tunnel URL and an API key.
 *
 * Every reply (ws) or sentence (http) logs a `[voicebox …]` line to the worker's stdout.
 */
import { randomUUID } from "node:crypto";
import { type APIConnectOptions, APIConnectionError, APIStatusError, AudioByteStream, tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import WebSocket from "ws";
import { Gate } from "./gate.ts";
import { SocketPool, type TakenSocket } from "./qwen-socket-pool.ts";

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
/** The sentence playing plus the next one, queued on the server so it starts the moment the first ends. */
const MAX_IN_FLIGHT = 2;
/**
 * How long a request may wait for its first audio. It includes the wait on the server's lock behind
 * the sentence before it (a 250-character sentence is ~15 s of audio at RTF ~0.85).
 */
const FIRST_AUDIO_TIMEOUT_MS = 60_000;
/** Cloudflare closes a WebSocket idle for ~100 s; a parked one is retired before that. */
const IDLE_SOCKET_MS = 60_000;

export type VoiceboxTransport = "ws" | "http";

export interface VoiceboxTtsOptions {
  /** Server origin, e.g. `http://127.0.0.1:17493` or the tunnel's `https://tts.<domain>`. */
  url: string;
  /** Voicebox voice profile id. */
  profileId: string;
  /** Sent as `Authorization: Bearer …`; only the tunnel needs it, local requests do not. */
  apiKey?: string;
  language: string;
  /** `1.7B` or `0.6B` (the second must be downloaded in Voicebox first). */
  modelSize: string;
  /** Audio per model chunk; smaller means earlier first audio and more decoder calls. */
  intervalMs: number;
  /** `ws`: one socket per reply, text streamed in. `http`: one request per sentence. */
  transport: VoiceboxTransport;
}

export class VoiceboxTTS extends tts.TTS {
  label = "voicebox.TTS";
  readonly opts: VoiceboxTtsOptions;
  readonly gate = new Gate(MAX_IN_FLIGHT);
  readonly pool: SocketPool;

  constructor(opts: VoiceboxTtsOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: opts.transport === "ws" });
    this.opts = { ...opts, url: opts.url.replace(/\/+$/, "") };
    this.pool = new SocketPool(() => this.#openSocket(), IDLE_SOCKET_MS, (m) => console.log(`[voicebox pool] ${m}`));
  }

  override get model(): string {
    return `qwen3-tts-${this.opts.modelSize}`;
  }

  override get provider(): string {
    return "voicebox";
  }

  headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
    };
  }

  /**
   * Loads the model and runs one short generation while the learner is still being greeted. A cold
   * model takes ~35 s; without this the first reply pays it. A failure only logs: the first reply
   * then finds out for itself.
   */
  warm(): void {
    if (this.opts.transport === "ws") this.pool.warm();
    const t0 = Date.now();
    const { url, profileId, language, modelSize } = this.opts;
    fetch(`${url}/tts/warmup`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ profile_id: profileId, language, model_size: modelSize }),
    })
      .then(async (res) => {
        const body = res.ok ? "" : ` ${(await res.text()).slice(0, 200)}`;
        console.log(`[voicebox] warmup HTTP ${res.status} in ${Date.now() - t0}ms${body}`);
      })
      .catch((error: unknown) => {
        console.log(`[voicebox] warmup failed after ${Date.now() - t0}ms: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new VoiceboxChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    if (this.opts.transport !== "ws") {
      throw new Error("VoiceboxTTS over http does not stream text in; the session wraps it in tts.StreamAdapter");
    }
    return new VoiceboxSynthesizeStream(this, options?.connOptions);
  }

  override async close(): Promise<void> {
    this.pool.closeAll();
    await super.close();
  }

  /** A socket that has sent `start` and got `ready`: the voice is built, the next text speaks at once. */
  #openSocket(): Promise<WebSocket> {
    const { url, apiKey, profileId, language, modelSize, intervalMs } = this.opts;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${url.replace(/^http/, "ws")}/tts/ws`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
      // A parked socket can error with nobody listening; that must not crash the worker.
      ws.on("error", () => undefined);
      // `start` waits for the GPU lock, so behind a long sentence it can take that sentence's time.
      const timer = setTimeout(() => fail(new Error(`no ready within ${FIRST_AUDIO_TIMEOUT_MS}ms`)), FIRST_AUDIO_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.close();
        reject(error);
      };
      const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        const message = parse(data);
        if (message.type === "ready") {
          if (message.sample_rate !== SAMPLE_RATE || message.channels !== NUM_CHANNELS) {
            fail(new Error(`Voicebox sends ${message.sample_rate} Hz / ${message.channels} ch; this adapter plays ${SAMPLE_RATE} Hz mono`));
            return;
          }
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(ws);
        } else if (message.type === "error") {
          fail(new Error(`Voicebox refused start: ${message.message}`));
        }
      };
      ws.on("message", onMessage);
      ws.once("open", () =>
        ws.send(JSON.stringify({ type: "start", profile_id: profileId, language, model_size: modelSize, interval_ms: intervalMs })),
      );
      ws.once("error", (error) => fail(error));
      // The upgrade was refused (bad key: 403): ws reports a bare status unless it is named here.
      ws.once("unexpected-response", (_req, res) => fail(new Error(`Voicebox WebSocket upgrade refused: HTTP ${res.statusCode}`)));
    });
  }
}

interface VoiceboxMessage {
  type?: string;
  message?: string;
  sample_rate?: number;
  channels?: number;
  first_chunk_ms?: number;
}

function parse(data: WebSocket.RawData): VoiceboxMessage {
  try {
    return JSON.parse(data.toString()) as VoiceboxMessage;
  } catch {
    return {};
  }
}

function toArrayBuffer(data: WebSocket.RawData | Uint8Array): ArrayBuffer {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * A reply as ONE `/tts/ws` session on a socket that already sent `start`: each piece of Claude's
 * text goes out as `text` as it arrives, a framework flush as `flush`, the end of input as `end`.
 * The server answers with `segment_start`, PCM frames and `segment_end` per sentence, then `end`.
 *
 * A server `error` concerns one sentence: the server restarts its worker and goes on with the queued
 * ones, so the reply goes on too. A reply that ends with no audio at all is caught by `speech-watch.ts`.
 */
class VoiceboxSynthesizeStream extends tts.SynthesizeStream {
  label = "voicebox.SynthesizeStream";
  readonly #owner: VoiceboxTTS;

  // No parameter properties: `node` strips types natively (`lk agent console`) and rejects them.
  constructor(owner: VoiceboxTTS, connOptions?: APIConnectOptions) {
    super(owner, connOptions);
    this.#owner = owner;
  }

  protected async run(): Promise<void> {
    const { pool } = this.#owner;
    const signal = this.abortController.signal;
    const streamId = randomUUID().slice(0, 8);
    const log = (message: string) => console.log(`[voicebox stream ${streamId}] ${message}`);
    const t0 = Date.now();
    const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    // One frame is held back so the last one can be marked `final` once `end` arrives.
    let held: AudioFrame | undefined;
    const emit = (frame: AudioFrame) => {
      if (held && !this.queue.closed) this.queue.put({ requestId: streamId, segmentId: streamId, frame: held, final: false });
      held = frame;
    };
    let bytes = 0;
    let firstAudioMs: number | null = null;
    let sentChars = 0;
    let segments = 0;
    const serverFirstChunks: number[] = [];
    const errors: string[] = [];
    let socketNote = "";
    let pump: Promise<void> = Promise.resolve();

    try {
      let taken: TakenSocket | undefined;
      // A parked socket the server already closed is replaced at once, twice at most.
      for (let tries = 0; ; tries += 1) {
        const opened = Date.now();
        taken = await pool.take();
        if (taken.ws.readyState === WebSocket.OPEN) {
          socketNote = taken.reused
            ? `warm socket (idle ${(taken.idleMs / 1000).toFixed(1)}s)`
            : `fresh socket (${Date.now() - opened}ms to open)`;
          break;
        }
        pool.discard(taken.ws);
        if (tries >= 2) throw new Error("every Voicebox socket was closed before use");
      }
      const ws = taken.ws;
      if (signal.aborted) {
        pool.discard(ws);
        return;
      }

      await new Promise<void>((resolve, reject) => {
        let done = false;
        let cancelling = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", onAbort);
          ws.off("message", onMessage);
          ws.off("close", onClose);
          ws.off("error", onError);
          pool.discard(ws); // `end` closes the socket anyway: one reply per socket
          if (error) reject(error);
          else resolve();
        };
        const send = (payload: object) => {
          if (!done && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
        };
        const onAbort = () => {
          log(
            `cancelled by the framework after ${since()} (barge-in or teardown): firstAudio=${firstAudioMs ?? "-"}ms ` +
              `${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s audio, ${segments} sentences started — ${socketNote}`,
          );
          cancelling = true;
          // `cancel` stops the sentence being made; the close that follows ends the session.
          send({ type: "cancel" });
          finish();
        };
        const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            if (cancelling) return;
            const buf = toArrayBuffer(data);
            bytes += buf.byteLength;
            firstAudioMs ??= Date.now() - t0;
            for (const frame of bstream.write(buf)) emit(frame);
            return;
          }
          const message = parse(data);
          switch (message.type) {
            case "segment_start":
              segments += 1;
              break;
            case "segment_end":
              if (typeof message.first_chunk_ms === "number") serverFirstChunks.push(message.first_chunk_ms);
              break;
            case "end":
              for (const frame of bstream.flush()) emit(frame);
              finish();
              break;
            case "error":
              errors.push(String(message.message));
              log(`server error on a sentence (the rest goes on): ${message.message}`);
              break;
            default:
              log(`unexpected message: ${data.toString().slice(0, 200)}`);
          }
        };
        const onClose = (code: number, reason: Buffer) => {
          log(`socket closed before end: code=${code} reason=${JSON.stringify(reason.toString())}`);
          finish(new Error(`Voicebox socket closed early (${code}) ${reason.toString()}`.trim()));
        };
        const onError = (error: Error) => {
          log(`socket error: ${error.message}`);
          finish(error);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
        pump = (async () => {
          for await (const data of this.input) {
            if (done) continue; // drain, so the framework's input side is never left blocked
            if (data === tts.SynthesizeStream.FLUSH_SENTINEL) {
              send({ type: "flush" });
              continue;
            }
            this.markStarted();
            send({ type: "text", text: data });
            sentChars += data.length;
          }
          send({ type: "end" });
        })();
        pump.catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
      });

      if (signal.aborted) return;
      if (held) this.queue.put({ requestId: streamId, segmentId: streamId, frame: held, final: true });
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
      log(
        `done in ${since()} firstAudio=${firstAudioMs ?? "-"}ms serverFirstChunk=${JSON.stringify(serverFirstChunks)} ` +
          `audio=${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s chars=${sentChars} sentences=${segments} — ${socketNote}` +
          (errors.length ? ` errors=${errors.length}` : "") +
          (bytes === 0 && sentChars > 0 ? " — FINISHED WITH NO AUDIO" : ""),
      );
    } catch (error) {
      log(
        `FAILED after ${since()} firstAudio=${firstAudioMs ?? "-"}ms bytes=${bytes} chars=${sentChars}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
        options: { retryable: false },
      });
    } finally {
      await pump.catch(() => undefined);
    }
  }
}

/** One sentence: one `POST /tts/stream`, its PCM body cut into frames as it arrives. */
class VoiceboxChunkedStream extends tts.ChunkedStream {
  label = "voicebox.ChunkedStream";
  readonly #owner: VoiceboxTTS;

  // No parameter properties: `node` strips types natively (`lk agent console`) and rejects them.
  constructor(owner: VoiceboxTTS, text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, owner, connOptions, abortSignal);
    this.#owner = owner;
  }

  protected async run(): Promise<void> {
    const { opts, gate } = this.#owner;
    const signal = this.abortSignal;
    const requestId = randomUUID().slice(0, 8);
    const text = this.inputText;
    const log = (message: string) => console.log(`[voicebox ${requestId}] ${message}`);
    const t0 = Date.now();

    if (!(await gate.acquire(signal))) return; // talked over while still in line: never sent
    const waitedMs = Date.now() - t0;
    const sent = Date.now();
    let bytes = 0;
    let firstAudioMs: number | null = null;
    let serverFirstChunk = "-";
    // Times out the wait for the first audio only; once audio flows, the sentence may take as long as it lasts.
    const firstAudio = new AbortController();
    const timer = setTimeout(() => firstAudio.abort(), FIRST_AUDIO_TIMEOUT_MS);
    try {
      const res = await fetch(`${opts.url}/tts/stream`, {
        method: "POST",
        headers: this.#owner.headers(),
        body: JSON.stringify({
          profile_id: opts.profileId,
          text,
          language: opts.language,
          model_size: opts.modelSize,
          interval_ms: opts.intervalMs,
          format: "pcm",
        }),
        signal: AbortSignal.any([signal, firstAudio.signal]),
      });
      serverFirstChunk = res.headers.get("x-first-chunk-ms") ?? "-";
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new APIStatusError({
          message: `Voicebox /tts/stream HTTP ${res.status}: ${body}`,
          // 4xx is a bad profile, engine or key: the same request fails again. 5xx may not.
          options: { statusCode: res.status, retryable: res.status >= 500 },
        });
      }
      const rate = Number(res.headers.get("x-sample-rate") ?? SAMPLE_RATE);
      if (rate !== SAMPLE_RATE || res.headers.get("x-channels") !== String(NUM_CHANNELS)) {
        throw new APIConnectionError({
          message: `Voicebox sent ${rate} Hz / ${res.headers.get("x-channels")} ch; this adapter plays ${SAMPLE_RATE} Hz mono`,
          options: { retryable: false },
        });
      }
      if (!res.body) throw new APIConnectionError({ message: "Voicebox /tts/stream returned no body" });

      const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
      // One frame is held back so the last one can be marked `final`.
      let held: AudioFrame | undefined;
      const emit = (frame: AudioFrame) => {
        if (held) this.queue.put({ requestId, segmentId: requestId, frame: held, final: false });
        held = frame;
      };
      for await (const chunk of res.body) {
        if (firstAudioMs === null) {
          firstAudioMs = Date.now() - sent;
          clearTimeout(timer);
        }
        bytes += chunk.byteLength;
        for (const frame of bstream.write(toArrayBuffer(chunk))) emit(frame);
      }
      for (const frame of bstream.flush()) emit(frame);
      if (held) this.queue.put({ requestId, segmentId: requestId, frame: held, final: true });
      log(
        `done in ${Date.now() - t0}ms firstAudio=${firstAudioMs ?? "-"}ms serverFirstChunk=${serverFirstChunk}ms ` +
          `waited=${waitedMs}ms audio=${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s chars=${text.length}` +
          (bytes === 0 ? " — FINISHED WITH NO AUDIO" : ""),
      );
    } catch (error) {
      if (signal.aborted) {
        log(`cancelled after ${Date.now() - t0}ms (barge-in or teardown): ${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s audio`);
        return;
      }
      const message = firstAudio.signal.aborted && firstAudioMs === null
        ? `no audio within ${FIRST_AUDIO_TIMEOUT_MS}ms`
        : error instanceof Error ? error.message : String(error);
      log(`FAILED after ${Date.now() - t0}ms firstAudio=${firstAudioMs ?? "-"}ms bytes=${bytes} chars=${text.length}: ${message}`);
      if (error instanceof APIStatusError || (error instanceof APIConnectionError && !error.retryable)) throw error;
      // A retry replays the whole sentence, so only one that has played nothing may retry.
      throw new APIConnectionError({ message: `Voicebox: ${message}`, options: { retryable: bytes === 0 } });
    } finally {
      clearTimeout(timer);
      gate.release();
    }
  }
}
