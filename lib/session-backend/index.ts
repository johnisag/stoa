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

export function getSessionBackend(): SessionBackend {
  if (!backend) {
    backend = getBackendType() === "pty" ? new PtyBackend() : new TmuxBackend();
  }
  return backend;
}
