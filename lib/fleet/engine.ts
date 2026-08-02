import type {
  CreateFleetRunInput,
  FleetArtifactDto,
  FleetArtifactRow,
  FleetApprovalPreview,
  FleetEventDto,
  FleetEventRow,
  FleetReviewPolicy,
  FleetPlannerState,
  FleetRunDetailDto,
  FleetRunDto,
  FleetRunRow,
  FleetTaskDto,
  FleetTaskRow,
  FleetWorkerDto,
  FleetWorkerRow,
  FleetVerificationDto,
  FleetVerificationRow,
} from "./types";
import {
  fleetDesiredStateForPolicy,
  parseFleetAutomationPolicy,
  normalizeFleetAutomationPolicy,
} from "./automation-policy";
import type { FleetAutomationPolicy, FleetDesiredState } from "./types";
import {
  normalizeFleetResourceLimits,
  type FleetResourceLimits,
} from "./resource-admission";
import type { FleetBudgetStopMode } from "./budgets";
import type { FleetPlanRiskNote } from "./plan";
import {
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
} from "./admission";
import { isValidProviderId, type ProviderId } from "@/lib/providers/registry";
import { resolveExactModelForAgent } from "@/lib/model-catalog";

export interface NormalizedFleetRunDraft {
  name: string;
  goal: string;
  repoId: string | null;
  projectId: string | null;
  budgetUsd: number | null;
  budgetTokens: number | null;
  budgetStopMode: FleetBudgetStopMode;
  budgetWarningThreshold: number;
  providerCaps: Readonly<Record<string, number>>;
  resourceLimits: FleetResourceLimits;
  defaultMaxAttempts: number;
  provider: string;
  model: string | null;
  maxConcurrency: number;
  reviewPolicy: FleetReviewPolicy;
  desiredState: FleetDesiredState;
  automationPolicy: FleetAutomationPolicy;
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

function budgetStopModeValue(value: unknown): FleetBudgetStopMode {
  return value === "hard-stop" || value === "ask-operator"
    ? value
    : "pause-new";
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

  const rawConcurrency = Math.trunc(
    numberValue(payload.maxConcurrency) ?? FLEET_DEFAULT_PARALLEL_WORKERS
  );
  const maxConcurrency = Number.isFinite(rawConcurrency)
    ? Math.max(1, Math.min(FLEET_MAX_TOTAL_WORKERS, rawConcurrency))
    : FLEET_DEFAULT_PARALLEL_WORKERS;
  const rawBudgetUsd = numberValue(payload.budgetUsd);
  const budgetUsd =
    rawBudgetUsd == null || !Number.isFinite(rawBudgetUsd)
      ? null
      : Math.max(0, rawBudgetUsd);
  const rawBudgetTokens = numberValue(payload.budgetTokens);
  const budgetTokens =
    rawBudgetTokens == null ||
    !Number.isSafeInteger(rawBudgetTokens) ||
    rawBudgetTokens < 0
      ? null
      : Math.min(rawBudgetTokens, 1_000_000_000_000);
  const rawWarningThreshold = numberValue(payload.budgetWarningThreshold);
  const budgetWarningThreshold =
    rawWarningThreshold == null || !Number.isFinite(rawWarningThreshold)
      ? 0.8
      : Math.min(1, Math.max(0.01, rawWarningThreshold));
  const rawRetries = Math.trunc(numberValue(payload.maxRetriesPerTask) ?? 1);
  const defaultMaxAttempts = Number.isFinite(rawRetries)
    ? Math.min(10, Math.max(1, rawRetries + 1))
    : 2;
  const requestedLimits =
    payload.resourceLimits && typeof payload.resourceLimits === "object"
      ? (payload.resourceLimits as Partial<FleetResourceLimits>)
      : {};
  const resourceLimits = normalizeFleetResourceLimits({
    ...requestedLimits,
    providerCaps:
      payload.providerCaps && typeof payload.providerCaps === "object"
        ? (payload.providerCaps as Readonly<Record<string, number>>)
        : requestedLimits.providerCaps,
  });
  const reviewPolicy = reviewPolicyValue(payload.reviewPolicy);
  const automation = normalizeFleetAutomationPolicy(
    payload.automationPolicy,
    reviewPolicy
  );
  if ("error" in automation) return automation;

  const rawProvider = textValue(payload.provider).trim() || "claude";
  if (
    rawProvider.length > FLEET_PROVIDER_MAX ||
    !isValidProviderId(rawProvider) ||
    rawProvider === "shell"
  ) {
    return { error: "provider must be a supported Fleet agent" };
  }
  const provider = rawProvider as ProviderId;
  const rawModel = textValue(payload.model).trim() || null;
  if (rawModel && rawModel.length > FLEET_MODEL_MAX) {
    return { error: `model must be at most ${FLEET_MODEL_MAX} characters` };
  }
  const resolvedModel = resolveExactModelForAgent(provider, rawModel);
  if (!resolvedModel.ok) return { error: resolvedModel.error };

  return {
    draft: {
      name,
      goal,
      repoId: textValue(payload.repoId).trim() || null,
      projectId: textValue(payload.projectId).trim() || null,
      budgetUsd,
      budgetTokens,
      budgetStopMode: budgetStopModeValue(payload.budgetStopMode),
      budgetWarningThreshold,
      providerCaps: resourceLimits.providerCaps,
      resourceLimits,
      defaultMaxAttempts,
      provider,
      model: resolvedModel.model,
      maxConcurrency,
      reviewPolicy,
      desiredState: fleetDesiredStateForPolicy(automation.policy),
      automationPolicy: automation.policy,
    },
  };
}

export function buildFleetApprovalPreview(
  canApproveExecutableWork = false
): FleetApprovalPreview {
  return {
    requiredGates: [
      "exact plan, execution, policy, and base-SHA binding",
      "manual approval or four independent clean plan critics",
      "unattended-agent consent or strong confinement",
      "exact task verification and four exact-head task reviews",
      "final integration verification and exact landing authorization",
    ],
    blockedActions: canApproveExecutableWork
      ? [
          "landing until final verification and authorization",
          "cleanup until terminal/archive and exact preview",
        ]
      : [
          "worker launch until exact plan approval",
          "resume or tick execution until exact plan approval",
          "landing until final verification and authorization",
          "cleanup until terminal/archive and exact preview",
        ],
    canApproveExecutableWork,
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

function parseFleetRiskNotes(
  value: string | null | undefined
): FleetPlanRiskNote[] {
  const parsed = parseJson(value ?? "[]");
  if (!Array.isArray(parsed) || parsed.length > 8) return [];
  const notes: FleetPlanRiskNote[] = [];
  for (const value of parsed) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const note = value as Record<string, unknown>;
    const severity = note.severity;
    const risk = note.risk;
    const mitigation = note.mitigation;
    if (
      (severity !== "low" && severity !== "medium" && severity !== "high") ||
      typeof risk !== "string" ||
      !risk.trim() ||
      risk.length > 500 ||
      typeof mitigation !== "string" ||
      !mitigation.trim() ||
      mitigation.length > 1_000
    ) {
      return [];
    }
    notes.push({ severity, risk, mitigation });
  }
  return notes;
}

function parseSettingsPlanText(value: string): string | null {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object") return null;
  const planText = (parsed as { planText?: unknown }).planText;
  return typeof planText === "string" && planText.trim() ? planText : null;
}

function parseObject(
  value: string | null | undefined
): Record<string, unknown> {
  const parsed = parseJson(value ?? null);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parsePlannerSettings(value: string): {
  state: FleetPlannerState;
  error: string | null;
  provider: string | null;
  sessionId: string | null;
} {
  const parsed = parseJson(value);
  const planner =
    parsed && typeof parsed === "object"
      ? (parsed as { planner?: unknown }).planner
      : null;
  if (!planner || typeof planner !== "object") {
    return { state: "idle", error: null, provider: null, sessionId: null };
  }
  const record = planner as Record<string, unknown>;
  const states: FleetPlannerState[] = [
    "idle",
    "starting",
    "running",
    "finalizing",
    "cleanup_pending",
    "ready",
    "failed",
  ];
  return {
    state: states.includes(record.state as FleetPlannerState)
      ? (record.state as FleetPlannerState)
      : "idle",
    error: typeof record.error === "string" ? record.error : null,
    provider: typeof record.provider === "string" ? record.provider : null,
    sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
  };
}

export function toFleetRunDto(
  row: FleetRunRow,
  counts: {
    taskCount: number;
    workerCount: number;
    attentionCount?: number;
    awaitingManualMerge?: boolean;
  }
): FleetRunDto {
  const planner = parsePlannerSettings(row.settings_json);
  const automation = parseFleetAutomationPolicy(row.automation_policy_json);
  const desiredStates: FleetDesiredState[] = [
    "draft",
    "planned",
    "running",
    "paused",
    "canceled",
  ];
  const desiredState = desiredStates.includes(
    row.desired_state as FleetDesiredState
  )
    ? (row.desired_state as FleetDesiredState)
    : "draft";
  return {
    id: row.id,
    name: row.name,
    goal: row.goal,
    repoId: row.repo_id,
    projectId: row.project_id,
    sourceKind: row.source_kind ?? null,
    sourceId: row.source_id ?? null,
    sourceName: row.source_name ?? null,
    status: row.status,
    budgetUsd: row.budget_usd,
    budgetTokens: row.budget_tokens ?? null,
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
    desiredState,
    automationPolicy: automation.policy,
    automationPolicyHash: row.automation_policy_hash ?? null,
    automationGrantedBy: row.automation_granted_by ?? null,
    automationGrantedAt: row.automation_granted_at ?? null,
    automationBaseSha: row.automation_base_sha ?? null,
    automationLastError: row.automation_last_error ?? null,
    mergeRequestedAt: row.merge_requested_at ?? null,
    mergeRequestedBy: row.merge_requested_by ?? null,
    mergeRequestKind: row.merge_request_kind ?? null,
    mergeTarget: row.merge_target ?? null,
    integrationState: row.integration_state ?? "idle",
    integrationBranch: row.integration_branch ?? null,
    integrationWorktree: row.integration_worktree ?? null,
    integrationBaseSha: row.integration_base_sha ?? null,
    integrationHeadSha: row.integration_head_sha ?? null,
    integrationPrNumber: row.integration_pr_number ?? null,
    integrationPrUrl: row.integration_pr_url ?? null,
    integrationPrHeadSha: row.integration_pr_head_sha ?? null,
    integrationMergeSha: row.integration_merge_sha ?? null,
    integrationError: row.integration_error ?? null,
    integrationUpdatedAt: row.integration_updated_at ?? null,
    archivedAt: row.archived_at ?? null,
    archivedBy: row.archived_by ?? null,
    retentionDays: row.retention_days ?? null,
    schedulerEpoch: row.scheduler_epoch ?? 0,
    recoveryRequired: row.recovery_required === 1,
    reservedBudgetUsd: row.reserved_budget_usd ?? 0,
    spentBudgetUsd: row.spent_budget_usd ?? 0,
    reservedBudgetTokens: row.reserved_budget_tokens ?? 0,
    spentBudgetTokens: row.spent_budget_tokens ?? 0,
    costConfidence: row.cost_confidence ?? "unknown",
    budgetStopMode: row.budget_stop_mode ?? "pause-new",
    budgetWarningThreshold: row.budget_warning_threshold ?? 0.8,
    budgetWarningEmittedAt: row.budget_warning_emitted_at ?? null,
    budgetHardLimitAt: row.budget_hard_limit_at ?? null,
    budgetInterruptDeadlineAt: row.budget_interrupt_deadline_at ?? null,
    providerCaps: normalizeFleetResourceLimits({
      providerCaps: parseObject(row.provider_caps_json) as Readonly<
        Record<string, number>
      >,
    }).providerCaps,
    resourceLimits: normalizeFleetResourceLimits(
      parseObject(row.resource_limits_json) as Partial<FleetResourceLimits>
    ),
    defaultMaxAttempts: row.default_max_attempts ?? 2,
    pauseMode: row.pause_mode ?? null,
    pauseReason: row.pause_reason ?? null,
    cancelMode: row.cancel_mode ?? null,
    taskCount: counts.taskCount,
    workerCount: counts.workerCount,
    attentionCount: counts.attentionCount ?? 0,
    awaitingManualMerge: counts.awaitingManualMerge ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvalPreview: buildFleetApprovalPreview(
      row.approval_state === "approved" &&
        row.approved_plan_hash != null &&
        row.approved_plan_hash === row.plan_hash
    ),
    plannerState: planner.state,
    plannerError: planner.error,
    plannerProvider: planner.provider,
    plannerSessionId: planner.sessionId,
  };
}

export function toFleetTaskDto(
  row: FleetTaskRow,
  dependsOnTaskIds: string[] = []
): FleetTaskDto {
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    dependsOnTaskIds,
    title: row.title,
    description: row.description,
    status: row.status,
    taskType: row.task_type,
    sortOrder: row.sort_order,
    fileClaims: parseStringArray(row.file_claims_json),
    priority: row.priority ?? 0,
    agentType: row.agent_type ?? null,
    model: row.model ?? null,
    workingDirectory: row.working_directory ?? null,
    baseBranch: row.base_branch ?? null,
    sourceRef: row.source_ref ?? null,
    sourceStepId: row.source_step_id ?? null,
    sourceIssueId: row.source_issue_id ?? null,
    sourceIssueNumber: row.source_issue_number ?? null,
    branchName: row.branch_name ?? null,
    worktreePath: row.worktree_path ?? null,
    baseSha: row.base_sha ?? null,
    headSha: row.head_sha ?? null,
    actualFileClaims: parseStringArray(row.actual_file_claims_json ?? "[]"),
    reportArtifactId: row.report_artifact_id ?? null,
    diffArtifactId: row.diff_artifact_id ?? null,
    verificationId: row.verification_id ?? null,
    verificationStatus: row.verification_status ?? null,
    verificationSpecHash: row.verification_spec_hash ?? null,
    verifiedHeadSha: row.verified_head_sha ?? null,
    verificationArtifactId: row.verification_artifact_id ?? null,
    verificationStartedAt: row.verification_started_at ?? null,
    verificationCompletedAt: row.verification_completed_at ?? null,
    reviewStatus: row.review_status ?? null,
    reviewHeadSha: row.review_head_sha ?? null,
    reviewVerificationHash: row.review_verification_hash ?? null,
    reviewCompletedAt: row.review_completed_at ?? null,
    fixRounds: row.fix_rounds ?? 0,
    activeFixId: row.active_fix_id ?? null,
    fixerSessionId: row.fixer_session_id ?? null,
    fixError: row.fix_error ?? null,
    retryNotBefore: row.retry_not_before ?? null,
    providerFailureCount: row.provider_failure_count ?? 0,
    providerState: row.provider_state ?? "ready",
    providerLastError: row.provider_last_error ?? null,
    integrationState: row.integration_state ?? "pending",
    integrationOperationId: row.integration_operation_id ?? null,
    integratedHeadSha: row.integrated_head_sha ?? null,
    integratedAt: row.integrated_at ?? null,
    maxAttempts: row.max_attempts ?? 2,
    currentAttempt: row.current_attempt ?? 0,
    acceptanceCriteria: row.acceptance_criteria ?? null,
    riskNotes: parseFleetRiskNotes(row.risk_notes_json),
    verifyCommand: row.verify_command ?? null,
    failureCode: row.failure_code ?? null,
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
    spawnRequestId: row.spawn_request_id ?? null,
    worktreePath: row.worktree_path ?? null,
    branchName: row.branch_name ?? null,
    baseSha: row.base_sha ?? null,
    headSha: row.head_sha ?? null,
    reportState: row.report_state ?? "legacy",
    reportStatus: row.report_status ?? null,
    reportSubmittedAt: row.report_submitted_at ?? null,
    reportCollectedAt: row.report_collected_at ?? null,
    reportBytes: row.report_bytes ?? 0,
    actualClaims: parseStringArray(row.actual_claims_json ?? "[]"),
    diffSummary: parseJson(row.diff_summary_json ?? null),
    reportPollCount: row.report_poll_count ?? 0,
    reportLastPolledAt: row.report_last_polled_at ?? null,
    reportNextPollAt: row.report_next_poll_at ?? null,
    reportError: row.report_error ?? null,
    reservationUsd: row.reservation_usd ?? 0,
    reservationTokens: row.reservation_tokens ?? 0,
    reservationConfidence: row.reservation_confidence ?? "unknown",
    reservationBasis: row.reservation_basis ?? null,
    actualCostUsd: row.actual_cost_usd ?? null,
    actualTokens: row.actual_tokens ?? null,
    costConfidence: row.cost_confidence ?? "unknown",
    costReconciledAt: row.cost_reconciled_at ?? null,
    interruptRequestedAt: row.interrupt_requested_at ?? null,
    interruptDeadlineAt: row.interrupt_deadline_at ?? null,
    interruptNoticeState: row.interrupt_notice_state ?? "unattempted",
    interruptStopState: row.interrupt_stop_state ?? "unattempted",
    interruptCause: row.interrupt_cause ?? null,
    renderedStatus: row.rendered_status ?? null,
    renderedStatusSummary: row.rendered_status_summary ?? null,
    renderedStatusSummaryRedacted:
      (row.rendered_status_summary_redacted ?? 0) === 1,
    renderedStatusReplacementCount: row.rendered_status_replacement_count ?? 0,
    renderedStatusStabilityCount: row.rendered_status_stability_count ?? 0,
    renderedStatusLastCapturedAt: row.rendered_status_last_captured_at ?? null,
    renderedStatusNextCaptureAt: row.rendered_status_next_capture_at ?? null,
    renderedStatusError: row.rendered_status_error ?? null,
    terminalCause: row.terminal_cause ?? null,
    failureCode: row.failure_code ?? null,
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

export function toFleetVerificationDto(
  row: FleetVerificationRow
): FleetVerificationDto {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id,
    attempt: row.attempt,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    specHash: row.spec_hash,
    command: row.command,
    status: row.status,
    runCount: row.run_count,
    outputArtifactId: row.output_artifact_id,
    outputHash: row.output_hash,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export function toFleetArtifactDto(row: FleetArtifactRow): FleetArtifactDto {
  return {
    id: row.id,
    taskId: row.task_id,
    workerId: row.worker_id ?? null,
    attempt: row.attempt ?? null,
    planHash: row.plan_hash,
    baseSha: row.base_sha ?? null,
    headSha: row.head_sha ?? null,
    contentHash: row.content_hash ?? null,
    metadata: parseJson(row.metadata_json ?? null),
    byteCount: row.byte_count ?? 0,
    artifactType: row.artifact_type,
    title: row.title,
    body: row.body,
    bodyPrunedAt: row.body_pruned_at ?? null,
    severity: row.severity,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export function composeFleetRunDetail(input: {
  run: FleetRunRow;
  tasks: FleetTaskRow[];
  dependencies?: import("./types").FleetTaskDependencyRow[];
  workers: FleetWorkerRow[];
  artifacts: FleetArtifactRow[];
  artifactTotal?: number;
  verifications?: FleetVerificationRow[];
  events: FleetEventRow[];
  eventTotal?: number;
}): FleetRunDetailDto {
  const attentionActive =
    input.run.archived_at == null &&
    !["completed", "failed", "canceled"].includes(input.run.status);
  const awaitingManualMerge =
    input.run.archived_at == null &&
    input.run.merge_requested_at == null &&
    input.run.approval_state === "approved" &&
    input.run.plan_hash != null &&
    input.run.approved_plan_hash === input.run.plan_hash &&
    (input.run.desired_state ?? "running") === "running" &&
    input.run.recovery_required === 0 &&
    ["running", "reviewing", "merging"].includes(input.run.status) &&
    ((input.run.merge_request_kind === "manual" &&
      input.run.integration_state === "ready_to_finalize" &&
      input.run.integration_base_sha === input.run.automation_base_sha &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(
        input.run.integration_head_sha ?? ""
      )) ||
      (input.run.merge_request_kind == null &&
        !parseFleetAutomationPolicy(input.run.automation_policy_json).policy
          .automaticMerge &&
        input.tasks.some(
          (task) =>
            !["explore", "review", "milestone", "planning"].includes(
              task.task_type
            )
        ) &&
        input.tasks.every((task) =>
          ["explore", "review", "milestone", "planning"].includes(
            task.task_type
          )
            ? ["completed", "skipped"].includes(task.status)
            : task.status === "ready_to_merge"
        )));
  const planner = parsePlannerSettings(input.run.settings_json);
  const runNeedsAttention =
    input.run.approval_state === "needs_approval" ||
    input.run.approval_state === "blocked" ||
    input.run.automation_last_error != null ||
    planner.state === "failed" ||
    input.run.pause_reason === "budget_exhausted" ||
    input.run.budget_hard_limit_at != null ||
    input.run.budget_warning_emitted_at != null ||
    input.run.recovery_required === 1 ||
    input.run.integration_error != null ||
    input.run.integration_state === "awaiting_operator";
  const runAttention = attentionActive && runNeedsAttention ? 1 : 0;
  const taskAttention = attentionActive
    ? input.tasks.filter(
        (task) =>
          [
            "waiting_for_operator",
            "failed",
            "blocked",
            "needs_inspection",
            "needs_followup",
          ].includes(task.status) ||
          task.verification_status === "fail" ||
          task.verification_status === "error" ||
          task.review_status === "changes_requested" ||
          task.provider_state === "backoff" ||
          task.provider_state === "failed" ||
          task.retry_not_before != null
      ).length
    : 0;
  const workerAttention = attentionActive
    ? input.workers.filter(
        (worker) =>
          [
            "waiting_for_operator",
            "failed",
            "dead",
            "cleanup_pending",
          ].includes(worker.status) ||
          (worker.rendered_status != null &&
            ["waiting", "error", "dead"].includes(worker.rendered_status)) ||
          worker.rendered_status_error != null
      ).length
    : 0;
  return {
    run: toFleetRunDto(input.run, {
      taskCount: input.tasks.length,
      workerCount: input.workers.length,
      attentionCount:
        runAttention +
        taskAttention +
        workerAttention +
        (awaitingManualMerge ? 1 : 0),
      awaitingManualMerge,
    }),
    tasks: input.tasks.map((task) =>
      toFleetTaskDto(
        task,
        (input.dependencies ?? [])
          .filter((dependency) => dependency.task_id === task.id)
          .map((dependency) => dependency.depends_on_task_id)
      )
    ),
    workers: input.workers.map(toFleetWorkerDto),
    artifacts: input.artifacts.map(toFleetArtifactDto),
    artifactTotal: input.artifactTotal ?? input.artifacts.length,
    artifactHasMore:
      (input.artifactTotal ?? input.artifacts.length) > input.artifacts.length,
    verifications: (input.verifications ?? []).map(toFleetVerificationDto),
    events: input.events.map(toFleetEventDto),
    eventTotal: input.eventTotal ?? input.events.length,
    eventHasMore:
      (input.eventTotal ?? input.events.length) > input.events.length,
  };
}
