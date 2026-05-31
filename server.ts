import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import {
  getBackendType,
  usePtyHost,
  resetSessionBackend,
} from "./lib/session-backend";
import {
  LocalTransport,
  HostTransport,
  type PtyTransport,
  type AttachHandle,
} from "./lib/session-backend/pty/transport";
import { getHostClient } from "./lib/session-backend/pty/host-client";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";

// Support: npm run dev -- -p 3012
const pFlagIndex = process.argv.indexOf("-p");
const portArg = pFlagIndex !== -1 ? process.argv[pFlagIndex + 1] : undefined;
const port = parseInt(portArg || process.env.PORT || "3011", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url!, true);
      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // Terminal WebSocket server
  const terminalWss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrades
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = parse(request.url || "");

    if (pathname === "/ws/terminal") {
      terminalWss.handleUpgrade(request, socket, head, (ws) => {
        terminalWss.emit("connection", ws, request);
      });
    }
    // Let HMR and other WebSocket connections pass through to Next.js
  });

  // Terminal connections. Two modes:
  //  - tmux: spawn a disposable shell pty per socket; the client drives
  //    `tmux attach` (legacy behavior, macOS/Linux).
  //  - pty: subscribe the socket to a long-lived session via a PtyTransport
  //    (in-process registry = Tier 1, or the host daemon = Tier 2). The
  //    host-vs-in-process decision is finalized at startup (see the probe before
  //    server.listen), so usePtyHost() here agrees with getSessionBackend() —
  //    no split brain.
  terminalWss.on("connection", (ws: WebSocket) => {
    if (getBackendType() !== "pty") {
      handleTmuxConnection(ws);
      return;
    }
    const transport: PtyTransport = usePtyHost()
      ? new HostTransport()
      : new LocalTransport();
    handlePtyTerminal(ws, transport);
  });

  // ── tmux mode (legacy): one shell pty per socket, killed on disconnect ──
  function handleTmuxConnection(ws: WebSocket) {
    let ptyProcess: pty.IPty;
    try {
      const shell = process.env.SHELL || "/bin/zsh";
      // Use minimal env - only essentials for shell to work
      // This lets Next.js/Vite/etc load .env.local without interference from parent process env
      const minimalEnv: { [key: string]: string } = {
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME || "/",
        USER: process.env.USER || "",
        SHELL: shell,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: process.env.LANG || "en_US.UTF-8",
      };

      ptyProcess = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.env.HOME || "/",
        env: minimalEnv,
      });
    } catch (err) {
      console.error("Failed to spawn pty:", err);
      ws.send(
        JSON.stringify({ type: "error", message: "Failed to start terminal" })
      );
      ws.close();
      return;
    }

    ptyProcess.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "output", data }));
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code: exitCode }));
        ws.close();
      }
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "input":
            ptyProcess.write(msg.data);
            break;
          case "resize":
            ptyProcess.resize(msg.cols, msg.rows);
            break;
          case "command":
            ptyProcess.write(msg.data + "\r");
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    ws.on("close", () => {
      ptyProcess.kill();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      ptyProcess.kill();
    });
  }

  // ── pty mode (native): subscribe a socket to a session via a transport ──
  // One handler for both Tier 1 (in-process registry) and Tier 2 (host daemon);
  // the PtyTransport hides which. attachStream gives a snapshot + per-client
  // resize/detach handle; we repaint then stream, with no await between the
  // snapshot and listener registration so no live bytes are dropped/dup'd.
  function handlePtyTerminal(ws: WebSocket, transport: PtyTransport) {
    let currentKey: string | null = null;
    let handle: AttachHandle | null = null;
    let lastSize = { cols: 80, rows: 24 };

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const attach = async (
      key: string,
      spawn?: { binary?: string; args?: string[]; cwd?: string }
    ) => {
      handle?.detach();
      handle = null;
      currentKey = key;
      try {
        const h = await transport.attachStream({
          key,
          spawn,
          cols: lastSize.cols,
          rows: lastSize.rows,
          onOutput: (data) => send({ type: "output", data }),
          onExit: (code) => send({ type: "exit", code }),
        });
        handle = h;
        if (h.snapshot) send({ type: "output", data: h.snapshot });
      } catch (err) {
        console.error("pty attach failed:", err);
        send({ type: "error", message: "Failed to attach session" });
      }
    };

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "attach":
            void attach(msg.key, msg.spawn);
            break;
          case "input":
            if (currentKey) transport.write(currentKey, msg.data);
            break;
          case "command":
            if (currentKey) transport.write(currentKey, msg.data + "\r");
            break;
          case "resize":
            lastSize = { cols: msg.cols, rows: msg.rows };
            handle?.resize(msg.cols, msg.rows);
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    // Disconnect detaches this client but leaves the session running.
    ws.on("close", () => handle?.detach());
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      handle?.detach();
    });
  }

  // Finalize the pty-host (Tier 2) decision ONCE, before accepting connections,
  // so the terminal path and the API/status path (getSessionBackend) agree. If
  // the daemon can't be reached we disable host mode globally and fall back to
  // the in-process registry (Tier 1) — terminals still work, just without
  // restart-survival. getSessionBackend() is lazy, so flipping the env here
  // (before its first call) makes the whole process consistently Tier 1.
  (async () => {
    if (usePtyHost()) {
      try {
        await getHostClient().ensureReady();
        console.log(
          "> pty-host daemon ready (Tier 2: sessions survive server restarts)"
        );
      } catch (err) {
        process.env.STOA_PTY_HOST = "0";
        resetSessionBackend(); // re-resolve to Tier 1 even if already cached
        console.error(
          "> pty-host daemon unreachable; using in-process sessions (Tier 1):",
          err instanceof Error ? err.message : err
        );
      }
    }
    server.listen(port, () => {
      console.log(`> Stoa ready on http://${hostname}:${port}`);
    });
  })();
});
