/**
 * Process-tree + MCP-server detection (Tier-0 / M3, abtop-inspired). For a session's
 * ROOT pid (the pty/tmux pane process), enumerate its descendant processes — the
 * agent's subagent/child-process fan-out — and pick out the MCP servers among them, so
 * the Agent Monitor can show "this agent has spawned N processes incl. M MCP servers".
 *
 * The cross-platform PROCESS SNAPSHOT is the only I/O (POSIX `ps`, Windows PowerShell
 * `Get-CimInstance Win32_Process`); it is best-effort and fails CLOSED to an empty list
 * (so a missing/odd `ps` just shows no tree, never throws). Everything else — the two
 * output PARSERS, the descendant walk, and the MCP classifier — is PURE and unit-tested.
 * Mirrors lib/dev-servers.ts: shell out with execFile (argv array, no shell string),
 * parse in JS.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { isWindows } from "./platform";

const execFileAsync = promisify(execFile);

/** One process in the snapshot. `command` is the full command line (may be ""). */
export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}

/** Per-session process fan-out, derived from a snapshot + a root pid. */
export interface ProcessFanout {
  /** Count of descendant processes under the root (excludes the root itself). */
  childCount: number;
  /** Friendly names of the MCP servers found among the descendants (deduped, sorted). */
  mcpServers: string[];
}

/**
 * Parse POSIX `ps -A -ww -o pid=,ppid=,command=` output. Each line is
 * `<pid> <ppid> <command…>` with leading padding; the command is the rest of the line
 * (may itself contain spaces). Lines that don't start with two integers are skipped.
 * Pure → unit-tested.
 */
export function parsePosixPs(stdout: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({ pid, ppid, command: m[3].trim() });
  }
  return out;
}

/**
 * Parse the Windows snapshot output. We ask PowerShell to emit one line per process as
 * `<pid>|||<ppid>|||<commandline>` (a `|||` delimiter avoids CSV quoting and is
 * vanishingly unlikely to appear in a real command line; a null CommandLine yields an
 * empty third field). Pure → unit-tested.
 */
export function parseWindowsProcList(stdout: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("|||");
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    // Re-join the rest in case a command line somehow contained the delimiter.
    out.push({ pid, ppid, command: parts.slice(2).join("|||").trim() });
  }
  return out;
}

/**
 * All descendants of `rootPid` from a flat snapshot, breadth-first, EXCLUDING the root.
 * Cycle-safe (a process can't be visited twice; a pid that is its own ancestor — pid
 * recycling / a bogus ppid — can't loop forever). The root itself is never included even
 * if some process claims it as a child of itself. Pure → unit-tested.
 */
