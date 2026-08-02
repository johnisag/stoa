import type {
  FleetApprovalState,
  FleetDesiredState,
  FleetIntegrationState,
  FleetRunStatus,
  FleetTaskStatus,
  FleetVerificationStatus,
  FleetWorkerReportState,
  FleetWorkerStatus,
} from "./types";

/**
 * Framework-neutral Fleet supervisor contract.
 *
 * The supervisor is advisory: these values describe durable Fleet truth and
 * safe recommendations. They do not carry executable commands, credentials,
 * capabilities, or authorization grants.
 */
export const FLEET_SUPERVISOR_SNAPSHOT_VERSION = 1 as const;
export const FLEET_SUPERVISOR_RULES_VERSION = 1 as const;

export type FleetSupervisorRecommendationKind =
  | "approval"
  | "retry"
  | "inspect"
  | "pause"
  | "merge_readiness"
  | "replan"
  | "grouping"
  | "merge_order";

export type FleetSupervisorAttentionSeverity = "critical" | "warning" | "info";

export type FleetSupervisorFailureCategory =
  | "provider"
  | "verification"
  | "review"
  | "integration"
  | "evidence"
  | "dependency"
  | "recovery"
  | "other";

export interface FleetSupervisorBindings {
  planHash: string | null;
  approvedPlanHash: string | null;
  policyHash: string | null;
  executionHash: string | null;
  approvedExecutionHash: string | null;
  baseSha: string | null;
  exactPlanApproval: boolean;
  exactExecutionApproval: boolean;
  contractComplete: boolean;
}

export interface FleetSupervisorRunSummary {
  id: string;
  status: FleetRunStatus | "unknown";
  desiredState: FleetDesiredState | "unknown";
  approvalState: FleetApprovalState | "unknown";
  integrationState: FleetIntegrationState | "unknown";
  maxConcurrency: number;
  schedulerEpoch: number;
  recoveryRequired: boolean;
  mergeRequested: boolean;
  archived: boolean;
}

export interface FleetSupervisorTaskSummary {
  id: string;
  parentTaskId: string | null;
  status: FleetTaskStatus | "unknown";
  sortOrder: number;
  priority: number;
  currentAttempt: number;
  maxAttempts: number;
  providerState:
    "ready" | "spawning" | "running" | "backoff" | "failed" | "unknown";
  retryNotBefore: string | null;
  failureCategory: FleetSupervisorFailureCategory | null;
  baseSha: string | null;
  headSha: string | null;
  verificationStatus: FleetVerificationStatus | "unknown" | null;
  exactVerificationPass: boolean;
  reviewStatus: "pending" | "clean" | "changes_requested" | "unknown" | null;
  exactReviewClean: boolean;
  fixRounds: number;
  integrationState: "pending" | "integrating" | "merged" | "failed" | "unknown";
}

export interface FleetSupervisorWorkerSummary {
  id: string;
  taskId: string | null;
  status: FleetWorkerStatus | "unknown";
  attempt: number;
  hasSession: boolean;
  reportState: FleetWorkerReportState | "unknown";
  reportStatus: "succeeded" | "blocked" | "failed" | "unknown" | null;
  failureCategory: FleetSupervisorFailureCategory | null;
  headSha: string | null;
}

export interface FleetSupervisorGateSummary {
  planReview: {
    required: number;
    exactCleanLenses: number;
    independentReviewers: number;
    complete: boolean;
  };
  tasks: {
    total: number;
    exactVerificationPass: number;
    verificationFailed: number;
    exactReviewClean: number;
    reviewChangesRequested: number;
    awaitingOperator: number;
    failed: number;
  };
  workers: {
    total: number;
    active: number;
    waitingForOperator: number;
    failed: number;
  };
}

export interface FleetSupervisorMergeSummary {
  assessmentComplete: boolean;
  requested: boolean;
  target: "github_pr" | "local" | null;
  integrationState: string;
  readyTaskIds: string[];
  waitingTaskIds: string[];
  mergedTaskIds: string[];
  blockerCodes: string[];
  blockerCount: number;
  allTasksIntegrated: boolean;
  canFinalize: boolean;
}

export interface FleetSupervisorAttentionItem {
  rank: number;
  severity: FleetSupervisorAttentionSeverity;
  code: string;
  taskId: string | null;
  workerId: string | null;
}

export interface FleetSupervisorRecommendation {
  id: string;
  priority: number;
  kind: FleetSupervisorRecommendationKind;
  reasonCode: string;
  taskId: string | null;
}

export interface FleetSupervisorTruncation {
  tasks: boolean;
  workers: boolean;
  attention: boolean;
  recommendations: boolean;
  executionContract: boolean;
}

export interface FleetSupervisorSnapshotState {
  version: typeof FLEET_SUPERVISOR_SNAPSHOT_VERSION;
  rulesVersion: typeof FLEET_SUPERVISOR_RULES_VERSION;
  advisoryOnly: true;
  run: FleetSupervisorRunSummary;
  bindings: FleetSupervisorBindings;
  gates: FleetSupervisorGateSummary;
  merge: FleetSupervisorMergeSummary;
  tasks: FleetSupervisorTaskSummary[];
  workers: FleetSupervisorWorkerSummary[];
  attention: FleetSupervisorAttentionItem[];
  truncation: FleetSupervisorTruncation;
}

export interface FleetSupervisorSnapshot extends FleetSupervisorSnapshotState {
  recommendations: FleetSupervisorRecommendation[];
  snapshotHash: string;
}

export type FleetExternalSupervisorSource = "external_ai" | "conductor";

export interface FleetExternalSupervisorAction {
  kind: FleetSupervisorRecommendationKind;
  taskId: string | null;
  /** Ordered, bounded task scope for grouping/re-plan/merge-order advice. */
  taskIds?: string[];
  rationale: string;
}

export interface AppendFleetSupervisorRecommendationInput {
  expectedSnapshotHash: string;
  expectedPlanHash: string | null;
  expectedPolicyHash: string | null;
  expectedExecutionHash: string;
  expectedBaseSha: string | null;
  source: FleetExternalSupervisorSource;
  summary: string;
  actions: FleetExternalSupervisorAction[];
}
