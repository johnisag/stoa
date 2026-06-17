import { test, expect } from "@playwright/test";
import { waitForHydration } from "./helpers";

/**
 * app-shell — screenshots the initial app chrome after hydration with no
 * sessions in the DB. Captures the header, sidebar (expanded), and the empty
 * pane area.
 */
test("app shell — empty state", async ({ page }) => {
  await page.goto("/");
  await waitForHydration(page);

  // The desktop sidebar opens automatically after hydration on a 1440px
  // viewport. Wait for it to be visible before snapping.
  await page.waitForSelector(".bg-sidebar-background", { timeout: 5_000 });

  await expect(page).toHaveScreenshot("app-shell-empty.png", {
    fullPage: false,
  });
});
