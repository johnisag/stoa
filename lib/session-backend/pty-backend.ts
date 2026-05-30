/**
 * Pty implementation of SessionBackend.
 *
 * Satisfies the same data/status/input contract as the tmux backend, but
 * against the in-process pty registry instead of the tmux server. This is the
 * cross-platform backend (ConPTY on Windows).
 *
 * Note on create(): the interactive terminal path spawns agents directly via
 * the registry (driven by server.ts on attach), so create() here is used by the
 * headless callers (orchestration workers, summarize). Those pass a shell
 * command string, which we run through the platform shell. The bash banner
 * wrapper still assumes a POSIX shell — running orchestration on native Windows
 * is a documented follow-up (migration-plan.md Phase 4); the interactive path
 * does not depend on it.
 */

import { isWindows, resolveBinary } from "../platform";
import type {
  SessionBackend,
  SessionActivity,
  CaptureOptions,
  CreateOptions,
  SendOptions,
} from "./types";
import {
  spawnSession,
  killSession,
  renameSession,
  hasSession,
  getSession,
  listSessions,
} from "./pty/registry";

export class PtyBackend implements SessionBackend {
  async create({
    name,
    cwd,
    command,
    binary,
    args,
  }: CreateOptions): Promise<void> {
    // Preferred path: spawn the agent binary directly with argv — no bash
    // banner, works on native Windows. Used when the caller supplies binary.
    if (binary && binary.length > 0) {
      spawnSession(name, { binary, args: args ?? [], cwd });
      return;
    }
    // Fallback: run the (banner-wrapped) command string through a shell. The
    // bash banner assumes POSIX; orchestration on native Windows should pass
    // binary/args above instead.
    if (isWindows) {
      const pwsh = resolveBinary("pwsh");
      if (pwsh) {
        spawnSession(name, {
          binary: pwsh,
          args: ["-NoLogo", "-Command", command],
          cwd,
        });
      } else {
        spawnSession(name, {
          binary: process.env.ComSpec || "cmd.exe",
          args: ["/c", command],
          cwd,
        });
      }
    } else {
      spawnSession(name, {
        binary: process.env.SHELL || "/bin/bash",
        args: ["-c", command],
        cwd,
      });
    }
  }

  async kill(name: string): Promise<void> {
    killSession(name);
  }

  async rename(oldName: string, newName: string): Promise<void> {
    // Throw on a no-op (target exists / session missing) so callers don't commit
    // a DB rename that doesn't match a live session.
    if (!renameSession(oldName, newName)) {
      throw new Error(`rename failed: ${oldName} -> ${newName}`);
    }
  }

  async exists(name: string): Promise<boolean> {
    const session = getSession(name);
    return !!session && session.alive;
  }

  async list(): Promise<string[]> {
    return listSessions()
      .filter((s) => s.alive)
      .map((s) => s.key);
  }

  async listWithActivity(): Promise<SessionActivity[]> {
    return listSessions()
      .filter((s) => s.alive)
      .map((s) => ({
        name: s.key,
        // Epoch seconds, matching tmux's #{session_activity} granularity.
        activity: Math.floor(s.lastActivity / 1000),
      }));
  }

  async getPanePath(name: string): Promise<string | null> {
    const session = getSession(name);
    return session ? session.cwd : null;
  }

  async getEnv(name: string, varName: string): Promise<string | null> {
    // A pty can't introspect its child's environment. Callers that need
    // CLAUDE_SESSION_ID fall back to reading Claude's JSONL on disk.
    const session = getSession(name);
    return session?.meta[varName] ?? null;
  }

  async capture(name: string, opts?: CaptureOptions): Promise<string> {
    const session = getSession(name);
    if (!session) return "";
    return session.capture(opts?.lines);
  }

  async sendEnter(name: string): Promise<void> {
    getSession(name)?.write("\r");
  }

  async sendKeysLiteral(name: string, text: string): Promise<void> {
    getSession(name)?.write(text);
  }

  async sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    getSession(name)?.write(text + (opts?.enter ? "\r" : ""));
  }

  async pasteText(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void> {
    const session = getSession(name);
    if (!session) return;
    // Bracketed paste so multi-line input isn't submitted line-by-line
    // (what tmux load-buffer/paste-buffer effectively achieved).
    session.write(`\x1b[200~${text}\x1b[201~`);
    if (opts?.enter) session.write("\r");
  }
}
