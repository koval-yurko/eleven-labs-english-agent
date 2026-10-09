/**
 * Alibaba Qwen-Audio TTS as a LiveKit `tts.TTS` — there is no LiveKit plugin for it, so this is the
 * adapter. It speaks Model Studio's duplex WebSocket protocol (run-task → task-started →
 * continue-task… → finish-task → task-finished; audio arrives as binary frames between the JSON
 * events). Output is raw 24 kHz mono PCM16.
 *
 * A reply is ONE task (`QwenSynthesizeStream`): the answer is fed in sentence-sized pieces, held back
 * by `pacer.ts` so synthesis stays ~12 s ahead of playback, over a socket that is already open
 * (`qwen-socket-pool.ts`). Why, and what was tried before:
 * docs/2026-10-09-qwen-tts-latency-and-rate-limits.md.
 *
 * Every task logs a `[qwen …]` summary to the worker's stdout (`lk agent logs`).
 */
import { randomUUID } from "node:crypto";
import { type APIConnectOptions, APIConnectionError, AudioByteStream, tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import WebSocket from "ws";
import { Pacer } from "./pacer.ts";
import { SocketPool, type TakenSocket } from "./qwen-socket-pool.ts";
import { segment } from "./speech-segments.ts";

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;

/**
 * Model Studio allows 3 requests/s per model for the whole account (rate-limit page). The first
 * adapter made one request per sentence and was throttled (lesson 36df4fed); the guards that remain:
 *  - a reply is ONE task on one socket, not a connection per sentence;
 *  - at most `MAX_IN_FLIGHT` tasks run at once, the rest wait their turn and leave if aborted;
 *  - a throttled task is retried with backoff (it has produced no audio, so nothing is repeated).
 */
const MAX_IN_FLIGHT = 5;
/** Audio kept queued ahead of playback; see `pacer.ts`. */
const LOOKAHEAD_MS = 12_000;
/** Characters spoken per second, measured on this voice (124 chars ≈ 5.7 s, 414 ≈ 23 s). */
const CHARS_PER_SEC = 17;
const THROTTLE_RETRIES = 4;
const THROTTLE_BACKOFF_MS = 400;
/** The server closes an idle socket after ~60 s (probed 2026-10-09); retire ours before it does. */
const IDLE_SOCKET_MS = 45_000;
/** How long a cancelled task may take to answer `task-finished` before its socket is thrown away. */
const CANCEL_GRACE_MS = 1500;

/**
 * A counting gate whose waiters can leave. A reply the learner talked over is aborted while it is
 * still queued; it must give its place up at once, or every live reply waits behind work nobody
 * will hear (lesson d688e87d: requests sat ~19 s in line behind stale ones).
 */
class Gate {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(limit: number) {
    this.#free = limit;
  }
  /** Resolves true when the caller holds a slot (and must `release`), false if it was aborted first. */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const i = this.#waiting.indexOf(grant);
        if (i >= 0) this.#waiting.splice(i, 1);
        resolve(false);
      };
      this.#waiting.push(grant);
      signal.addEventListener("abort", leave, { once: true });
    });
  }
  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

class ThrottledError extends Error {}
/** A reused socket that the server had already closed: retry at once on a fresh one. */
class StaleSocketError extends Error {}

export interface QwenTtsOptions {
  apiKey: string;
  /** Model Studio workspace id — part of the endpoint host. */
  workspaceId: string;
  /** `ap-southeast-1` (Singapore, international) or `cn-beijing`. The API key is per region. */
  region: string;
  model: string;
  voice: string;
  /** One of Model Studio's `language_hints`; only the first is processed. */
  language: string;
}

export class QwenTTS extends tts.TTS {
  label = "qwen.TTS";
  readonly opts: QwenTtsOptions;
  readonly gate = new Gate(MAX_IN_FLIGHT);
  readonly pool: SocketPool;

  constructor(opts: QwenTtsOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.opts = opts;
    this.pool = new SocketPool(() => this.#openSocket(), IDLE_SOCKET_MS, (m) => console.log(`[qwen pool] ${m}`));
  }

  override get model(): string {
    return this.opts.model;
  }

  override get provider(): string {
    return "alibaba-model-studio";
  }

  /** Opens the socket for the first reply while the learner is still being greeted. */
  warm(): void {
    this.pool.warm();
  }

  /** One task per reply, over a warm socket, paced to playback (see `QwenSynthesizeStream`). */
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new QwenSynthesizeStream(this, options?.connOptions);
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new QwenChunkedStream(this, text, connOptions, abortSignal);
  }

