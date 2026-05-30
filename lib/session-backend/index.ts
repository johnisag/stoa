/**
 * SessionBackend factory.
 *
 * Returns the process-wide SessionBackend. Today this is always the tmux
 * backend. When the native pty backend lands (migration-plan.md Phase 2), this
 * is where platform/config selection happens — e.g. pty on Windows, or when
 * AGENT_OS_BACKEND=pty is set.
 */

import type { SessionBackend } from "./types";
import { TmuxBackend } from "./tmux-backend";

export type { SessionBackend, SessionActivity } from "./types";

let backend: SessionBackend | null = null;

export function getSessionBackend(): SessionBackend {
  if (!backend) {
    // Future: select PtyBackend when isWindows or AGENT_OS_BACKEND === "pty".
    backend = new TmuxBackend();
  }
  return backend;
}
