# Internal TypeScript Contracts: 008-langsmith-tracing

The package-level (non-HTTP) boundaries this feature adds or changes. These are the
contract-test surfaces (Constitution: contract tests on each boundary).

## 1. `LiveStoryRepository` additions (`packages/live-story/src/persistence/repository.ts`)

Two **service-role / non-owner-scoped** reads, used only by the webhook + sweep. Both get
in-memory (`InMemoryLiveStoryRepository`) and Supabase (`SupabaseLiveStoryRepository`) impls.

```ts
export interface SessionCorrelation {
  sessionId: string;
  lessonId: string;
  ownerId: string;
}

export interface LiveStoryRepository {
  // ...existing owner-scoped methods unchanged...

  /**
   * Correlate an ElevenLabs conversation id back to its session/lesson/owner. Service-role:
   * the webhook caller has no owner in hand. Returns null when no session carries the id
   * (caller then forwards the trace uncorrelated + tagged "unmatched"). R3 / FR-005.
   */
  findSessionByConversationId(conversationId: string): Promise<SessionCorrelation | null>;

  /**
   * Active sessions idle since before `idleOlderThan`, bounded by `limit`, for the sweep.
   * Service-role (operates across owners). R5 / FR-003.
   */
  findStaleActiveSessions(idleOlderThan: Date, limit: number): Promise<SessionCorrelation[]>;
}
```

Existing `appendTurns` / `updateScenario` / `setConversationId` additionally bump
`last_activity_at = now()`. `endSession(ownerId, sessionId)` is reused by the sweep.

**Contract tests** (against the in-memory impl, mirrored by a Supabase integration test):
- `findSessionByConversationId` returns the row across owners; null when unknown.
- `findStaleActiveSessions` returns only `active` rows older than the cutoff, respects `limit`,
  excludes `ended` rows and rows touched within the window.
- an append bumps `last_activity_at` (a just-appended session is NOT returned by a sweep).

## 2. Telemetry envelope schema (`@idiomatic/contracts` or live-story)

```ts
export const TelemetryDelivery = z.object({
  type: z.enum(["post_call_transcription_otel", "post_call_transcription"]),
  event_timestamp: z.number().optional(),
  data: z.object({
    conversation_id: z.string(),
    agent_id: z.string(),
    otlp_traces: z.object({ resourceSpans: z.array(z.unknown()) }).optional(),
    metadata: z.record(z.unknown()).optional(),
    conversation_turn_metrics: z.record(z.unknown()).optional(),
  }).passthrough(),
});
export type TelemetryDelivery = z.infer<typeof TelemetryDelivery>;
```

**Contract tests**: a captured OTel fixture parses; a captured JSON fixture parses; a
truncated/garbage body fails `safeParse` (route → 400).

## 3. OTLP forwarder (`packages/generator/src/observability/otlp-forward.ts`)

```ts
/** Soft dep: no LANGSMITH_API_KEY -> returns { ok:false, reason:"no_sink" } without calling. */
export function forwardOtlpToLangSmith(
  resourceSpans: unknown[],
  opts: { project: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch },
): Promise<{ ok: boolean; reason?: "no_sink" | "forward_failed" }>;
```

**Contract tests**: no key → `no_sink`, no fetch call; with key → POSTs to
`/otel/v1/traces` with `x-api-key` + `Langsmith-Project`; a non-2xx downstream →
`forward_failed` (and the route still returns 200, FR-008).

## 4. Enrichment helper (`packages/live-story/src/services/otel-enrich.ts`)

```ts
/** Inject lesson/owner/thread/status resource attributes onto resourceSpans (R4). Pure. */
export function enrichResourceSpans(
  resourceSpans: unknown[],
  attrs: { lessonId?: string; ownerId?: string; scenario?: string | null;
           status?: string; turnCount?: number; unmatched?: boolean },
): unknown[];
```

**Contract tests** (pure, no I/O): attributes are present on output; `unmatched:true` omits
lesson/owner and adds the `unmatched` tag; thread key equals `lessonId` when present.

## 5. Tier A: `SessionTracer` behavior change (`session-tracer.ts`)

No signature change to `recordSession(trace: SessionTrace)`. Behavior tightened (R8/FR-013):
- `start_time` ← `trace.createdAt` (new field on `SessionTrace`), not `Date.now()`.
- `end_time` set only when `trace.ended`.
- one **child run per turn** under the session run.
- run metadata/tags include `scenario`, `status`, `turnCount`, `termination_reason`.

**Contract tests**: extend `packages/generator/tests/unit/tracing-runtime.test.ts` — assert
captured `createRun` payload has child runs, start/end from the session (not wall-clock), and
the new metadata keys.
