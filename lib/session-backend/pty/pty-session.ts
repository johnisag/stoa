/**
 * PtySession — one long-lived agent process under Stoa's own supervision.
 *
 * Replaces what a single tmux session provided:
 *  - a persistent process (survives browser disconnect; killed only explicitly)
 *  - rendered scrollback for status/preview (via a headless xterm VT emulator)
 *  - multi-client attach (a Set of subscribers; output fans out to all)
 *  - input injection (pty.write)
 *
 * The headless Terminal renders the byte stream into a grid so capture() returns
 * the SAME shape of text tmux's `capture-pane -p` did — critical because the
 * status detector matches a spinner line that overwrites itself in place, not an
 * append-only byte log. A (re)connecting client repaints from serialize() (the
 * rendered VT state); a small bounded raw byte buffer is kept only as a fallback
 * for the rare case serialize() throws.
 *
 * See migration-plan.md, Phase 2.
 */

import type { IPty } from "node-pty";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { isWindows } from "../../platform";

/**
 * Max raw bytes retained for client replay. This is only a FALLBACK for when
 * serialize() throws (the addon is the real repaint path) — so keep it small.
 * 64 KiB is plenty for a degraded repaint of recent output without holding a
 * quarter-megabyte of ANSI per session.
 */
const RAW_BUFFER_LIMIT = 64 * 1024;
/**
 * Slack before trimming the raw buffer. We let it grow to 2× the limit and then
 * trim back to 1×, so the trim allocation amortizes to O(1) per byte instead of
 * reallocating ~RAW_BUFFER_LIMIT on EVERY chunk once full (the old hot-path cost).
 */
const RAW_BUFFER_HIGH_WATER = RAW_BUFFER_LIMIT * 2;
/**
 * Scrollback rows the headless emulator keeps for rendered capture(). Status and
 * preview read only the visible screen; the deepest consumer (summarize) reads
 * 500 lines — so 1000 is comfortably enough and ~5× less per-session memory than
 * the old 5000. It also shrinks every serialize() snapshot (repaint payload).
 */
const HEADLESS_SCROLLBACK = 1000;

export type OutputListener = (data: string) => void;
export type ExitListener = (info: { exitCode: number }) => void;

export interface PtySessionInit {
  key: string;
  pty: IPty;
  cwd: string;
  cols: number;
  rows: number;
  /** Optional env var the agent is expected to set (e.g. CLAUDE_SESSION_ID); read later if known. */
  meta?: Record<string, string>;
}

export class PtySession {
  // Mutable so a registry rename keeps it in sync (used by list/listWithActivity).
  key: string;
  readonly cwd: string;
  private readonly pty: IPty;
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private rawBuffer = "";
  private outputListeners = new Set<OutputListener>();
  private exitListeners = new Set<ExitListener>();
  private _alive = true;
  private _lastActivity: number;
  private _exitCode: number | null = null;
  meta: Record<string, string>;

