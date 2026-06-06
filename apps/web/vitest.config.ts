import { defineConfig } from "vitest/config";

/**
 * Vitest collects the web app's unit/contract/integration tests (`*.test.ts`). Playwright
 * E2E specs (`tests/e2e/*.spec.ts`, T050) import `@playwright/test` and must NOT be run by
 * Vitest — they run via `pnpm test:e2e`. Restricting the include to `*.test.ts` keeps the
 * two runners cleanly separated.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "tests/e2e/**"],
  },
});