export function collectDescendants(
  procs: ProcInfo[],
  rootPid: number
): ProcInfo[] {
  // Index children by ppid for an O(n) walk.
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    if (p.pid === p.ppid) continue; // self-parent → ignore (would self-loop)
    const arr = byParent.get(p.ppid);
    if (arr) arr.push(p);
    else byParent.set(p.ppid, [p]);
  }
  const seen = new Set<number>([rootPid]);
  const result: ProcInfo[] = [];
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of byParent.get(parent) ?? []) {
      if (seen.has(child.pid)) continue; // cycle / already collected
      seen.add(child.pid);
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

// A command line looks like an MCP server when it carries an MCP marker: the literal
// "mcp" as a path/word segment (mcp-server-*, *-mcp, server.mcp, "mcp start"), the
// official SDK package, or Stoa's own orchestration server. Deliberately anchored to
// word/segment boundaries so a file the agent merely EDITS (e.g. "src/mcp.ts" passed to
// an editor) is far less likely to false-positive than a bare substring match — though
// this is a best-effort OBSERVABILITY hint, not a security boundary.
// An MCP marker: the official SDK, Stoa's own server, or an "mcp" path/word SEGMENT
// (mcp-server-*, *_mcp, "mcp start"). Boundary set includes "_" so python-style
// `mcp_server_x` is recognized. Anchored to segment boundaries, not a bare substring,
// so "decompressor" can't trip it — this is a best-effort OBSERVABILITY hint, not a
// security boundary.
const MCP_MARKERS: RegExp[] = [
  /modelcontextprotocol/i,
  /\borchestration-server\b/i,
  /(^|[\s/\\=:@._-])mcp([\s/\\=:._-]|$)/i,
];

// Priority-ordered patterns for a friendly MCP-SERVER name (the package/executable),
// most specific first. Each requires the "mcp" to sit in a server-NAME shape
// (mcp-server-x / mcp_server_x / x-mcp / mcp-x), NOT a bare data token — so a file an
// agent merely touches (mcp.ts, mcp.conf, /.mcp/) doesn't match any of these and the
// command classifies as "not a server" (null) below.
const MCP_NAME_PATTERNS: RegExp[] = [
  /@modelcontextprotocol\/([\w.-]+)/i, // @modelcontextprotocol/server-everything → server-everything
  /\b(mcp[-_]server[\w._-]*)/i, // mcp-server-filesystem, mcp_server_fetch
  /\b([\w.]+[-_]mcp)\b/i, // foo-mcp, my_mcp
  /\b(mcp[-_][\w._-]+)/i, // mcp-foo, mcp_foo
  /\b(orchestration-server)\b/i, // Stoa's own MCP server
];

// Tokens that merely MENTION mcp but are data, not a server: a config/log/doc file, or
// a dotfile/dotdir like ".mcp". Used to reject false-positive names.
const NON_SERVER_TOKEN = /\.(conf|log|json|md|txt|ya?ml|toml)$/i;

/**
 * If `command` looks like it RUNS an MCP server, return a short friendly name for it,
 * else null. Strips an agent's own `--mcp-config <file>` flag first (config-loading, not
 * a server), then requires a server-name-shaped token (mcp-server-x / x-mcp / mcp-x /
 * @modelcontextprotocol/x / orchestration-server), trimming path + script extension. A
 * command that's mcp-ish only via a data file / dotfile / flag value yields null (no
 * phantom server). Pure → unit-tested.
 */
export function mcpServerName(command: string): string | null {
  if (!command) return null;
  // An agent loading config with `--mcp-config <file>` is NOT itself an MCP server.
  const cleaned = command.replace(/--mcp-config(=\S+|\s+\S+)?/gi, " ");
  if (!MCP_MARKERS.some((re) => re.test(cleaned))) return null;
  for (const re of MCP_NAME_PATTERNS) {
    const m = re.exec(cleaned);
    if (!m) continue;
    const base = m[1].replace(/^.*[/\\]/, ""); // basename
    if (base.startsWith(".")) continue; // dotfile/dotdir (.mcp) → not a server
    if (NON_SERVER_TOKEN.test(base)) continue; // mcp.conf / mcp.log → a data file
    const token = base.replace(/\.(ts|js|mjs|cjs)$/i, ""); // strip a server-script ext
    if (token) return token;
  }
  return null; // mcp-ish, but only via a file/flag/data token → not a server
}

/**
 * Combine a snapshot + a root pid into the per-session fan-out: how many descendant
 * processes, and the deduped+sorted friendly names of the MCP servers among them. A
 * null/invalid root (we couldn't resolve the session's pid) yields an empty fan-out.
 * Pure → unit-tested.
 */
export function fanoutFor(
  procs: ProcInfo[],
  rootPid: number | null | undefined
): ProcessFanout {
  if (rootPid == null || !Number.isInteger(rootPid) || rootPid <= 0) {
    return { childCount: 0, mcpServers: [] };
  }
  const descendants = collectDescendants(procs, rootPid);
  const mcp = new Set<string>();
  for (const p of descendants) {
    const name = mcpServerName(p.command);
    if (name) mcp.add(name);
  }
  return {
    childCount: descendants.length,
    mcpServers: [...mcp].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * The PowerShell one-liner that emits the Windows process snapshot in our `|||` format.
 * Exposed for the test that locks the exact command. `-NoProfile` keeps it fast and
 * profile-independent; `Get-CimInstance` is the modern replacement for the deprecated
 * `wmic`.
 */
export const WINDOWS_SNAPSHOT_PS =
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  '"$($_.ProcessId)|||$($_.ParentProcessId)|||$($_.CommandLine)" }';

/**
 * Snapshot every process on the host as {pid, ppid, command}. Best-effort and
 * fail-CLOSED: any spawn/parse error yields [] (the Monitor then shows no fan-out rather
 * than throwing). POSIX uses `ps`; Windows uses PowerShell `Get-CimInstance`. Not on any
 * hot path — called on demand when the Monitor's process view is requested.
 */
export async function snapshotProcesses(): Promise<ProcInfo[]> {
  try {
    if (isWindows) {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_PS],
        { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }
      );
      return parseWindowsProcList(stdout);
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-A", "-ww", "-o", "pid=,ppid=,command="],
      // windowsHide is a no-op on POSIX (ps never runs on Windows), but the coverage
      // guard requires it on every execFile call site so a console-flash can't slip in.
      // timeout bounds a wedged enumerator (it would otherwise hang the request).
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 }
    );
    return parsePosixPs(stdout);
  } catch {
    return [];
  }
}
