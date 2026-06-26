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

import { createHash } from "node:crypto";
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
  /**
   * When the session opened (ISO). Used as the run `start_time` so the reported duration is the
   * real conversation length, not the create→update upsert wall-clock (008-langsmith-tracing,
   * Tier A / FR-013). Falls back to "now" if unparseable.
   */
  createdAt: string;
  /** Why the session ended — e.g. "abandoned" for a sweep-finalized session. Surfaced as metadata. */
  terminationReason?: string;
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

/** Run metadata/tags filterable in LangSmith (Tier A / FR-012). */
function sessionMetadata(trace: SessionTrace) {
  return {
    lessonId: trace.lessonId,
    ownerId: trace.ownerId,
    sessionId: trace.sessionId,
    // LangSmith groups runs sharing a `thread_id` into one Thread view. Keying it on the lesson
    // collapses every session of a lesson (re-starts, reconnects, dev remounts) into one timeline.
    thread_id: trace.lessonId,
    scenario: trace.scenario,
    status: trace.status,
    turnCount: trace.turns.length,
    ...(trace.terminationReason ? { termination_reason: trace.terminationReason } : {}),
  };
}

/** Session start in epoch ms from `createdAt`, falling back to now if unparseable. */
function startMs(trace: SessionTrace): number {
  const parsed = Date.parse(trace.createdAt);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** A stable UUID-formatted id derived from the session + turn, so child runs never duplicate. */
function childRunId(sessionId: string, turnIndex: number): string {
  const h = createHash("sha1").update(`${sessionId}:${turnIndex}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** LangSmith dotted-order timestamp: `YYYYMMDDTHHMMSSffffffZ`. */
function dottedTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const micros = `${p(d.getUTCMilliseconds(), 3)}000`;
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${micros}Z`
  );
}

/**
 * Build the parent (session-level) run arguments for LangSmith (Tier A). Pure — extracted so
 * the run shape (real start_time, end_time-only-on-ended, metadata) is unit-testable without a
 * live client. `endNowMs` is the wall-clock end stamped on the finalizing append.
 */
export function buildSessionRunInputs(
  trace: SessionTrace,
  project: string,
  endNowMs: number,
): Record<string, unknown> {
  const start = startMs(trace);
  return {
    id: trace.sessionId,
    name: "liveStorySession",
    run_type: "chain",
    project_name: project,
    // Real start from session open, not the upsert wall-clock (Tier A / FR-013).
    start_time: start,
    trace_id: trace.sessionId,
    dotted_order: `${dottedTime(start)}${trace.sessionId}`,
    inputs: { lessonId: trace.lessonId, scenario: trace.scenario },
    outputs: summarize(trace),
    extra: { metadata: sessionMetadata(trace) },
    // end_time set ONLY when the session has actually ended (Tier A).
    ...(trace.ended ? { end_time: endNowMs } : {}),
  };
}

/**
 * Build one child run per transcript turn (Tier A per-turn hierarchy). Pure. Child ids are
 * deterministic (session + turnIndex) so the finalizing append never duplicates them.
 */
export function buildTurnChildRuns(
  trace: SessionTrace,
  project: string,
): Record<string, unknown>[] {
  const start = startMs(trace);
  const parentDotted = `${dottedTime(start)}${trace.sessionId}`;
  return trace.turns
    .slice()
    .sort((a, b) => a.turnIndex - b.turnIndex)
    .map((t) => {
      const childStart = start + t.turnIndex * 1000;
      const childId = childRunId(trace.sessionId, t.turnIndex);
      return {
        id: childId,
        name: `turn ${t.turnIndex} (${t.role}/${t.kind})`,
        run_type: t.role === "teacher" ? "llm" : "chain",
        project_name: project,
        parent_run_id: trace.sessionId,
        trace_id: trace.sessionId,
        dotted_order: `${parentDotted}.${dottedTime(childStart)}${childId}`,
        start_time: childStart,
        end_time: childStart + 1,
        inputs: { role: t.role, kind: t.kind },
        outputs: { text: t.text },
      };
    });
}

/**
 * A LangSmith-backed {@link SessionTracer}, or a no-op when unconfigured / the SDK is absent.
 * The run id IS the session id, so the first append creates the run and every later append
 * (and the final `ended` one) patches the same run — one trace per spoken lesson. On the
 * finalizing (`ended`) append it also emits one child run per transcript turn, giving the
 * trace a real per-turn hierarchy even without the richer ElevenLabs OTel telemetry (Tier A).
 */
export function createLangSmithSessionTracer(
  env: NodeJS.ProcessEnv = process.env,
): SessionTracer {
  if (!langSmithApiKey(env)) return noopSessionTracer;
  const project = langSmithProject(env);

  return {
    async recordSession(trace) {
      try {
        // The shared client funnels this through the one queue that shutdown drains.
        const client = await getSharedLangSmithClient(env);
        if (!client) return;

        if (trace.isNew) {
          await client.createRun(buildSessionRunInputs(trace, project, Date.now()));
        } else {
          await client.updateRun(trace.sessionId, {
            outputs: summarize(trace),
            extra: { metadata: sessionMetadata(trace) },
            ...(trace.ended ? { end_time: Date.now() } : {}),
          });
        }

        // On finalize, emit a child run per turn — the per-turn hierarchy (Tier A). Done once
        // (only on the `ended` append, which the sweep also triggers for abandoned sessions),
        // so deterministic child ids never duplicate across the session's incremental appends.
        if (trace.ended) {
          for (const child of buildTurnChildRuns(trace, project)) {
            await client.createRun(child);
          }
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
