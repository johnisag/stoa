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

import * as pty from "node-pty";
import { isWindows, homeDir, expandHome, resolveBinary } from "../../platform";
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
 * Resolve a binary + args into a spawnable (file, args) pair, cross-platform.
 *
 * On Windows, npm-installed CLIs are `.cmd`/`.bat` shims that CreateProcess
 * cannot launch directly, so we route them through cmd.exe. Otherwise we spawn
 * the resolved absolute path (or the bare name if not found on PATH).
 */
function resolveSpawn(
  binary: string,
  args: string[]
): { file: string; args: string[] } {
  const resolved = resolveBinary(binary) || binary;
  if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
    const comspec = process.env.ComSpec || "cmd.exe";
    return { file: comspec, args: ["/c", resolved, ...args] };
  }
  return { file: resolved, args };
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
  const cwd = expandHome(spec.cwd) || homeDir();
  const { file, args } = resolveSpawn(spec.binary, spec.args);

  const proc = pty.spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: buildEnv(spec.env),
  });

  const session = new PtySession({ key, pty: proc, cwd, cols, rows });
  // Reap from the registry when the process exits. Delete by identity (not by
  // the original key) so a renamed session is still removed from its new key.
  session.onExit(() => {
    for (const [k, v] of sessions) {
      if (v === session) {
        sessions.delete(k);
        break;
      }
    }
  });
  sessions.set(key, session);
  return session;
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
    : process.env.SHELL || "/bin/bash";
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
    sessions.delete(key);
  }
}

export async function killSessionAndWait(
  key: string,
  timeoutMs?: number
): Promise<void> {
  const session = sessions.get(key);
  if (session) {
    await session.killAndWait(timeoutMs);
    sessions.delete(key);
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
