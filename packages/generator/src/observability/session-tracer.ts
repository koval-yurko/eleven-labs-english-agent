/**
 * Live-session traceability via LangSmith (companion to `workflow/tracing.ts`, which traces
 * batch generation). The adaptive live-story conversation runs inside ElevenLabs — the agent's
 * Claude calls never pass through this process, so they can't be traced. What the app CAN
 * observe is the durable transcript it persists as turns finalize; this records that, OFF the
 * speech path, as ONE upsertable LangSmith run per session so a spoken lesson shows up in the
 * same project as generation.
 *
 * Soft dependency, exactly like the rest of our LangSmith wiring: with no `LANGSMITH_API_KEY`
 * (or no SDK installed) this is a no-op, and every call is best-effort — tracing never throws
 * into the transcript-persistence path.
 */

import { getSharedLangSmithClient, flushTracing } from "./tracing-runtime";

export interface SessionTraceTurn {
  role: string;
  kind: string;
  text: string;
  turnIndex: number;
}

export interface SessionTrace {
  /** The live session id (a UUID) — reused as the LangSmith run id so appends upsert in place. */
  sessionId: string;
  lessonId: string;
  ownerId: string;
  scenario: string | null;
  status: string;
  /** Full ordered transcript so far (the run is re-stated on every append, latest wins). */
  turns: SessionTraceTurn[];
  /** True only on the first append of a session — create the run; otherwise patch it. */
  isNew: boolean;
  /** True when this append marks the session ended — finalize the run's `end_time`. */
  ended: boolean;
}

/** The port the transcript service depends on. Defaults to {@link noopSessionTracer}. */
export interface SessionTracer {
  recordSession(trace: SessionTrace): Promise<void>;
}

export const noopSessionTracer: SessionTracer = {
  async recordSession() {
    /* no-op */
  },
};

function langSmithApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LANGSMITH_API_KEY ?? env.LANGCHAIN_API_KEY;
}

function langSmithProject(env: NodeJS.ProcessEnv = process.env): string {
  return env.LANGSMITH_PROJECT ?? env.LANGCHAIN_PROJECT ?? "idiomatic-generation";
}

function summarize(trace: SessionTrace) {
  const teacherTurns = trace.turns.filter((t) => t.role === "teacher").length;
  return {
    turnCount: trace.turns.length,
    teacherTurns,
    learnerTurns: trace.turns.length - teacherTurns,
    scenario: trace.scenario,
    status: trace.status,
    // The transcript is the durable, owner-scoped record this feature exists to surface;
    // including it is the point of the trace (it is not stdout, so Constitution V's
    // debug-gating of log text does not apply).
    transcript: trace.turns
      .slice()
      .sort((a, b) => a.turnIndex - b.turnIndex)
      .map((t) => ({ index: t.turnIndex, role: t.role, kind: t.kind, text: t.text })),
  };
}

/**
 * A LangSmith-backed {@link SessionTracer}, or a no-op when unconfigured / the SDK is absent.
 * The run id IS the session id, so the first append creates the run and every later append
 * (and the final `ended` one) patches the same run — one trace per spoken lesson.
 */
export function createLangSmithSessionTracer(
  env: NodeJS.ProcessEnv = process.env,
): SessionTracer {
  if (!langSmithApiKey(env)) return noopSessionTracer;

  return {
    async recordSession(trace) {
      try {
        // The shared client funnels this through the one queue that shutdown drains.
        const client = await getSharedLangSmithClient(env);
        if (!client) return;
        const outputs = summarize(trace);

        if (trace.isNew) {
          await client.createRun({
            id: trace.sessionId,
            name: "liveStorySession",
            run_type: "chain",
            project_name: langSmithProject(env),
            start_time: Date.now(),
            inputs: { lessonId: trace.lessonId, scenario: trace.scenario },
            outputs,
            extra: {
              metadata: {
                lessonId: trace.lessonId,
                ownerId: trace.ownerId,
                sessionId: trace.sessionId,
                // LangSmith groups runs sharing a `thread_id` into one Thread view. Keying it
                // on the lesson collapses every session of a lesson (re-starts, reconnects,
                // dev remounts) into a single timeline — "one conversation in one place".
                thread_id: trace.lessonId,
              },
            },
            ...(trace.ended ? { end_time: Date.now() } : {}),
          });
        } else {
          await client.updateRun(trace.sessionId, {
            outputs,
            ...(trace.ended ? { end_time: Date.now() } : {}),
          });
        }

        // A completed session is the durable artifact this trace exists for: drain it now so
        // it lands even if the process is torn down (serverless freeze / scale-in) before the
        // auto-batch timer fires — shutdown hooks are the net, this is the guarantee.
        if (trace.ended) await flushTracing();
      } catch {
        // Tracing is best-effort; never let it break transcript persistence.
      }
    },
  };
}
