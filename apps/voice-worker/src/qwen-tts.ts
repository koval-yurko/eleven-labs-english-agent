/**
 * Alibaba Qwen-Audio TTS as a LiveKit `tts.TTS` — there is no LiveKit plugin for it, so this is the
 * adapter. It speaks Model Studio's duplex WebSocket protocol (run-task → task-started →
 * continue-task → finish-task → task-finished; audio arrives as binary frames between the JSON
 * events). docs/2026-10-08-livekit-tts-candidates-qwen-gemini.md §2.
 *
 * Deliberately NOT a `SynthesizeStream`: `stream()` wraps this in LiveKit's sentence
 * `StreamAdapter`, so each sentence is one task on a fresh connection. That costs a handshake per
 * sentence but is the smallest thing that can be right; if `ttsTtfbMs` in the turn ledger says the
 * handshake matters, the upgrade is one long-lived socket with a task per sentence.
 *
 * UNTESTED against the live service — it needs a DashScope key, a workspace id, and a model id
 * confirmed in the console (the doc's §2.2). Output is raw 24 kHz mono PCM16.
 */
import { randomUUID } from "node:crypto";
import { type APIConnectOptions, AudioByteStream, tokenize, tts } from "@livekit/agents";
import WebSocket from "ws";

const SAMPLE_RATE = 24000;

/**
 * Report-less evidence, worker log of lesson 36df4fed (2026-10-08): ~20 requests in a few seconds,
 * one per sentence on a fresh connection and several of them preemptive replies the learner then
 * talked over, and Model Studio answered `Throttling.RateQuota` — which the adapter treated as
 * fatal. Three defences, all here:
 *  - sentences are merged to at least `MIN_CHUNK_CHARS` so a reply is a few requests, not a dozen;
 *  - at most `MAX_IN_FLIGHT` synthesis tasks run at once, the rest wait rather than being refused;
 *  - a throttled task is retried with backoff (it has produced no audio, so nothing is repeated).
 */
const MIN_CHUNK_CHARS = 80;
const MAX_IN_FLIGHT = 5;
const THROTTLE_RETRIES = 4;
const THROTTLE_BACKOFF_MS = 400;

/**
 * A counting gate whose waiters can leave. A reply the learner talked over is aborted while its
 * chunks are still queued; they must give their place up at once, or every live reply waits behind
 * work nobody will hear (lesson d688e87d: requests sat ~19 s in line behind stale ones).
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
const NUM_CHANNELS = 1;

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

  constructor(opts: QwenTtsOptions) {
    super(SAMPLE_RATE, NUM_CHANNELS, { streaming: false });
    this.opts = opts;
  }

  override get model(): string {
    return this.opts.model;
  }

  override get provider(): string {
    return "alibaba-model-studio";
  }

  /** The sentence adapter turns the model's text deltas into one `synthesize` per sentence. */
  stream(): tts.SynthesizeStream {
    return new tts.StreamAdapter(this, new tokenize.basic.SentenceTokenizer({ minSentenceLength: MIN_CHUNK_CHARS })).stream();
  }

  synthesize(text: string, connOptions?: APIConnectOptions, abortSignal?: AbortSignal): tts.ChunkedStream {
    return new QwenChunkedStream(this, text, this.opts, connOptions, abortSignal);
  }
}

class QwenChunkedStream extends tts.ChunkedStream {
  label = "qwen.ChunkedStream";

  constructor(
    private readonly owner: QwenTTS,
    private readonly text: string,
    private readonly opts: QwenTtsOptions,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal,
  ) {
    super(text, owner, connOptions, abortSignal);
  }

