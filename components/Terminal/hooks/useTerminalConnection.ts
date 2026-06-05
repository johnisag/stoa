"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import { WS_RECONNECT_BASE_DELAY } from "../constants";
import type {
  AttachPayload,
  TerminalScrollState,
  UseTerminalConnectionProps,
  UseTerminalConnectionReturn,
} from "./useTerminalConnection.types";
import {
  createTerminal,
  updateTerminalForMobile,
  updateTerminalTheme,
} from "./terminal-init";
import { setupTouchScroll } from "./touch-scroll";
import { createWebSocketConnection } from "./websocket-connection";
import { setupResizeHandlers } from "./resize-handlers";

export type { TerminalScrollState } from "./useTerminalConnection.types";

export function useTerminalConnection({
  terminalRef,
  onConnected,
  onDisconnected,
  onBeforeUnmount,
  initialScrollState,
  isMobile = false,
  theme = "dark",
  selectMode = false,
}: UseTerminalConnectionProps): UseTerminalConnectionReturn {
  const [connected, setConnected] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "disconnected" | "reconnecting"
  >("connecting");
  // Brief overlay while switching to a DIFFERENT session in this same terminal,
  // covering the gap between reset() and the incoming snapshot's first paint.
  const [isAttaching, setIsAttaching] = useState(false);
  const attachTimerRef = useRef<NodeJS.Timeout | null>(null);
  // True once the agent process exits ("exit" message). Drives the Relaunch
  // overlay and (via sessionEndedRef) suppresses auto-reconnect respawn.
  const [sessionEnded, setSessionEnded] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  // Last attach request, re-sent on every (re)connect so the native pty session
  // is re-subscribed and its scrollback repainted after a dropped socket.
  const attachPayloadRef = useRef<AttachPayload | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const reconnectFnRef = useRef<(() => void) | null>(null);

  // Reconnection tracking
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectDelayRef = useRef<number>(WS_RECONNECT_BASE_DELAY);
  const intentionalCloseRef = useRef<boolean>(false);
  // Mirrors `sessionEnded` for synchronous reads in WS callbacks (which capture
  // stale state). Set on agent exit; cleared on explicit relaunch / new attach.
  const sessionEndedRef = useRef<boolean>(false);
  // One-shot: skip the pre-attach reset() on the next re-attach so an explicit
  // relaunch keeps the prior scrollback ([Session ended] + history) instead of
  // wiping it; the respawned agent's output then appends below.
  const preserveOnReattachRef = useRef<boolean>(false);

  // Store callbacks and state in refs
  const callbacksRef = useRef({ onConnected, onDisconnected, onBeforeUnmount });
  callbacksRef.current = { onConnected, onDisconnected, onBeforeUnmount };
  const initialScrollStateRef = useRef(initialScrollState);
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;

  // Simple callbacks
  const scrollToBottom = useCallback(
    () => xtermRef.current?.scrollToBottom(),
    []
  );

  const copySelection = useCallback(() => {
    const selection = xtermRef.current?.getSelection();
    if (selection) {
      navigator.clipboard.writeText(selection);
      return true;
    }
    return false;
  }, []);

  // Whether the terminal currently holds a text selection. The xterm selection
  // is its own model (not a DOM Selection — the canvas/WebGL renderer paints it),
  // so callers can't use window.getSelection() to detect it. Used to avoid
  // stealing focus on the click that completes a drag-select (focus() clears it).
  const hasSelection = useCallback(
    () => xtermRef.current?.hasSelection() ?? false,
    []
  );

  const sendInput = useCallback((data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "input", data }));
    }
  }, []);

  const sendCommand = useCallback((command: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "command", data: command }));
    }
  }, []);

  // Tear down the transient "attaching" overlay (on first output or timeout).
  const clearAttaching = useCallback(() => {
    if (attachTimerRef.current) {
      clearTimeout(attachTimerRef.current);
      attachTimerRef.current = null;
    }
    setIsAttaching(false);
  }, []);

  const attachSession = useCallback(
    (payload: AttachPayload) => {
      const prev = attachPayloadRef.current;
      attachPayloadRef.current = payload;
      // Switching to a DIFFERENT session in this same terminal: clear the screen
      // and scrollback so the incoming session's snapshot repaints cleanly rather
      // than layering on top of the previous session's output.
      if (prev?.key !== payload.key) {
        const term = xtermRef.current;
        term?.reset();
        // Switching sessions clears any prior "ended" gate.
        sessionEndedRef.current = false;
        setSessionEnded(false);
        // Cover the freshly-cleared (black) screen with a brief overlay until the
        // incoming session's first output paints — no blank flash on switch.
        // Cleared by the WS onOutput callback below (the snapshot arrives as an
        // "output" message), or this 2s safety timeout if the session is silent.
        clearAttaching();
        if (term) {
          setIsAttaching(true);
          attachTimerRef.current = setTimeout(() => clearAttaching(), 2000);
        }
      }
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "attach",
            key: payload.key,
            spawn: payload.spawn,
          })
        );
      }
    },
    [clearAttaching]
  );

  const focus = useCallback(() => xtermRef.current?.focus(), []);

  // Paste via xterm so bracketed-paste mode is honored: a multi-line paste goes
  // in as ONE paste (wrapped in ESC[200~/201~ when the app supports it) instead
  // of each newline executing as a separate command.
  const paste = useCallback(
    (text: string) => xtermRef.current?.paste(text),
    []
  );

  const getScrollState = useCallback((): TerminalScrollState | null => {
    if (!xtermRef.current || !terminalRef.current) return null;
    const buffer = xtermRef.current.buffer.active;
    const viewport = terminalRef.current.querySelector(
      ".xterm-viewport"
    ) as HTMLElement;
    return {
      scrollTop: viewport?.scrollTop ?? 0,
      cursorY: buffer.cursorY,
      baseY: buffer.baseY,
    };
  }, [terminalRef]);

  const restoreScrollState = useCallback(
    (state: TerminalScrollState) => {
      const viewport = terminalRef.current?.querySelector(
        ".xterm-viewport"
      ) as HTMLElement;
      if (viewport) {
        requestAnimationFrame(() => {
          viewport.scrollTop = state.scrollTop;
        });
      }
    },
    [terminalRef]
  );

  const triggerResize = useCallback(() => {
    const fitAddon = fitAddonRef.current;
    const term = xtermRef.current;
    if (!fitAddon || !term) return;
    fitAddon.fit();
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
      );
    }
  }, []);

  const reconnect = useCallback(() => {
    reconnectFnRef.current?.();
  }, []);

  // Explicit relaunch after the agent exited: clear the "ended" gate and
  // re-attach WITH spawn (reusing the stored payload) so the server respawns a
  // fresh agent. This is the ONLY path that respawns an exited session — auto-
  // reconnect stays suppressed while ended.
  const relaunch = useCallback(() => {
    sessionEndedRef.current = false;
    setSessionEnded(false);
    const payload = attachPayloadRef.current;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN && payload) {
      // Keep the existing scrollback (no reset): the respawned agent's output
      // appends below the prior history + [Session ended] marker.
      ws.send(
        JSON.stringify({
          type: "attach",
          key: payload.key,
          spawn: payload.spawn,
        })
      );
    } else {
      // Socket dropped — reconnect; tell onConnected to keep scrollback when it
      // re-attaches (so relaunch preserves history on the reconnect path too).
      preserveOnReattachRef.current = true;
      reconnectFnRef.current?.();
    }
  }, []);

  // Main setup effect
  useEffect(() => {
    if (!terminalRef.current) return;

    let cancelled = false;
    // Reset intentional close flag (may be true from previous cleanup)
    intentionalCloseRef.current = false;
    let cleanupTouchScroll: (() => void) | null = null;
    let cleanupResizeHandlers: (() => void) | null = null;
    let cleanupWebSocket: (() => void) | null = null;
    let cleanupTerminal: (() => void) | null = null;

    let rafId = 0;
    let sizeWaitFrames = 0;
    // Replaces the old fixed 150ms delay: create the terminal as soon as its
    // container is laid out (driven by rAF), not after a magic constant. Wait a
    // few frames for a non-zero size so fit() gets real cols/rows, then proceed
    // regardless (the ResizeObserver refit corrects any later size change).
    const init = () => {
      if (cancelled || !terminalRef.current) return;
      const el = terminalRef.current;
      if (el.offsetWidth === 0 && el.offsetHeight === 0 && sizeWaitFrames < 5) {
        sizeWaitFrames++;
        rafId = requestAnimationFrame(init);
        return;
      }

      // Initialize terminal
      const { term, fitAddon, searchAddon, cleanup } = createTerminal(
        terminalRef.current,
        isMobile,
        theme
      );
      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      cleanupTerminal = cleanup;

      // Scroll tracking — drive the jump-to-bottom button. xterm's buffer math is
      // synchronous + accurate at callback time and matches mobile's touch-scroll
      // (which sets the viewport overflow:hidden, so a DOM scrollHeight read is
      // unreliable there). The button only failed on macOS because scrolling
      // itself was dead (the scrollbar CSS); fixing that restores this path.
      term.onScroll(() => {
        const buffer = term.buffer.active;
        setIsAtBottom(buffer.viewportY >= buffer.baseY);
      });

      // Setup touch scroll
      cleanupTouchScroll = setupTouchScroll({ term, selectModeRef, isMobile });

      // Setup WebSocket
      const wsManager = createWebSocketConnection(
        term,
        {
          onConnected: () => {
            // An exited session must not auto-re-attach (which would respawn).
            // Auto-reconnect is already suppressed at the WS layer; this guards
            // any in-flight connect. Relaunch clears `ended` before reconnecting.
            if (sessionEndedRef.current) return;
            callbacksRef.current.onConnected?.();
            // Re-attach to the native pty session after (re)connect so the
            // server re-subscribes this socket and repaints scrollback.
            const payload = attachPayloadRef.current;
            if (payload && wsRef.current?.readyState === WebSocket.OPEN) {
              // The clear is now driven by the server's "reset" frame, sent
              // atomically right before the snapshot replay (see onReset below) —
              // so it can't race with stale output the way a client-side reset
              // here did (which left duplicated scrollback on reconnect).
              wsRef.current.send(
                JSON.stringify({
                  type: "attach",
                  key: payload.key,
                  spawn: payload.spawn,
                })
              );
            }
            // Restore scroll state after connection
            if (initialScrollStateRef.current && terminalRef.current) {
              setTimeout(() => {
                const viewport = terminalRef.current?.querySelector(
                  ".xterm-viewport"
                ) as HTMLElement;
                if (viewport)
                  viewport.scrollTop = initialScrollStateRef.current!.scrollTop;
              }, 200);
            }
          },
          onDisconnected: () => callbacksRef.current.onDisconnected?.(),
          onConnectionStateChange: setConnectionState,
          onSetConnected: setConnected,
          // First output after a session switch (the snapshot) clears the
          // transient "attaching" overlay; only does work while one is pending.
          onOutput: () => {
            if (attachTimerRef.current) {
              clearTimeout(attachTimerRef.current);
              attachTimerRef.current = null;
              setIsAttaching(false);
            }
          },
          // Server is about to replay the snapshot — clear so it REPLACES the
          // buffer (no layered/duplicated scrollback). Skip once on an explicit
          // relaunch so prior on-screen history is preserved.
          onReset: () => {
            // Always consume the flag (so a relaunch that produced no snapshot
            // can't leave it set and skip a LATER legitimate reset); only the
            // immediate post-relaunch reset is skipped, to preserve history.
            const preserve = preserveOnReattachRef.current;
            preserveOnReattachRef.current = false;
            if (!preserve) xtermRef.current?.reset();
          },
          // Agent process exited: mark ended so auto-reconnect stops respawning
          // and the Terminal shows a Relaunch affordance.
          onExit: () => {
            sessionEndedRef.current = true;
            setSessionEnded(true);
          },
        },
        wsRef,
        reconnectTimeoutRef,
        reconnectDelayRef,
        intentionalCloseRef,
        sessionEndedRef
      );
      cleanupWebSocket = wsManager.cleanup;
      reconnectFnRef.current = wsManager.reconnect;

      // Setup resize handlers
      cleanupResizeHandlers = setupResizeHandlers({
        term,
        fitAddon,
        containerRef: terminalRef,
        isMobile,
        sendResize: wsManager.sendResize,
      });
    };
    rafId = requestAnimationFrame(init);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      intentionalCloseRef.current = true;

      // Save scroll state before unmount
      const term = xtermRef.current;
      if (term && callbacksRef.current.onBeforeUnmount && terminalRef.current) {
        const buffer = term.buffer.active;
        const viewport = terminalRef.current.querySelector(
          ".xterm-viewport"
        ) as HTMLElement;
        callbacksRef.current.onBeforeUnmount({
          scrollTop: viewport?.scrollTop ?? 0,
          cursorY: buffer.cursorY,
          baseY: buffer.baseY,
        });
      }

      // Cleanup in reverse order
      cleanupResizeHandlers?.();
      cleanupWebSocket?.();
      cleanupTouchScroll?.();
      cleanupTerminal?.();

      // Dispose the transient attach-overlay timer.
      if (attachTimerRef.current) {
        clearTimeout(attachTimerRef.current);
        attachTimerRef.current = null;
      }

      // Reset refs
      reconnectDelayRef.current = WS_RECONNECT_BASE_DELAY;

      if (wsRef.current) wsRef.current = null;
      if (xtermRef.current) {
        try {
          xtermRef.current.dispose();
        } catch {
          /* ignore */
        }
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
    // Build the terminal + WebSocket ONCE per mount. `isMobile` and `theme` are
    // deliberately excluded: re-running this effect tears down the socket and
    // disposes the xterm, which forces a pty re-attach — and if the backend
    // session isn't alive, a re-spawn that reprints the agent's startup banner
    // at the new width (the "stacked banners on resize / theme switch" bug).
    // Crossing the 768px breakpoint flips `isMobile` constantly while dragging,
    // so this would fire repeatedly. Live updates for both are handled without a
    // rebuild by the dedicated effects below (updateTerminalForMobile /
    // updateTerminalTheme). `terminalRef` is a stable ref object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalRef]);

  // Handle isMobile changes dynamically
  useEffect(() => {
    const term = xtermRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    updateTerminalForMobile(term, fitAddon, isMobile, (cols, rows) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
  }, [isMobile]);

  // Handle theme changes dynamically
  useEffect(() => {
    if (xtermRef.current) {
      updateTerminalTheme(xtermRef.current, theme);
    }
  }, [theme]);

  return {
    connected,
    connectionState,
    isAttaching,
    isAtBottom,
    xtermRef,
    searchAddonRef,
    scrollToBottom,
    copySelection,
    hasSelection,
    sendInput,
    sendCommand,
    attachSession,
    focus,
    paste,
    getScrollState,
    restoreScrollState,
    triggerResize,
    reconnect,
    sessionEnded,
    relaunch,
  };
}
