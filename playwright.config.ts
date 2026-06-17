import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/visual",
  snapshotDir: "./test/visual/baselines",
  outputDir: "./test-results/visual",

  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],

  // Single Chromium project — pixel output is only deterministic on one
  // browser+OS combination. The CI job locks to ubuntu-latest.
  projects: [
    {
      name: "visual",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        timezoneId: "UTC",
      },
    },
  ],

  use: {
    baseURL: "http://localhost:3011",
    actionTimeout: 10_000,
  },

  // Start the dev server. `reuseExistingServer` lets local dev reuse a
  // running instance; CI always starts fresh.
  webServer: {
    command:
      "cross-env DB_PATH=./tmp/visual-test.db STOA_AUTH=off npm run dev",
    url: "http://localhost:3011",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DB_PATH: "./tmp/visual-test.db",
      STOA_AUTH: "off",
    },
  },

  // Pixel comparison thresholds: 10% per-pixel color tolerance, up to 1% of
  // total pixels allowed to differ (handles sub-pixel anti-aliasing variance).
  expect: {
    toHaveScreenshot: {
      threshold: 0.1,
      maxDiffPixelRatio: 0.01,
    },
    timeout: 30_000,
  },

  timeout: 30_000,
});
