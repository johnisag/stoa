import type {
  CreateFleetRunInput,
  FleetArtifactDto,
  FleetArtifactRow,
  FleetApprovalPreview,
  FleetEventDto,
  FleetEventRow,
  FleetReviewPolicy,
  FleetRunDetailDto,
  FleetRunDto,
  FleetRunRow,
  FleetTaskDto,
  FleetTaskRow,
  FleetWorkerDto,
  FleetWorkerRow,
} from "./types";

export interface NormalizedFleetRunDraft {
  name: string;
  goal: string;
  repoId: string | null;
  projectId: string | null;
  budgetUsd: number | null;
  provider: string;
  model: string | null;
  maxConcurrency: number;
  reviewPolicy: FleetReviewPolicy;
}

export const FLEET_RUN_NAME_MAX = 120;
export const FLEET_RUN_GOAL_MAX = 12000;
export const FLEET_PROVIDER_MAX = 40;
export const FLEET_MODEL_MAX = 120;

const REVIEW_POLICIES: readonly FleetReviewPolicy[] = [
  "four_agent",
  "four_agent_plus_red_team",
  "manual",
];

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return null;
}

function cappedTextValue(value: unknown, max: number): string {
  return textValue(value).trim().slice(0, max);
}

function reviewPolicyValue(value: unknown): FleetReviewPolicy {
  return REVIEW_POLICIES.includes(value as FleetReviewPolicy)
    ? (value as FleetReviewPolicy)
    : "four_agent";
}

function draftPayload(
  value: unknown
): Partial<Record<keyof CreateFleetRunInput, unknown>> {
  return value && typeof value === "object"
    ? (value as Partial<Record<keyof CreateFleetRunInput, unknown>>)
    : {};
}

export function normalizeFleetRunDraft(
  input: unknown
): { draft: NormalizedFleetRunDraft } | { error: string } {
  const payload = draftPayload(input);
  const name = cappedTextValue(payload.name, FLEET_RUN_NAME_MAX);
  const goal = cappedTextValue(payload.goal, FLEET_RUN_GOAL_MAX);
  if (!name) return { error: "name is required" };
  if (!goal) return { error: "goal is required" };

  const rawConcurrency = Math.trunc(numberValue(payload.maxConcurrency) ?? 1);
  const maxConcurrency = Number.isFinite(rawConcurrency)
    ? Math.max(1, Math.min(40, rawConcurrency))
    : 1;
  const rawBudgetUsd = numberValue(payload.budgetUsd);
  const budgetUsd =
    rawBudgetUsd == null || !Number.isFinite(rawBudgetUsd)
      ? null
      : Math.max(0, rawBudgetUsd);

  return {
    draft: {
      name,
      goal,
      repoId: textValue(payload.repoId).trim() || null,
      projectId: textValue(payload.projectId).trim() || null,
      budgetUsd,
      provider:
        cappedTextValue(payload.provider, FLEET_PROVIDER_MAX) || "claude",
      model: cappedTextValue(payload.model, FLEET_MODEL_MAX) || null,
      maxConcurrency,
      reviewPolicy: reviewPolicyValue(payload.reviewPolicy),
    },
  };
}

export function buildFleetApprovalPreview(): FleetApprovalPreview {
  return {
    requiredGates: [
      "operator phase-start authorization",
      "full local verification gate",
      "four-agent review with adversarial lane",
      "green CI on the final PR head",
      "authorized head-SHA-pinned merge",
    ],
    blockedActions: [
      "autonomous planner execution",
      "worker spawning",
      "resume or tick execution",
      "merge or cleanup",
    ],
    canApproveExecutableWork: false,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseStringArray(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseSettingsPlanText(value: string): string | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") return null;
  const planText = (parsed as { planText?: unknown }).planText;
  return typeof planText === "string" && planText.trim() ? planText : null;
}

export function toFleetRunDto(
  row: FleetRunRow,
  counts: { taskCount: number; workerCount: number }
): FleetRunDto {
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    repoId: row.repo_id,
    projectId: row.project_id,
    status: row.status,
    budgetUsd: row.budget_usd,
    provider: row.provider,
    model: row.model,
    maxConcurrency: row.max_concurrency,
    reviewPolicy: row.review_policy,
    approvalState: row.approval_state,
    planHash: row.plan_hash,
    planText: parseSettingsPlanText(row.settings_json),
    approvedPlanHash: row.approved_plan_hash,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    taskCount: counts.taskCount,
    workerCount: counts.workerCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvalPreview: buildFleetApprovalPreview(),
  };
}

export function toFleetTaskDto(row: FleetTaskRow): FleetTaskDto {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    taskType: row.task_type,
    sortOrder: row.sort_order,
    fileClaims: parseStringArray(row.file_claims_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toFleetWorkerDto(row: FleetWorkerRow): FleetWorkerDto {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    status: row.status,
    provider: row.provider,
    model: row.model,
    attempt: row.attempt,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    spawnError: row.spawn_error,
    createdAt: row.created_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at,
  };
}

export function toFleetEventDto(row: FleetEventRow): FleetEventDto {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    payload: parseJson(row.payload),
    createdAt: row.created_at,
  };
}

export function toFleetArtifactDto(row: FleetArtifactRow): FleetArtifactDto {
  return {
    id: row.id,
    taskId: row.task_id,
    planHash: row.plan_hash,
    artifactType: row.artifact_type,
    title: row.title,
    body: row.body,
    severity: row.severity,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export function composeFleetRunDetail(input: {
  run: FleetRunRow;
  tasks: FleetTaskRow[];
  workers: FleetWorkerRow[];
  artifacts: FleetArtifactRow[];
  events: FleetEventRow[];
}): FleetRunDetailDto {
  return {
    run: toFleetRunDto(input.run, {
      taskCount: input.tasks.length,
      workerCount: input.workers.length,
    }),
    tasks: input.tasks.map(toFleetTaskDto),
    workers: input.workers.map(toFleetWorkerDto),
    artifacts: input.artifacts.map(toFleetArtifactDto),
    events: input.events.map(toFleetEventDto),
  };
}