  override async close(): Promise<void> {
    this.pool.closeAll();
    await super.close();
  }

  #openSocket(): Promise<WebSocket> {
    const { opts } = this;
    const url = `wss://${opts.workspaceId}.${opts.region}.maas.aliyuncs.com/api-ws/v1/inference`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
      // A parked socket can error with nobody listening; that must not crash the worker.
      ws.on("error", () => undefined);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      // The upgrade itself was refused (bad key, wrong region, no access): ws reports it as a
      // bare "Unexpected server response: 4xx" unless the response body is read here.
      ws.once("unexpected-response", (_req, res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          console.log(`[qwen pool] upgrade refused: HTTP ${res.statusCode} body=${body.slice(0, 400)}`);
          reject(new Error(`Qwen TTS upgrade refused: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
        });
      });
    });
  }
}

/** `synthesize(text)` for callers with a whole string: the streaming path with the text pushed at once. */
class QwenChunkedStream extends tts.ChunkedStream {
  label = "qwen.ChunkedStream";
  readonly #owner: QwenTTS;

  constructor(owner: QwenTTS, text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal) {
    super(text, owner, connOptions, abortSignal);
    this.#owner = owner;
  }

  protected async run(): Promise<void> {
    const stream = new QwenSynthesizeStream(this.#owner);
    this.abortSignal.addEventListener("abort", () => stream.close(), { once: true });
    stream.pushText(this.inputText);
    stream.endInput();
    for await (const audio of stream) {
      if (audio === tts.SynthesizeStream.END_OF_STREAM) break;
      this.queue.put(audio);
    }
    if (stream.error) throw stream.error;
  }
}

/**
 * A reply as ONE Model Studio task. `run-task` opens it, each piece of the answer goes out as a
 * `continue-task` when the pacer says playback needs it, `finish-task` closes it. Audio comes back
 * on the same socket as Claude is still writing, and the socket then goes back to the pool.
 *
 * Cancelling (the learner talks over the tutor) is `finish-task` with `directive: "cancel"`, which
 * the server answers with `task-finished` and no further audio (client-events doc) — and the socket
 * is reusable after it.
 */
class QwenSynthesizeStream extends tts.SynthesizeStream {
  label = "qwen.SynthesizeStream";
  readonly #owner: QwenTTS;

  // No parameter properties: `node` strips types natively (`lk agent console`) and rejects them.
  constructor(owner: QwenTTS, connOptions?: APIConnectOptions) {
    super(owner, connOptions);
    this.#owner = owner;
  }

  protected async run(): Promise<void> {
    const { opts, gate, pool } = this.#owner;
    // One pacer per reply. Replies overlap (a preemptive one starts before the previous one is
    // cancelled), and a shared pacer made the new reply wait for audio of the old one: "held piece 1
    // for 1001ms" at the start of lesson 0dd1b82e's reply, with nothing yet queued for it.
    const pacer = new Pacer(LOOKAHEAD_MS);
    const signal = this.abortController.signal;
    const streamId = randomUUID().slice(0, 8);
    const log = (message: string) => console.log(`[qwen stream ${streamId}] ${message}`);
    const t0 = Date.now();
    const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

    // The answer so far, cut into pieces. Kept whole so a throttled attempt can be replayed.
    const pieces: string[] = [];
    let inputEnded = false;
    let wake: (() => void) | null = null;
    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    signal.addEventListener("abort", notify, { once: true });

    const pump = (async () => {
      let buffer = "";
      for await (const data of this.input) {
        if (data === tts.SynthesizeStream.FLUSH_SENTINEL) continue;
        buffer += data;
        const cut = segment(buffer, false);
        buffer = cut.rest;
        if (cut.pieces.length) {
          pieces.push(...cut.pieces);
          notify();
        }
      }
      pieces.push(...segment(buffer, true).pieces);
      inputEnded = true;
      notify();
    })();

    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const requestId = streamId;
    // One frame is held back so the last one can be marked `final` once task-finished arrives.
    let held: AudioFrame | undefined;
    const emit = (frame: AudioFrame) => {
      if (held && !this.queue.closed) this.queue.put({ requestId, frame: held, final: false, segmentId: requestId });
      held = frame;
    };

    let bytes = 0;
    let firstAudioMs: number | null = null;
    let sentChars = 0;
    let socketNote = "";
    const events: Record<string, number> = {};

    const attempt = async (): Promise<void> => {
      const opened = Date.now();
      const taken: TakenSocket = await pool.take();
      const { ws, reused } = taken;
      socketNote = reused
        ? `warm socket (idle ${(taken.idleMs / 1000).toFixed(1)}s)`
        : `fresh socket (${Date.now() - opened}ms to open)`;
      log(`start model=${opts.model} voice=${opts.voice} — ${socketNote}`);
      await new Promise<void>((resolve, reject) => {
        const taskId = randomUUID();
        const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });
        let done = false;
        let started = false;
        let cancelling = false;
        let cursor = 0;
        let cancelTimer: NodeJS.Timeout | undefined;

        const finish = (outcome: { reuse: boolean; error?: Error }) => {
          if (done) return;
          done = true;
          clearTimeout(cancelTimer);
          signal.removeEventListener("abort", onAbort);
          ws.off("message", onMessage);
          ws.off("close", onClose);
          ws.off("error", onError);
          if (outcome.reuse) pool.give(ws);
          else pool.discard(ws);
          if (outcome.error) reject(outcome.error);
          else resolve();
        };
        const onAbort = () => {
          log(
            `cancelled by the framework after ${since()} (barge-in or teardown): firstAudio=${firstAudioMs ?? "-"}ms ` +
              `${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s audio, ${cursor}/${pieces.length} pieces sent — ${socketNote}`,
          );
          if (!started || ws.readyState !== WebSocket.OPEN) {
            finish({ reuse: false });
            return;
          }
          // Ask the server to stop; it answers task-finished and the socket stays usable.
          cancelling = true;
          try {
            ws.send(JSON.stringify({ header: header("finish-task"), payload: { input: {}, directive: "cancel" } }));
          } catch {
            finish({ reuse: false });
            return;
          }
          cancelTimer = setTimeout(() => finish({ reuse: false }), CANCEL_GRACE_MS);
        };
        const onClose = (code: number, reason: Buffer) => {
          if (done) return;
          log(`socket closed before task-finished: code=${code} reason=${JSON.stringify(reason.toString())}`);
          const message = `Qwen TTS socket closed early (${code}) ${reason.toString()}`.trim();
          finish({ reuse: false, error: reused && !started ? new StaleSocketError(message) : new Error(message) });
        };
        const onError = (err: Error) => {
          log(`socket error: ${err.message}`);
          finish({ reuse: false, error: reused && !started ? new StaleSocketError(err.message) : err });
        };

        const sender = async () => {
          while (!done && !signal.aborted) {
            if (cursor < pieces.length) {
              const piece = pieces[cursor]!;
              const secs = piece.length / CHARS_PER_SEC;
              const waited = await pacer.admit(signal, secs);
              if (waited < 0 || done) return;
              if (waited > 500) log(`paced: held piece ${cursor + 1} for ${waited}ms (queued audio was ahead of playback)`);
              this.markStarted();
              ws.send(JSON.stringify({ header: header("continue-task"), payload: { input: { text: piece } } }));
              sentChars += piece.length;
              cursor += 1;
              continue;
            }
            if (inputEnded) {
              ws.send(JSON.stringify({ header: header("finish-task"), payload: { input: {} } }));
              log(`all text sent at ${since()}: ${cursor} pieces, ${sentChars} chars`);
              return;
            }
            await new Promise<void>((r) => {
              wake = r;
            });
          }
        };

        const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) {
            if (cancelling) return; // audio still in flight for a task nobody is listening to
            const buf = toArrayBuffer(data);
            bytes += buf.byteLength;
            firstAudioMs ??= Date.now() - t0;
            for (const frame of bstream.write(buf)) emit(frame);
            return;
          }
          const raw = data.toString();
          let event: { header?: { task_id?: string; event?: string; error_code?: string; error_message?: string } };
          try {
            event = JSON.parse(raw);
          } catch {
            log(`non-JSON text message: ${raw.slice(0, 300)}`);
            return;
          }
          // A late event from the previous (cancelled) task on this socket is not ours.
          if (event.header?.task_id && event.header.task_id !== taskId) return;
          const name = event.header?.event ?? "(no event)";
          events[name] = (events[name] ?? 0) + 1;
          switch (name) {
            case "task-started":
              started = true;
              void sender().catch((e: unknown) => finish({ reuse: false, error: e instanceof Error ? e : new Error(String(e)) }));
              break;
            case "task-finished":
              if (!cancelling) for (const frame of bstream.flush()) emit(frame);
              finish({ reuse: true });
              break;
            case "task-failed": {
              log(`task-failed: ${raw.slice(0, 600)}`);
              const code = event.header?.error_code ?? "";
              const message = `Qwen TTS failed: ${code} ${event.header?.error_message}`;
              // The docs: after task-failed the client must close the connection.
              finish({ reuse: false, error: code.startsWith("Throttling") ? new ThrottledError(message) : new Error(message) });
              break;
            }
            case "result-generated":
              break; // sentence-begin / -synthesis / -end: counted in the summary
            default:
              log(`unexpected event ${name}: ${raw.slice(0, 300)}`);
          }
        };

        signal.addEventListener("abort", onAbort, { once: true });
        ws.on("message", onMessage);
        ws.on("close", onClose);
        ws.on("error", onError);
        ws.send(
          JSON.stringify({
            header: header("run-task"),
            payload: {
              task_group: "audio",
              task: "tts",
              function: "SpeechSynthesizer",
              model: opts.model,
              input: {},
              parameters: {
                text_type: "PlainText",
                voice: opts.voice,
                format: "pcm",
                sample_rate: SAMPLE_RATE,
                language_hints: [opts.language],
              },
            },
          }),
        );
      });
    };

    const waitStart = Date.now();
    if (!(await gate.acquire(signal))) {
      log("dropped from the queue: aborted before its turn");
      return;
    }
    if (Date.now() - waitStart > 1000) log(`waited ${Date.now() - waitStart}ms for a free slot`);
    try {
      let stale = 0;
      for (let n = 0; ; ) {
        try {
          await attempt();
          break;
        } catch (error) {
          if (signal.aborted || bytes > 0) throw error;
          if (error instanceof StaleSocketError && stale < 2) {
            stale += 1;
            log(`the parked socket was already closed (${error.message}); retrying on a fresh one`);
            continue;
          }
          if (!(error instanceof ThrottledError) || n >= THROTTLE_RETRIES) throw error;
          const wait = THROTTLE_BACKOFF_MS * 2 ** n;
          n += 1;
          log(`throttled (attempt ${n}/${THROTTLE_RETRIES + 1}); retrying in ${wait}ms`);
          pacer.reset();
          sentChars = 0;
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      if (signal.aborted) return;
      // The final frame carries `final: true`; with no audio at all there is nothing to mark.
      if (held) this.queue.put({ requestId, frame: held, final: true, segmentId: requestId });
      this.queue.put(tts.SynthesizeStream.END_OF_STREAM);
      log(
        `done in ${since()} firstAudio=${firstAudioMs ?? "-"}ms bytes=${bytes} ` +
          `(${(bytes / (SAMPLE_RATE * 2)).toFixed(1)}s audio) chars=${sentChars} — ${socketNote} ` +
          `events=${JSON.stringify(events)}` +
          (bytes === 0 && sentChars > 0 ? " — FINISHED WITH NO AUDIO" : ""),
      );
    } catch (error) {
      log(
        `FAILED after ${since()} firstAudio=${firstAudioMs ?? "-"}ms bytes=${bytes} chars=${sentChars} ` +
          `events=${JSON.stringify(events)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new APIConnectionError({
        message: error instanceof Error ? error.message : String(error),
        options: { retryable: false },
      });
    } finally {
      gate.release();
      await pump.catch(() => undefined);
    }
  }
}

function toArrayBuffer(data: WebSocket.RawData): ArrayBuffer {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
