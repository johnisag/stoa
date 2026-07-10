import type { DispatchRepo } from "@/lib/dispatch/types";

export type FleetRunStatus =
  "draft" | "planned" | "running" | "paused" | "completed" | "canceled";

export type FleetReviewPolicy =
  "four_agent" | "four_agent_plus_red_team" | "manual";

export type FleetApprovalState =
  "draft" | "needs_approval" | "approved" | "blocked";

export type FleetTaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "needs_inspection"
  | "blocked"
  | "canceled"
  | "completed";

export type FleetArtifactSeverity = "info" | "warning" | "blocker";

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
  lease_token: string | null;
  lease_expires_at: string | null;
  spawn_error: string | null;
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
  canApproveExecutableWork: false;
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
  taskCount: number;
  workerCount: number;
  createdAt: string;
  updatedAt: string;
  approvalPreview: FleetApprovalPreview;
}

export interface FleetTaskDto {
  id: string;
  parentTaskId: string | null;
  title: string;
  description: string | null;
  status: FleetTaskStatus;
  taskType: string;
  sortOrder: number;
  fileClaims: string[];
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
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  spawnError: string | null;
  createdAt: string;
  lastHeartbeatAt: string | null;
  endedAt: string | null;
}

export interface FleetSpawnResult {
  sessionId: string;
  worktreePath: string;
  branchName: string;
}

export interface FleetSpawnInput {
  run: FleetRunRow;
  task: FleetTaskRow;
  repo: DispatchRepo;
  workerId: string;
  leaseToken: string;
}

export interface FleetSchedulerSummary {
  launched: number;
  recovered: number;
  skipped: number;
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
  pendingLaunches: number;
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
