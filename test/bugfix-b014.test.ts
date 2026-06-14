// @vitest-environment jsdom
/**
 * Regression for B014: the OPEN-socket relaunch branch must preserve scrollback.
 *
 * On relaunch over an already-open socket the hook re-sends attach-with-spawn,
 * and the SERVER answers with a "reset" frame right before replaying the
 * snapshot. That reset is driven through the `onReset` callback, which clears
 * the xterm UNLESS preserveOnReattachRef was set. The bug: only the dropped-
 * socket else branch set that flag, so the open-socket relaunch let the server's
 * reset wipe the scrollback the comment promised to keep.
 *
 * This test fires onReset after relaunch and asserts the terminal is NOT reset
 * (history preserved). It also fires a SECOND onReset to prove the flag is
 * consumed once, so a later legitimate reset still clears the buffer.
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

describe("useTerminalConnection — B014 open-socket relaunch preserves scrollback", () => {
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

  it("server reset after an open-socket relaunch does NOT clear the terminal", () => {
    const terminalRef = { current: document.createElement("div") };
    const { result } = renderHook(() =>
      useTerminalConnection({ terminalRef, isMobile: false, theme: "dark" })
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const callbacks = vi.mocked(createWebSocketConnection).mock.calls[0][1];

    // Explicit first attach sets the payload (prev key null → one reset).
    act(() => {
      result.current.attachSession({
        key: "claude-1",
        spawn: { binary: "claude", args: [], cwd: "." },
      });
    });

    // Agent exits → ended gate set.
    act(() => {
      callbacks.onExit?.();
    });
    expect(result.current.sessionEnded).toBe(true);

    // Relaunch over the open socket, then the server replays its snapshot,
    // preceded by a "reset" frame (the onReset callback).
    act(() => {
      result.current.relaunch();
    });
    term.reset.mockClear();
    act(() => {
      callbacks.onReset?.();
    });

    // The post-relaunch reset is skipped → scrollback (prior output +
    // [Session ended] marker) is preserved.
    expect(term.reset).not.toHaveBeenCalled();
  });

  it("consumes the preserve flag once — a LATER reset still clears the buffer", () => {
    const terminalRef = { current: document.createElement("div") };
    const { result } = renderHook(() =>
      useTerminalConnection({ terminalRef, isMobile: false, theme: "dark" })
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });

    const callbacks = vi.mocked(createWebSocketConnection).mock.calls[0][1];
    act(() => {
      result.current.attachSession({
        key: "claude-1",
        spawn: { binary: "claude", args: [], cwd: "." },
      });
    });
    act(() => {
      callbacks.onExit?.();
    });
    act(() => {
      result.current.relaunch();
    });

    term.reset.mockClear();
    // First reset after relaunch: preserved (flag consumed).
    act(() => {
      callbacks.onReset?.();
    });
    expect(term.reset).not.toHaveBeenCalled();

    // A SECOND, unrelated reset (e.g. a real reconnect snapshot) must clear.
    act(() => {
      callbacks.onReset?.();
    });
    expect(term.reset).toHaveBeenCalledTimes(1);
  });
});
