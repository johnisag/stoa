import type { FleetBudgetStopMode, FleetCostConfidence } from "./budgets";
import type { FleetResourceLimits } from "./resource-admission";
import type { FleetPlanRiskNote } from "./plan";

export type FleetRunStatus =
  | "draft"
  | "planned"
  | "running"
  | "paused"
  | "reviewing"
  | "merging"
  | "completed"
  | "failed"
  | "canceled";

export type FleetReviewPolicy =
  "four_agent" | "four_agent_plus_red_team" | "manual";

export type FleetDesiredState =
  "draft" | "planned" | "running" | "paused" | "canceled";

export type FleetAutomationAction =
  "planning" | "plan_approval" | "start" | "fix" | "merge";

export type FleetAutomationMergeTarget = "github_pr" | "local";
export type FleetAutomationCleanupPolicy = "preserve";

/**
 * Durable, operator-granted automation policy. New versions must be introduced
 * as a union member rather than changing v1 semantics in place.
 */
export interface FleetAutomationPolicyV1 {
  version: 1;
  automaticPlanning: boolean;
  automaticPlanApproval: boolean;
  automaticStart: boolean;
  automaticFixes: boolean;
  maxAutomaticFixRounds: number;
  automaticMerge: boolean;
  mergeTarget: FleetAutomationMergeTarget;
  allowSensitivePaths: boolean;
  allowUnconfinedAgents: boolean;
  plannerTaskCap: number;
  cleanupPolicy: FleetAutomationCleanupPolicy;
  retentionDays: number | null;
}

export type FleetAutomationPolicy = FleetAutomationPolicyV1;

export type FleetPlanReviewLens =
  | "correctness_security"
  | "conventions_cross_platform"
  | "simplicity_ux"
  | "adversarial_red_team";

export interface FleetReviewEvidenceRow {
  id: string;
  fleet_run_id: string;
  subject_type: "plan";
  subject_hash: string;
  policy_hash: string;
  execution_hash: string;
  base_sha: string;
  lens: FleetPlanReviewLens;
  reviewer_session_id: string;
  verdict: "clean" | "changes_requested";
  state?:
    | "pending"
    | "spawning"
    | "running"
    | "cleanup_pending"
    | "clean"
    | "changes_requested";
  created_at: string;
}

export type FleetApprovalState =
  "draft" | "needs_approval" | "approved" | "blocked";

export type FleetTaskStatus =
  | "draft"
  | "planned"
  | "ready"
  | "blocked"
  | "leasing"
  | "spawning"
  | "running"
  | "waiting_for_operator"
  | "needs_followup"
  | "needs_inspection"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "ready_to_merge"
  | "merging"
  | "merged"
  | "failed"
  | "canceled"
  | "skipped"
  | "completed";

export type FleetPauseMode = "pause-new" | "pause-and-interrupt";
export type FleetCancelMode =
  "cancel-preserve-worktrees" | "cancel-and-clean-owned-worktrees";
export type FleetDestructiveOwnerType =
  "planner" | "plan_review" | "worker" | "task_review" | "fixer" | "supervisor";
export type FleetDestructiveTargetOwnerType =
  FleetDestructiveOwnerType | "integration_workspace";
export type FleetClaimType = "unknown" | "exclusive";

export type FleetArtifactSeverity = "info" | "warning" | "blocker";
export type FleetPlannerState =
  | "idle"
  | "starting"
  | "running"
  | "finalizing"
  | "cleanup_pending"
  | "ready"
  | "failed";

export type FleetWorkerStatus =
  | "leasing"
  | "spawning"
  | "running"
  | "waiting_for_operator"
  | "completed"
  | "failed"
  | "canceled"
  | "dead"
  | "cleanup_pending"
  | "cleanup_complete";

export type FleetRenderedStatus =
  "running" | "waiting" | "idle" | "error" | "dead";
export type FleetInterruptNoticeState =
  "unattempted" | "requested" | "delivered" | "failed";
export type FleetInterruptStopState = "unattempted" | "requested" | "confirmed";
export type FleetInterruptCause = "operator_pause" | "budget_hard_limit";

export type FleetWorkerReportState =
  "legacy" | "pending" | "accepted" | "invalid";

export type FleetVerificationStatus =
  "pending" | "running" | "pass" | "fail" | "error";

