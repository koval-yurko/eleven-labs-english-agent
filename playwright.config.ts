import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E config (T050, SC-009). Runs the submit → generate → replay flow across a
 * desktop and a mobile viewport. Both projects use Chromium so a single `playwright install
 * chromium` is enough (no WebKit download needed).
 *
 * Running it:
 *   - Against an already-running app:  E2E_BASE_URL=http://localhost:3000 pnpm test:e2e
 *   - Self-starting dev server:        pnpm test:e2e   (uses the webServer block below)
 *
 * The authenticated flow needs a signed-in session. Provide a Playwright storageState file
 * via E2E_STORAGE_STATE (created once by logging in through Auth0) — without it, the
 * authenticated test self-skips and only the unauthenticated gating checks run.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "apps/web/tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "Desktop Chrome",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
  ],
  // Only self-start a server when the caller hasn't pointed us at a running one.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "pnpm --filter @idiomatic/web dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
