/**
 * PtyTransport — the seam between the SessionBackend/terminal logic and WHERE
 * the pty actually lives.
 *
 *  - LocalTransport: the in-process registry (Tier 1).
 *  - HostTransport:  the out-of-process pty-host daemon over IPC (Tier 2).
 *
 * Both expose the same control + streaming surface, so a single PtyBackend and a
 * single server.ts WebSocket handler work against either by composition instead
 * of duplicating spawn/attach/input/resize/kill logic per tier.
 */

import type { SessionActivity } from "../types";
import {
  spawnSession,
  spawnShellSession,
  getSession,
  killSessionAndWait,
  renameSession,
  listSessions,
  type SpawnSpec,
} from "./registry";
import { getHostClient } from "./host-client";

/** How to spawn a session that doesn't exist yet on attach. */
export interface AttachSpawn {
  /** Empty/omitted binary => a plain platform shell. */
  binary?: string;
  args?: string[];
  cwd?: string;
}

export interface AttachRequest {
  key: string;
  /** Create the session if it isn't already running. */
  spawn?: AttachSpawn;
  cols: number;
  rows: number;
  onOutput: (data: string) => void;
  onExit: (code: number) => void;
  /**
   * Read-only observer (e.g. a mini-terminal preview): stream output + snapshot
   * but DON'T register as a sizing client, so it never shrinks the pty for the
   * real viewer. resize() becomes a no-op for these.
   */
  observer?: boolean;
}

/** A live subscription for one client, scoped to resize/detach that client. */
export interface AttachHandle {
  /** Repaint of the current screen to write to the (re)connecting terminal. */
  snapshot: string;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export interface PtyTransport {
  // ── control ──
  spawn(key: string, spec: SpawnSpec): Promise<void>;
  kill(key: string): Promise<void>;
  rename(oldKey: string, newKey: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(): Promise<string[]>;
  listActivity(): Promise<SessionActivity[]>;
  panePath(key: string): Promise<string | null>;
  pid(key: string): Promise<number | null>;
  capture(key: string, lines?: number): Promise<string>;
  write(key: string, data: string): void;
  // ── streaming (used by server.ts) ──
  attachStream(req: AttachRequest): Promise<AttachHandle>;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** Tier 1 — the in-process registry. */
export class LocalTransport implements PtyTransport {
  async spawn(key: string, spec: SpawnSpec): Promise<void> {
    spawnSession(key, spec);
  }
  async kill(key: string): Promise<void> {
    await killSessionAndWait(key);
  }
  async rename(oldKey: string, newKey: string): Promise<void> {
    if (!renameSession(oldKey, newKey)) {
      throw new Error(`rename failed: ${oldKey} -> ${newKey}`);
    }
  }
  async exists(key: string): Promise<boolean> {
    const s = getSession(key);
    return !!s && s.alive;
  }
  async list(): Promise<string[]> {
    return listSessions()
      .filter((s) => s.alive)
      .map((s) => s.key);
  }
  async listActivity(): Promise<SessionActivity[]> {
    return listSessions()
      .filter((s) => s.alive)
      .map((s) => ({
        name: s.key,
        activity: Math.floor(s.lastActivity / 1000),
      }));
  }
  async panePath(key: string): Promise<string | null> {
    return getSession(key)?.cwd ?? null;
  }
  async pid(key: string): Promise<number | null> {
    const p = getSession(key)?.pid;
    return typeof p === "number" && p > 0 ? p : null;
  }
  async capture(key: string, lines?: number): Promise<string> {
    return getSession(key)?.capture(lines) ?? "";
  }
  write(key: string, data: string): void {
    getSession(key)?.write(data);
  }
  async attachStream(req: AttachRequest): Promise<AttachHandle> {
    let session = getSession(req.key);
    if ((!session || !session.alive || session.dying) && req.spawn) {
      const cwd = req.spawn.cwd || ".";
      session =
        req.spawn.binary && req.spawn.binary.length > 0
          ? spawnSession(req.key, {
              binary: req.spawn.binary,
              args: req.spawn.args ?? [],
              cwd,
              cols: req.cols,
              rows: req.rows,
            })
          : spawnShellSession(req.key, cwd, req.cols, req.rows);
    }
    if (!session) throw new Error(`session not found: ${req.key}`);

    const snapshot = session.serialize();
    const offOutput = session.onOutput(req.onOutput);
    const offExit = session.onExit(({ exitCode }) => req.onExit(exitCode));
    // Observers don't register a size (no shrink); everyone else is a sizing client.
    const clientId = req.observer
      ? null
      : session.addClient(req.cols, req.rows);
    const live = session;
    return {
      snapshot,
      resize:
        clientId === null
          ? () => {}
          : (cols, rows) => live.resizeClient(clientId, cols, rows),
      detach: () => {
        offOutput();
        offExit();
        if (clientId !== null) live.removeClient(clientId);
      },
    };
  }
}

/** Tier 2 — the out-of-process daemon, via the host client. */
export class HostTransport implements PtyTransport {
  private client = getHostClient();

  async spawn(key: string, spec: SpawnSpec): Promise<void> {
    await this.client.spawn(key, {
      binary: spec.binary,
      args: spec.args,
      cwd: spec.cwd,
      cols: spec.cols,
      rows: spec.rows,
      env: spec.env,
    });
  }
  async kill(key: string): Promise<void> {
    await this.client.kill(key);
  }
  async rename(oldKey: string, newKey: string): Promise<void> {
    await this.client.rename(oldKey, newKey); // rejects on daemon no-op
  }
  async exists(key: string): Promise<boolean> {
    return this.client.exists(key);
  }
  async list(): Promise<string[]> {
    return this.client.list();
  }
  async listActivity(): Promise<SessionActivity[]> {
    return this.client.listActivity();
  }
  async panePath(key: string): Promise<string | null> {
    return this.client.panePath(key);
  }
  async pid(key: string): Promise<number | null> {
    return this.client.pid(key);
  }
  async capture(key: string, lines?: number): Promise<string> {
    return this.client.capture(key, lines);
  }
  write(key: string, data: string): void {
    this.client.input(key, data);
  }
  async attachStream(req: AttachRequest): Promise<AttachHandle> {
    if (req.spawn) {
      const cwd = req.spawn.cwd || ".";
      if (req.spawn.binary && req.spawn.binary.length > 0) {
        await this.client.spawn(req.key, {
          binary: req.spawn.binary,
          args: req.spawn.args ?? [],
          cwd,
          cols: req.cols,
          rows: req.rows,
        });
      } else {
        await this.client.spawnShell(req.key, cwd, req.cols, req.rows);
      }
    }
    const { snapshot, detach } = await this.client.attach(
      req.key,
      req.onOutput,
      req.onExit,
      req.observer,
      req.cols,
      req.rows
    );
    return {
      snapshot,
      resize: req.observer
        ? () => {}
        : (cols, rows) => this.client.resize(req.key, cols, rows),
      detach,
    };
  }
}

export { DEFAULT_COLS, DEFAULT_ROWS };
