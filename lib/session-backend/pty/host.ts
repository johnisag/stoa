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
  killSessionAndWait,
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
    { offOutput: () => void; offExit: () => void; clientId: number | null }
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
  try {
    conn.socket.write(encode(msg));
  } catch (err) {
    // Drop just this connection on a write/encode failure so it reconnects and
    // repaints from a fresh snapshot, rather than limping along half-broken.
    // (Crash-safety on the output path is already handled at the source:
    // PtySession.fanOut isolates each subscriber and the IPC decoder swallows
    // malformed frames, so a throw here can't escape to crash the daemon — this
    // catch is about connection hygiene, not keeping the process alive.)
    console.error("[pty-host] send failed; dropping connection:", err);
    conn.socket.destroy();
  }
}

async function handleMessage(conn: Conn, msg: ClientMessage) {
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
      if (!session || session.dying) {
        send(conn, {
          t: "res",
          id: msg.id,
          ok: false,
          error: "no such session",
        });
        break;
      }
      const snapshot = session.serialize();
      const existing = conn.attached.get(msg.key);

      // Same-key multi-viewer (#2): all browser sockets share ONE HostClient → ONE
      // daemon Conn, which fans the single output stream out to every local tab and
      // sends exactly one daemon detach when its LAST local listener for the key
      // drops. So a 2nd attach to the SAME key must REUSE the existing output/exit
      // subscription — a fresh one would DOUBLE every output frame — rather than
      // detach-and-recreate. (The old code detached first, which evicted the prior
      // tab's SIZING slot: a live-wall observer attaching a worker that's also open
      // full-screen froze that pane's resize.)
      const offOutput =
        existing?.offOutput ??
        session.onOutput((data) =>
          send(conn, { t: "output", key: msg.key, data })
        );
      const offExit =
        existing?.offExit ??
        session.onExit(({ exitCode }) =>
          send(conn, { t: "exit", key: msg.key, code: exitCode })
        );

      // Sizing (pty -> smallest viewer): only a NON-observer drives it, and an
      // observer must never evict the real viewer's sizing slot (the #2 bug).
      // Preserve any existing viewer clientId; register a NEW sizing client only
      // when a viewer attaches and none exists yet; an already-registered viewer
      // re-attaching just updates its size. Use the client's initial viewport size
      // when provided so the first paint isn't clipped.
      // (Still single-slot per (key, conn): two REAL same-key viewers on one
      // connection share it — last size wins, not min-of-both. True per-viewer
      // min-sizing would need per-subscription slots + a sub id in detach; deferred
      // — it's not the reported failure and this is the locked daemon seam.)
      const initialCols = msg.cols ?? session.cols;
      const initialRows = msg.rows ?? session.rows;
      let clientId = existing?.clientId ?? null;
      if (!msg.observer) {
        if (clientId === null) {
          clientId = session.addClient(initialCols, initialRows);
        } else if (msg.cols !== undefined && msg.rows !== undefined) {
          session.resizeClient(clientId, initialCols, initialRows);
        }
      }
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
      // Ignore resize messages from clients that are not attached on this
      // connection — otherwise a client that never attached could resize the
      // shared pty and affect actual viewers.
      if (!sub || !session) break;
      // Observers (clientId === null) own no sizing slot — ignore their resizes.
      if (sub.clientId !== null)
        session.resizeClient(sub.clientId, msg.cols, msg.rows);
      break;
    }

    case "kill":
      await killSessionAndWait(msg.key);
      send(conn, { t: "res", id: msg.id, ok: true });
      break;

    case "rename": {
      const ok = renameSession(msg.oldKey, msg.newKey);
      if (ok) {
        // Migrate any subscription this connection holds under the old key so
        // that a later detach (which the client now sends under the new key)
        // actually cleans up the daemon-side output/exit listeners and sizing
        // client instead of leaking them.
        const sub = conn.attached.get(msg.oldKey);
        if (sub) {
          conn.attached.delete(msg.oldKey);
          conn.attached.set(msg.newKey, sub);
        }
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
    }

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
    if (sub.clientId !== null) getSession(key)?.removeClient(sub.clientId);
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
      let messageChain = Promise.resolve();
      const decode = createDecoder<ClientMessage>((msg) => {
        messageChain = messageChain.then(async () => {
          try {
            await handleMessage(conn, msg);
          } catch (err) {
            if ("id" in msg)
              send(conn, {
                t: "res",
                id: msg.id,
                ok: false,
                error: String(err),
              });
          }
        });
      });
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

/**
 * Last-resort keep-alive for the Tier-2 daemon.
 *
 * The daemon owns EVERY live agent session in one process, so a single
 * unhandled throw / rejected promise would otherwise crash it and kill them all
 * at once — the largest stability blast-radius in the tree. The hot paths are
 * already guarded at the source (the IPC frame decoder swallows malformed
 * frames, PtySession.fanOut isolates each subscriber, and send() drops a single
 * failing connection), but an exception from some unforeseen async seam must
 * NOT take the process down. Log it and keep serving the surviving sessions.
 *
 * Installed ONLY in the standalone daemon entry point (scripts/pty-host.ts) —
 * never when the host runs in-process under the web server or the test runner,
 * where a process-wide handler would mask real crashes elsewhere.
 */
let guardsInstalled = false;
function onUncaughtException(err: unknown, origin?: string): void {
  console.error(`[pty-host] uncaughtException (kept alive, ${origin}):`, err);
}
function onUnhandledRejection(reason: unknown): void {
  console.error("[pty-host] unhandledRejection (kept alive):", reason);
}

export function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
}

export function uninstallProcessGuards(): void {
  if (!guardsInstalled) return;
  guardsInstalled = false;
  process.removeListener("uncaughtException", onUncaughtException);
  process.removeListener("unhandledRejection", onUnhandledRejection);
}
