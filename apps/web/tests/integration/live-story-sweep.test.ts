import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration (008-langsmith-tracing, T024): the scheduled sweep route's cron-secret guard and
 * its success envelope. Runs against the in-memory stack (no Supabase env in CI), so the sweep
 * over an empty store returns a zero result — the point here is the auth gate + wiring.
 */

const SECRET = "cron_test_secret";
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  process.env.CRON_SECRET = SECRET;
  ({ POST } = await import("../../app/api/live-story/sweep/route"));
});
afterAll(() => {
  delete process.env.CRON_SECRET;
});

function call(headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request("http://localhost/api/live-story/sweep", { method: "POST", headers }));
}

describe("POST /api/live-story/sweep", () => {
  it("rejects a missing Authorization header with 401", async () => {
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret with 401", async () => {
    const res = await call({ authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("runs the sweep and returns {scanned, finalized} for a valid secret", async () => {
    const res = await call({ authorization: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scanned: number; finalized: number };
    expect(body).toHaveProperty("scanned");
    expect(body).toHaveProperty("finalized");
    expect(typeof body.finalized).toBe("number");
  });
});
