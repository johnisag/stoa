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
import { createPtyBackend } from "./pty-backend";

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
 * Tier 2: when the pty backend is active, route through the out-of-process
 * pty-host daemon so sessions survive web-server restarts. DEFAULT ON for the
 * pty backend (Windows) — opt out with AGENT_OS_PTY_HOST=0|false|off. server.ts
 * probes the daemon once and falls back to the in-process registry (Tier 1) if
 * it can't be reached, so this is safe to default on.
 */
export function usePtyHost(): boolean {
  if (getBackendType() !== "pty") return false;
  const flag = process.env.AGENT_OS_PTY_HOST?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return true;
}

export function getSessionBackend(): SessionBackend {
  if (!backend) {
    backend =
      getBackendType() === "tmux"
        ? new TmuxBackend()
        : createPtyBackend(usePtyHost());
  }
  return backend;
}

/**
 * Drop the cached backend instance so the next getSessionBackend() re-resolves.
 * Used by server.ts when the pty-host daemon probe fails and it flips to Tier 1,
 * so even a backend cached before the flip is re-evaluated (no split brain).
 */
export function resetSessionBackend(): void {
  backend = null;
}
