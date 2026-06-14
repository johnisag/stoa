// @vitest-environment jsdom
/**
 * Regression for B016: MobileTabBar.handleNavigate stores a setTimeout in
 * debounceRef but the component had NO unmount cleanup. Unmounting mid-navigation
 * (the debounce window is 150ms for pty / 500ms for tmux) would later fire
 * `setIsNavigating(false)` on an unmounted component — a leaked timer that calls
 * setState on a gone component.
 *
 * The fix adds `useEffect(() => () => clearTimeout(debounceRef.current), [])`.
 *
 * This test navigates (which awaits the backend probe and then schedules the
 * debounce setTimeout), captures that timer's id, unmounts while it is still
 * pending, and asserts the unmount cleanup called clearTimeout with exactly that
 * id. Before the fix nothing clears it on unmount, so the assertion fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { act, fireEvent, render, cleanup } from "@testing-library/react";

// Backend probe drives the debounce delay; resolve it to "pty" (150ms guard).
const getActiveBackend = vi.fn(() => Promise.resolve("pty" as const));
vi.mock("@/lib/client/backend", () => ({
  getActiveBackend: () => getActiveBackend(),
}));

// Keep the render hermetic: stub the heavier children so we don't drag in
// react-query / server-touching modules.
vi.mock("@/data/verdict-inbox/useAttentionCount", () => ({
  useAttentionCount: () => 0,
}));
vi.mock("@/components/ContextMeter", () => ({ ContextMeter: () => null }));
vi.mock("@/components/AutoApproveBadge", () => ({
  AutoApproveBadge: () => null,
}));

import { MobileTabBar } from "@/components/Pane/MobileTabBar";
import type { Session, Project } from "@/lib/db";

function makeSession(id: string, name: string): Session {
  // Only the fields MobileTabBar reads need to be real; cast the rest.
  return {
    id,
    name,
    project_id: null,
    working_directory: "/work",
    conductor_session_id: null,
    group_path: null,
    auto_approve: 0,
  } as unknown as Session;
}

describe("MobileTabBar — B016 unmount clears the pending navigation timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getActiveBackend.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clears the in-flight debounce timer on unmount", async () => {
    const sessions: Session[] = [
      makeSession("a", "Alpha"),
      makeSession("b", "Beta"),
    ];
    const projects: Project[] = [];

    const { container, unmount } = render(
      createElement(MobileTabBar, {
        session: sessions[0],
        sessions,
        projects,
        viewMode: "terminal" as const,
        isConductor: false,
        workerCount: 0,
        onViewModeChange: () => {},
        onSelectSession: () => {},
      })
    );

    // Spy on the timer APIs AFTER mount (the fake-timer clock is already in play)
    // so we capture only the navigation's setTimeout, not React's internals.
    const setSpy = vi.spyOn(global, "setTimeout");
    const clearSpy = vi.spyOn(global, "clearTimeout");

    // current index is 0 of 2 → "prev" is disabled, "next" is enabled. Clicking
    // the enabled chevron runs handleNavigate, which awaits getActiveBackend()
    // and then schedules the debounce setTimeout.
    const navButtons = Array.from(
      container.querySelectorAll("button")
    ) as HTMLButtonElement[];
    const enabledChevron = navButtons.find(
      (b) => !b.disabled && b.querySelector("svg.lucide-chevron-right")
    );
    expect(enabledChevron).toBeTruthy();

    await act(async () => {
      fireEvent.click(enabledChevron!);
      // Flush the getActiveBackend().then() microtask so the timer is scheduled.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Identify the debounce timer by its pty-guard delay (150ms) so we don't pick
    // up any unrelated timer React's scheduler may have queued during the render.
    const navCallIndex = setSpy.mock.calls.findIndex((c) => c[1] === 150);
    expect(navCallIndex).toBeGreaterThanOrEqual(0);
    const timerId = setSpy.mock.results[navCallIndex].value as ReturnType<
      typeof setTimeout
    >;

    // Unmount while the debounce timer is still pending → cleanup must clear it.
    act(() => {
      unmount();
    });

    expect(clearSpy).toHaveBeenCalledWith(timerId);
  });
});
