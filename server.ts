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
} from "./lib/session-backend/pty/transport";
import { AttachSession } from "./lib/session-backend/pty/attach-session";
import { getHostClient } from "./lib/session-backend/pty/host-client";
import {
  computeManagedStatuses,
  diffStatuses,
  snapshotStatuses,
  detectPushEvents,
  statusById,
  type PushEvent,
} from "./lib/session-status";
import { sendPushToAll, hasPushSubscriptions } from "./lib/push";
import { getDb, queries, type Session } from "./lib/db";
import type { SessionStatus } from "./lib/status-detector";
import {
  getServerToken,
  trustLoopback,
  trustTailscale,
  configuredAllowedOrigins,
  buildAuthCookie,
  decideHttpAuth,
  decideWsAuth,
} from "./lib/auth";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";

// Auth (Jupyter-style token; loopback trusted unless STOA_REQUIRE_AUTH=1). The
// Origin allowlist on WS upgrades runs even when the token gate is disabled.
const SERVER_TOKEN = getServerToken();
const AUTH_ENABLED = SERVER_TOKEN !== null;
const TRUST_LOOPBACK = trustLoopback();
const TRUST_TAILSCALE = trustTailscale();
const ALLOWED_ORIGINS = configuredAllowedOrigins();

const AUTH_REQUIRED_HTML = `<!doctype html><meta charset="utf-8"><title>Stoa — token required</title><body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:0 1.5rem;color:#ddd;background:#111"><h1 style="font-size:1.3rem">🔒 Stoa needs a token</h1><p>This server requires an access token for non-local connections. Open the tokenized URL printed in the server console, or append <code>?token=YOUR_TOKEN</code> to the address.</p></body>`;

