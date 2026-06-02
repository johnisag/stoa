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
  sendInput: (data: string) => void;
  sendCommand: (command: string) => void;
  attachSession: (payload: AttachPayload) => void;
  focus: () => void;
  getScrollState: () => TerminalScrollState | null;
  restoreScrollState: (state: TerminalScrollState) => void;
  triggerResize: () => void;
  reconnect: () => void;
  /** True after the agent process exits; surfaces a Relaunch affordance. */
  sessionEnded: boolean;
  /** Explicitly respawn an exited session (the only path that respawns it). */
  relaunch: () => void;
}
