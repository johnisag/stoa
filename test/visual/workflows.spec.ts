import { test } from "@playwright/test";
import { matchBaseline, waitForAppReady } from "./helpers";

/**
 * Visual regression tests for 3 key views:
 *   1. app-shell   — the root page after hydration (empty-state / loading)
 *   2. session-list — the sidebar with the session list visible
 *   3. workflows   — the Workflows view opened from the nav
 *
 * Run:        npm run test:visual
 * Update:     npm run test:visual:update
 * View diffs: open /visual-diff in the dev server
 */

test.describe("Visual baselines", () => {
  test("app-shell", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    // Mask any dynamic timestamps or session names to avoid churn.
    await matchBaseline(page, "app-shell");
  });

  test("session-list", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    // On desktop the sidebar starts open (useEffect sets sidebarOpen=true).
    // Wait for at least one session-list item OR the empty state message.
    await page
      .locator(
        '[data-testid="session-list"], [data-testid="empty-session-list"], .session-list-header, [class*="SessionList"]'
      )
      .first()
      .waitFor({ timeout: 8_000 })
      .catch(() => {
        /* component may not have data-testid — the screenshot will show whatever renders */
      });
    await matchBaseline(page, "session-list");
  });

  test("workflows", async ({ page }) => {
    await page.goto("/");
    await waitForAppReady(page);
    // Trigger the Workflows view via keyboard shortcut (Ctrl+Shift+Z on non-mac).
    await page.keyboard.press("Control+Shift+Z");
    // Wait for the WorkflowBuilder / workflows header to appear.
    await page
      .locator(
        '[data-testid="workflows-view"], [class*="WorkflowBuilder"], [class*="WorkflowsView"]'
      )
      .first()
      .waitFor({ timeout: 8_000 })
      .catch(() => {
        /* fallback: screenshot whatever rendered */
      });
    await matchBaseline(page, "workflows");
  });
});
