import type { FleetApprovalState, FleetTaskStatus } from "./types";
import type { FleetCostConfidence } from "./budgets";

export interface FleetApprovalCostEstimateDto {
  kind: "estimated_remaining";
  estimatedUsd: number | null;
  estimatedTokens: number | null;
  confidence: FleetCostConfidence;
  capped: boolean;
  sessionCounts: {
    workerAttempts: number;
    taskReviews: number;
    planReviews: number;
    planner: number;
    total: number;
  };
  projectedTotalUsd: number | null;
  projectedTotalTokens: number | null;
  budgetComparison: {
    usd: "within" | "exceeds" | "unlimited" | "unknown";
    tokens: "within" | "exceeds" | "unlimited" | "unknown";
  };
  exclusions: string[];
}

export interface FleetApprovalControlPreviewDto {
  runId: string;
  estimate: FleetApprovalCostEstimateDto;
  bindings: {
    approvedPlanHash: string | null;
    currentPlanHash: string;
    approvedExecutionHash: string | null;
    currentExecutionHash: string;
    storedPolicyHash: string | null;
    currentPolicyHash: string | null;
    baseSha: string | null;
    runUpdatedAt: string;
  };
  approvedVsCurrent: {
    planChanged: boolean;
    executionChanged: boolean;
    policyChanged: boolean;
  };
  run: {
    status: string;
    maxConcurrency: number;
    budgetUsd: number | null;
    budgetTokens: number | null;
    reservedBudgetUsd: number;
    spentBudgetUsd: number;
    reservedBudgetTokens: number;
    spentBudgetTokens: number;
    budgetStopMode: string;
    budgetHardLimitAt: string | null;
    budgetInterruptDeadlineAt: string | null;
    pauseReason: string | null;
  };
  tasks: Array<{
    id: string;
    status: FleetTaskStatus;
    approvalState: FleetApprovalState;
    attempt: number;
    baseSha: string | null;
    headSha: string | null;
    updatedAt: string;
    notYetStarted: boolean;
    hasActiveWorker: boolean;
    manualLaunchApprovalRequired: boolean;
    approvedTaskHash: string | null;
    plannedClaims: string[];
    actualClaims: string[];
    actualClaimsHash: string;
    addedActualClaims: string[];
    sensitivePaths: Array<{ path: string; reason: string }>;
    quarantinedForClaimApproval: boolean;
    skipClosure: {
      taskIds: string[];
      hash: string;
      eligible: boolean;
      blockers: string[];
    };
  }>;
  recentApprovals: Array<{
    eventType: string;
    actor: string;
    createdAt: string;
    detail: unknown;
  }>;
}

export interface FleetApprovalControlBinding {
  requestId: string;
  expectedPlanHash: string;
  expectedExecutionHash: string;
  expectedPolicyHash: string;
  expectedBaseSha: string | null;
  expectedRunUpdatedAt: string;
}

export interface FleetTaskApprovalControlBinding extends FleetApprovalControlBinding {
  expectedTaskStatus: FleetTaskStatus;
  expectedTaskApprovalState: FleetApprovalState;
  expectedAttempt: number;
  expectedTaskBaseSha: string | null;
  expectedHeadSha: string | null;
  expectedTaskUpdatedAt: string;
}

export type FleetApprovalControlMutation =
  | {
      kind: "concurrency";
      body: FleetApprovalControlBinding & { maxConcurrency: number };
    }
  | {
      kind: "budget";
      body: FleetApprovalControlBinding & {
        budgetUsd?: number | null;
        budgetTokens?: number | null;
        overrideHardStop: boolean;
        expectedPauseReason: string | null;
      };
    }
  | {
      kind: "task_skip";
      taskId: string;
      body: FleetTaskApprovalControlBinding & {
        expectedSkipClosureHash: string;
      };
    }
  | {
      kind: "task_manual_launch";
      taskId: string;
      body: FleetTaskApprovalControlBinding & { required: boolean };
    }
  | {
      kind: "task_read_only";
      taskId: string;
      body: FleetTaskApprovalControlBinding;
    }
  | {
      kind: "task_claims";
      taskId: string;
      body: FleetTaskApprovalControlBinding & {
        expectedActualClaimsHash: string;
        approvedActualClaims: string[];
        approveSensitivePaths: boolean;
      };
    };

export interface FleetApprovalControlResponseDto {
  ok: true;
  action: string;
  idempotent: boolean;
  planHash: string;
  executionHash: string;
  preview: FleetApprovalControlPreviewDto;
}
