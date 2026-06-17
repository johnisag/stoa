import { test, expect } from "@playwright/test";
import { waitForHydration, seedProject, seedSession } from "./helpers";

/**
 * session-list — seeds one project + one session via the API before loading
 * the page, then screenshots the populated sidebar session list.
 */
test.beforeAll(async ({ browser }) => {
  // Use a dedicated page to seed data before the test page navigates.
  const page = await browser.newPage();
  const projectId = await seedProject(page);
  await seedSession(page, projectId);
  await page.close();
});

test("session list — populated", async ({ page }) => {
  await page.goto("/");
  await waitForHydration(page);

  // Wait for at least one session card to appear in the sidebar.
  await page.waitForSelector(".bg-sidebar-background", { timeout: 5_000 });

  await expect(page).toHaveScreenshot("session-list-populated.png", {
    fullPage: false,
  });
});
