import { type Page, expect } from "@playwright/test";
import * as path from "path";
import * as fs from "fs";

/**
 * Absolute path to the committed baseline screenshots directory.
 * Baselines are checked into the repo so mismatches are surfaced on CI.
 */
export const BASELINE_DIR = path.join(
  __dirname,
  "../..",
  "test/visual/baselines"
);

/**
 * Take a screenshot of the page and compare it against the stored baseline.
 *
 * @param page   - Playwright Page
 * @param name   - Baseline filename (without extension), e.g. "app-shell"
 * @param opts   - Optional overrides passed to toMatchSnapshot
 */
export async function matchBaseline(
  page: Page,
  name: string,
  opts: { maxDiffPixelRatio?: number; threshold?: number } = {}
) {
  const snapshotPath = path.join(BASELINE_DIR, `${name}.png`);

  // If the baseline doesn't exist yet we write it on the first run.
  // `npm run test:visual:update` also regenerates them explicitly.
  if (!fs.existsSync(snapshotPath)) {
    fs.mkdirSync(BASELINE_DIR, { recursive: true });
  }

  await expect(page).toHaveScreenshot(`${name}.png`, {
    maxDiffPixelRatio: opts.maxDiffPixelRatio ?? 0.02,
    threshold: opts.threshold ?? 0.1,
    // Store alongside test files under baselines/ for discoverability.
    snapshotDir: BASELINE_DIR,
    // Suppress animation jitter.
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
