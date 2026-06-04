"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { getTerminalThemeForApp } from "./Terminal/constants";

/**
 * Read-only live preview of a session's terminal — the inline worker
 * mini-terminal. Attaches to /ws/terminal as an OBSERVER (no input, no resize,
 * so it never disturbs the real viewer's pty) and streams the snapshot + live
 * output into a small xterm. pty-backend only; the parent gates on that.
 */
export function MiniTerminal({
  attachKey,
  theme = "dark",
}: {
  attachKey: string;
  theme?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // Read at construction without making the socket effect depend on theme.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Live theme updates without tearing down the xterm + WebSocket.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalThemeForApp(theme);
    }
  }, [theme]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !attachKey) return;
    let disposed = false;

    const term = new XTerm({
      fontSize: 11,
      fontFamily:
        '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      scrollback: 3000,
      disableStdin: true, // read-only preview
      cursorBlink: false,
      cursorStyle: "bar",
      allowProposedApi: true,
      theme: getTerminalThemeForApp(themeRef.current),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Fit once the container has a real size AND whenever it changes (the expand
    // reveal, layout shifts). A ResizeObserver fires post-layout, so the first
    // fit is correct — a synchronous fit() right after open() measures 0x0.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* not laid out yet */
      }
    });
    ro.observe(container);

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal`);
    ws.onopen = () => {
      // Observer attach: stream output only — never write to or resize the pty.
      ws.send(
        JSON.stringify({ type: "attach", key: attachKey, observer: true })
      );
    };
    ws.onmessage = (e) => {
      if (disposed) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "output") term.write(msg.data);
        else if (msg.type === "exit")
          term.write("\r\n\x1b[33m[session ended]\x1b[0m\r\n");
        else if (msg.type === "error")
          term.write(
            `\r\n\x1b[31m[${msg.message || "attach failed"}]\x1b[0m\r\n`
          );
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onerror = () => {
      if (!disposed) term.write("\r\n\x1b[31m[connection error]\x1b[0m\r\n");
    };

    return () => {
      disposed = true;
      ro.disconnect();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      term.dispose();
      termRef.current = null;
    };
    // theme is applied via the separate effect above — don't reconnect on it.
  }, [attachKey]);

  return (
    <div className="border-border/40 bg-background/70 mt-1 overflow-hidden rounded-md border">
      <div ref={containerRef} className="h-44 w-full p-1" />
    </div>
  );
}
