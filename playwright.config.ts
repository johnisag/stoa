import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for visual regression tests.
 * Only runs against Chromium for cross-platform screenshot consistency.
 * Tests are in test/visual/ and are separate from the vitest unit suite.
 */
export default defineConfig({
  testDir: "./test/visual",
  testMatch: "**/*.spec.ts",
  // Parallel is fine for screenshot tests (each navigates independently).
  fullyParallel: true,
  // Don't retry on CI — mismatches are real failures.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    // Visual tests run against a running dev server; the base URL is overridden
    // by PLAYWRIGHT_BASE_URL if set (useful in CI or for pointing at a build).
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3011",
    // No headless on Windows by default to match the CI ubuntu runner appearance;
    // override via PLAYWRIGHT_HEADED=1.
    headless: process.env.PLAYWRIGHT_HEADED !== "1",
    // Stable viewport for reproducible screenshots.
    viewport: { width: 1280, height: 800 },
    // Don't record video/traces by default; attach on failure.
    video: "off",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // The visual tests require the app to be running. In CI the workflow starts
  // the dev server first; locally run `npm run dev` before `npm run test:visual`.
  // webServer is intentionally NOT configured here because `npm run dev` is a
  // long-lived process that CI manages separately — adding webServer would spawn
  // a second instance and collide on port 3011.
});
