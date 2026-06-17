import { test, expect } from "@playwright/test";
import { waitForHydration } from "./helpers";

/**
 * workflows — navigates to the Workflows view via the keyboard shortcut
 * (Ctrl+Shift+Z, which maps to "open-workflows" in NAV_KEYBINDINGS) and
 * screenshots the WorkflowBuilder canvas.
 *
 * The shortcut is preferred over a click-based navigation because the nav
 * button selector could change; the keyboard action is wired to a stable
 * action string in app/page.tsx.
 */
test("workflows view — builder canvas", async ({ page }) => {
  await page.goto("/");
  await waitForHydration(page);

  // Open the Workflows pane tab via the registered keyboard shortcut.
  await page.keyboard.press("Control+Shift+Z");

  // Wait for the workflows view to mount. The WorkflowBuilder renders a
  // canvas root; wait for any element with "workflow" in its data-testid or
  // for text content that signals the builder loaded.
  // Fall back to a short idle wait if neither materialises quickly.
  await page
    .waitForSelector('[data-view="workflows"], [data-testid*="workflow"]', {
      timeout: 5_000,
    })
    .catch(() =>
      page.waitForTimeout(1_500)
    );

  await expect(page).toHaveScreenshot("workflows-builder.png", {
    fullPage: false,
  });
});
