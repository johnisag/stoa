/**
 * Pty session registry — Stoa's in-process replacement for the tmux server.
 *
 * A module-level Map of live PtySession objects that outlives any single
 * WebSocket. Shared by:
 *   - PtyBackend (lib/session-backend/pty-backend.ts) for the data/status ops
 *     the API routes and status detector call, and
 *   - server.ts, which subscribes WebSocket clients to a session's output.
 *
 * Tier 1 (migration-plan.md §1): sessions survive browser disconnects but not an
 * Stoa server restart — the Map lives in the Node process. Tier 2 would move
 * this into a separate long-lived pty-host process.
 */

import { existsSync, readFileSync, statSync } from "fs";
import * as pty from "node-pty";
import {
  isWindows,
  homeDir,
  expandHome,
  resolveBinary,
  defaultInteractiveShell,
} from "../../platform";
import { PtySession } from "./pty-session";

/** The process-wide registry. Survives WebSocket lifecycles, dies with the Node process. */
const sessions = new Map<string, PtySession>();

export interface SpawnSpec {
  /** Executable to run (e.g. "claude"); resolved on PATH and .cmd-wrapped on Windows. */
  binary: string;
  /** Arguments, passed as a real argv array (no shell quoting). */
  args: string[];
  /** Working directory; "~"/"$HOME" are expanded. */
  cwd: string;
  cols?: number;
  rows?: number;
  /** Extra environment overlaid on the inherited env. */
  env?: Record<string, string>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/**
 * On Windows, opt node-pty into the bundled conpty.dll path. This avoids
 * node-pty's kill-time Node helper (the `conpty_console_list` agent), which can
 * flash a console window when a session is spawned or killed. No-op off Windows.
 */
export function windowsConptyOptions(
  platform: NodeJS.Platform = process.platform
): { useConptyDll?: true } {
  return platform === "win32" ? { useConptyDll: true } : {};
}

/**
 * Resolve a binary + args into a spawnable (file, args) pair, cross-platform.
 *
 * On Windows, npm-installed CLIs are `.cmd`/`.bat` shims that CreateProcess
 * cannot launch directly. Prefer unwrapping standard npm shims to their real
 * node/exe target so argv stays shell-free; fail closed on unrecognized shims.
 * Otherwise spawn the resolved absolute path (or the bare name if not found on
 * PATH).
 */
interface ResolveSpawnDeps {
  onWindows?: boolean;
  resolveBin?: (name: string) => string | null;
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

function dirnameAnySep(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx >= 0 ? filePath.slice(0, idx) : ".";
}

function joinAnySep(dir: string, relativePath: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const cleanDir = dir.replace(/[\\/]+$/, "");
  const cleanRelative = relativePath.replace(/[\\/]+/g, sep);
  return `${cleanDir}${sep}${cleanRelative}`;
}

function resolveNpmCmdShim(
  shimPath: string,
  args: string[],
  deps: ResolveSpawnDeps
): { file: string; args: string[] } | null {
  const read = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let content: string;
  try {
    content = read(shimPath);
  } catch {
    return null;
  }

  const baseDir = dirnameAnySep(shimPath);
  const nodeScript = content.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/i);
  if (nodeScript) {
    const exists = deps.exists ?? existsSync;
    const localNode = joinAnySep(baseDir, "node.exe");
    const nodePath = exists(localNode)
      ? localNode
      : (deps.resolveBin ?? resolveBinary)("node") ||
        process.execPath ||
        "node";
    return {
      file: nodePath,
      args: [joinAnySep(baseDir, nodeScript[1]), ...args],
    };
  }

  const directExe = content.match(
    /(?:^|[&|])\s*"%dp0%\\([^"]+\.(?:exe|com))"\s+%\*/im
  );
  if (directExe) {
    return { file: joinAnySep(baseDir, directExe[1]), args: [...args] };
  }

  return null;
}

function unsupportedCmdShim(shimPath: string): never {
  throw new Error(`Unable to safely launch Windows command shim: ${shimPath}`);
}

function resolveSpawn(
  binary: string,
  args: string[],
  deps: ResolveSpawnDeps = {}
): { file: string; args: string[] } {
  const resolved = (deps.resolveBin ?? resolveBinary)(binary) || binary;
  if ((deps.onWindows ?? isWindows) && /\.(cmd|bat)$/i.test(resolved)) {
    const npmShim = resolveNpmCmdShim(resolved, args, deps);
    if (npmShim) return npmShim;
    return unsupportedCmdShim(resolved);
  }
  return { file: resolved, args };
}

/** Exposed for cross-platform tests of Windows shim routing. */
export function _resolveSpawnForTests(
  binary: string,
  args: string[],
  deps?: ResolveSpawnDeps
): { file: string; args: string[] } {
  return resolveSpawn(binary, args, deps);
}