const firstQueryValue = (
  v: string | string[] | undefined
): string | undefined => (Array.isArray(v) ? v[0] : v);

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

      if (AUTH_ENABLED) {
        const decision = decideHttpAuth({
          serverToken: SERVER_TOKEN,
          remoteAddr: req.socket.remoteAddress,
          trustLoopback: TRUST_LOOPBACK,
          trustTailscale: TRUST_TAILSCALE,
          authHeader: req.headers.authorization,
          cookieHeader: req.headers.cookie,
          queryToken: firstQueryValue(parsedUrl.query.token),
        });
        if (decision.type === "deny") {
          res.statusCode = 401;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(AUTH_REQUIRED_HTML);
          return;
        }
        if (decision.type === "bootstrap") {
          // Valid ?token= → set the cookie and redirect to the same URL without
          // the token in it (so it doesn't linger in history/logs/referrers).
          const secure = req.headers["x-forwarded-proto"] === "https";
          delete parsedUrl.query.token;
          const qs = new URLSearchParams(
            parsedUrl.query as Record<string, string>
          ).toString();
          res.statusCode = 302;
          res.setHeader("Set-Cookie", buildAuthCookie(decision.token, secure));
          res.setHeader(
            "Location",
            (parsedUrl.pathname || "/") + (qs ? `?${qs}` : "")
          );
          res.end();
          return;
        }
      }

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    }
  });

  // Terminal WebSocket server
  const terminalWss = new WebSocketServer({ noServer: true });
  // Live status-events server: pushes session status deltas to the UI.
  const eventsWss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrades
  server.on("upgrade", (request, socket, head) => {
    const { pathname, query } = parse(request.url || "", true);

    const wss =
      pathname === "/ws/terminal"
        ? terminalWss
        : pathname === "/ws/events"
          ? eventsWss
          : null;
    // Let HMR and other WebSocket connections pass through to Next.js.
    if (!wss) return;

    // Origin allowlist (always — CSWSH defense) + token gate. The browser sends
    // the auth cookie on a same-origin upgrade, so no client wiring is needed.
    const decision = decideWsAuth({
      serverToken: SERVER_TOKEN,
      origin: request.headers.origin,
      host: request.headers.host,
      allowedOrigins: ALLOWED_ORIGINS,
      remoteAddr: request.socket.remoteAddress,
      trustLoopback: TRUST_LOOPBACK,
      trustTailscale: TRUST_TAILSCALE,
      authHeader: request.headers.authorization,
      cookieHeader: request.headers.cookie,
      queryToken: firstQueryValue(query.token),
    });
    if (decision.type === "deny") {
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${decision.reason}`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
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

  // ── live status events (/ws/events) ──
  // Push session status deltas so the board updates instantly, as a safety-net
  // ALONGSIDE the client's 5s poll (which still backstops missed ticks + removed
  // sessions). The ticker only does work while a client is listening.
  const eventClients = new Set<WebSocket>();
  let lastStatusSnapshot = new Map<string, string>();
  // Separate status-only snapshot for Web Push transition detection (runs even
  // with no WS client connected, so closed-tab pushes still fire).
  let lastPushStatusById = new Map<string, SessionStatus>();
  // Per-(session,event) cooldown so a flapping agent doesn't spam pushes
  // (mirrors the in-app checkStateChanges cooldown).
  const lastPushAt = new Map<string, number>();
  const PUSH_COOLDOWN_MS = 15000;
  const shouldPush = (ev: PushEvent): boolean => {
    const key = `${ev.id}-${ev.kind}`;
    const now = Date.now();
    if (now - (lastPushAt.get(key) ?? 0) < PUSH_COOLDOWN_MS) return false;
    lastPushAt.set(key, now);
    return true;
  };

  // Friendly session name for a push body (falls back to the backend key).
  const pushFor = (ev: PushEvent) => {
    let name = ev.name;
    try {
      name =
        (queries.getSession(getDb()).get(ev.id) as Session | undefined)?.name ??
        ev.name;
    } catch {
      // DB unavailable — use the backend key
    }
    const verb =
      ev.kind === "waiting"
        ? "needs your input"
        : ev.kind === "error"
          ? "hit an error"
          : "finished";
    return sendPushToAll({
      title: "Stoa",
      body: `${name} ${verb}`,
      tag: `${ev.id}-${ev.kind}`,
      url: "/",
    });
  };

  const broadcastEvent = (obj: unknown) => {
    const data = JSON.stringify(obj);
    for (const ws of eventClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  };

  eventsWss.on("connection", (ws: WebSocket) => {
    eventClients.add(ws);
    // Force the next tick to re-broadcast everything so the just-connected
    // client gets the current state (it merges deltas into its status cache).
    lastStatusSnapshot = new Map();
    ws.on("close", () => eventClients.delete(ws));
    ws.on("error", () => eventClients.delete(ws));
  });

  let statusTickBusy = false;
  setInterval(async () => {
    const wsListening = eventClients.size > 0;
    // Web Push must fire with no tab open, so the ticker also runs whenever a
    // push subscription exists (computeManagedStatuses is cheap when idle).
    const pushEnabled = hasPushSubscriptions();
    if (!wsListening && !pushEnabled) {
      if (lastStatusSnapshot.size) lastStatusSnapshot = new Map();
      if (lastPushStatusById.size) lastPushStatusById = new Map();
      return;
    }
    if (statusTickBusy) return; // don't stack ticks if a capture runs slow
    statusTickBusy = true;
    try {
      const curr = await computeManagedStatuses();
      if (wsListening) {
        const deltas = diffStatuses(lastStatusSnapshot, curr);
        lastStatusSnapshot = snapshotStatuses(curr);
        if (deltas.length) broadcastEvent({ type: "status", deltas });
      }
      if (pushEnabled) {
        const events = detectPushEvents(lastPushStatusById, curr);
        lastPushStatusById = statusById(curr);
        // Fan out to every subscription, throttled per-event. The "don't
        // double-notify while a tab is watching" decision is made PER-DEVICE in
        // the service worker (it suppresses the push only if a Stoa tab is
        // visible on that device) — the old server-side `!wsListening` gate was
        // global, so one open tab silenced push to every other device.
        for (const ev of events) {
          if (shouldPush(ev)) await pushFor(ev);
        }
      }
    } catch (err) {
      console.error("status events tick failed:", err);
    } finally {
      statusTickBusy = false;
    }
  }, 2500);

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
    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    // The attach state machine (incl. the sequence guard that stops a racing
    // re-attach from double-subscribing) lives in AttachSession; this handler
    // just maps WebSocket frames onto it.
    const session = new AttachSession(transport, {
      output: (data) => send({ type: "output", data }),
      exit: (code) => send({ type: "exit", code }),
      error: (message) => send({ type: "error", message }),
    });

    ws.on("message", (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());
        switch (msg.type) {
          case "attach":
            void session.attach(msg.key, msg.spawn);
            break;
          case "input":
            session.write(msg.data);
            break;
          case "command":
            session.write(msg.data + "\r");
            break;
          case "resize":
            session.resize(msg.cols, msg.rows);
            break;
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    });

    // Disconnect detaches this client but leaves the session running.
    ws.on("close", () => session.detach());
    ws.on("error", (err) => {
      console.error("WebSocket error:", err);
      session.detach();
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
      if (AUTH_ENABLED) {
        console.log(
          `> Auth on${TRUST_LOOPBACK ? " (localhost trusted)" : " (token required everywhere)"}. Remote access:`
        );
        console.log(`>   http://<this-host>:${port}/?token=${SERVER_TOKEN}`);
        if (TRUST_TAILSCALE)
          console.log(
            `>   Tailscale range (100.64.0.0/10) is trusted — no token over the tailnet.`
          );
        console.log(
          `>   STOA_AUTH=off disables it; STOA_REQUIRE_AUTH=1 requires it on localhost too.`
        );
      } else {
        console.log(
          "> Auth DISABLED (STOA_AUTH=off) — anyone who can reach this port has full access."
        );
      }
    });
  })();
});
