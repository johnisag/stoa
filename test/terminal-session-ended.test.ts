// @vitest-environment jsdom
/**
 * Regression test for the "silent respawn after agent exit" fix.
 *
 * When the agent process exits, the client must NOT auto-reconnect — a
 * reconnect re-attaches WITH spawn and silently launches a fresh agent over the
 * top of the ended session. createWebSocketConnection now gates
 * forceReconnect/attemptReconnect on `endedRef`; this locks that, and that the
 * server "exit" message fires the onExit callback (which sets the ended gate).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebSocketConnection } from "@/components/Terminal/hooks/websocket-connection";

// Minimal fake WebSocket: counts constructions and lets us drive onmessage.
class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CLOSING = 2;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function fakeTerm() {
  return {
    cols: 80,
    rows: 24,
    // write may carry a completion callback (the exit path fires onExit from it,
    // once the FIFO write queue has flushed) — invoke it synchronously here.
    write: vi.fn((_s: string, cb?: () => void) => cb?.()),
    focus: vi.fn(),
    onData: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    buffer: { active: { viewportY: 0, baseY: 0 } },
  };
}

function makeRefs() {
  return {
    wsRef: { current: null as unknown },
    reconnectTimeoutRef: { current: null as unknown },
    reconnectDelayRef: { current: 1000 },
    intentionalCloseRef: { current: false },
    endedRef: { current: false },
  };
}

const baseCallbacks = () => ({
  onConnectionStateChange: vi.fn(),
  onSetConnected: vi.fn(),
});

describe("createWebSocketConnection — exited session suppresses reconnect", () => {
  let OrigWS: unknown;
  beforeEach(() => {
    FakeWebSocket.instances = [];
    OrigWS = (globalThis as { WebSocket?: unknown }).WebSocket;
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  });
  afterEach(() => {
    (globalThis as { WebSocket?: unknown }).WebSocket = OrigWS;
  });

  it("forceReconnect is a no-op once ended (no fresh socket → no respawn)", () => {
    const refs = makeRefs();
    const mgr = createWebSocketConnection(
      fakeTerm() as never,
      baseCallbacks(),
      refs.wsRef as never,
      refs.reconnectTimeoutRef as never,
      refs.reconnectDelayRef as never,
      refs.intentionalCloseRef as never,
      refs.endedRef as never
    );
    expect(FakeWebSocket.instances.length).toBe(1); // initial socket
    void mgr;

    refs.endedRef.current = true;
    mgr.reconnect(); // forceReconnect — must be suppressed
    expect(FakeWebSocket.instances.length).toBe(1); // no new socket

    refs.endedRef.current = false;
    mgr.reconnect(); // resumes once not ended
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('fires onExit and prints [Session ended] on a server "exit" message', () => {
    const refs = makeRefs();
    const onExit = vi.fn();
    const term = fakeTerm();
    createWebSocketConnection(
      term as never,
      { ...baseCallbacks(), onExit },
      refs.wsRef as never,
      refs.reconnectTimeoutRef as never,
      refs.reconnectDelayRef as never,
      refs.intentionalCloseRef as never,
      refs.endedRef as never
    );
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({ data: JSON.stringify({ type: "exit" }) });

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(
      expect.stringContaining("[Session ended]"),
      expect.any(Function)
    );
  });

  it('fires onError and prints the reason on a server "error" frame', () => {
    // Regression: the "error" frame used to match no branch and be silently
    // dropped — in the native pty path the socket stays OPEN, so the screen just
    // hung (a session-switch left "Switching…" stuck). It must surface the reason
    // and fire onError so the hook shows the Relaunch bar.
    const refs = makeRefs();
    const onError = vi.fn();
    const term = fakeTerm();
    createWebSocketConnection(
      term as never,
      { ...baseCallbacks(), onError },
      refs.wsRef as never,
      refs.reconnectTimeoutRef as never,
      refs.reconnectDelayRef as never,
      refs.intentionalCloseRef as never,
      refs.endedRef as never
    );
    const ws = FakeWebSocket.instances[0];
    ws.onmessage?.({
      data: JSON.stringify({
        type: "error",
        message: "Failed to attach session",
      }),
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("Failed to attach session");
    expect(term.write).toHaveBeenCalledWith(
      expect.stringContaining("[Failed to attach session]")
    );
  });
});
