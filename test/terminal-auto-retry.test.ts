// @vitest-environment jsdom
/**
 * Hook wiring for auto-retry (the logic the pure helpers in auto-retry.test.ts
 * can't cover): a TRANSIENT exit arms a capped, backed-off retry whose timer
 * fires the existing attach-with-spawn relaunch; a NON-transient exit and a CLEAN
 * exit (code 0) do NOT arm; Cancel stops a pending retry; the cap stops the loop.
 * Mirrors terminal-relaunch.test.ts, with a buffer-bearing fake term so the
 * screen-tail classifier sees real text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// A fake xterm whose buffer returns whatever lines the test sets — drives
// readScreenTail (cursorY anchors the tail at the last written line).
let screenLines: string[] = [];
const term = {
  onScroll: vi.fn(),
  dispose: vi.fn(),
  reset: vi.fn(),
  write: vi.fn(),
  rows: 30,
  buffer: {
    active: {
      baseY: 0,
      get cursorY() {
        return Math.max(0, screenLines.length - 1);
      },
      viewportY: 0,
      getLine: (i: number) =>
        screenLines[i] != null
          ? { translateToString: () => screenLines[i] }
          : null,
    },
  },
};
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
  createWebSocketConnection: vi.fn((_term, _callbacks, wsRef) => {
    wsRef.current = { readyState: 1, send: fakeWsSend };
    return { cleanup: vi.fn(), reconnect: vi.fn(), sendResize: vi.fn() };
  }),
}));

import { createWebSocketConnection } from "@/components/Terminal/hooks/websocket-connection";
import { useTerminalConnection } from "@/components/Terminal/hooks/useTerminalConnection";

function mountAndAttach() {
  const terminalRef = { current: document.createElement("div") };
  const hook = renderHook(() =>
    useTerminalConnection({ terminalRef, isMobile: false, theme: "dark" })
  );
  act(() => {
    vi.advanceTimersByTime(200);
  });
  act(() => {
    hook.result.current.attachSession({
      key: "claude-1",
      spawn: { binary: "claude", args: [], cwd: "." },
    });
  });
  const callbacks = vi.mocked(createWebSocketConnection).mock.calls[0][1];
  return { ...hook, callbacks };
}

const lastAttachSpawn = () =>
  fakeWsSend.mock.calls
    .map((c) => JSON.parse(c[0] as string))
    .filter((m) => m.type === "attach" && m.spawn).length;

describe("useTerminalConnection — auto-retry wiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    screenLines = [];
    term.reset.mockClear();
    fakeWsSend.mockClear();
    vi.mocked(createWebSocketConnection).mockClear();
    (globalThis as { WebSocket?: unknown }).WebSocket = class {
      static OPEN = 1;
    };
  });
  afterEach(() => vi.useRealTimers());

  it("arms on a TRANSIENT exit and the timer fires the relaunch", () => {
    const { result, callbacks } = mountAndAttach();
    screenLines = ["Error: read ECONNRESET"];
    act(() => callbacks.onExit?.(1));

    expect(result.current.autoRetry?.attempt).toBe(1);
    const before = lastAttachSpawn();
    act(() => vi.advanceTimersByTime(5000)); // base backoff
    expect(result.current.autoRetry).toBeNull();
    expect(lastAttachSpawn()).toBe(before + 1); // relaunched with spawn
  });

  it("does NOT arm on a NON-transient exit (real failure → manual relaunch)", () => {
    const { result, callbacks } = mountAndAttach();
    screenLines = ["TypeError: cannot read property 'x' of undefined"];
    act(() => callbacks.onExit?.(1));
    expect(result.current.autoRetry).toBeNull();
  });

  it("does NOT arm on a CLEAN exit (code 0), even with transient-looking text", () => {
    const { result, callbacks } = mountAndAttach();
    screenLines = ["fetch failed"]; // would be transient — but code 0 = user quit
    act(() => callbacks.onExit?.(0));
    expect(result.current.autoRetry).toBeNull();
  });

  it("Cancel stops a pending retry (no relaunch fires)", () => {
    const { result, callbacks } = mountAndAttach();
    screenLines = ["socket hang up"];
    act(() => callbacks.onExit?.(1));
    expect(result.current.autoRetry).not.toBeNull();
    const before = lastAttachSpawn();
    act(() => result.current.cancelAutoRetry());
    expect(result.current.autoRetry).toBeNull();
    act(() => vi.advanceTimersByTime(60000));
    expect(lastAttachSpawn()).toBe(before); // nothing relaunched
  });

  it("stops at the cap — never an infinite loop", () => {
    const { result, callbacks } = mountAndAttach();
    screenLines = ["fetch failed"];
    // 4 transient exits, each arming then firing its backoff relaunch.
    const delays = [5000, 10000, 20000, 40000];
    for (let i = 0; i < 4; i++) {
      act(() => callbacks.onExit?.(1));
      expect(result.current.autoRetry?.attempt).toBe(i + 1);
      act(() => vi.advanceTimersByTime(delays[i]));
    }
    // 5th transient exit is past the cap → not armed (loop stops).
    act(() => callbacks.onExit?.(1));
    expect(result.current.autoRetry).toBeNull();
  });
});
