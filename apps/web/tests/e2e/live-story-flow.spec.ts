import { test, expect } from "@playwright/test";

/**
 * T050 — end-to-end live-story surface across desktop + mobile viewports (FR-029/SC-013).
 *
 * The realtime voice transport (mic, STT, barge-in, streaming TTS) is owned by ElevenLabs
 * and cannot be driven from Playwright, so this spec verifies the parts the app owns:
 *  1. Unauthenticated gating (always runs): the live-story, turns, and transcript APIs all
 *     reject anonymous callers (FR-028).
 *  2. Authenticated (only with E2E_STORAGE_STATE): a ready lesson opens directly into the Live
 *     Story panel with its start affordance and NO <audio> element at all (007-live-only).
 *
 * The narration → barge-in → resume, scenario-steer → coverage, and barge-in caption
 * correction behaviours are exercised by the pure-state unit tests (narration-state.test.ts)
 * and the contract/integration suites against a faked transport, which DO run in CI.
 * Both Playwright projects (Desktop Chrome, Pixel 5) run every test.
 */

test.describe("unauthenticated gating (FR-028)", () => {
  test("live-story APIs reject anonymous callers", async ({ request }) => {
    const start = await request.post("/api/lessons/some-id/live-story", { data: {} });
    expect(start.status()).toBe(401);

    const turns = await request.post("/api/lessons/some-id/live-story/turns", {
      data: { sessionId: "s1", turns: [{ role: "teacher", kind: "narration", text: "hi" }] },
    });
    expect(turns.status()).toBe(401);

    const transcript = await request.get("/api/lessons/some-id/transcript");
    expect(transcript.status()).toBe(401);
  });
});

const storageState = process.env.E2E_STORAGE_STATE;

test.describe("authenticated live-story surface", () => {
  test.skip(
    !storageState,
    "Set E2E_STORAGE_STATE to a signed-in Auth0 session to run the authenticated surface.",
  );
  test.use({ storageState });

  test("a ready lesson opens directly into the Live Story with no audio element", async ({ page }) => {
    await page.goto("/lessons/new");
    await page.getByRole("textbox").fill(["break the ice", "spill the beans"].join("\n"));
    await page.getByRole("button", { name: /generate lesson/i }).click();

    await expect(page).toHaveURL(/\/lessons\/[^/]+$/);

    // The ready lesson presents exactly one experience: the live, hands-free story (US2/SC-002).
    await expect(page.getByText("Live Story")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: /start live story/i })).toBeVisible();
    // No pre-rendered audio player anywhere on the page (007-live-only).
    expect(await page.locator("audio").count()).toBe(0);
  });
});
