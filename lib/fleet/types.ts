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

export interface FleetRunRow {
  id: string;
  name: string;
  goal: string;
  repo_id: string | null;
  project_id: string | null;
  status: FleetRunStatus;
  budget_usd: number | null;
  provider: string;
  model: string | null;
  max_concurrency: number;
  review_policy: FleetReviewPolicy;
  approval_state: FleetApprovalState;
  plan_hash: string | null;
  approved_plan_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  conductor_session_id?: string | null;
  scheduler_epoch?: number;
  recovery_required?: number;
  reserved_budget_usd?: number;
  spent_budget_usd?: number;
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
  priority?: number;
  agent_type?: string | null;
  model?: string | null;
  working_directory?: string | null;
  base_branch?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  max_attempts?: number;
  current_attempt?: number;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  scheduler_epoch?: number;
  spawn_request_id?: string | null;
  acceptance_criteria?: string | null;
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
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  reservation_usd?: number;
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

export interface FleetArtifactRow {
  id: string;
  fleet_run_id: string;
  task_id: string | null;
  plan_hash: string | null;
  artifact_type: string;
  title: string;
  body: string;
  severity: FleetArtifactSeverity;
  actor: string;
  created_at: string;
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
  status: FleetRunStatus;
  budgetUsd: number | null;
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
  schedulerEpoch: number;
  recoveryRequired: boolean;
  reservedBudgetUsd: number;
  spentBudgetUsd: number;
  pauseMode: FleetPauseMode | null;
  pauseReason: string | null;
  cancelMode: FleetCancelMode | null;
  taskCount: number;
  workerCount: number;
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
  branchName: string | null;
  worktreePath: string | null;
  maxAttempts: number;
  currentAttempt: number;
  acceptanceCriteria: string | null;
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
  reservationUsd: number;
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

export interface FleetArtifactDto {
  id: string;
  taskId: string | null;
  planHash: string | null;
  artifactType: string;
  title: string;
  body: string;
  severity: FleetArtifactSeverity;
  actor: string;
  createdAt: string;
}

export interface FleetRunDetailDto {
  run: FleetRunDto;
  tasks: FleetTaskDto[];
  workers: FleetWorkerDto[];
  artifacts: FleetArtifactDto[];
  events: FleetEventDto[];
}

export interface CreateFleetRunInput {
  name: string;
  goal: string;
  repoId?: string | null;
  projectId?: string | null;
  budgetUsd?: number | null;
  provider?: string | null;
  model?: string | null;
  maxConcurrency?: number | null;
  reviewPolicy?: FleetReviewPolicy | null;
}

export interface IngestFleetPlanInput {
  planText: string;
  actor?: string | null;
}

export interface ApproveFleetPlanInput {
  expectedPlanHash: string;
  approvedBy?: string | null;
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
}

export interface CancelFleetRunInput {
  actor?: string | null;
  mode?: FleetCancelMode | null;
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
