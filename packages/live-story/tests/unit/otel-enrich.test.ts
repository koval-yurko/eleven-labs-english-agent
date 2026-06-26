import { describe, expect, it } from "vitest";
import { enrichResourceSpans } from "../../src/services/otel-enrich";

/**
 * Contract test for the pure OTLP enricher (008-langsmith-tracing, T010 + T028).
 */

type KV = { key: string; value: Record<string, unknown> };

function attrsOf(spans: unknown[]): KV[] {
  const span = spans[0] as { resource?: { attributes?: KV[] } };
  return span.resource?.attributes ?? [];
}
function find(spans: unknown[], key: string): KV | undefined {
  return attrsOf(spans).find((a) => a.key === key);
}

const baseSpans = (): unknown[] => [
  { resource: { attributes: [{ key: "service.name", value: { stringValue: "convai" } }] }, scopeSpans: [] },
];

describe("enrichResourceSpans", () => {
  it("injects lessonId + ownerId resource attributes when correlated", () => {
    const out = enrichResourceSpans(baseSpans(), { lessonId: "lesson-1", ownerId: "owner-1" });
    expect(find(out, "langsmith.metadata.lessonId")?.value).toEqual({ stringValue: "lesson-1" });
    expect(find(out, "langsmith.metadata.ownerId")?.value).toEqual({ stringValue: "owner-1" });
    // Original attributes are preserved.
    expect(find(out, "service.name")).toBeDefined();
    // Pure: input not mutated.
  });

  it("does not mutate the input array", () => {
    const input = baseSpans();
    const before = JSON.stringify(input);
    enrichResourceSpans(input, { lessonId: "l", ownerId: "o" });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("omits lesson/owner and tags unmatched when correlation misses", () => {
    const out = enrichResourceSpans(baseSpans(), { unmatched: true });
    expect(find(out, "langsmith.metadata.lessonId")).toBeUndefined();
    expect(find(out, "langsmith.metadata.ownerId")).toBeUndefined();
    expect(find(out, "langsmith.metadata.unmatched")?.value).toEqual({ boolValue: true });
  });

  it("sets thread_id = lessonId so the trace joins the lesson Thread (US3)", () => {
    const out = enrichResourceSpans(baseSpans(), { lessonId: "lesson-9", ownerId: "o" });
    expect(find(out, "langsmith.metadata.thread_id")?.value).toEqual({ stringValue: "lesson-9" });
  });

  it("emits filterable session summary attributes (US3)", () => {
    const out = enrichResourceSpans(baseSpans(), {
      lessonId: "l",
      ownerId: "o",
      scenario: "space travel",
      status: "ended",
      turnCount: 7,
      terminationReason: "abandoned",
    });
    expect(find(out, "langsmith.metadata.scenario")?.value).toEqual({ stringValue: "space travel" });
    expect(find(out, "langsmith.metadata.status")?.value).toEqual({ stringValue: "ended" });
    expect(find(out, "langsmith.metadata.turnCount")?.value).toEqual({ intValue: 7 });
    expect(find(out, "langsmith.metadata.termination_reason")?.value).toEqual({
      stringValue: "abandoned",
    });
  });

  it("creates a resource when a span group has none", () => {
    const out = enrichResourceSpans([{ scopeSpans: [] }], { lessonId: "l", ownerId: "o" });
    expect(find(out, "langsmith.metadata.lessonId")).toBeDefined();
  });
});
