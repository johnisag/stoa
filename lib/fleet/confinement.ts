import { detectSandboxTool } from "@/lib/sandbox/detect";
import type { ApprovalMode } from "@/lib/sandbox/types";
import type { FleetAutomationPolicy } from "./types";

/** Evidence required before Fleet may equate prompt bypass with confinement. */
export interface FleetConfinementEvidence {
  osSandbox: boolean;
  networkAuthorityProtected: boolean;
  isolatedGitMetadata: boolean;
  isolatedProviderState: boolean;
}

export function evaluateFleetConfinementEvidence(
  evidence: FleetConfinementEvidence
): boolean {
  return (
    evidence.osSandbox &&
    evidence.networkAuthorityProtected &&
    evidence.isolatedGitMetadata &&
    evidence.isolatedProviderState
  );
}

/**
 * Current host evidence. Bubblewrap alone is intentionally insufficient:
 * linked worktrees share writable Git metadata and provider homes contain
 * persistent executable configuration. Both require per-attempt isolation
 * before Stoa may advertise a strong unattended boundary.
 */
export function fleetConfinementEvidence(): FleetConfinementEvidence {
  const authMode = (process.env.STOA_AUTH ?? "").trim().toLowerCase();
  return {
    osSandbox: process.env.STOA_SANDBOX === "1" && detectSandboxTool() !== null,
    networkAuthorityProtected:
      process.env.STOA_REQUIRE_AUTH === "1" && authMode !== "off",
    isolatedGitMetadata: false,
    isolatedProviderState: false,
  };
}

export function fleetStrongConfinementAvailable(): boolean {
  return evaluateFleetConfinementEvidence(fleetConfinementEvidence());
}

export function fleetAgentApprovalMode(
  policy: Pick<FleetAutomationPolicy, "allowUnconfinedAgents">
): ApprovalMode {
  if (fleetStrongConfinementAvailable()) return "sandboxed-auto";
  return policy.allowUnconfinedAgents ? "full-bypass" : "prompt";
}

/** Fleet-owned sessions are internal and cannot service interactive prompts. */
export function fleetUnattendedAgentLaunchAllowed(
  policy: Pick<FleetAutomationPolicy, "allowUnconfinedAgents">
): boolean {
  return fleetAgentApprovalMode(policy) !== "prompt";
}