/** Build the child environment (inherit parent, normalize HOME/USER, overlay extras). */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v != null) base[k] = v;
  }
  // Many CLIs read HOME even on Windows; ensure it's set alongside USERPROFILE.
  if (!base.HOME) base.HOME = homeDir();
  base.TERM = base.TERM || "xterm-256color";
  base.COLORTERM = base.COLORTERM || "truecolor";
  return { ...base, ...(extra ?? {}) };
}

/**
 * Validate the cwd before node-pty reaches CreateProcess. Windows reports a
 * missing directory as opaque error 267; surfacing the path here makes stale
 * worktrees and deleted projects actionable instead of looking like a pty bug.
 */
function resolveSpawnCwd(rawCwd: string): string {
  const cwd = expandHome(rawCwd) || homeDir();
  try {
    if (statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Fall through to the consistent error below.
  }
  throw new Error(`Working directory does not exist: ${cwd}`);
}

/** Whether a session with this key currently exists (alive or not yet reaped). */
export function hasSession(key: string): boolean {
  return sessions.has(key);
}

export function getSession(key: string): PtySession | undefined {
  return sessions.get(key);
}

export function listSessions(): PtySession[] {
  return [...sessions.values()];
}

export function listSessionKeys(): string[] {
  return [...sessions.keys()];
}

/**
 * Spawn a new session under `key`. If one already exists it is returned as-is
 * (idempotent attach-or-create, mirroring `tmux attach || tmux new`).
 */
export function spawnSession(key: string, spec: SpawnSpec): PtySession {
  const existing = sessions.get(key);
  if (existing && existing.alive) return existing;
  if (existing) sessions.delete(key); // dead remnant; replace

  const cols = spec.cols ?? DEFAULT_COLS;
  const rows = spec.rows ?? DEFAULT_ROWS;
  const cwd = resolveSpawnCwd(spec.cwd);
  const { file, args } = resolveSpawn(spec.binary, spec.args);

  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: buildEnv(spec.env),
    ...windowsConptyOptions(),
  });

  const session = new PtySession({ key, pty: proc, cwd, cols, rows });
  // Reap from the registry when the process exits. Delete by identity (not by
  // the original key) so a renamed session is still removed from its new key.
  session.onExit(() => deleteByIdentity(session));
  sessions.set(key, session);
  return session;
}

/** Remove a session from the registry by IDENTITY, whatever key it now lives
 * under — so a rename (possibly racing an async kill) can't leave it leaked or
 * make a delete-by-stale-key clobber a different session reusing that key. */
function deleteByIdentity(session: PtySession): void {
  for (const [k, v] of sessions) {
    if (v === session) {
      sessions.delete(k);
      return;
    }
  }
}

/**
 * Spawn an interactive shell session (for the "shell" provider / plain terminal).
 */
export function spawnShellSession(
  key: string,
  cwd: string,
  cols?: number,
  rows?: number
): PtySession {
  const shell = isWindows
    ? resolveBinary("pwsh") || process.env.ComSpec || "powershell.exe"
    : defaultInteractiveShell();
  return spawnSession(key, {
    binary: shell,
    args: [],
    cwd,
    cols,
    rows,
  });
}

export function killSession(key: string): void {
  const session = sessions.get(key);
  if (session) {
    session.kill();
    deleteByIdentity(session);
  }
}

export async function killSessionAndWait(
  key: string,
  timeoutMs?: number
): Promise<void> {
  const session = sessions.get(key);
  if (session) {
    // Mark the session as dying BEFORE awaiting process exit so any concurrent
    // attach sees the flag and rejects instead of subscribing to a session that
    // is about to be deleted from the registry.
    session.markDying();
    await session.killAndWait(timeoutMs);
    // Delete by identity — a rename during the await could move it to a new key,
    // and a delete-by-original-key would miss it (or clobber a session that
    // reused the key).
    deleteByIdentity(session);
  }
}

/** Returns true if the rename happened, false on a no-op (missing/collision). */
export function renameSession(oldKey: string, newKey: string): boolean {
  if (oldKey === newKey) return true;
  const session = sessions.get(oldKey);
  if (!session) return false;
  // Don't clobber an existing session under newKey.
  if (sessions.has(newKey)) return false;
  sessions.delete(oldKey);
  session.key = newKey; // keep the label in sync (list/listWithActivity report it)
  sessions.set(newKey, session);
  return true;
}

/** Resolve a leading "~"/path for callers that need the same expansion. */
export function resolveCwd(cwd: string): string {
  return expandHome(cwd) || homeDir();
}

/** Exposed for tests/diagnostics. */
export async function _resetRegistryForTests(): Promise<void> {
  const live = [...sessions.values()];
  for (const session of live) session.kill();
  await Promise.all(live.map((session) => session.waitForExit()));
  sessions.clear();
}