  constructor(init: PtySessionInit) {
    this.key = init.key;
    this.cwd = init.cwd;
    this.pty = init.pty;
    this.meta = init.meta ?? {};
    this._lastActivity = Date.now();
    this.term = new Terminal({
      cols: init.cols,
      rows: init.rows,
      scrollback: HEADLESS_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    this.pty.onData((data: string) => {
      this._lastActivity = Date.now();
      // Feed the headless emulator (rendered grid for capture()).
      this.term.write(data);
      // Retain raw bytes for the serialize() fallback, capped. Trim only when we
      // cross the high-water mark (2× limit), back down to the limit — so the
      // O(limit) slice happens at most once per `limit` bytes, not every chunk.
      this.rawBuffer += data;
      if (this.rawBuffer.length > RAW_BUFFER_HIGH_WATER) {
        this.rawBuffer = this.rawBuffer.slice(
          this.rawBuffer.length - RAW_BUFFER_LIMIT
        );
        // The slice cuts at a UTF-16 code-unit boundary; if it landed inside a
        // surrogate pair, drop the orphaned low surrogate so the fallback
        // repaint doesn't begin with a stray U+FFFD.
        const c = this.rawBuffer.charCodeAt(0);
        if (c >= 0xdc00 && c <= 0xdfff)
          this.rawBuffer = this.rawBuffer.slice(1);
      }
      for (const listener of this.outputListeners) listener(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this._alive = false;
      this._exitCode = exitCode;
      for (const listener of this.exitListeners) listener({ exitCode });
    });
  }

  get alive(): boolean {
    return this._alive;
  }

  get lastActivity(): number {
    return this._lastActivity;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Raw byte history (legacy / fallback). Prefer serialize() for repaint. */
  getRawBuffer(): string {
    return this.rawBuffer;
  }

  /**
   * A clean repaint of the CURRENT screen + scrollback, as escape sequences,
   * produced from the rendered VT state (like tmux redrawing on attach). This
   * reconstructs the exact current screen for a (re)connecting client without
   * replaying the entire raw byte history — avoiding mid-sequence truncation
   * and stale/duplicated frames from a long-running TUI.
   */
  serialize(): string {
    try {
      return this.serializer.serialize();
    } catch {
      // Fall back to raw history if serialization ever fails.
      return this.rawBuffer;
    }
  }

  /** Write input to the process. */
  write(data: string): void {
    if (this._alive) this.pty.write(data);
  }

  /** Resize the pty (and the headless emulator). */
  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    try {
      this.term.resize(cols, rows);
      if (this._alive) this.pty.resize(cols, rows);
    } catch {
      // resize can race with exit; ignore
    }
  }

  // ── Multi-client sizing ────────────────────────────────────────────────
  // With several clients viewing one session, resize the pty to the SMALLEST
  // client (tmux's default window-size policy) so no client sees clipped output.
  private clientSizes = new Map<number, { cols: number; rows: number }>();
  private nextClientId = 1;

  /** Register a viewing client; returns an id to update/remove it. */
  addClient(cols: number, rows: number): number {
    const id = this.nextClientId++;
    this.clientSizes.set(id, { cols, rows });
    this.applyMinSize();
    return id;
  }

  resizeClient(id: number, cols: number, rows: number): void {
    if (!this.clientSizes.has(id)) return;
    this.clientSizes.set(id, { cols, rows });
    this.applyMinSize();
  }

  removeClient(id: number): void {
    if (this.clientSizes.delete(id)) this.applyMinSize();
  }

  private applyMinSize(): void {
    if (this.clientSizes.size === 0) return;
    let cols = Infinity;
    let rows = Infinity;
    for (const s of this.clientSizes.values()) {
      cols = Math.min(cols, s.cols);
      rows = Math.min(rows, s.rows);
    }
    if (Number.isFinite(cols) && Number.isFinite(rows)) this.resize(cols, rows);
  }

  /**
   * Rendered terminal text, matching `tmux capture-pane -p [-S -N]`.
   * @param lines  last N rows of (scrollback+visible); omit for the visible screen only.
   */
  capture(lines?: number): string {
    const buf = this.term.buffer.active;
    const total = buf.length; // scrollback + screen rows
    let start: number;
    let end: number;
    if (lines != null) {
      end = total;
      start = Math.max(0, total - lines);
    } else {
      // Visible screen only.
      start = buf.baseY;
      end = buf.baseY + this.term.rows;
    }
    const out: string[] = [];
    for (let y = start; y < end; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true) : "");
    }
    return out.join("\n");
  }

  /** Subscribe to live output. Returns an unsubscribe function. */
  onOutput(listener: OutputListener): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  /** Subscribe to process exit. Returns an unsubscribe function. */
  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.outputListeners.size;
  }

  /** Terminate the process. */
  kill(): void {
    if (this._alive) {
      try {
        this.pty.kill();
      } catch {
        // already gone
      }
    }
  }

  waitForExit(timeoutMs = 5000): Promise<boolean> {
    if (!this._alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      let offExit: (() => void) | null = null;
      const timer = setTimeout(() => {
        offExit?.();
        resolve(!this._alive);
      }, timeoutMs);
      timer.unref?.();
      offExit = this.onExit(() => {
        clearTimeout(timer);
        offExit?.();
        resolve(true);
      });
    });
  }

  async killAndWait(timeoutMs = 5000): Promise<boolean> {
    const pid = this.pty.pid;
    this.kill();
    const exited = await this.waitForExit(timeoutMs);
    if (isWindows && pid > 0 && this.processExists(pid)) {
      try {
        process.kill(pid);
      } catch {
        // already gone
      }
      return this.waitForExit(1000);
    }
    return exited;
  }

  private processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
