/**
 * Listening-port enumeration (Tier-0 / M4, abtop-inspired). Lists every TCP port in the
 * LISTEN state with its owning pid, host-wide — the inverse of lib/dev-servers.ts's
 * single-port `getPidOnPort`. The Agent Monitor (M4) intersects this with each session's
 * process tree (lib/process-tree.ts) to attribute an agent-spawned server to its session
 * and flag the ones Stoa doesn't manage as "orphans".
 *
 * The SNAPSHOT is the only I/O (Windows `netstat -ano`, POSIX `lsof`), best-effort and
 * fail-CLOSED to []. The two parsers are PURE and unit-tested. Mirrors the netstat/lsof
 * approach already established in lib/dev-servers.ts (per-platform branch, execFile argv,
 * JS-side parse) — lsof is used ONLY on the POSIX branch (Windows uses netstat).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows } from "./platform";

const execFileAsync = promisify(execFile);

/** A listening TCP port and the pid that owns it. */
export interface PortOwner {
  port: number;
  pid: number;
}

/** Extract the port from a local-address token (`0.0.0.0:3000`, `[::]:3000`,
 *  `127.0.0.1:8080`, `*:5173`) — the digits after the LAST colon. Null if absent or out
 *  of the 1..65535 range. Pure. */
function portFromAddr(addr: string): number | null {
  const m = /:(\d+)$/.exec(addr);
  if (!m) return null;
  const port = Number(m[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * Parse Windows `netstat -ano` output → listening {port, pid}. A TCP listener row is
 * `TCP <local> <foreign> LISTENING <pid>`; everything else (UDP, non-LISTENING, headers)
 * is skipped. Pure → unit-tested.
 */
export function parseNetstatListening(stdout: string): PortOwner[] {
  const out: PortOwner[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (cols[0].toUpperCase() !== "TCP") continue;
    if (cols[3].toUpperCase() !== "LISTENING") continue;
    const port = portFromAddr(cols[1]);
    const pid = Number(cols[cols.length - 1]);
    if (port == null || !Number.isInteger(pid) || pid <= 0) continue;
    out.push({ port, pid });
  }
  return out;
}

/**
 * Parse POSIX `lsof -nP -iTCP -sTCP:LISTEN -Fpn` field output → listening {port, pid}.
 * lsof `-F` emits one field per line, tagged by its first char: `p<pid>` starts a process
 * record, each following `n<addr>` is one of that process's listening sockets. Pure →
 * unit-tested.
 */
export function parseLsofListening(stdout: string): PortOwner[] {
  const out: PortOwner[] = [];
  let pid: number | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") {
      const n = Number(val);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (tag === "n" && pid != null) {
      const port = portFromAddr(val);
      if (port != null) out.push({ port, pid });
    }
  }
  return out;
}

/**
 * Host-wide snapshot of listening TCP ports + owners. Best-effort, fail-CLOSED to []: a
 * missing tool, a non-zero exit (lsof exits 1 when nothing matches), or a parse error all
 * yield [] (the Monitor then shows no ports rather than throwing). Not on the hot path —
 * called on demand alongside the process snapshot.
 */
export async function listListeningPorts(): Promise<PortOwner[]> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync("netstat", ["-ano"], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 10_000,
      });
      return parseNetstatListening(stdout);
    }
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
      // windowsHide is a POSIX no-op but the coverage guard wants it on every call site.
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }
    );
    return parseLsofListening(stdout);
  } catch {
    return [];
  }
}
