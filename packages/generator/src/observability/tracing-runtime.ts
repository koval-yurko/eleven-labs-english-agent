/**
 * Shared LangSmith runtime + graceful-shutdown flushing.
 *
 * The LangSmith SDK auto-batches runs and sends them from a background timer. A process that
 * exits before that timer fires loses whatever is still queued — this is why `pnpm
 * eval:generation` runs showed up "pending" with their feedback dropped (the CLI calls
 * `process.exit()` the instant upload returns), and it is the same risk a server faces when it
 * receives SIGTERM mid-deploy. The fix is to (a) funnel every tracing path through ONE client
 * so there is a single queue to drain, and (b) drain it on shutdown.
 *
 * Everything here is best-effort and soft: with no `LANGSMITH_API_KEY` (or no SDK installed)
 * the shared client is null and every function is a no-op.
 */

/** The slice of the LangSmith Client we depend on, incl. the drain hooks for shutdown. */
export interface SharedLangSmithClient {
  createRun(args: Record<string, unknown>): Promise<unknown> | unknown;
  updateRun(runId: string, args: Record<string, unknown>): Promise<unknown> | unknown;
  /** Resolves once every queued auto-batch has been sent (langsmith ≥ 0.1). */
  awaitPendingTraceBatches?(): Promise<void>;
  /** Older drain hook; flushes the auto-batch queue immediately. */
  flush?(): Promise<void>;
}

type ClientCtor = new (opts: { apiKey: string }) => SharedLangSmithClient;
interface LangSmithModule {
  Client?: ClientCtor;
  default?: { Client?: ClientCtor };
}

function langSmithApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
}

let clientPromise: Promise<SharedLangSmithClient | null> | null = null;

/**
 * The single process-wide LangSmith client, memoized. Returns null when unconfigured or the
 * SDK is absent. All tracing paths (session tracer, generation `traceable`, eval upload) share
 * it so {@link flushTracing} drains one queue.
 */
export function getSharedLangSmithClient(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedLangSmithClient | null> {
  if (clientPromise) return clientPromise;
  const apiKey = langSmithApiKey(env);
  if (!apiKey) return Promise.resolve(null);
  clientPromise = (async () => {
    try {
      const mod = (await import("langsmith")) as unknown as LangSmithModule;
      const Client = mod.Client ?? mod.default?.Client;
      if (!Client) return null;
      return new Client({ apiKey });
    } catch {
      return null; // SDK not installed — degrade to no-op.
    }
  })();
  return clientPromise;
}

/**
 * Drain every queued run to LangSmith. Idempotent and best-effort — safe to call repeatedly
 * and from a shutdown handler; never throws. No-op when tracing is unconfigured.
 */
export async function flushTracing(): Promise<void> {
  if (!clientPromise) return; // client was never created — nothing queued.
  try {
    const client = await clientPromise;
    if (!client) return;
    if (typeof client.awaitPendingTraceBatches === "function") {
      await client.awaitPendingTraceBatches();
    } else if (typeof client.flush === "function") {
      await client.flush();
    }
  } catch {
    // Best-effort: shutdown must proceed even if the final send fails.
  }
}

let hooksInstalled = false;

/**
 * Install graceful-shutdown hooks that flush pending traces before the process exits. Idempotent
 * (safe to call from Next's `instrumentation.ts` `register()` on every cold start). On a normal
 * drain it flushes via `beforeExit`; on SIGTERM/SIGINT it flushes, then re-raises the signal so
 * the runtime's own shutdown (and any other listeners) still run and the exit code is correct.
 */
export function installTracingShutdownHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // `beforeExit` fires when the loop empties on a normal exit (e.g. a finished CLI/script).
  process.once("beforeExit", () => {
    void flushTracing();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const onSignal = () => {
      // Detach so the re-raised signal reaches the runtime's default/other handlers, not us.
      process.removeListener(signal, onSignal);
      void flushTracing().finally(() => {
        process.kill(process.pid, signal);
      });
    };
    process.on(signal, onSignal);
  }
}
