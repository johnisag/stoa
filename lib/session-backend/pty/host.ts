/**
 * Pty-host daemon (Tier 2).
 *
 * A standalone, long-lived process that owns the pty registry and serves it
 * over a local socket, so agent sessions survive the Stoa web server
 * restarting. It reuses the exact same registry/PtySession used in-process for
 * Tier 1 — this file only adds the socket server and per-connection output
 * routing.
 *
 * Run via `node scripts/pty-host.js` (or tsx). startHost() is also called by the
 * client when it auto-spawns the daemon, and by tests.
 */

import net from "net";
import fs from "fs";
import {
  spawnSession,
  spawnShellSession,
  getSession,
  hasSession,
  killSession,
  renameSession,
  listSessions,
} from "./registry";
import {
  hostAddress,
  encode,
  createDecoder,
  type ClientMessage,
  type HostMessage,
} from "./protocol";

interface Conn {
  socket: net.Socket;
  /** Keys this connection is attached to: output/exit unsubscribers + sizing-client id. */
  attached: Map<
    string,
    { offOutput: () => void; offExit: () => void; clientId: number }
  >;
}

/** Drop streamed output if a client is this far behind, to bound daemon memory. */
const OUTPUT_BACKPRESSURE_CAP = 8 * 1024 * 1024; // 8 MB

function send(conn: Conn, msg: HostMessage) {
  if (conn.socket.destroyed) return;
  // If a client falls too far behind on the output stream, drop its socket
  // rather than silently shedding frames (which would leave the client's screen
  // permanently corrupted mid-ANSI). The client reconnects and repaints from a
  // fresh serialize() snapshot — clean recovery instead of silent divergence.
  if (
    msg.t === "output" &&
    conn.socket.writableLength > OUTPUT_BACKPRESSURE_CAP
  ) {
    conn.socket.destroy();
    return;
  }
  conn.socket.write(encode(msg));
}

function handleMessage(conn: Conn, msg: ClientMessage) {
  switch (msg.t) {
    case "ping":
      send(conn, { t: "res", id: msg.id, ok: true });
      break;

    case "spawn":
      try {
        spawnSession(msg.key, msg.spec);
        send(conn, { t: "res", id: msg.id, ok: true });
      } catch (err) {
        send(conn, { t: "res", id: msg.id, ok: false, error: String(err) });
      }
      break;

    case "spawnShell":
      try {
        spawnShellSession(msg.key, msg.cwd, msg.cols, msg.rows);
        send(conn, { t: "res", id: msg.id, ok: true });
      } catch (err) {
        send(conn, { t: "res", id: msg.id, ok: false, error: String(err) });
      }
      break;

    case "attach": {
      const session = getSession(msg.key);
      if (!session) {
        send(conn, {
          t: "res",
          id: msg.id,
          ok: false,
          error: "no such session",
        });
        break;
      }
      // Detach any prior subscription for this key on this connection.
      detachKey(conn, msg.key);
      const snapshot = session.serialize();
      const offOutput = session.onOutput((data) =>
        send(conn, { t: "output", key: msg.key, data })
      );
      const offExit = session.onExit(({ exitCode }) =>
        send(conn, { t: "exit", key: msg.key, code: exitCode })
      );
      // Register this connection as a sizing client (pty -> smallest viewer).
      const clientId = session.addClient(session.cols, session.rows);
      conn.attached.set(msg.key, { offOutput, offExit, clientId });
      // The snapshot is the response value; the client repaints it first.
      send(conn, { t: "res", id: msg.id, ok: true, value: { snapshot } });
      break;
    }

    case "detach":
      detachKey(conn, msg.key);
      break;

    case "input":
      getSession(msg.key)?.write(msg.data);
      break;

    case "resize": {
      const sub = conn.attached.get(msg.key);
      const session = getSession(msg.key);
      if (sub && session)
        session.resizeClient(sub.clientId, msg.cols, msg.rows);
      else session?.resize(msg.cols, msg.rows);
      break;
    }

    case "kill":
      killSession(msg.key);
      send(conn, { t: "res", id: msg.id, ok: true });
      break;

    case "rename":
      if (renameSession(msg.oldKey, msg.newKey)) {
        send(conn, { t: "res", id: msg.id, ok: true });
      } else {
        send(conn, {
          t: "res",
          id: msg.id,
          ok: false,
          error: `rename failed: ${msg.oldKey} -> ${msg.newKey}`,
        });
      }
      break;

    case "capture": {
      const session = getSession(msg.key);
      send(conn, {
        t: "res",
        id: msg.id,
        ok: true,
        value: session ? session.capture(msg.lines) : "",
      });
      break;
    }

    case "exists": {
      const session = getSession(msg.key);
      send(conn, {
        t: "res",
        id: msg.id,
        ok: true,
        value: !!session && session.alive,
      });
      break;
    }

    case "list":
      send(conn, {
        t: "res",
        id: msg.id,
        ok: true,
        value: listSessions()
          .filter((s) => s.alive)
          .map((s) => s.key),
      });
      break;

    case "listActivity":
      send(conn, {
        t: "res",
        id: msg.id,
        ok: true,
        value: listSessions()
          .filter((s) => s.alive)
          .map((s) => ({
            name: s.key,
            activity: Math.floor(s.lastActivity / 1000),
          })),
      });
      break;

    case "panePath": {
      const session = getSession(msg.key);
      send(conn, {
        t: "res",
        id: msg.id,
        ok: true,
        value: session ? session.cwd : null,
      });
      break;
    }
  }
}

