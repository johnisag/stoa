/**
 * IPC protocol for the pty-host daemon (Tier 2, migration-plan.md §6, Phase 6).
 *
 * The host owns the pty registry in a separate long-lived process so agent
 * sessions survive the Stoa web server restarting. Web-server-side clients
 * talk to it over a local socket (named pipe on Windows, unix socket on POSIX).
 *
 * Framing: newline-delimited JSON. pty output is carried as a JSON string
 * (ANSI bytes are valid UTF-8 text here), so no extra base64 layer is needed.
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
  | { t: "attach"; id: number; key: string }
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

export function encode(msg: ClientMessage | HostMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Largest single frame we'll buffer before assuming a peer is misbehaving (or
 * malicious) and resetting — prevents unbounded memory from a stream that never
 * sends a newline. One pty snapshot can be sizable, so keep this generous.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Stateful newline-delimited JSON decoder. Feed chunks; get back complete
 * messages. Tolerates messages split across chunks; drops a frame that grows
 * past MAX_FRAME_BYTES without a delimiter.
 */
export function createDecoder<T>(
  onMessage: (msg: T) => void
): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length === 0) continue;
      try {
        onMessage(JSON.parse(line) as T);
      } catch {
        // skip malformed line
      }
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      // No delimiter in an oversized buffer — discard to bound memory.
      buffer = "";
    }
  };
}
