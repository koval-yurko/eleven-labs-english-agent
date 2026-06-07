import { test, expect } from "@playwright/test";

/**
 * T039 — end-to-end live-tutor surface across desktop + mobile viewports.
 *
 * The realtime voice transport (mic, STT, barge-in, TTS) is owned by ElevenLabs and
 * cannot be driven from Playwright, so this spec verifies the parts we own:
 *  1. Unauthenticated gating (always runs): the live-session + exchanges APIs reject
 *     anonymous callers (FR-017/FR-018).
 *  2. Authenticated (only with E2E_STORAGE_STATE): a ready lesson shows the live-tutor
 *     panel with the hands-free affordance next to the player.
 *
 * Both Playwright projects (Desktop Chrome, Pixel 5) run every test (SC-010).
 */

test.describe("unauthenticated gating (FR-017/FR-018)", () => {
  test("live-tutor APIs reject anonymous callers", async ({ request }) => {
    const liveSession = await request.post("/api/lessons/some-id/live-session", { data: {} });
    expect(liveSession.status()).toBe(401);

    const postExchange = await request.post("/api/lessons/some-id/exchanges", {
      data: { interruptionPositionSeconds: 0, turns: [{ role: "learner", text: "hi", turnIndex: 0 }] },
    });
    expect(postExchange.status()).toBe(401);

    const listExchanges = await request.get("/api/lessons/some-id/exchanges");
    expect(listExchanges.status()).toBe(401);
  });
});

const storageState = process.env.E2E_STORAGE_STATE;

test.describe("authenticated live-tutor surface", () => {
  test.skip(
    !storageState,
    "Set E2E_STORAGE_STATE to a signed-in Auth0 session to run the authenticated surface.",
  );
  test.use({ storageState });

  test("a ready lesson shows the live-tutor panel next to the player", async ({ page }) => {
    // Generate a short lesson.
    await page.goto("/lessons/new");
    await page.getByRole("textbox").fill(["break the ice", "spill the beans"].join("\n"));
    await page.getByRole("button", { name: /generate lesson/i }).click();

    // Wait for it to become ready (player appears).
    await expect(page).toHaveURL(/\/lessons\/[^/]+$/);
    await expect(page.locator("audio")).toBeVisible({ timeout: 120_000 });

    // The live-tutor panel and its hands-free affordance are present (US1).
    await expect(page.getByText("Live tutor")).toBeVisible();
    await expect(page.getByRole("button", { name: /enable live q&a/i })).toBeVisible();
  });
});
