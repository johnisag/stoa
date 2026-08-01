import type {
  FleetAutomationPolicy,
  FleetAutomationPolicyV1,
  FleetDesiredState,
  FleetReviewPolicy,
} from "./types";

export const FLEET_AUTOMATION_POLICY_VERSION = 1 as const;

export const DEFAULT_FLEET_AUTOMATION_POLICY: FleetAutomationPolicyV1 = {
  version: FLEET_AUTOMATION_POLICY_VERSION,
  automaticPlanning: false,
  automaticPlanApproval: false,
  automaticStart: false,
  automaticFixes: false,
  maxAutomaticFixRounds: 0,
  automaticMerge: false,
  mergeTarget: "github_pr",
  allowSensitivePaths: false,
  allowUnconfinedAgents: false,
  plannerTaskCap: 8,
  cleanupPolicy: "preserve",
  retentionDays: null,
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric)
    ? Math.max(min, Math.min(max, Math.trunc(numeric)))
    : fallback;
}

export function normalizeFleetAutomationPolicy(
  value: unknown,
  reviewPolicy: FleetReviewPolicy
): { policy: FleetAutomationPolicyV1 } | { error: string } {
  if (value != null && !objectValue(value)) {
    return { error: "automationPolicy must be an object" };
  }
  const input = objectValue(value) ?? {};
  if (
    input.version != null &&
    input.version !== FLEET_AUTOMATION_POLICY_VERSION
  ) {
    return { error: "unsupported fleet automation policy version" };
  }

  const policy: FleetAutomationPolicyV1 = {
    version: FLEET_AUTOMATION_POLICY_VERSION,
    automaticPlanning: input.automaticPlanning === true,
    automaticPlanApproval: input.automaticPlanApproval === true,
    automaticStart: input.automaticStart === true,
    automaticFixes: input.automaticFixes === true,
    maxAutomaticFixRounds: boundedInteger(
      input.maxAutomaticFixRounds,
      DEFAULT_FLEET_AUTOMATION_POLICY.maxAutomaticFixRounds,
      0,
      20
    ),
    automaticMerge: input.automaticMerge === true,
    mergeTarget: input.mergeTarget === "local" ? "local" : "github_pr",
    allowSensitivePaths: input.allowSensitivePaths === true,
    allowUnconfinedAgents: input.allowUnconfinedAgents === true,
    plannerTaskCap: boundedInteger(
      input.plannerTaskCap,
      DEFAULT_FLEET_AUTOMATION_POLICY.plannerTaskCap,
      1,
      40
    ),
    cleanupPolicy: "preserve",
    retentionDays:
      input.retentionDays == null
        ? null
        : boundedInteger(input.retentionDays, 30, 1, 3650),
  };

  if (policy.automaticPlanApproval && !policy.automaticPlanning) {
    return { error: "automatic plan approval requires automatic planning" };
  }
  if (policy.automaticPlanApproval && reviewPolicy === "manual") {
    return {
      error: "automatic plan approval requires a four-agent review policy",
    };
  }
  if (policy.automaticStart && !policy.automaticPlanApproval) {
    return { error: "automatic start requires automatic plan approval" };
  }
  if (policy.automaticFixes && !policy.automaticStart) {
    return { error: "automatic fixes require automatic start" };
  }
  if (
    policy.automaticMerge &&
    (!policy.automaticStart ||
      !policy.automaticFixes ||
      policy.maxAutomaticFixRounds < 1)
  ) {
    return {
      error:
        "automatic merge requires automatic start and at least one automatic fix round",
    };
  }

  return { policy };
}

function policiesEqual(
  left: FleetAutomationPolicy,
  right: FleetAutomationPolicy
): boolean {
  return (
    left.version === right.version &&
    left.automaticPlanning === right.automaticPlanning &&
    left.automaticPlanApproval === right.automaticPlanApproval &&
    left.automaticStart === right.automaticStart &&
    left.automaticFixes === right.automaticFixes &&
    left.maxAutomaticFixRounds === right.maxAutomaticFixRounds &&
    left.automaticMerge === right.automaticMerge &&
    left.mergeTarget === right.mergeTarget &&
    left.allowSensitivePaths === right.allowSensitivePaths &&
    left.allowUnconfinedAgents === right.allowUnconfinedAgents &&
    left.plannerTaskCap === right.plannerTaskCap &&
    left.cleanupPolicy === right.cleanupPolicy &&
    left.retentionDays === right.retentionDays
  );
}

export function parseFleetAutomationPolicy(value: string | null | undefined): {
  policy: FleetAutomationPolicy;
  valid: boolean;
} {
  if (!value) {
    return { policy: { ...DEFAULT_FLEET_AUTOMATION_POLICY }, valid: false };
  }
  try {
    const parsed = JSON.parse(value);
    const normalized = normalizeFleetAutomationPolicy(parsed, "four_agent");
    if ("error" in normalized) {
      return { policy: { ...DEFAULT_FLEET_AUTOMATION_POLICY }, valid: false };
    }
    const record = objectValue(parsed);
    const candidate = record as unknown as FleetAutomationPolicy;
    if (!record || !policiesEqual(candidate, normalized.policy)) {
      return { policy: { ...DEFAULT_FLEET_AUTOMATION_POLICY }, valid: false };
    }
    return { policy: normalized.policy, valid: true };
  } catch {
    return { policy: { ...DEFAULT_FLEET_AUTOMATION_POLICY }, valid: false };
  }
}

export function fleetDesiredStateForPolicy(
  policy: FleetAutomationPolicy
): FleetDesiredState {
  if (policy.automaticStart) return "running";
  if (policy.automaticPlanning) return "planned";
  return "draft";
}

export function fleetAutomationPolicyJson(
  policy: FleetAutomationPolicy
): string {
  return JSON.stringify(policy);
}
