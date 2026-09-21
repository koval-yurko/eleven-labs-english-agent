/** The closed set of things a diagnostic event can be about.
 *  See ../../../../docs/2026-09-09-mobile-debug-reports-and-feedback.md §4.3. */

/**
 * Every code the phone may emit.
 *
 * A closed set, because this is the axis every later question is grouped by — *how many reports
 * this week carry `transport.error` with `code 1008`?* A free-text `code` makes that question
 * unanswerable within a week of the first typo.
 *
 * Two properties, and they point in opposite directions on purpose:
 *
 *  - **Closed on the phone.** `emit({ code: "transport.eror" })` is a compile error, which is the
 *    only place a typo can be caught for free.
 *  - **Open at the edge of the server.** `sanitizeDebugReport` PRESERVES a code it does not know
 *    rather than dropping the event (see `report.ts`). An old build filing a code this deployment
 *    has never heard of must still get a row — the alternative is that the reports which matter
 *    most, the ones from the build nobody has updated, are the ones silently discarded.
 *
 * `session.start_refused` earns its place by being a NON-event: `focusLesson` refusing to move
 * while a session is live is the feature, and a refusal that leaves no trace is indistinguishable
 * from a button that did nothing.
 */
export const DEBUG_CODES = [
  // lifecycle
  "app.foreground",
  "app.background",
  "app.launch",
  "app.crash",
  "app.unhandled_rejection",
  // session machine
  "session.focus",
  "session.start",
  "session.start_refused",
  "session.claim",
  "session.release",
  "session.kickoff",
  "session.end",
  "session.status",
  "session.error",
  "session.id_mismatch",
  // pause
  "pause.hold",
  "pause.hold_plan",
  "pause.release",
  "pause.release_plan",
  "pause.heartbeat_failed",
  // durability
  "journal.write",
  "journal.write_failed",
  "journal.restore",
  /**
   * A recovered journal that could NOT be pushed and was kept on the device for a later attempt.
   *
   * Its own code rather than a flag on `persist.failed`, because it answers a different question:
   * not "did a save fail" but "is a transcript still stuck on a phone". One of those is an incident,
   * the other is a backlog.
   */
  "journal.retained",
  "journal.clear_failed",
  "pausemarker.write",
  "pausemarker.restore",
  "persist.ok",
  "persist.failed",
  "persist.skipped",
  // transport — `provider` on the event says which stack this came from
  "transport.mint",
  "transport.mint_failed",
  "transport.connect",
  "transport.connected",
  "transport.disconnect",
  "transport.error",
  "transport.usage",
  "transport.shim",
  /**
   * LiveKit only, and the pair exists because on this provider "the tutor is here" is a SEPARATE
   * fact from "the room is connected" (research doc §5.3). Every other provider has one connection
   * and the agent is the far end of it; here the phone joins a room and a worker is dispatched into
   * it afterwards, so a lesson can be perfectly connected with no tutor in it.
   *
   * `agent_left` without a `tutor.ending` signal before it is a worker that died mid-lesson, which
   * is what turns into `onEnd("error")` and the learner's "dropped" card. Its presence in a report
   * is the difference between "the tutor crashed" and "the learner hung up".
   */
  "transport.agent_joined",
  "transport.agent_left",
  /**
   * A control the phone sent that the worker did not accept. An RPC failure means a `say` or a
   * `cancelTurn` was lost — the learner sees a tutor that ignored them — while a stream send is the
   * resume context, whose loss means the tutor silently starts the lesson over.
   */
  "transport.rpc_failed",
  "transport.stream_sent",
  /**
   * Learner's last line → the tutor starts speaking, in ms. The ONE latency number measured the
   * same way on every provider, because it lives in the session and not in any adapter
   * (docs/2026-09-11-livekit-claude-diy-provider.md §5.3). It is imprecise, since each provider
   * delivers the learner's transcript at a different moment, but it is comparable.
   */
  "turn.gap",
  // network
  "api.request",
  "api.failed",
  "api.retry_401",
  /**
   * The spool (S2). These describe the reporting channel itself, which is the one part of this
   * feature whose failures are otherwise unobservable BY CONSTRUCTION: a report that never arrives
   * cannot tell you it never arrived. They land in the NEXT report, which is the point.
   */
  "spool.queued",
  "spool.sent",
  "spool.dropped",
  // captured console
  "console.warn",
  "console.error",
] as const;

export type DebugCode = (typeof DEBUG_CODES)[number];

const KNOWN = new Set<string>(DEBUG_CODES);

/** Is this a code this build knows? Used to LABEL, never to reject — see the docblock above. */
export function isKnownDebugCode(code: string): code is DebugCode {
  return KNOWN.has(code);
}
