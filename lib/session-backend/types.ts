/**
 * SessionBackend — the abstraction that decouples Stoa from tmux.
 *
 * Today the only implementation is `TmuxBackend`, which reproduces the exact
 * tmux commands the codebase used inline. A future `PtyBackend` (ConPTY on
 * Windows) will implement the same interface against an in-process pty registry
 * + headless VT emulator — see migration-plan.md, Phases 1–2.
 *
 * All methods are async so a shell-based backend (tmux) and an in-process
 * backend (pty) can both satisfy the contract; existing call sites already
 * await their tmux calls, so this matches current usage.
 *
 * Escaping/quoting of session names and input text is owned by the backend.
 * Call sites must pass RAW strings and must NOT pre-escape — the tmux backend
 * applies the same escaping that used to live at the call site.
 */

/** A session name paired with its last-activity time (epoch seconds, as tmux reports it). */
export interface SessionActivity {
  name: string;
  /** Unix epoch seconds of last pane activity, or null if unknown. */
  activity: number | null;
}

export interface CaptureOptions {
  /**
   * Number of scrollback lines to include (maps to tmux `capture-pane -S -N`).
   * Omit for the visible screen only (`capture-pane -p`).
   */
  lines?: number;
}

export interface CreateOptions {
  /** Session key/name (e.g. `${agentType}-${id}`). */
  name: string;
  /** Working directory for the session. May contain a leading "~"; each backend
   * expands it for its platform (tmux -> $HOME, pty -> os.homedir). */
  cwd: string;
  /** The full shell command to run inside the session (banner-wrapped). Used by
   * the tmux backend, and by the pty backend only when binary/args are absent. */
  command: string;
  /** Structured argv for a direct (shell-less) spawn. Preferred by the pty
   * backend — avoids the bash banner so it works on native Windows. */
  binary?: string;
  args?: string[];
}

export interface SendOptions {
  /** Press Enter after sending the text. */
  enter?: boolean;
}

export interface SessionBackend {
  // ── Lifecycle ──────────────────────────────────────────────────────────
  /** Create a detached session running `command` in `cwd`. (tmux: new-session -d) */
  create(opts: CreateOptions): Promise<void>;
  /** Kill a session; no-op if it doesn't exist. (tmux: kill-session) */
  kill(name: string): Promise<void>;
  /** Rename a session. (tmux: rename-session) */
  rename(oldName: string, newName: string): Promise<void>;
  /** Whether a session currently exists. (tmux: has-session) */
  exists(name: string): Promise<boolean>;
  /** All Stoa-managed session names. (tmux: list-sessions -F '#{session_name}') */
  list(): Promise<string[]>;
  /** All sessions with last-activity timestamps. (tmux: list-sessions -F '…#{session_activity}') */
  listWithActivity(): Promise<SessionActivity[]>;

  // ── Metadata ───────────────────────────────────────────────────────────
  /** The session's current pane path. (tmux: display-message '#{pane_current_path}') */
  getPanePath(name: string): Promise<string | null>;
  /** Read an environment variable set in the session. (tmux: show-environment) */
  getEnv(name: string, varName: string): Promise<string | null>;

  // ── Read ───────────────────────────────────────────────────────────────
  /** Rendered terminal text (visible grid, or last N scrollback lines). (tmux: capture-pane -p) */
  capture(name: string, opts?: CaptureOptions): Promise<string>;

  // ── Input ──────────────────────────────────────────────────────────────
  /** Press Enter. (tmux: send-keys Enter) */
  sendEnter(name: string): Promise<void>;
  /** Send text verbatim, no shell/tmux interpretation. (tmux: send-keys -l) */
  sendKeysLiteral(name: string, text: string): Promise<void>;
  /** Send text with tmux key interpretation, optionally submitting. (tmux: send-keys "…" Enter) */
  sendKeysInterpreted(
    name: string,
    text: string,
    opts?: SendOptions
  ): Promise<void>;
  /** Inject arbitrary (possibly multi-line) text robustly, optionally submitting. (tmux: load-buffer/paste-buffer) */
  pasteText(name: string, text: string, opts?: SendOptions): Promise<void>;
}