export type FleetMergeTarget = "github_pr" | "local";
export type FleetIntegrationState =
  | "idle"
  | "initializing"
  | "integrating"
  | "final_verifying"
  | "ready_to_finalize"
  | "pushing"
  | "waiting_ci"
  | "merging"
  | "awaiting_operator"
  | "failed"
  | "completed"
  | "cleanup_pending"
  | "cleanup_complete";
export type FleetMergeOperationState =
  "pending" | "running" | "waiting" | "completed" | "failed";
export type FleetMergeOperationType =
  | "task_merge"
  | "final_verify"
  | "local_finalize"
  | "github_push"
  | "github_pr"
  | "github_merge";

export type FleetTaskReviewState =
  | "pending"
  | "spawning"
  | "running"
  | "cleanup_pending"
  | "clean"
  | "changes_requested";

export type FleetTaskFixState =
  | "pending"
  | "spawning"
  | "running"
  | "cleanup_pending"
  | "completed"
  | "failed";

export interface FleetRunRow {
  id: string;
  name: string;
  goal: string;
  repo_id: string | null;
  project_id: string | null;
  source_kind?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  status: FleetRunStatus;
  budget_usd: number | null;
  budget_tokens?: number | null;
  provider: string;
  model: string | null;
  max_concurrency: number;
  review_policy: FleetReviewPolicy;
  approval_state: FleetApprovalState;
  plan_hash: string | null;
  approved_plan_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  desired_state?: FleetDesiredState;
  automation_policy_version?: number;
  automation_policy_json?: string;
  automation_policy_hash?: string | null;
  automation_granted_by?: string | null;
  automation_granted_at?: string | null;
  automation_base_sha?: string | null;
  automation_last_error?: string | null;
  merge_requested_at?: string | null;
  merge_requested_by?: string | null;
  merge_request_kind?: "manual" | "automatic" | null;
  merge_target?: FleetMergeTarget | null;
  integration_state?: FleetIntegrationState;
  integration_branch?: string | null;
  integration_worktree?: string | null;
  integration_base_sha?: string | null;
  integration_head_sha?: string | null;
  integration_pr_number?: number | null;
  integration_pr_url?: string | null;
  integration_pr_head_sha?: string | null;
  integration_merge_sha?: string | null;
  integration_error?: string | null;
  integration_updated_at?: string | null;
  archived_at?: string | null;
  archived_by?: string | null;
  retention_days?: number | null;
  conductor_session_id?: string | null;
  scheduler_epoch?: number;
  recovery_required?: number;
  reserved_budget_usd?: number;
  spent_budget_usd?: number;
  reserved_budget_tokens?: number;
  spent_budget_tokens?: number;
  cost_confidence?: FleetCostConfidence;
  budget_stop_mode?: FleetBudgetStopMode;
  budget_warning_threshold?: number;
  budget_warning_emitted_at?: string | null;
  budget_hard_limit_at?: string | null;
  budget_interrupt_deadline_at?: string | null;
  provider_caps_json?: string;
  resource_limits_json?: string;
  default_max_attempts?: number;
  pause_mode?: FleetPauseMode | null;
  pause_reason?: string | null;
  cancel_mode?: FleetCancelMode | null;
  started_at?: string | null;
  ended_at?: string | null;
  settings_json: string;
  created_at: string;
  updated_at: string;
}

