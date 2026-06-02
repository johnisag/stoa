// @vitest-environment jsdom
/**
 * Regression test for the "stacked startup banners on resize / theme switch" bug.
 *
 * Root cause: the main connection effect in `useTerminalConnection` listed
 * `isMobile` and `theme` in its dependency array. Crossing the 768px breakpoint
 * (dragging the window width back and forth) or toggling the theme would tear
 * down the WebSocket + dispose the xterm and re-attach to the pty — and if the
 * backend session wasn't alive, re-spawn the agent, reprinting its startup
 * banner at the new width. Repeated crossings stacked several banners.
 *
 * Invariant locked here: the terminal + WebSocket are built ONCE per mount;
 * changing `isMobile` / `theme` must NOT rebuild them (the live font/theme
 * updates are handled by separate effects). This test fails if `isMobile` or
 * `theme` is re-added to the connection effect's dependency array.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// Mock every heavy sub-module so the hook runs without a real xterm,
// WebSocket, or canvas — we only care how often the connection is built.
vi.mock("@/components/Terminal/hooks/terminal-init", () => ({
  createTerminal: vi.fn(() => ({
    term: { onScroll: vi.fn(), dispose: vi.fn(), reset: vi.fn() },
    fitAddon: {},
    searchAddon: {},
    cleanup: vi.fn(),
  })),
  updateTerminalForMobile: vi.fn(),
  updateTerminalTheme: vi.fn(),
}));
vi.mock("@/components/Terminal/hooks/touch-scroll", () => ({
  setupTouchScroll: vi.fn(() => vi.fn()),
}));
vi.mock("@/components/Terminal/hooks/resize-handlers", () => ({
  setupResizeHandlers: vi.fn(() => vi.fn()),
}));
vi.mock("@/components/Terminal/hooks/websocket-connection", () => ({
  createWebSocketConnection: vi.fn(() => ({
    cleanup: vi.fn(),
    reconnect: vi.fn(),
    sendResize: vi.fn(),
  })),
}));

import { createWebSocketConnection } from "@/components/Terminal/hooks/websocket-connection";
import { createTerminal } from "@/components/Terminal/hooks/terminal-init";
import { useTerminalConnection } from "@/components/Terminal/hooks/useTerminalConnection";

describe("useTerminalConnection — connection built once per mount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createWebSocketConnection).mockClear();
    vi.mocked(createTerminal).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not rebuild the socket/terminal when isMobile flips (resize-banner bug)", () => {
    const terminalRef = { current: document.createElement("div") };

    const { rerender } = renderHook(
      ({ isMobile, theme }) =>
        useTerminalConnection({ terminalRef, isMobile, theme }),
      { initialProps: { isMobile: false, theme: "dark" } }
    );

    // Setup runs behind a 150ms connect timer.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(createWebSocketConnection).toHaveBeenCalledTimes(1);
    expect(createTerminal).toHaveBeenCalledTimes(1);

    // Cross the 768px breakpoint repeatedly (dragging width across it).
    act(() => {
      rerender({ isMobile: true, theme: "dark" });
      vi.advanceTimersByTime(200);
    });
    act(() => {
      rerender({ isMobile: false, theme: "dark" });
      vi.advanceTimersByTime(200);
    });

    // Still exactly one connection — no teardown / re-attach / re-spawn.
    expect(createWebSocketConnection).toHaveBeenCalledTimes(1);
    expect(createTerminal).toHaveBeenCalledTimes(1);
  });

  it("does not rebuild the socket/terminal when the theme changes", () => {
    const terminalRef = { current: document.createElement("div") };

    const { rerender } = renderHook(
      ({ theme }) =>
        useTerminalConnection({ terminalRef, isMobile: false, theme }),
      { initialProps: { theme: "dark" } }
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(createWebSocketConnection).toHaveBeenCalledTimes(1);

    act(() => {
      rerender({ theme: "light" });
      vi.advanceTimersByTime(200);
    });

    expect(createWebSocketConnection).toHaveBeenCalledTimes(1);
  });
});
