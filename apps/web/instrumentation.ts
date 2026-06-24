/**
 * Next.js instrumentation hook — runs once per server process on startup (App Router).
 * We install graceful-shutdown hooks so any LangSmith traces still queued in the auto-batch
 * sender (generation runs + live-story session transcripts) are flushed before the process
 * exits on SIGTERM/SIGINT (e.g. a deploy rollover or `Ctrl-C`). No-op without LANGSMITH_API_KEY.
 *
 * The hook module uses Node-only `process.on`/`process.kill`, so it is imported dynamically
 * inside the Node.js-runtime guard — this keeps it out of the Edge runtime's static import graph
 * (the Edge runtime has no process signals and no LangSmith client anyway).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installTracingShutdownHooks } = await import("@idiomatic/generator");
    installTracingShutdownHooks();
  }
}
