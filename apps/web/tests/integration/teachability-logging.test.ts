import { describe, expect, it } from "vitest";
import { captureLogger, makeHarness } from "../helpers";

/** T026 (US3) — per-item teachability.item records decision/itemType/skipReason; text @debug only. */

const OWNER = "auth0|alice";
// One teachable idiom + one duplicate (skipped) so both decisions appear.
const INPUT = ["break the ice", "break the ice", "12345"];

describe("teachability logging", () => {
  it("logs a decision + type per item, and a summary, without raw text at info", async () => {
    const cap = captureLogger("info");
    const { service } = makeHarness({ logger: cap.logger });

    const outcome = await service.createLesson(OWNER, INPUT);
    if (!outcome.ok) throw new Error("expected ok");

    const trail = cap.forLesson(outcome.lesson.id);

    const summary = trail.find((e) => e.event === "teachability.summary");
    expect(summary?.fields).toMatchObject({ requested: 3, accepted: 1, skipped: 2 });

    const items = trail.filter((e) => e.event === "teachability.item");
    expect(items).toHaveLength(3);

    const accepted = items.find((e) => e.fields?.decision === "accepted");
    expect(accepted?.fields?.itemType).toBeDefined();
    expect(accepted?.fields?.text).toBeUndefined(); // privacy: no raw text at info

    const dup = items.find((e) => e.fields?.skipReason === "duplicate");
    expect(dup?.fields?.decision).toBe("skipped");
  });

  it("includes raw item text only at debug level (FR-017)", async () => {
    const cap = captureLogger("debug");
    const { service } = makeHarness({ logger: cap.logger });

    const outcome = await service.createLesson(OWNER, ["break the ice"]);
    if (!outcome.ok) throw new Error("expected ok");

    const item = cap
      .forLesson(outcome.lesson.id)
      .find((e) => e.event === "teachability.item");
    expect(item?.fields?.text).toBe("break the ice");
  });
});
