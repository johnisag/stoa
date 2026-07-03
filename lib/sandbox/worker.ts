/**
 * Worker launch-tier decision (#27) — the opt-in policy for spawned orchestration
 * workers. PURE given its injected deps (the caller supplies the env flag,
 * backend type, and detection result) so it is unit-testable.
 *
 * OPT-IN + FAIL-CLOSED: the OS sandbox is off unless `STOA_SANDBOX=1`. In PR1 the
 * bwrap wrap engages ONLY on the pty backend (the tmux command-string composition
 * is a follow-up), so "sandboxed-auto" is offered ONLY when the pty backend is
 * active AND a primitive is present — this is what prevents the fail-open where a
 * bypass flag would be pushed on the (unwrapped) tmux path. Anything else stays
 * "full-bypass" (today's behavior — zero change when the flag is unset).
 */

import type { ApprovalMode } from "./types";

export interface WorkerSandboxDecision {
  approvalMode: ApprovalMode;
  /** Whether a real OS sandbox WILL confine this launch (gates the bypass flag). */
  sandboxActive: boolean;
}

export function decideWorkerSandbox(deps: {
  /** STOA_SANDBOX opt-in. */
  sandboxEnabled: boolean;
  backendType: "pty" | "tmux";
  /** detectSandboxTool() !== null on this host. */
  detected: boolean;
}): WorkerSandboxDecision {
  const active =
    deps.sandboxEnabled && deps.backendType === "pty" && deps.detected;
  return active
    ? { approvalMode: "sandboxed-auto", sandboxActive: true }
    : { approvalMode: "full-bypass", sandboxActive: false };
}
