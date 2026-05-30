/**
 * Pty-host daemon (Tier 2).
 *
 * A standalone, long-lived process that owns the pty registry and serves it
 * over a local socket, so agent sessions survive the AgentOS web server
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

function send(conn: Conn, msg: HostMessage) {
  if (!conn.socket.destroyed) conn.socket.write(encode(msg));
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
      renameSession(msg.oldKey, msg.newKey);
      send(conn, { t: "res", id: msg.id, ok: true });
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
      const decode = createDecoder<ClientMessage>((msg) =>
        handleMessage(conn, msg)
      );
      socket.setEncoding("utf8");
      socket.on("data", decode);
      // Disconnect detaches this client's subscriptions but does NOT kill the
      // sessions — that's the whole point of the daemon.
      const cleanup = () => {
        for (const key of [...conn.attached.keys()]) detachKey(conn, key);
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
    if (!server) return resolve();
    const srv = server;
    server = null;
    srv.close(() => resolve());
  });
}
