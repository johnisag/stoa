/**
 * SessionBackend factory + backend-type selection.
 *
 * Selection rule (migration-plan.md Phase 2):
 *   - AGENT_OS_BACKEND env var, if set to "pty" | "tmux", wins (explicit override).
 *   - Otherwise: native pty backend on Windows; tmux backend on macOS/Linux.
 *
 * The tmux backend remains the default everywhere it works, so existing
 * macOS/Linux behavior is unchanged; Windows gets the native pty backend.
 */

import { isWindows } from "../platform";
import type { SessionBackend } from "./types";
import { TmuxBackend } from "./tmux-backend";
import { PtyBackend } from "./pty-backend";
import { HostBackend } from "./pty/host-backend";

export type { SessionBackend, SessionActivity } from "./types";

export type BackendType = "tmux" | "pty";

let cachedType: BackendType | null = null;
let backend: SessionBackend | null = null;

export function getBackendType(): BackendType {
  if (cachedType) return cachedType;
  const override = process.env.AGENT_OS_BACKEND?.toLowerCase();
  if (override === "pty" || override === "tmux") {
    cachedType = override;
  } else {
    cachedType = isWindows ? "pty" : "tmux";
  }
  return cachedType;
}

/**
 * Tier 2 (opt-in): when AGENT_OS_PTY_HOST is truthy and the pty backend is
 * active, route through the out-of-process pty-host daemon so sessions survive
 * web-server restarts. Default off — the in-process registry (Tier 1) is used.
 */
export function usePtyHost(): boolean {
  const flag = process.env.AGENT_OS_PTY_HOST;
  return (
    getBackendType() === "pty" &&
    flag != null &&
    flag !== "" &&
    flag !== "0" &&
    flag.toLowerCase() !== "false"
  );
}

export function getSessionBackend(): SessionBackend {
  if (!backend) {
    if (getBackendType() === "tmux") {
      backend = new TmuxBackend();
    } else {
      backend = usePtyHost() ? new HostBackend() : new PtyBackend();
    }
  }
  return backend;
}
