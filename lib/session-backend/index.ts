/**
 * SessionBackend factory + backend-type selection.
 *
 * Selection rule (migration-plan.md Phase 2):
 *   - STOA_BACKEND env var, if set to "pty" | "tmux", wins (explicit override).
 *   - Otherwise: native pty backend on Windows; tmux backend on macOS/Linux.
 *
 * The tmux backend remains the default everywhere it works, so existing
 * macOS/Linux behavior is unchanged; Windows gets the native pty backend.
 */

import { isWindows } from "../platform";
import type { SessionBackend } from "./types";
import { TmuxBackend } from "./tmux-backend";
import { createPtyBackend } from "./pty-backend";
import { withAudit } from "../audit/ledger";
import { detectContainerRuntime } from "../container/detect";
import { isValidImageName } from "../container/docker-args";

// Re-export the container wrap factory so the terminal-WS handler (server.ts)
// selects the SAME transport shape as getSessionBackend (no split brain).
export { wrapWithContainer } from "./pty/container-transport";

export type { SessionBackend, SessionActivity } from "./types";

export type BackendType = "tmux" | "pty";

let cachedType: BackendType | null = null;
let backend: SessionBackend | null = null;

export function getBackendType(): BackendType {
  if (cachedType) return cachedType;
  const override = process.env.STOA_BACKEND?.toLowerCase();
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
 * pty backend (Windows) — opt out with STOA_PTY_HOST=0|false|off. server.ts
 * probes the daemon once and falls back to the in-process registry (Tier 1) if
 * it can't be reached, so this is safe to default on.
 */
export function usePtyHost(): boolean {
  if (getBackendType() !== "pty") return false;
  const flag = process.env.STOA_PTY_HOST?.toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return true;
}

/**
 * #47 container isolation transport — run each agent inside `docker run` via the
 * ContainerTransport decorator. OPT-IN + FAIL-OPEN: off unless STOA_CONTAINER is
 * truthy AND a valid STOA_CONTAINER_IMAGE is set AND docker is present; a missing
 * runtime degrades to the plain pty (the wrap factory returns the delegate). PR1
 * wraps the Tier-1 LocalTransport only (docker-on-daemon is a follow-up), so it
 * requires the pty backend (and Tier 1 — set STOA_PTY_HOST=0 on Windows).
 */
export function useContainer(): boolean {
  if (getBackendType() !== "pty" || usePtyHost()) return false;
  const flag = process.env.STOA_CONTAINER?.toLowerCase();
  if (!(flag === "1" || flag === "true" || flag === "on")) return false;
  return (
    isValidImageName(process.env.STOA_CONTAINER_IMAGE) &&
    detectContainerRuntime() !== null
  );
}

export function getSessionBackend(): SessionBackend {
  if (!backend) {
    const base =
      getBackendType() === "tmux"
        ? new TmuxBackend()
        : createPtyBackend(usePtyHost(), useContainer());
    // Wrap with the audit/event ledger (default on) so every lifecycle + input
    // op is recorded at this single seam, across tmux and both pty tiers.
    backend = withAudit(base);
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
  cachedType = null;
}
