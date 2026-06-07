import { test, expect } from "@playwright/test";

/**
 * T050 — end-to-end lesson flow across desktop + mobile viewports (SC-009).
 *
 * Two layers:
 *  1. Unauthenticated gating (always runs): the API rejects anonymous callers (FR-017).
 *  2. Authenticated submit → generate → reopen (runs only when an Auth0 session is supplied
 *     via E2E_STORAGE_STATE — see playwright.config.ts). The ready lesson opens directly into
 *     the live story — there is NO pre-rendered <audio> player (007-live-only, US2/SC-002).
 *
 * Both Playwright projects (Desktop Chrome, Pixel 5) execute every test, so the responsive
 * behavior is covered without duplicating specs.
 */

test.describe("unauthenticated gating (FR-017)", () => {
  test("the lessons API rejects anonymous callers", async ({ request }) => {
    const post = await request.post("/api/lessons", { data: { items: ["break the ice"] } });
    expect(post.status()).toBe(401);

    const list = await request.get("/api/lessons");
    expect(list.status()).toBe(401);
  });
});

const storageState = process.env.E2E_STORAGE_STATE;

test.describe("authenticated submit → generate → replay (SC-009)", () => {
  test.skip(
    !storageState,
    "Set E2E_STORAGE_STATE to a signed-in Auth0 session to run the full flow.",
  );
  test.use({ storageState });

  test("a learner submits a list, reaches the live story, and reopens it from the library", async ({
    page,
  }) => {
    // Submit a short list.
    await page.goto("/lessons/new");
    await expect(page.getByRole("heading", { name: "New lesson" })).toBeVisible();
    await page
      .getByRole("textbox")
      .fill(["break the ice", "spill the beans", "under the weather"].join("\n"));
    await page.getByRole("button", { name: /generate lesson/i }).click();

    // We land on the lesson page; it shows progress, then becomes ready as the live story.
    await expect(page).toHaveURL(/\/lessons\/[^/]+$/);
    await expect(page.getByRole("button", { name: /start live story/i })).toBeVisible({
      timeout: 120_000,
    });
    // The lesson opens directly into the live story — no pre-rendered audio player (US2/SC-002).
    expect(await page.locator("audio").count()).toBe(0);

    // Every submitted item is listed as taught (FR-009/SC-002).
    await expect(page.getByText("Taught in this lesson")).toBeVisible();
    for (const item of ["break the ice", "spill the beans", "under the weather"]) {
      await expect(page.getByText(item, { exact: false })).toBeVisible();
    }

    const lessonUrl = page.url();

    // Reopen from the library: it appears in the list and reopens into the live story.
    await page.goto("/lessons");
    const link = page.getByRole("link", { name: /break the ice/i }).first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole("button", { name: /start live story/i })).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.locator("audio").count()).toBe(0);

    // The deep link still works (cross-session reopen surface).
    await page.goto(lessonUrl);
    await expect(page.getByRole("button", { name: /start live story/i })).toBeVisible({
      timeout: 30_000,
    });
    expect(await page.locator("audio").count()).toBe(0);
  });
});
