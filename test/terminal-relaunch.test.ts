// @vitest-environment jsdom
/**
 * Regression: relaunching an ended session must PRESERVE the terminal
 * scrollback (prior output + the [Session ended] marker) — it must not reset()
 * the xterm. The respawned agent's output appends below the kept history.
 * (Reported: typed "hello", exited, relaunched → "hello" was gone.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const term = { onScroll: vi.fn(), dispose: vi.fn(), reset: vi.fn() };
const fakeWsSend = vi.fn();

vi.mock("@/components/Terminal/hooks/terminal-init", () => ({
  createTerminal: vi.fn(() => ({
    term,
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
  // Simulate an OPEN socket so relaunch takes the open-socket path.
  createWebSocketConnection: vi.fn((_term, _callbacks, wsRef) => {
    wsRef.current = { readyState: 1, send: fakeWsSend };
    return { cleanup: vi.fn(), reconnect: vi.fn(), sendResize: vi.fn() };
  }),
}));

import { createWebSocketConnection } from "@/components/Terminal/hooks/websocket-connection";
import { useTerminalConnection } from "@/components/Terminal/hooks/useTerminalConnection";

describe("useTerminalConnection — relaunch preserves scrollback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    term.reset.mockClear();
    fakeWsSend.mockClear();
    vi.mocked(createWebSocketConnection).mockClear();
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      static OPEN = 1;
    };
  });
  afterEach(() => vi.useRealTimers());

  it("relaunch sends attach-with-spawn but does NOT reset the terminal", () => {
    const terminalRef = { current: document.createElement("div") };
    const { result } = renderHook(() =>
      useTerminalConnection({ terminalRef, isMobile: false, theme: "dark" })
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Explicit first attach sets the payload (prev key null → one reset).
    act(() => {
      result.current.attachSession({
        key: "claude-1",
        spawn: { binary: "claude", args: [], cwd: "." },
      });
    });
    const resetsAfterAttach = term.reset.mock.calls.length;

    // Agent exits → ended gate set.
    const callbacks = vi.mocked(createWebSocketConnection).mock.calls[0][1];
    act(() => {
      callbacks.onExit?.();
    });
    expect(result.current.sessionEnded).toBe(true);

    fakeWsSend.mockClear();
    act(() => {
      result.current.relaunch();
    });

    // No extra reset (scrollback kept), ended cleared, fresh attach-with-spawn.
    expect(term.reset.mock.calls.length).toBe(resetsAfterAttach);
    expect(result.current.sessionEnded).toBe(false);
    const attach = fakeWsSend.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((m) => m.type === "attach");
    expect(attach).toBeTruthy();
    expect(attach.spawn).toEqual({ binary: "claude", args: [], cwd: "." });
  });
});
