import type { Page } from "@playwright/test";

export const BASE_URL = "http://localhost:3011";

/**
 * Wait for the SPA to finish hydrating.
 *
 * The loading spinner (animate-spin) is present while !isHydrated in app/page.tsx.
 * Once hydration is complete the spinner is removed and either DesktopView or
 * MobileView renders. We also wait for network to become idle so data fetches
 * (sessions, projects) have had a chance to settle.
 */
export async function waitForHydration(page: Page): Promise<void> {
  // Wait for the spinner to disappear (hydration gate in app/page.tsx).
  await page.waitForFunction(
    () => document.querySelector(".animate-spin") === null,
    { timeout: 15_000 }
  );
  // Let any triggered fetch settle.
  await page.waitForLoadState("networkidle");
}

/**
 * POST a project fixture so the session-list screenshot is non-empty.
 * Returns the new project id.
 */
export async function seedProject(page: Page): Promise<string> {
  const res = await page.request.post(`${BASE_URL}/api/projects`, {
    data: { name: "Visual Test Project", workingDirectory: "/tmp" },
  });
  const data = (await res.json()) as { project: { id: string } };
  return data.project.id;
}

/**
 * POST a session fixture attached to the given project.
 */
export async function seedSession(
  page: Page,
  projectId: string
): Promise<void> {
  await page.request.post(`${BASE_URL}/api/sessions`, {
    data: {
      name: "Visual Test Agent",
      workingDirectory: "/tmp",
      agentType: "claude",
      projectId,
    },
  });
}
