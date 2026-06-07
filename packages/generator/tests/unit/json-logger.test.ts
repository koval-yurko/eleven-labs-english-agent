import { describe, expect, it } from "vitest";
import { JsonLogger, type LogEntry } from "../../src/observability";

/** T012 — level filtering + required-field invariants on emitted LogEntry (FR-004/FR-013). */

function capture(level: "debug" | "info" | "warn" | "error") {
  const lines: string[] = [];
  const logger = new JsonLogger({
    level,
    sink: (line) => lines.push(line),
    now: () => "2026-06-06T12:00:00.000Z",
  });
  return { logger, lines };
}

describe("JsonLogger", () => {
  it("drops entries below the configured level", () => {
    const { logger, lines } = capture("info");
    logger.debug("generate.draft", "should be dropped");
    logger.info("generate.result", "kept");
    logger.warn("generate.coverage", "kept");
    logger.error("generate.error", "kept");

    expect(lines).toHaveLength(3);
    const events = lines.map((l) => (JSON.parse(l) as LogEntry).event);
    expect(events).toEqual(["generate.result", "generate.coverage", "generate.error"]);
  });

  it("includes debug entries when the level is debug", () => {
    const { logger, lines } = capture("debug");
    logger.debug("generate.draft", "kept at debug");
    expect(lines).toHaveLength(1);
  });

  it("emits all required fields on every entry", () => {
    const { logger, lines } = capture("info");
    logger.child({ lessonId: "lesson_1", ownerId: "auth0|x" }).info("render.total", "done", {
      bytes: 10,
    });

    const entry = JSON.parse(lines[0]!) as LogEntry;
    expect(entry.ts).toBe("2026-06-06T12:00:00.000Z");
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("render.total");
    expect(entry.lessonId).toBe("lesson_1");
    expect(entry.ownerId).toBe("auth0|x");
    expect(entry.msg).toBe("done");
    expect(entry.fields).toEqual({ bytes: 10 });
  });

  it("emits an explicit null lessonId before correlation", () => {
    const { logger, lines } = capture("info");
    logger.info("lesson.status", "pre-correlation");
    const entry = JSON.parse(lines[0]!) as LogEntry;
    expect(entry.lessonId).toBeNull();
    expect("lessonId" in entry).toBe(true);
  });

  it("renders human-readable lines when pretty is set", () => {
    const lines: string[] = [];
    const logger = new JsonLogger({
      level: "info",
      pretty: true,
      sink: (line) => lines.push(line),
      now: () => "2026-06-06T12:00:00.000Z",
    });
    logger.child({ lessonId: "lesson_1" }).info("render.total", "done", { bytes: 10 });
    expect(lines[0]).toContain("render.total");
    expect(lines[0]).toContain("(lesson_1)");
    expect(() => JSON.parse(lines[0]!)).toThrow();
  });
});
