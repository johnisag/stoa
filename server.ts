import { createServer } from "http";
import { parse } from "url";
import next from "next";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { getBackendType, usePtyHost } from "./lib/session-backend";
import {
  getSession,
  spawnSession,
  spawnShellSession,
} from "./lib/session-backend/pty/registry";
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
  //  - pty: subscribe the socket to a long-lived session in the in-process
  //    registry; the session survives disconnects (native, cross-platform).
  terminalWss.on("connection", (ws: WebSocket) => {
    if (getBackendType() === "pty") {
      if (usePtyHost()) {
        handlePtyHostConnection(ws);
      } else {
        handlePtyConnection(ws);
      }
    } else {
      handleTmuxConnection(ws);
    }
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

  // ── pty mode (native): subscribe to a long-lived registry session ──
  function handlePtyConnection(ws: WebSocket) {
    let currentKey: string | null = null;
    let offOutput: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let clientId: number | null = null;
    let lastSize = { cols: 80, rows: 24 };

    const detach = () => {
      offOutput?.();
      offExit?.();
      offOutput = null;
      offExit = null;
      // Drop this client's size vote so the pty can grow back for others.
      if (currentKey != null && clientId != null) {
        getSession(currentKey)?.removeClient(clientId);
      }
      clientId = null;
    };

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const attach = (
      key: string,
      spawn?: { binary?: string; args?: string[]; cwd?: string }
    ) => {
      detach();
      currentKey = key;

      let session = getSession(key);
      if ((!session || !session.alive) && spawn) {
        try {
          const cwd = spawn.cwd || process.env.HOME || ".";
          session =
            spawn.binary && spawn.binary.length > 0
              ? spawnSession(key, {
                  binary: spawn.binary,
                  args: spawn.args ?? [],
                  cwd,
                  cols: lastSize.cols,
                  rows: lastSize.rows,
                })
              : spawnShellSession(key, cwd, lastSize.cols, lastSize.rows);
        } catch (err) {
          console.error("Failed to spawn pty session:", err);
          send({ type: "error", message: "Failed to start session" });
          return;
        }
      }

      if (!session) {
        send({ type: "error", message: "Session not found" });
        return;
      }

      // Repaint history first, then stream live output. No await between the
      // snapshot read and listener registration, so no bytes are dropped/dup'd.
      const snapshot = session.getRawBuffer();
      if (snapshot) send({ type: "output", data: snapshot });
      offOutput = session.onOutput((data) => send({ type: "output", data }));
      offExit = session.onExit(({ exitCode }) =>
        send({ type: "exit", code: exitCode })
      );
      // Register as a sizing client (pty resizes to the smallest viewer).
      clientId = session.addClient(lastSize.cols, lastSize.rows);
    };

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "attach":
            attach(msg.key, msg.spawn);
            break;
          case "input":
            if (currentKey) getSession(currentKey)?.write(msg.data);
            break;
          case "command":
            if (currentKey) getSession(currentKey)?.write(msg.data + "\r");
            break;
          case "resize":
            lastSize = { cols: msg.cols, rows: msg.rows };
            if (currentKey && clientId != null) {
              getSession(currentKey)?.resizeClient(
                clientId,
                msg.cols,
                msg.rows
              );
            }
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    // Disconnect detaches this client but leaves the session running.
    ws.on("close", () => detach());
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      detach();
    });
  }

  // ── pty host mode (Tier 2): subscribe via the out-of-process daemon ──
  function handlePtyHostConnection(ws: WebSocket) {
    const client = getHostClient();
    let currentKey: string | null = null;
    let detach: (() => void) | null = null;
    let lastSize = { cols: 80, rows: 24 };

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    const attach = async (
      key: string,
      spawn?: { binary?: string; args?: string[]; cwd?: string }
    ) => {
      detach?.();
      detach = null;
      currentKey = key;
      try {
        // Create-if-missing on the daemon (idempotent for a live session).
        if (spawn) {
          const cwd = spawn.cwd || process.env.HOME || ".";
          if (spawn.binary && spawn.binary.length > 0) {
            await client.spawn(key, {
              binary: spawn.binary,
              args: spawn.args ?? [],
              cwd,
              cols: lastSize.cols,
              rows: lastSize.rows,
            });
          } else {
            await client.spawnShell(key, cwd, lastSize.cols, lastSize.rows);
          }
        }
        const { snapshot, detach: d } = await client.attach(
          key,
          (data) => send({ type: "output", data }),
          (code) => send({ type: "exit", code })
        );
        detach = d;
        if (snapshot) send({ type: "output", data: snapshot });
        client.resize(key, lastSize.cols, lastSize.rows);
      } catch (err) {
        console.error("pty-host attach failed:", err);
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
            if (currentKey) client.input(currentKey, msg.data);
            break;
          case "command":
            if (currentKey) client.input(currentKey, msg.data + "\r");
            break;
          case "resize":
            lastSize = { cols: msg.cols, rows: msg.rows };
            if (currentKey) client.resize(currentKey, msg.cols, msg.rows);
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    ws.on("close", () => detach?.());
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      detach?.();
    });
  }

  server.listen(port, () => {
    console.log(`> Agent-OS ready on http://${hostname}:${port}`);
  });
});