function detachKey(conn: Conn, key: string) {
  const sub = conn.attached.get(key);
  if (sub) {
    sub.offOutput();
    sub.offExit();
    getSession(key)?.removeClient(sub.clientId);
    conn.attached.delete(key);
  }
}

let server: net.Server | null = null;

// Idle self-shutdown: the daemon exits once there are NO live sessions and NO
// connected clients for a sustained period, so it never accumulates as a zombie.
// It will never exit while a session is alive (that would kill the agent).
const connections = new Set<net.Socket>();
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
let lastBusyAt = Date.now();
let idleTimer: NodeJS.Timeout | null = null;

function checkIdle(): void {
  const busy = connections.size > 0 || listSessions().some((s) => s.alive);
  if (busy) {
    lastBusyAt = Date.now();
    return;
  }
  if (Date.now() - lastBusyAt > IDLE_SHUTDOWN_MS) {
    process.exit(0);
  }
}

/**
 * Start the host server. Resolves once listening. If the address is already in
 * use (another host is running), resolves false without starting a second one.
 */
export function startHost(): Promise<boolean> {
  if (server) return Promise.resolve(true);
  const address = hostAddress();

  // On POSIX a stale socket file blocks bind; remove it if no one is listening.
  return new Promise((resolve, reject) => {
    const srv = net.createServer((socket) => {
      const conn: Conn = { socket, attached: new Map() };
      connections.add(socket);
      lastBusyAt = Date.now();
      const decode = createDecoder<ClientMessage>((msg) =>
        handleMessage(conn, msg)
      );
      // No setEncoding: the decoder reads raw Buffers so length-prefixed frames
      // reassemble byte-exact (multi-byte UTF-8 is never split mid-character).
      socket.on("data", decode);
      // Disconnect detaches this client's subscriptions but does NOT kill the
      // sessions — that's the whole point of the daemon.
      const cleanup = () => {
        for (const key of [...conn.attached.keys()]) detachKey(conn, key);
        connections.delete(socket);
        lastBusyAt = Date.now();
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });

    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another host already owns the address.
        resolve(false);
        return;
      }
      reject(err);
    });

    const listen = () => {
      srv.listen(address, () => {
        server = srv;
        // Periodically self-terminate when fully idle (no sessions, no clients).
        idleTimer = setInterval(checkIdle, 60_000);
        idleTimer.unref?.();
        resolve(true);
      });
    };

    if (!address.startsWith("\\\\")) {
      // POSIX socket file: clear a stale one first.
      fs.unlink(address, () => listen());
    } else {
      listen();
    }
  });
}

export function stopHost(): Promise<void> {
  return new Promise((resolve) => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (!server) return resolve();
    const srv = server;
    server = null;
    // Destroy any open client sockets first, otherwise srv.close() waits for
    // them to end and never completes.
    for (const sock of connections) sock.destroy();
    connections.clear();
    srv.close(() => resolve());
  });
}
