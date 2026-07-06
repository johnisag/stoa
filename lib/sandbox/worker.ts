/**
 * Worker launch-tier decision (#27) — the opt-in policy for spawned orchestration
 * workers. PURE given its injected deps (the caller supplies the env flag and
 * detection result) so it is unit-testable.
 *
 * OPT-IN + FAIL-CLOSED: the OS sandbox is off unless `STOA_SANDBOX=1` AND a
 * sandbox primitive is present. Both pty (argv) and tmux (shell command string)
 * paths have wrap composition now, so "sandboxed-auto" is offered for either
 * backend when detection succeeds. Anything else stays "full-bypass" (today's
 * behavior — zero change when the flag is unset).
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
  /** detectSandboxTool() !== null on this host. */
  detected: boolean;
}): WorkerSandboxDecision {
  const active = deps.sandboxEnabled && deps.detected;
  return active
    ? { approvalMode: "sandboxed-auto", sandboxActive: true }
    : { approvalMode: "full-bypass", sandboxActive: false };
}

/**
 * FAIL-CLOSED coupling of the bypass flag to the ACTUAL wrap outcome (#27). The
 * bypass flag may be pushed only when the tentative gate said sandboxed-auto AND
 * the wrap did NOT downgrade — so if the OS wrap can't confine (a downgrade), the
 * flag is withheld and the worker prompts rather than running
 * unattended-and-unconfined. The caller MUST feed this result into buildAgentArgs'
 * sandboxActive so the flag and the confinement are decided by ONE verdict.
 */
export function effectiveSandboxActive(
  tentativeActive: boolean,
  wrapDowngraded: boolean
): boolean {
  return tentativeActive && !wrapDowngraded;
}