export interface FleetTaskRow {
  id: string;
  fleet_run_id: string;
  parent_task_id: string | null;
  title: string;
  description: string | null;
  status: FleetTaskStatus;
  task_type: string;
  sort_order: number;
  file_claims_json: string;
  source_ref?: string | null;
  source_step_id?: string | null;
  source_issue_id?: string | null;
  source_issue_number?: number | null;
  priority?: number;
  agent_type?: string | null;
  model?: string | null;
  working_directory?: string | null;
  base_branch?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  actual_file_claims_json?: string;
  report_artifact_id?: string | null;
  diff_artifact_id?: string | null;
  verification_id?: string | null;
  verification_status?: FleetVerificationStatus | null;
  verification_spec_hash?: string | null;
  verified_head_sha?: string | null;
  verification_artifact_id?: string | null;
  verification_started_at?: string | null;
  verification_completed_at?: string | null;
  review_status?: "pending" | "clean" | "changes_requested" | null;
  review_head_sha?: string | null;
  review_verification_hash?: string | null;
  review_completed_at?: string | null;
  fix_rounds?: number;
  active_fix_id?: string | null;
  fixer_session_id?: string | null;
  fix_error?: string | null;
  integration_state?: "pending" | "integrating" | "merged" | "failed";
  integration_operation_id?: string | null;
  integrated_head_sha?: string | null;
  integrated_at?: string | null;
  retry_not_before?: string | null;
  provider_failure_count?: number;
  provider_state?: "ready" | "spawning" | "running" | "backoff" | "failed";
  provider_last_error?: string | null;
  provider_backoff_event_at?: string | null;
  max_attempts?: number;
  current_attempt?: number;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  scheduler_epoch?: number;
  spawn_request_id?: string | null;
  acceptance_criteria?: string | null;
  risk_notes_json?: string;
  verify_command?: string | null;
  approved_task_hash?: string | null;
  approval_state?: FleetApprovalState;
  failure_code?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FleetWorkerRow {
  id: string;
  fleet_run_id: string;
  task_id: string | null;
  session_id: string | null;
  status: FleetWorkerStatus;
  provider: string | null;
  model: string | null;
  attempt: number;
  spawn_request_id?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  report_path?: string | null;
  report_nonce_hash?: string | null;
  report_state?: FleetWorkerReportState;
  report_status?: "succeeded" | "blocked" | "failed" | null;
  report_submitted_at?: string | null;
  report_collected_at?: string | null;
  report_bytes?: number;
  actual_claims_json?: string;
  diff_summary_json?: string | null;
  report_poll_count?: number;
  report_last_polled_at?: string | null;
  report_next_poll_at?: string | null;
  report_error?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  reservation_usd?: number;
  reservation_tokens?: number;
  reservation_confidence?: FleetCostConfidence;
  reservation_basis?: string | null;
  actual_cost_usd?: number | null;
  actual_tokens?: number | null;
  cost_confidence?: FleetCostConfidence;
  cost_reconciled_at?: string | null;
  interrupt_requested_at?: string | null;
  interrupt_deadline_at?: string | null;
  interrupt_notice_state?: FleetInterruptNoticeState;
  interrupt_stop_state?: FleetInterruptStopState;
  interrupt_cause?: FleetInterruptCause | null;
  rendered_status?: FleetRenderedStatus | null;
  rendered_status_summary?: string | null;
  rendered_status_summary_redacted?: number;
  rendered_status_replacement_count?: number;
  rendered_status_stability_count?: number;
  rendered_status_last_captured_at?: string | null;
  rendered_status_next_capture_at?: string | null;
  rendered_status_error?: string | null;
  terminal_cause?: string | null;
  failure_code?: string | null;
  created_at: string;
  last_heartbeat_at: string | null;
  ended_at: string | null;
}

export interface FleetEventRow {
  id: number;
  fleet_run_id: string;
  event_type: string;
  actor: string;
  payload: string | null;
  created_at: string;
}

export interface FleetVerificationRow {
  id: string;
  fleet_run_id: string;
  task_id: string;
  worker_id: string | null;
  attempt: number;
  base_sha: string;
  head_sha: string;
  spec_hash: string;
  command: string;
  status: FleetVerificationStatus;
  run_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  output_artifact_id: string | null;
  output_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FleetTaskReviewRow {
  id: string;
  fleet_run_id: string;
  task_id: string;
  worker_id: string | null;
  attempt: number;
  base_sha: string;
  head_sha: string;
  verification_id: string;
  verification_spec_hash: string;
  verification_evidence_hash: string;
  policy_hash: string;
  lens: FleetPlanReviewLens;
  provider: string | null;
  model: string | null;
  launch_failure_count: number;
  retry_not_before: string | null;
  reviewer_session_id: string;
  verdict: "clean" | "changes_requested";
  state: FleetTaskReviewState;
  request_id: string;
  nonce_hash: string;
  result_path: string;
  result_verdict: "clean" | "changes_requested" | null;
  result_bytes: number | null;
  project_path: string | null;
  reviewer_worktree_path: string | null;
  reviewer_branch_name: string;
  findings_json: string;
  error: string | null;
  started_at: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface FleetTaskFixRow {
  id: string;
  fleet_run_id: string;
  task_id: string;
  worker_id: string | null;
  attempt: number;
  round: number;
  old_head_sha: string;
  new_head_sha: string | null;
  policy_hash: string;
  verification_evidence_hash: string;
  provider: string | null;
  model: string | null;
  launch_failure_count: number;
  retry_not_before: string | null;
  state: FleetTaskFixState;
  request_id: string;
  nonce_hash: string;
  result_path: string;
  fixer_session_id: string;
  project_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  findings_json: string;
  result_bytes: number | null;
  error: string | null;
  started_at: string | null;
  deadline_at: string | null;
  completed_at: string | null;
  updated_at: string;
  created_at: string;
}

export interface FleetMergeOperationRow {
  id: string;
  operation_key: string;
  fleet_run_id: string;
  task_id: string | null;
  operation_type: FleetMergeOperationType;
  state: FleetMergeOperationState;
  target: FleetMergeTarget | null;
  expected_base_sha: string;
  expected_task_head_sha: string | null;
  result_head_sha: string | null;
  verification_commands_json: string;
  verification_output_hash: string | null;
  output_artifact_id: string | null;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FleetArtifactRow {
  id: string;
  fleet_run_id: string;
  task_id: string | null;
  worker_id?: string | null;
  attempt?: number | null;
  plan_hash: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  content_hash?: string | null;
  metadata_json?: string;
  byte_count?: number;
  artifact_type: string;
  title: string;
  body: string;
  severity: FleetArtifactSeverity;
  actor: string;
  body_pruned_at?: string | null;
  created_at: string;
}

export type FleetCleanupActionState =
  "pending" | "running" | "completed" | "failed" | "skipped";

export interface FleetCleanupActionRow {
  id: string;
  action_key: string;
  fleet_run_id: string;
  worker_id: string | null;
  artifact_id: string | null;
  action_type: "delete_worktree" | "delete_report_file" | "prune_artifact_body";
  state: FleetCleanupActionState;
  target_path: string | null;
  project_path: string | null;
  expected_content_hash: string | null;
  requested_by: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface FleetApprovalPreview {
  requiredGates: string[];
  blockedActions: string[];
  canApproveExecutableWork: boolean;
}

export interface FleetRunDto {
  id: string;
  name: string;
  goal: string;
  repoId: string | null;
  projectId: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  sourceName: string | null;
  status: FleetRunStatus;
  budgetUsd: number | null;
  budgetTokens: number | null;
  provider: string;
  model: string | null;
  maxConcurrency: number;
  reviewPolicy: FleetReviewPolicy;
  approvalState: FleetApprovalState;
  planHash: string | null;
  planText: string | null;
  approvedPlanHash: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  desiredState: FleetDesiredState;
  automationPolicy: FleetAutomationPolicy;
  automationPolicyHash: string | null;
  automationGrantedBy: string | null;
  automationGrantedAt: string | null;
  automationBaseSha: string | null;
  automationLastError: string | null;
  mergeRequestedAt: string | null;
  mergeRequestedBy: string | null;
  mergeRequestKind: "manual" | "automatic" | null;
  mergeTarget: FleetMergeTarget | null;
  integrationState: FleetIntegrationState;
  integrationBranch: string | null;
  integrationWorktree: string | null;
  integrationBaseSha: string | null;
  integrationHeadSha: string | null;
  integrationPrNumber: number | null;
  integrationPrUrl: string | null;
  integrationPrHeadSha: string | null;
  integrationMergeSha: string | null;
  integrationError: string | null;
  integrationUpdatedAt: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  retentionDays: number | null;
  schedulerEpoch: number;
  recoveryRequired: boolean;
  reservedBudgetUsd: number;
  spentBudgetUsd: number;
  reservedBudgetTokens: number;
  spentBudgetTokens: number;
  costConfidence: FleetCostConfidence;
  budgetStopMode: FleetBudgetStopMode;
  budgetWarningThreshold: number;
  budgetWarningEmittedAt: string | null;
  budgetHardLimitAt: string | null;
  budgetInterruptDeadlineAt: string | null;
  providerCaps: Readonly<Record<string, number>>;
  resourceLimits: FleetResourceLimits;
  defaultMaxAttempts: number;
  pauseMode: FleetPauseMode | null;
  pauseReason: string | null;
  cancelMode: FleetCancelMode | null;
  taskCount: number;
  workerCount: number;
  /** Operator-attention signals summarized for list/board surfaces. */
  attentionCount: number;
  /** Exact reviewed work is waiting for a manual staging or landing action. */
  awaitingManualMerge: boolean;
  createdAt: string;
  updatedAt: string;
  approvalPreview: FleetApprovalPreview;
  plannerState: FleetPlannerState;
  plannerError: string | null;
  plannerProvider: string | null;
  plannerSessionId: string | null;
}

export interface FleetTaskDto {
  id: string;
  parentTaskId: string | null;
  dependsOnTaskIds: string[];
  title: string;
  description: string | null;
  status: FleetTaskStatus;
  taskType: string;
  sortOrder: number;
  fileClaims: string[];
  priority: number;
  agentType: string | null;
  model: string | null;
  workingDirectory: string | null;
  baseBranch: string | null;
  sourceRef: string | null;
  sourceStepId: string | null;
  sourceIssueId: string | null;
  sourceIssueNumber: number | null;
  branchName: string | null;
  worktreePath: string | null;
  baseSha: string | null;
  headSha: string | null;
  actualFileClaims: string[];
  reportArtifactId: string | null;
  diffArtifactId: string | null;
  verificationId: string | null;
  verificationStatus: FleetVerificationStatus | null;
  verificationSpecHash: string | null;
  verifiedHeadSha: string | null;
  verificationArtifactId: string | null;
  verificationStartedAt: string | null;
  verificationCompletedAt: string | null;
  reviewStatus: "pending" | "clean" | "changes_requested" | null;
  reviewHeadSha: string | null;
  reviewVerificationHash: string | null;
  reviewCompletedAt: string | null;
  fixRounds: number;
  activeFixId: string | null;
  fixerSessionId: string | null;
  fixError: string | null;
  retryNotBefore: string | null;
  providerFailureCount: number;
  providerState: "ready" | "spawning" | "running" | "backoff" | "failed";
  providerLastError: string | null;
  integrationState: "pending" | "integrating" | "merged" | "failed";
  integrationOperationId: string | null;
  integratedHeadSha: string | null;
  integratedAt: string | null;
  maxAttempts: number;
  currentAttempt: number;
  acceptanceCriteria: string | null;
  riskNotes: FleetPlanRiskNote[];
  verifyCommand: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetWorkerDto {
  id: string;
  taskId: string | null;
  sessionId: string | null;
  status: FleetWorkerStatus;
  provider: string | null;
  model: string | null;
  attempt: number;
  spawnRequestId: string | null;
  worktreePath: string | null;
  branchName: string | null;
  baseSha: string | null;
  headSha: string | null;
  reportState: FleetWorkerReportState;
  reportStatus: "succeeded" | "blocked" | "failed" | null;
  reportSubmittedAt: string | null;
  reportCollectedAt: string | null;
  reportBytes: number;
  actualClaims: string[];
  diffSummary: unknown;
  reportPollCount: number;
  reportLastPolledAt: string | null;
  reportNextPollAt: string | null;
  reportError: string | null;
  reservationUsd: number;
  reservationTokens: number;
  reservationConfidence: FleetCostConfidence;
  reservationBasis: string | null;
  actualCostUsd: number | null;
  actualTokens: number | null;
  costConfidence: FleetCostConfidence;
  costReconciledAt: string | null;
  interruptRequestedAt: string | null;
  interruptDeadlineAt: string | null;
  interruptNoticeState: FleetInterruptNoticeState;
  interruptStopState: FleetInterruptStopState;
  interruptCause: FleetInterruptCause | null;
  renderedStatus: FleetRenderedStatus | null;
  renderedStatusSummary: string | null;
  renderedStatusSummaryRedacted: boolean;
  renderedStatusReplacementCount: number;
  renderedStatusStabilityCount: number;
  renderedStatusLastCapturedAt: string | null;
  renderedStatusNextCaptureAt: string | null;
  renderedStatusError: string | null;
  terminalCause: string | null;
  failureCode: string | null;
  createdAt: string;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
}

export interface FleetEventDto {
  id: number;
  eventType: string;
  actor: string;
  payload: unknown;
  createdAt: string;
}

export interface FleetVerificationDto {
  id: string;
  taskId: string;
  workerId: string | null;
  attempt: number;
  baseSha: string;
  headSha: string;
  specHash: string;
  command: string;
  status: FleetVerificationStatus;
  runCount: number;
  outputArtifactId: string | null;
  outputHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FleetArtifactDto {
  id: string;
  taskId: string | null;
  workerId: string | null;
  attempt: number | null;
  planHash: string | null;
  baseSha: string | null;
  headSha: string | null;
  contentHash: string | null;
  metadata: unknown;
  byteCount: number;
  artifactType: string;
  title: string;
  body: string;
  bodyPrunedAt: string | null;
  severity: FleetArtifactSeverity;
  actor: string;
  createdAt: string;
}

export interface FleetArtifactBodyDto {
  id: string;
  contentHash: string | null;
  byteCount: number;
  body: string;
  bodyPrunedAt: string | null;
}

export interface FleetRunDetailDto {
  run: FleetRunDto;
  tasks: FleetTaskDto[];
  workers: FleetWorkerDto[];
  artifacts: FleetArtifactDto[];
  verifications: FleetVerificationDto[];
  events: FleetEventDto[];
}

export interface CreateFleetRunInput {
  name: string;
  goal: string;
  repoId?: string | null;
  projectId?: string | null;
  budgetUsd?: number | null;
  budgetTokens?: number | null;
  budgetStopMode?: FleetBudgetStopMode | null;
  budgetWarningThreshold?: number | null;
  providerCaps?: Record<string, number> | null;
  resourceLimits?: Partial<FleetResourceLimits> | null;
  maxRetriesPerTask?: number | null;
  provider?: string | null;
  model?: string | null;
  maxConcurrency?: number | null;
  reviewPolicy?: FleetReviewPolicy | null;
  automationPolicy?: Partial<FleetAutomationPolicyV1> | null;
}

export interface IngestFleetPlanInput {
  planText: string;
  actor?: string | null;
}

export interface ApproveFleetPlanInput {
  expectedPlanHash: string;
}

export interface AttachFleetArtifactInput {
  taskId?: string | null;
  expectedPlanHash: string;
  title: string;
  body: string;
  severity?: FleetArtifactSeverity | null;
  actor?: string | null;
}

export interface ResumeFleetRunInput {
  actor?: string | null;
  conductorSessionId?: string | null;
}

export interface PauseFleetRunInput {
  actor?: string | null;
  mode?: FleetPauseMode | null;
  graceMs?: number | null;
}

export interface CancelFleetRunInput {
  actor?: string | null;
  mode?: FleetCancelMode | null;
  confirm?: boolean;
  confirmation?: string;
  previewDigest?: string;
}

export interface FleetDestructivePreviewOwner {
  ownerType: FleetDestructiveTargetOwnerType;
  ownerId: string;
  taskId: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sessionStatus: string | null;
  active: boolean;
}

export interface FleetDestructivePreviewOwnerRef {
  ownerType: FleetDestructiveTargetOwnerType;
  ownerId: string;
  workerId: string | null;
  sessionId: string | null;
}

export interface FleetDestructiveActionPreview {
  runId: string;
  action: "cancel" | "cleanup";
  /** Exact, stable database revision used to close the preview/mutation race. */
  revision: string;
  /** Digest of the complete canonical preview the operator confirmed. */
  targetDigest: string;
  complete: boolean;
  objectLimit: number;
  truncatedKinds: Array<
    "owners" | "sessions" | "worktrees" | "branches" | "artifacts"
  >;
  excludedWorktreeCount: number;
  owners: FleetDestructivePreviewOwner[];
  sessions: Array<{
    id: string;
    name: string | null;
    status: string | null;
    active: boolean;
    owners: Array<{
      ownerType: FleetDestructiveTargetOwnerType;
      ownerId: string;
    }>;
  }>;
  worktrees: Array<{
    worktreePath: string;
    projectPath: string;
    exists: boolean;
    expectedHeadSha: string | null;
    owners: FleetDestructivePreviewOwnerRef[];
    branchNames: string[];
    sessionIds: string[];
  }>;
  branches: Array<{
    branchName: string;
    worktreePath: string;
    ownerType: FleetDestructiveTargetOwnerType;
    ownerId: string;
    expectedHeadSha: string | null;
    preserved: boolean;
  }>;
  artifacts: Array<{
    id: string;
    taskId: string | null;
    workerId: string | null;
    artifactType: string;
    title: string;
    byteCount: number;
    bodyPrunedAt: string | null;
    preserved: true;
  }>;
  effects: {
    stopActiveSessions: boolean;
    deleteVerifiedWorktrees: boolean;
    preserveBranches: boolean;
    preserveArtifactMetadata: boolean;
    artifactBodyRetentionDays: number | null;
  };
}

export interface FleetTaskDependencyRow {
  id: string;
  fleet_run_id: string;
  task_id: string;
  depends_on_task_id: string;
  dependency_type: "blocks" | "informs" | "review_of" | "fixes";
}

export interface FleetTaskClaimRow {
  id: string;
  fleet_run_id: string;
  task_id: string;
  path: string;
  claim_type: FleetClaimType;
  confidence: number;
}
