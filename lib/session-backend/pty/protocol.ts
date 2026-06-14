/**
 * IPC protocol for the pty-host daemon (Tier 2, migration-plan.md §6, Phase 6).
 *
 * The host owns the pty registry in a separate long-lived process so agent
 * sessions survive the Stoa web server restarting. Web-server-side clients
 * talk to it over a local socket (named pipe on Windows, unix socket on POSIX).
 *
 * Framing: length-prefixed binary frames — a 4-byte big-endian length, then that
 * many payload bytes. The payload's first byte is a KIND tag:
 *
 *   KIND_JSON   (1): rest is a UTF-8 JSON message — all control/response/exit
 *                    traffic. Low-frequency, so JSON's convenience is free here.
 *   KIND_OUTPUT (2): a pty output frame — [u16 keyLen][key UTF-8][raw bytes].
 *                    The hot path: carrying the bytes verbatim avoids JSON-
 *                    escaping ANSI/control sequences on every chunk (ESC ->
 *                    "", etc.), cutting both wire bytes and CPU on each end
 *                    versus the old newline-delimited JSON.
 *
 * Why length-prefix over a delimiter: pty output is binary and full of newlines
 * and ESC bytes, so any delimiter would need escaping anyway. A length prefix
 * carries raw bytes and reassembles exactly — and multi-byte UTF-8 is never
 * split mid-character, because a payload is only decoded once fully buffered
 * (no reliance on the socket's StringDecoder, which is why we read Buffers).
 */

import os from "os";
import path from "path";
import { isWindows } from "../../platform";

/**
 * Absolute address of the host's listening socket. The basename can be
 * overridden via STOA_PTY_HOST_NAME so multiple Stoa instances (or test
 * files) can run isolated daemons without colliding on the global pipe/socket.
 */
export function hostAddress(): string {
  const name = process.env.STOA_PTY_HOST_NAME || "stoa-pty-host";
  if (isWindows) {
    return `\\\\.\\pipe\\${name}`;
  }
  return path.join(os.tmpdir(), `${name}.sock`);
}

export interface SpawnSpecMsg {
  binary: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

// Client -> Host
export type ClientMessage =
  | { t: "spawn"; id: number; key: string; spec: SpawnSpecMsg }
  | {
      t: "spawnShell";
      id: number;
      key: string;
      cwd: string;
      cols?: number;
      rows?: number;
    }
  | {
      t: "attach";
      id: number;
      key: string;
      observer?: boolean;
      cols?: number;
      rows?: number;
    }
  | { t: "detach"; key: string }
  | { t: "input"; key: string; data: string }
  | { t: "resize"; key: string; cols: number; rows: number }
  | { t: "kill"; id: number; key: string }
  | { t: "rename"; id: number; oldKey: string; newKey: string }
  | { t: "capture"; id: number; key: string; lines?: number }
  | { t: "exists"; id: number; key: string }
  | { t: "list"; id: number }
  | { t: "listActivity"; id: number }
  | { t: "panePath"; id: number; key: string }
  | { t: "ping"; id: number };

// Host -> Client
export type HostMessage =
  | { t: "res"; id: number; ok: true; value?: unknown }
  | { t: "res"; id: number; ok: false; error: string }
  | { t: "output"; key: string; data: string }
  | { t: "exit"; key: string; code: number };

const KIND_JSON = 1;
const KIND_OUTPUT = 2;
const LEN_BYTES = 4; // 32-bit big-endian frame length prefix

/**
 * Largest single frame we'll accept before assuming a desynced/misbehaving peer
 * and resetting — prevents unbounded memory from a bogus length prefix. One pty
 * snapshot can be sizable, so keep this generous.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Prepend the 4-byte big-endian length prefix to a payload. */
function frame(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(LEN_BYTES + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, LEN_BYTES);
  return out;
}

export function encode(msg: ClientMessage | HostMessage): Buffer {
  // Hot path: pty output carried as raw bytes (no JSON escaping).
  if (msg.t === "output") {
    const keyBuf = Buffer.from(msg.key, "utf8");
    const dataBuf = Buffer.from(msg.data, "utf8");
    const payload = Buffer.allocUnsafe(1 + 2 + keyBuf.length + dataBuf.length);
    payload[0] = KIND_OUTPUT;
    payload.writeUInt16BE(keyBuf.length, 1);
    keyBuf.copy(payload, 3);
    dataBuf.copy(payload, 3 + keyBuf.length);
    return frame(payload);
  }
  // Everything else: a JSON payload behind the KIND_JSON tag.
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const payload = Buffer.allocUnsafe(1 + body.length);
  payload[0] = KIND_JSON;
  body.copy(payload, 1);
  return frame(payload);
}

/**
 * Stateful length-prefixed frame decoder. Feed Buffer chunks; get back complete
 * messages (output frames reconstructed as `{ t: "output", key, data }`, so the
 * routing code sees the same shapes as before). Tolerates frames split across
 * chunks and multiple frames per chunk; drops everything buffered if a length
 * prefix exceeds MAX_FRAME_BYTES (desync guard).
 */
export function createDecoder<T>(
  onMessage: (msg: T) => void
): (chunk: Buffer) => void {
  let buffer: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= LEN_BYTES) {
      const len = buffer.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        // Implausible length => the stream is desynced/corrupt. Drop the buffer
        // to bound memory; the socket owner reconnects and repaints on the next
        // op rather than acting on garbage.
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < LEN_BYTES + len) break; // wait for the rest of the frame
      const payload = buffer.subarray(LEN_BYTES, LEN_BYTES + len);
      buffer = buffer.subarray(LEN_BYTES + len);
      // A length-prefixed frame is self-delimiting, so a single malformed frame
      // (a corrupt/desynced/hostile peer) must be SKIPPED — never thrown out of
      // the socket 'data' handler, where it would be an uncaught exception that
      // crashes the pty-host daemon and kills every live session. This mirrors
      // the old newline-JSON decoder, which swallowed all parse errors.
      try {
        const kind = payload[0];
        if (kind === KIND_OUTPUT) {
          // Need at least [tag][u16 keyLen], and the key must fit the payload —
          // else a bogus inner length would OOB-throw or silently mis-split.
          if (payload.length < 3) continue;
          const keyLen = payload.readUInt16BE(1);
          if (3 + keyLen > payload.length) continue;
          const key = payload.toString("utf8", 3, 3 + keyLen);
          const data = payload.toString("utf8", 3 + keyLen);
          onMessage({ t: "output", key, data } as T);
        } else if (kind === KIND_JSON) {
          onMessage(JSON.parse(payload.toString("utf8", 1)) as T);
        }
        // Unknown kind: ignore (forward-compatible).
      } catch {
        // skip a malformed/corrupt frame
      }
    }
  };
}
