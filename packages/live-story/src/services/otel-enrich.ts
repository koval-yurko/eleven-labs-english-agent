/**
 * Pure enrichment of ElevenLabs' OTLP `resourceSpans` before they are forwarded to LangSmith
 * (008-langsmith-tracing, R4). Injects cross-cutting identity as OTLP **resource attributes**
 * so the trace is filterable by lesson/owner (FR-005) and joins the lesson's existing LangSmith
 * Thread (FR-006) — `thread_id = lessonId`, matching the run-API session tracer's convention.
 *
 * No I/O, no SDK, no mutation of the input (returns a fresh structure) — trivially testable.
 * When a delivery cannot be correlated to a session, callers pass `unmatched: true`: lesson/owner
 * are omitted and an `unmatched` marker is added instead, so the trace still lands but is never
 * mis-attributed (clarification Q2).
 */

export interface EnrichAttributes {
  lessonId?: string;
  ownerId?: string;
  scenario?: string | null;
  status?: string;
  turnCount?: number;
  terminationReason?: string;
  /** True when correlation missed — omit lesson/owner, tag the trace `unmatched`. */
  unmatched?: boolean;
}

/** OTLP KeyValue with a typed AnyValue, the wire shape LangSmith's OTLP ingest expects. */
type OtlpKeyValue = { key: string; value: Record<string, unknown> };

function str(key: string, value: string): OtlpKeyValue {
  return { key, value: { stringValue: value } };
}
function int(key: string, value: number): OtlpKeyValue {
  return { key, value: { intValue: value } };
}
function bool(key: string, value: boolean): OtlpKeyValue {
  return { key, value: { boolValue: value } };
}

/** Build the LangSmith metadata attributes for a delivery. */
function buildAttributes(attrs: EnrichAttributes): OtlpKeyValue[] {
  const kvs: OtlpKeyValue[] = [];
  const M = "langsmith.metadata.";

  if (attrs.unmatched) {
    kvs.push(bool(`${M}unmatched`, true));
  } else {
    if (attrs.lessonId) {
      kvs.push(str(`${M}lessonId`, attrs.lessonId));
      // Collapse generation + every session of a lesson into one Thread (FR-006).
      kvs.push(str(`${M}thread_id`, attrs.lessonId));
    }
    if (attrs.ownerId) kvs.push(str(`${M}ownerId`, attrs.ownerId));
  }

  // Filterable session summary (FR-012) — emitted whether or not correlation succeeded.
  if (attrs.scenario != null) kvs.push(str(`${M}scenario`, attrs.scenario));
  if (attrs.status) kvs.push(str(`${M}status`, attrs.status));
  if (typeof attrs.turnCount === "number") kvs.push(int(`${M}turnCount`, attrs.turnCount));
  if (attrs.terminationReason) {
    kvs.push(str(`${M}termination_reason`, attrs.terminationReason));
  }
  return kvs;
}

/** Append `injected` to an attribute list on `holder[key]`, creating it when absent. */
function appendAttrs(
  holder: Record<string, unknown>,
  key: string,
  injected: OtlpKeyValue[],
): void {
  const existing = Array.isArray(holder[key]) ? (holder[key] as OtlpKeyValue[]) : [];
  holder[key] = [...existing, ...injected];
}

/**
 * Return a deep-cloned copy of `resourceSpans` with the enrichment attributes appended both to
 * each group's `resource.attributes` AND to every individual span's `attributes`.
 *
 * The span-level injection is the load-bearing one: LangSmith reads `langsmith.metadata.*` and
 * `thread_id` from **span** attributes when building a run — resource-level attributes were NOT
 * surfaced as run metadata in practice (observed: lessonId/thread_id/scenario never appeared on
 * the forwarded trace). Writing them onto every span guarantees the lesson/owner/thread land and
 * the trace is filterable + threaded (FR-005/006/012). Resource attributes are kept for
 * compatibility with any consumer that does read them.
 */
export function enrichResourceSpans(
  resourceSpans: unknown[],
  attrs: EnrichAttributes,
): unknown[] {
  const injected = buildAttributes(attrs);
  const cloned = structuredClone(resourceSpans) as Array<Record<string, unknown>>;

  for (const group of cloned) {
    const resource = (group.resource as Record<string, unknown> | undefined) ?? {};
    appendAttrs(resource, "attributes", injected);
    group.resource = resource;

    const scopeSpans = Array.isArray(group.scopeSpans) ? group.scopeSpans : [];
    for (const scope of scopeSpans as Array<Record<string, unknown>>) {
      const spans = Array.isArray(scope.spans) ? scope.spans : [];
      for (const span of spans as Array<Record<string, unknown>>) {
        appendAttrs(span, "attributes", injected);
      }
    }
  }
  return cloned;
}
