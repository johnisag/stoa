import { type Page, expect } from "@playwright/test";

/**
 * Take a screenshot of the page and compare it against the stored baseline.
 * Baselines live in test/visual/baselines/ (configured via snapshotDir in
 * playwright.config.ts) and are checked into the repo.
 *
 * Generate / update: npm run test:visual:update
 */
export async function matchBaseline(
  page: Page,
  name: string,
  opts: { maxDiffPixelRatio?: number; threshold?: number } = {}
) {
  await expect(page).toHaveScreenshot(`${name}.png`, {
    maxDiffPixelRatio: opts.maxDiffPixelRatio ?? 0.02,
    threshold: opts.threshold ?? 0.1,
    animations: "disabled",
  });
}

/**
 * Wait until the app shell has hydrated (the spinner is gone and the
 * sidebar is visible). Avoids false-positive diffs from loading states.
 */
export async function waitForAppReady(page: Page) {
  // The loading spinner has class `animate-spin`; wait until it disappears.
  await page
    .locator(".animate-spin")
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => {
      /* spinner may never appear in fast environments — that's fine */
    });
  // Also wait for the network to quiet down so data-driven content is stable.
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    /* networkidle is a best-effort signal */
  });
}
