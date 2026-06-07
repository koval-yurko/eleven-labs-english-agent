import { describe, expect, it } from "vitest";
import { JsonLogger, type LogEntry } from "../../src/observability";

/** T014 — child() context merge, two-child disjointness, emit-failure isolation (FR-014/FR-015). */

describe("JsonLogger child + isolation", () => {
  it("merges parent and child context", () => {
    const lines: string[] = [];
    const root = new JsonLogger({ sink: (l) => lines.push(l), now: () => "t" });
    root.child({ ownerId: "auth0|a" }).child({ lessonId: "lesson_1" }).info("render.total", "m");
    const entry = JSON.parse(lines[0]!) as LogEntry;
    expect(entry.ownerId).toBe("auth0|a");
    expect(entry.lessonId).toBe("lesson_1");
  });

  it("keeps two children's entries separable by their own context (no bleed)", () => {
    const lines: string[] = [];
    const root = new JsonLogger({ sink: (l) => lines.push(l), now: () => "t" });
    const a = root.child({ lessonId: "lesson_a" });
    const b = root.child({ lessonId: "lesson_b" });

    a.info("generate.draft", "a1");
    b.info("generate.draft", "b1");
    a.info("generate.result", "a2");

    const entries = lines.map((l) => JSON.parse(l) as LogEntry);
    expect(entries.filter((e) => e.lessonId === "lesson_a")).toHaveLength(2);
    expect(entries.filter((e) => e.lessonId === "lesson_b")).toHaveLength(1);
    // No entry from one child carries the other's id.
    expect(entries.every((e) => e.lessonId === "lesson_a" || e.lessonId === "lesson_b")).toBe(true);
  });

  it("never propagates a serialization failure to the caller", () => {
    const root = new JsonLogger({
      sink: () => {
        throw new Error("disk full");
      },
      now: () => "t",
    });
    expect(() => root.info("generate.result", "m", { ok: true })).not.toThrow();
  });

  it("never propagates an unserializable payload to the caller", () => {
    const lines: string[] = [];
    const root = new JsonLogger({ sink: (l) => lines.push(l), now: () => "t" });
    const circular: Record<string, unknown> = {};
    circular.self = circular; // JSON.stringify throws on this
    expect(() => root.info("generate.result", "m", circular)).not.toThrow();
    expect(lines).toHaveLength(0);
  });
});
