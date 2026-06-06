import { describe, expect, it } from "vitest";
import { classifyInput, parseEntries } from "../../src/index.js";

/** Teachability classifier + normalize/dedupe (FR-002, FR-003, research R9). */

describe("parseEntries", () => {
  it("splits newline-delimited input and drops blank lines", () => {
    expect(parseEntries("break the ice\n\n  spill the beans  \n")).toEqual([
      "break the ice",
      "spill the beans",
    ]);
  });

  it("accepts an array as-is, trimming entries", () => {
    expect(parseEntries(["  hello ", "world"])).toEqual(["hello", "world"]);
  });
});

describe("classifyInput", () => {
  it("accepts valid words, idioms, and sentences with the right type", () => {
    const { items, accepted } = classifyInput([
      "serendipity",
      "break the ice",
      "It was raining cats and dogs all weekend long here.",
    ]);
    expect(accepted).toHaveLength(3);
    expect(items.map((i) => i.itemType)).toEqual(["word", "idiom", "sentence"]);
  });

  it("treats duplicates (case-insensitive) as a single teachable item (FR-003)", () => {
    const { accepted, skipped } = classifyInput(["Break the ice", "break the ice"]);
    expect(accepted).toHaveLength(1);
    expect(skipped).toEqual([{ rawText: "break the ice", reason: "duplicate" }]);
  });

  it("skips non-English text", () => {
    const { skipped } = classifyInput(["こんにちは"]);
    expect(skipped[0]?.reason).toBe("non_english");
  });

  it("skips gibberish (no vowels / digits-only)", () => {
    const { skipped } = classifyInput(["xkcdfgh", "12345"]);
    expect(skipped.map((s) => s.reason)).toEqual(["gibberish", "gibberish"]);
  });

  it("skips an over-long pasted paragraph as not_discrete", () => {
    const paragraph = Array.from({ length: 40 }, () => "word").join(" ");
    const { skipped } = classifyInput([paragraph]);
    expect(skipped[0]?.reason).toBe("not_discrete");
  });
});
