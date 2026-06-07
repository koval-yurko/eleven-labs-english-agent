import { describe, expect, it } from "vitest";
import { redactFields } from "../../src/observability";

/** T013 — secret redaction yields zero matches against secret-name/value patterns (FR-012). */

describe("redactFields", () => {
  it("redacts values under secret-looking keys regardless of content", () => {
    const out = redactFields({
      apiKey: "whatever",
      api_key: "whatever",
      ANTHROPIC_API_KEY: "x",
      password: "hunter2",
      authorization: "Basic abc",
      token: "t",
      itemCount: 3,
    });
    expect(out.apiKey).toBe("[redacted]");
    expect(out.api_key).toBe("[redacted]");
    expect(out.ANTHROPIC_API_KEY).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.authorization).toBe("[redacted]");
    expect(out.token).toBe("[redacted]");
    // Non-secret keys pass through untouched.
    expect(out.itemCount).toBe(3);
  });

  it("redacts secret-shaped values even under innocent keys", () => {
    const out = redactFields({
      note: "sk-ant-abcdefghijklmnop0123456789",
      header: "Bearer abcdefghijklmnop",
      jwt: "eyJhbGciOi.eyJzdWIiOi.signature_part",
      plain: "break the ice",
    });
    expect(out.note).toBe("[redacted]");
    expect(out.header).toBe("[redacted]");
    expect(out.jwt).toBe("[redacted]");
    expect(out.plain).toBe("break the ice");
  });

  it("redacts recursively through nested objects and arrays", () => {
    const out = redactFields({
      nested: { secret: "s", deep: { token: "t", ok: 1 } },
      list: ["sk-ant-abcdefghijklmnop0123456789", "fine"],
    });
    const nested = out.nested as Record<string, unknown>;
    expect(nested.secret).toBe("[redacted]");
    expect((nested.deep as Record<string, unknown>).token).toBe("[redacted]");
    expect((nested.deep as Record<string, unknown>).ok).toBe(1);
    expect(out.list).toEqual(["[redacted]", "fine"]);
  });

  it("does not mutate the input", () => {
    const input = { apiKey: "x" };
    redactFields(input);
    expect(input.apiKey).toBe("x");
  });
});