  protected async run(): Promise<void> {
    const { opts } = this;
    let taskId = randomUUID(); // a new one per attempt: Model Studio wants a fresh task_id for every task
    const bstream = new AudioByteStream(SAMPLE_RATE, NUM_CHANNELS);
    const url = `wss://${opts.workspaceId}.${opts.region}.maas.aliyuncs.com/api-ws/v1/inference`;
    const header = (action: string) => ({ action, task_id: taskId, streaming: "duplex" });

    /**
     * One line per synthesis, always, however it ends — the worker's log is the only place a
     * Qwen failure is visible (report b6184945 was a bare "Error (fatal)"). Times are ms since
     * the request began; `-` means the step never happened, which is usually the answer.
     */
    const t0 = Date.now();
    const at = (t: number | null) => (t === null ? "-" : `${t - t0}`);
    const trace = {
      opened: null as number | null,
      started: null as number | null,
      firstAudio: null as number | null,
      finished: null as number | null,
      bytes: 0,
      binaryMessages: 0,
      events: {} as Record<string, number>,
    };
    const tag = `[qwen ${taskId.slice(0, 8)}]`;
    const log = (message: string) => console.log(`${tag} ${message}`);
    log(
      `request model=${opts.model} voice=${opts.voice} chars=${this.text.length} ` +
        `text=${JSON.stringify(this.text.slice(0, 80))}`,
    );

    const put = (frame: Parameters<typeof this.queue.put>[0]["frame"]) => {
      if (!this.queue.closed) this.queue.put({ requestId: taskId, frame, final: false, segmentId: taskId });
    };

    const once = () =>
      new Promise<void>((resolve, reject) => {
        taskId = randomUUID();
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
        let done = false;
        const finish = (error?: Error) => {
          if (done) return;
          done = true;
          this.abortSignal.removeEventListener("abort", onAbort);
          try {
            ws.close();
          } catch {
            // already closed
          }
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => {
          log(`aborted by the framework (barge-in or teardown) after ${Date.now() - t0}ms`);
          finish();
        };
        this.abortSignal.addEventListener("abort", onAbort);

        ws.on("open", () => {
          trace.opened = Date.now();
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
        // The upgrade itself was refused (bad key, wrong region, no access): ws reports it as a
        // bare "Unexpected server response: 4xx" unless the response body is read here.
        ws.on("unexpected-response", (_req, res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk.toString()));
          res.on("end", () => {
            log(`upgrade refused: HTTP ${res.statusCode} ${res.statusMessage ?? ""} body=${body.slice(0, 400)}`);
            finish(new Error(`Qwen TTS upgrade refused: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
          });
        });
        ws.on("message", (data, isBinary) => {
          if (isBinary) {
            const buf = toArrayBuffer(data);
            trace.binaryMessages += 1;
            trace.bytes += buf.byteLength;
            trace.firstAudio ??= Date.now();
            for (const frame of bstream.write(buf)) put(frame);
            return;
          }
          const raw = data.toString();
          let event: {
            header?: { event?: string; error_code?: string; error_message?: string };
            payload?: unknown;
          };
          try {
            event = JSON.parse(raw);
          } catch {
            log(`non-JSON text message: ${raw.slice(0, 300)}`);
            return;
          }
          const name = event.header?.event ?? "(no event)";
          trace.events[name] = (trace.events[name] ?? 0) + 1;
          switch (name) {
            case "task-started":
              trace.started = Date.now();
              ws.send(JSON.stringify({ header: header("continue-task"), payload: { input: { text: this.text } } }));
              ws.send(JSON.stringify({ header: header("finish-task"), payload: { input: {} } }));
              break;
            case "task-finished":
              trace.finished = Date.now();
              for (const frame of bstream.flush()) put(frame);
              if (!this.queue.closed) this.queue.close();
              finish();
              break;
            case "task-failed":
              log(`task-failed: ${raw.slice(0, 600)}`);
              {
                const code = event.header?.error_code ?? "";
                const message = `Qwen TTS failed: ${code} ${event.header?.error_message}`;
                finish(code.startsWith("Throttling") ? new ThrottledError(message) : new Error(message));
              }
              break;
            case "result-generated":
            case "sentence-synthesis":
              break; // expected progress events — counted in the summary, not worth a line each
            default:
              log(`unexpected event ${name}: ${raw.slice(0, 300)}`);
          }
        });
        ws.on("error", (err) => {
          log(`socket error: ${err.message}`);
          finish(err);
        });
        ws.on("close", (code, reason) => {
          if (!done) log(`socket closed before task-finished: code=${code} reason=${JSON.stringify(reason.toString())}`);
          finish(done ? undefined : new Error(`Qwen TTS socket closed early (${code}) ${reason.toString()}`.trim()));
        });
      });

    const waitStart = Date.now();
    if (!(await this.owner.gate.acquire(this.abortSignal))) {
      log(`dropped from the queue after ${Date.now() - waitStart}ms: aborted before its turn`);
      return;
    }
    const waited = Date.now() - waitStart;
    if (waited > 1000) log(`waited ${waited}ms for a free slot (limit ${MAX_IN_FLIGHT})`);
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await once();
          break;
        } catch (error) {
          // Retry only a throttle that produced nothing: audio already queued cannot be replayed.
          if (!(error instanceof ThrottledError) || trace.bytes > 0 || attempt >= THROTTLE_RETRIES) throw error;
          if (this.abortSignal.aborted) return;
          const wait = THROTTLE_BACKOFF_MS * 2 ** attempt;
          log(`throttled (attempt ${attempt + 1}/${THROTTLE_RETRIES + 1}); retrying in ${wait}ms`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      log(
        `done in ${Date.now() - t0}ms open=${at(trace.opened)} started=${at(trace.started)} ` +
          `firstAudio=${at(trace.firstAudio)} finished=${at(trace.finished)} ` +
          `bytes=${trace.bytes} (${(trace.bytes / (SAMPLE_RATE * 2)).toFixed(1)}s audio) ` +
          `binary=${trace.binaryMessages} events=${JSON.stringify(trace.events)}` +
          (trace.bytes === 0 && trace.finished !== null ? " — FINISHED WITH NO AUDIO" : ""),
      );
    } catch (error) {
      log(
        `FAILED after ${Date.now() - t0}ms open=${at(trace.opened)} started=${at(trace.started)} ` +
          `firstAudio=${at(trace.firstAudio)} bytes=${trace.bytes} events=${JSON.stringify(trace.events)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    } finally {
      this.owner.gate.release();
    }
  }
}

function toArrayBuffer(data: WebSocket.RawData): ArrayBuffer {
  const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}
