"use client";

import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";

export interface TerminalScrollState {
  scrollTop: number;
  cursorY: number;
  baseY: number;
}

/** Structured attach request for the native pty backend. */
export interface AttachPayload {
  /** Session key, built by sessionKey() (e.g. "claude-<uuid>"). */
  key: string;
  /**
   * How to spawn the session if it doesn't exist yet. Omit binary (or pass "")
   * for a plain shell. cwd may contain a leading "~".
   */
  spawn?: { binary: string; args: string[]; cwd: string };
}

export interface UseTerminalConnectionProps {
  terminalRef: RefObject<HTMLDivElement | null>;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onBeforeUnmount?: (scrollState: TerminalScrollState) => void;
  initialScrollState?: TerminalScrollState;
  isMobile?: boolean;
  theme?: string;
  selectMode?: boolean;
}

export interface UseTerminalConnectionReturn {
  connected: boolean;
  connectionState: "connecting" | "connected" | "disconnected" | "reconnecting";
  /** True briefly while switching to another session (between reset + first paint). */
  isAttaching: boolean;
  isAtBottom: boolean;
  xtermRef: RefObject<XTerm | null>;
  searchAddonRef: RefObject<SearchAddon | null>;
  scrollToBottom: () => void;
  copySelection: () => boolean;
  hasSelection: () => boolean;
  sendInput: (data: string) => void;
  sendCommand: (command: string) => void;
  attachSession: (payload: AttachPayload) => void;
  focus: () => void;
  paste: (text: string) => void;
  getScrollState: () => TerminalScrollState | null;
  restoreScrollState: (state: TerminalScrollState) => void;
  triggerResize: () => void;
  reconnect: () => void;
  /** True after the agent process exits, or an attach/spawn fails (server
   *  "error" frame — see `attachError`); surfaces a Relaunch affordance. */
  sessionEnded: boolean;
  /**
   * The reason an attach/spawn FAILED (server "error" frame), or null. Set
   * alongside `sessionEnded`, so it shares the Relaunch bar — shown in place of
   * "Session ended" because the session never actually started.
   */
  attachError: string | null;
  /** Explicitly respawn an exited session (the only path that respawns it). */
  relaunch: () => void;
  /**
   * Pending auto-retry after the agent exited on a TRANSIENT failure (rate-limit
   * or network hiccup): the attempt number and the epoch-ms the relaunch fires —
   * or null when nothing is scheduled (non-transient exit, cancelled, or the cap
   * was reached). Drives the "retrying in Ns · cancel" affordance.
   */
  autoRetry: AutoRetryState | null;
  /** Cancel a pending auto-retry (the user override). No-op when none is armed. */
  cancelAutoRetry: () => void;
}

/** A scheduled auto-retry of an exited session (see autoRetry above). */
export interface AutoRetryState {
  /** 1-based attempt number this scheduled relaunch will be. */
  attempt: number;
  /** Epoch-ms the relaunch fires (drives the countdown). */
  retryAtMs: number;
}
