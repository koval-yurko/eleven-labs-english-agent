/**
 * One warm WebSocket to Model Studio, kept ready for the next reply.
 *
 * Opening the socket costs 0.5–2 s (TCP + TLS + upgrade, Frankfurt → Singapore) and used to be paid
 * at the start of EVERY reply, in front of the first word. Probed 2026-10-09 against the live service:
 * a socket runs further tasks after a normal `task-finished` (the docs only promise it after a
 * cancel), a task on a warm socket answered with first audio in 0.87–1.0 s against ~2 s cold, a
 * socket idle for 45 s still worked, and the server closed it with `1000 Bye` about 60 s after its
 * last task. So: idle sockets opened before the first reply and again as each is taken, dropped at
 * 45 s, and quietly renewed a few times so a learner who pauses to think still gets a warm reply.
 *
 * Generic over how a socket is opened, so `check.ts` exercises it against a local server.
 */
import type WebSocket from "ws";

/** Idle sockets are renewed this many times with no use in between, then left to expire. */
const MAX_IDLE_RENEWALS = 3;

/**
 * Sockets kept parked. Two, because replies overlap: the learner speaks, a preemptive reply starts on
 * one socket while the previous reply is still on another and is cancelled only moments later. With
 * one parked socket, 8 of 12 replies in the first real lessons (2026-10-10) opened a fresh one and
 * paid 0.5–1.3 s for it.
 */
const MAX_IDLE = 2;

interface Idle {
  ws: WebSocket;
  since: number;
  timer: NodeJS.Timeout;
  onClose: () => void;
}

export interface TakenSocket {
  ws: WebSocket;
  /** True for a socket that was already open — warm or returned by a previous reply. */
  reused: boolean;
  /** How long it had been idle; 0 for a fresh one. */
  idleMs: number;
}

export class SocketPool {
  readonly #open: () => Promise<WebSocket>;
  readonly #idleMs: number;
  readonly #log: (message: string) => void;
  #idle: Idle[] = [];
  #pending: Promise<void> | null = null;
  #renewals = 0;
  #closed = false;

  constructor(open: () => Promise<WebSocket>, idleMs: number, log: (message: string) => void = () => undefined) {
    this.#open = open;
    this.#idleMs = idleMs;
    this.#log = log;
  }

  /** How many sockets are parked. */
  get idleCount(): number {
    return this.#idle.length;
  }

  /** Opens a socket in the background if none is parked or on its way. Never throws. */
  warm(): void {
    if (this.#closed || this.#pending || this.#idle.length > 0) return;
    const started = Date.now();
    this.#pending = this.#open()
      .then((ws) => {
        this.#log(`warm socket ready in ${Date.now() - started}ms`);
        this.#park(ws);
      })
      .catch((error: unknown) => {
        this.#log(`warming failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#pending = null;
      });
  }

  /** A parked socket if there is one (waiting for a warm-up already under way), else a fresh one. */
  async take(): Promise<TakenSocket> {
    this.#renewals = 0;
    if (!this.#idle.length && this.#pending) await this.#pending;
    const parked = this.#idle.pop();
    let taken: TakenSocket;
    if (parked) {
      clearTimeout(parked.timer);
      parked.ws.off("close", parked.onClose);
      taken = { ws: parked.ws, reused: true, idleMs: Date.now() - parked.since };
    } else {
      taken = { ws: await this.#open(), reused: false, idleMs: 0 };
    }
    // The next reply may start before this one ends: have its socket opening now.
    this.warm();
    return taken;
  }

  /** A socket whose task ended cleanly goes back for the next reply. Anything else is `discard`ed. */
  give(ws: WebSocket): void {
    this.#park(ws);
  }

  discard(ws: WebSocket): void {
    try {
      ws.close();
    } catch {
      // already gone
    }
  }

  /** The session is over: close what is parked and stop renewing. */
  closeAll(): void {
    this.#closed = true;
    for (const idle of this.#idle) {
      clearTimeout(idle.timer);
      this.discard(idle.ws);
    }
    this.#idle = [];
  }

  #park(ws: WebSocket): void {
    // WebSocket.OPEN === 1; compared by value so this file needs only the type.
    if (this.#closed || ws.readyState !== 1 || this.#idle.length >= MAX_IDLE) {
      this.discard(ws);
      return;
    }
    const entry: Idle = {
      ws,
      since: Date.now(),
      timer: setTimeout(() => this.#expire(entry), this.#idleMs),
      onClose: () => {
        clearTimeout(entry.timer);
        this.#idle = this.#idle.filter((i) => i !== entry);
        this.#log("a parked socket was closed by the server");
      },
    };
    entry.timer.unref();
    ws.once("close", entry.onClose);
    this.#idle.push(entry);
  }

  #expire(entry: Idle): void {
    this.#idle = this.#idle.filter((i) => i !== entry);
    entry.ws.off("close", entry.onClose);
    this.discard(entry.ws);
    if (this.#renewals < MAX_IDLE_RENEWALS) {
      this.#renewals += 1;
      this.#log(`idle socket retired after ${this.#idleMs}ms; renewing (${this.#renewals}/${MAX_IDLE_RENEWALS})`);
      this.warm();
    } else {
      this.#log("idle socket retired; not renewing — nobody has spoken for a while");
    }
  }
}
