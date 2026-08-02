import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { hashFleetExecutionContract } from "./hash";
import {
  insertFleetArtifact,
  insertFleetEvent,
  prepareFleetArtifactBody,
} from "./durable-write";
import {
  approvedExecutionHash,
  inspectFleetMergeReadiness,
} from "./merge-readiness";
import {
  compareFleetSupervisorAttention,
  recommendFleetSupervisorActions,
} from "./supervisor-rules";
import {
  FLEET_SUPERVISOR_RULES_VERSION,
  FLEET_SUPERVISOR_SNAPSHOT_VERSION,
  type AppendFleetSupervisorRecommendationInput,
  type FleetExternalSupervisorAction,
  type FleetSupervisorAttentionItem,
  type FleetSupervisorBindings,
  type FleetSupervisorFailureCategory,
  type FleetSupervisorGateSummary,
  type FleetSupervisorMergeSummary,
  type FleetSupervisorRunSummary,
  type FleetSupervisorSnapshot,
  type FleetSupervisorSnapshotState,
  type FleetSupervisorTaskSummary,
  type FleetSupervisorWorkerSummary,
} from "./supervisor-types";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "./types";

export const FLEET_SUPERVISOR_JSON_BODY_MAX = 16 * 1024;

const EXECUTION_TASK_CAP = 256;
const EXECUTION_CLAIM_CAP = 4096;
const EXECUTION_DEPENDENCY_CAP = 2048;
const EXTERNAL_RECOMMENDATION_CAP = 256;
const PLAN_REVIEW_LENSES = [
  "correctness_security",
  "conventions_cross_platform",
  "simplicity_ux",
  "adversarial_red_team",
] as const;

export const DEFAULT_FLEET_SUPERVISOR_LIMITS = Object.freeze({
  tasks: 64,
  workers: 128,
  attention: 128,
  recommendations: 32,
});

export interface FleetSupervisorLimits {
  tasks?: number;
  workers?: number;
  attention?: number;
  recommendations?: number;
}

interface ResolvedLimits {
  tasks: number;
  workers: number;
  attention: number;
  recommendations: number;
}

interface TaskGateCounts {
  total: number;
  exact_verification_pass: number;
  verification_failed: number;
  exact_review_clean: number;
  review_changes_requested: number;
  awaiting_operator: number;
  failed: number;
}

interface WorkerGateCounts {
  total: number;
  active: number;
  waiting_for_operator: number;
  failed: number;
}

const RUN_STATUSES = [
  "draft",
  "planned",
  "running",
  "paused",
  "reviewing",
  "merging",
  "completed",
  "failed",
  "canceled",
] as const;
const DESIRED_STATES = [
  "draft",
  "planned",
  "running",
  "paused",
  "canceled",
] as const;
const APPROVAL_STATES = [
  "draft",
  "needs_approval",
  "approved",
  "blocked",
] as const;
const INTEGRATION_STATES = [
  "idle",
  "initializing",
  "integrating",
  "final_verifying",
  "ready_to_finalize",
  "pushing",
  "waiting_ci",
  "merging",
  "awaiting_operator",
  "failed",
  "completed",
  "cleanup_pending",
  "cleanup_complete",
] as const;
const TASK_STATUSES = [
  "draft",
  "planned",
  "ready",
  "blocked",
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "needs_followup",
  "needs_inspection",
  "verifying",
  "reviewing",
  "fixing",
  "ready_to_merge",
  "merging",
  "merged",
  "failed",
  "canceled",
  "skipped",
  "completed",
] as const;
const PROVIDER_STATES = [
  "ready",
  "spawning",
  "running",
  "backoff",
  "failed",
] as const;
const VERIFICATION_STATUSES = [
  "pending",
  "running",
  "pass",
  "fail",
  "error",
] as const;
const REVIEW_STATUSES = ["pending", "clean", "changes_requested"] as const;
const TASK_INTEGRATION_STATES = [
  "pending",
  "integrating",
  "merged",
  "failed",
] as const;
const WORKER_STATUSES = [
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "completed",
  "failed",
  "canceled",
  "dead",
  "cleanup_pending",
  "cleanup_complete",
] as const;
const REPORT_STATES = ["legacy", "pending", "accepted", "invalid"] as const;
const REPORT_STATUSES = ["succeeded", "blocked", "failed"] as const;

function resolveLimit(value: number | undefined, fallback: number): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(value as number, fallback);
}

function resolveLimits(input: FleetSupervisorLimits): ResolvedLimits {
  return {
    tasks: resolveLimit(input.tasks, DEFAULT_FLEET_SUPERVISOR_LIMITS.tasks),
    workers: resolveLimit(
      input.workers,
      DEFAULT_FLEET_SUPERVISOR_LIMITS.workers
    ),
    attention: resolveLimit(
      input.attention,
      DEFAULT_FLEET_SUPERVISOR_LIMITS.attention
    ),
    recommendations: resolveLimit(
      input.recommendations,
      DEFAULT_FLEET_SUPERVISOR_LIMITS.recommendations
    ),
  };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeInteger(
  value: unknown,
  fallback = 0,
  min = 0,
  max = 1_000_000
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.trunc(value)))
    : fallback;
}

function safeEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | "unknown" {
  return typeof value === "string" && allowed.includes(value as T[number])
    ? (value as T[number])
    : "unknown";
}

function safeNullableEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): T[number] | "unknown" | null {
  return value == null ? null : safeEnum(value, allowed);
}

function safeId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  return `opaque-${stableHash(value).slice(0, 24)}`;
}

function digest(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function gitSha(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function safeTimestamp(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}(?:T| )[0-9:.+-]+Z?$/.test(value)
  ) {
    return null;
  }
  // Preserve the safe durable representation. Parsing or normalizing a value
  // without an offset would make the hash depend on the host timezone.
  return value;
}

function failureCategory(
  value: unknown
): FleetSupervisorFailureCategory | null {
  if (typeof value !== "string" || !value) return null;
  const normalized = value.toLowerCase();
  if (
    normalized.includes("provider") ||
    normalized.includes("spawn") ||
    normalized.includes("quota") ||
    normalized.includes("rate")
  ) {
    return "provider";
  }
  if (normalized.includes("verification")) return "verification";
  if (normalized.includes("review") || normalized.includes("fix")) {
    return "review";
  }
  if (normalized.includes("integration") || normalized.includes("merge")) {
    return "integration";
  }
  if (
    normalized.includes("report") ||
    normalized.includes("claim") ||
    normalized.includes("worktree") ||
    normalized.includes("commit")
  ) {
    return "evidence";
  }
  if (normalized.includes("dependency")) return "dependency";
  if (normalized.includes("recovery")) return "recovery";
  return "other";
}

function taskSummary(task: FleetTaskRow): FleetSupervisorTaskSummary {
  const headSha = gitSha(task.head_sha);
  const verifiedHeadSha = gitSha(task.verified_head_sha);
  const reviewHeadSha = gitSha(task.review_head_sha);
  const verificationStatus = safeNullableEnum(
    task.verification_status,
    VERIFICATION_STATUSES
  );
  const reviewStatus = safeNullableEnum(task.review_status, REVIEW_STATUSES);
  return {
    id: safeId(task.id) ?? "opaque-missing-task",
    parentTaskId: safeId(task.parent_task_id),
    status: safeEnum(task.status, TASK_STATUSES),
    sortOrder: safeInteger(task.sort_order, 0, -1_000_000),
    priority: safeInteger(task.priority, 0, -1_000_000),
    currentAttempt: safeInteger(task.current_attempt),
    maxAttempts: safeInteger(task.max_attempts, 2, 1, 1_000),
    providerState: safeEnum(task.provider_state, PROVIDER_STATES),
    retryNotBefore: safeTimestamp(task.retry_not_before),
    failureCategory: failureCategory(task.failure_code),
    baseSha: gitSha(task.base_sha),
    headSha,
    verificationStatus,
    exactVerificationPass:
      verificationStatus === "pass" &&
      headSha != null &&
      verifiedHeadSha === headSha &&
      typeof task.verification_id === "string" &&
      task.verification_id.length > 0,
    reviewStatus,
    exactReviewClean:
      reviewStatus === "clean" && headSha != null && reviewHeadSha === headSha,
    fixRounds: safeInteger(task.fix_rounds),
    integrationState: safeEnum(task.integration_state, TASK_INTEGRATION_STATES),
  };
}

function workerSummary(worker: FleetWorkerRow): FleetSupervisorWorkerSummary {
  return {
    id: safeId(worker.id) ?? "opaque-missing-worker",
    taskId: safeId(worker.task_id),
    status: safeEnum(worker.status, WORKER_STATUSES),
    attempt: safeInteger(worker.attempt, 1, 0, 1_000),
    hasSession:
      typeof worker.session_id === "string" && worker.session_id.length > 0,
    reportState: safeEnum(worker.report_state, REPORT_STATES),
    reportStatus: safeNullableEnum(worker.report_status, REPORT_STATUSES),
    failureCategory: failureCategory(worker.failure_code),
    headSha: gitSha(worker.head_sha),
  };
}

function runSummary(run: FleetRunRow): FleetSupervisorRunSummary {
  return {
    id: safeId(run.id) ?? "opaque-missing-run",
    status: safeEnum(run.status, RUN_STATUSES),
    desiredState: safeEnum(run.desired_state ?? "draft", DESIRED_STATES),
    approvalState: safeEnum(run.approval_state, APPROVAL_STATES),
    integrationState: safeEnum(
      run.integration_state ?? "idle",
      INTEGRATION_STATES
    ),
    maxConcurrency: safeInteger(run.max_concurrency, 1, 1, 1_000),
    schedulerEpoch: safeInteger(run.scheduler_epoch),
    recoveryRequired: run.recovery_required === 1,
    mergeRequested:
      typeof run.merge_requested_at === "string" &&
      run.merge_requested_at.length > 0,
    archived: typeof run.archived_at === "string" && run.archived_at.length > 0,
  };
}

function currentBindings(
  run: FleetRunRow,
  executionHash: string | null,
  contractComplete: boolean
): FleetSupervisorBindings {
  const planHash = digest(run.plan_hash);
  const approvedPlanHash = digest(run.approved_plan_hash);
  const policyHash = digest(run.automation_policy_hash);
  const approvedExecution = digest(approvedExecutionHash(run));
  const baseSha = gitSha(run.automation_base_sha);
  return {
    planHash,
    approvedPlanHash,
    policyHash,
    executionHash,
    approvedExecutionHash: approvedExecution,
    baseSha,
    exactPlanApproval:
      run.approval_state === "approved" &&
      planHash != null &&
      approvedPlanHash === planHash,
    exactExecutionApproval:
      executionHash != null && approvedExecution === executionHash,
    contractComplete,
  };
}

function planReviewGate(
  db: Database.Database,
  runId: string,
  bindings: FleetSupervisorBindings
): FleetSupervisorGateSummary["planReview"] {
  if (
    !bindings.planHash ||
    !bindings.policyHash ||
    !bindings.executionHash ||
    !bindings.baseSha
  ) {
    return {
      required: PLAN_REVIEW_LENSES.length,
      exactCleanLenses: 0,
      independentReviewers: 0,
      complete: false,
    };
  }
  const rows = db
    .prepare(
      `SELECT lens, reviewer_session_id, verdict, state
       FROM fleet_reviews
       WHERE fleet_run_id = ? AND subject_type = 'plan'
         AND subject_hash = ? AND policy_hash = ?
         AND execution_hash = ? AND base_sha = ?
       ORDER BY lens ASC LIMIT ?`
    )
    .all(
      runId,
      bindings.planHash,
      bindings.policyHash,
      bindings.executionHash,
      bindings.baseSha,
      PLAN_REVIEW_LENSES.length + 1
    ) as Array<{
    lens: string;
    reviewer_session_id: string;
    verdict: string;
    state: string;
  }>;
  const clean = rows.filter(
    (row) =>
      PLAN_REVIEW_LENSES.includes(
        row.lens as (typeof PLAN_REVIEW_LENSES)[number]
      ) &&
      row.state === "clean" &&
      row.verdict === "clean" &&
      row.reviewer_session_id.length > 0
  );
  const lenses = new Set(clean.map((row) => row.lens));
  const reviewers = new Set(clean.map((row) => row.reviewer_session_id));
  return {
    required: PLAN_REVIEW_LENSES.length,
    exactCleanLenses: lenses.size,
    independentReviewers: reviewers.size,
    complete:
      lenses.size === PLAN_REVIEW_LENSES.length &&
      reviewers.size === PLAN_REVIEW_LENSES.length,
  };
}

function gateSummary(
  db: Database.Database,
  runId: string,
  bindings: FleetSupervisorBindings
): FleetSupervisorGateSummary {
  const tasks = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN verification_status = 'pass'
           AND head_sha IS NOT NULL AND verified_head_sha = head_sha
           AND verification_id IS NOT NULL THEN 1 ELSE 0 END), 0)
           AS exact_verification_pass,
         COALESCE(SUM(CASE WHEN verification_status IN ('fail', 'error')
           THEN 1 ELSE 0 END), 0) AS verification_failed,
         COALESCE(SUM(CASE WHEN review_status = 'clean'
           AND head_sha IS NOT NULL AND review_head_sha = head_sha
           THEN 1 ELSE 0 END), 0) AS exact_review_clean,
         COALESCE(SUM(CASE WHEN review_status = 'changes_requested'
           THEN 1 ELSE 0 END), 0) AS review_changes_requested,
         COALESCE(SUM(CASE WHEN status IN
           ('waiting_for_operator', 'needs_followup', 'needs_inspection', 'blocked')
           THEN 1 ELSE 0 END), 0) AS awaiting_operator,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0)
           AS failed
       FROM fleet_tasks WHERE fleet_run_id = ?`
    )
    .get(runId) as TaskGateCounts;
  const workers = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status IN ('leasing', 'spawning', 'running')
           THEN 1 ELSE 0 END), 0) AS active,
         COALESCE(SUM(CASE WHEN status = 'waiting_for_operator'
           THEN 1 ELSE 0 END), 0) AS waiting_for_operator,
         COALESCE(SUM(CASE WHEN status IN ('failed', 'dead')
           THEN 1 ELSE 0 END), 0) AS failed
       FROM fleet_workers WHERE fleet_run_id = ?`
    )
    .get(runId) as WorkerGateCounts;
  return {
    planReview: planReviewGate(db, runId, bindings),
    tasks: {
      total: safeInteger(tasks.total),
      exactVerificationPass: safeInteger(tasks.exact_verification_pass),
      verificationFailed: safeInteger(tasks.verification_failed),
      exactReviewClean: safeInteger(tasks.exact_review_clean),
      reviewChangesRequested: safeInteger(tasks.review_changes_requested),
      awaitingOperator: safeInteger(tasks.awaiting_operator),
      failed: safeInteger(tasks.failed),
    },
    workers: {
      total: safeInteger(workers.total),
      active: safeInteger(workers.active),
      waitingForOperator: safeInteger(workers.waiting_for_operator),
      failed: safeInteger(workers.failed),
    },
  };
}

function mergeBlockerCode(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized.includes("approved plan")) return "approval_binding";
  if (normalized.includes("base commit")) return "base_binding";
  if (normalized.includes("source repository")) return "source_checkout";
  if (normalized.includes("operator resolution")) return "operator_resolution";
  if (normalized.includes("verification")) return "verification_gate";
  if (normalized.includes("review")) return "review_gate";
  if (normalized.includes("failure")) return "task_failure";
  if (normalized.includes("blocker")) return "blocker_finding";
  if (normalized.includes("worker") || normalized.includes("report")) {
    return "worker_evidence";
  }
  if (normalized.includes("follow-up")) return "follow_up";
  if (normalized.includes("git") || normalized.includes("claim drift")) {
    return "git_evidence";
  }
  return "merge_gate";
}

function mergeSummary(
  db: Database.Database,
  run: FleetRunRow,
  tasks: FleetSupervisorTaskSummary[],
  assessmentComplete: boolean,
  outputLimit: number
): FleetSupervisorMergeSummary {
  if (!assessmentComplete) {
    return {
      assessmentComplete: false,
      requested: !!run.merge_requested_at,
      target:
        run.merge_target === "github_pr" || run.merge_target === "local"
          ? run.merge_target
          : null,
      integrationState: safeEnum(
        run.integration_state ?? "idle",
        INTEGRATION_STATES
      ),
      readyTaskIds: tasks
        .filter((task) => task.status === "ready_to_merge")
        .slice(0, outputLimit)
        .map((task) => task.id),
      waitingTaskIds: tasks
        .filter(
          (task) => !["merged", "completed", "skipped"].includes(task.status)
        )
        .slice(0, outputLimit)
        .map((task) => task.id),
      mergedTaskIds: tasks
        .filter((task) => task.status === "merged")
        .slice(0, outputLimit)
        .map((task) => task.id),
      blockerCodes: ["assessment_incomplete"],
      blockerCount: 1,
      allTasksIntegrated: false,
      canFinalize: false,
    };
  }
  const readiness = inspectFleetMergeReadiness(db, run.id);
  if (!readiness) {
    return {
      assessmentComplete: false,
      requested: false,
      target: null,
      integrationState: "unknown",
      readyTaskIds: [],
      waitingTaskIds: [],
      mergedTaskIds: [],
      blockerCodes: ["assessment_unavailable"],
      blockerCount: 1,
      allTasksIntegrated: false,
      canFinalize: false,
    };
  }
  const blockerCodes = [...new Set(readiness.blockers.map(mergeBlockerCode))]
    .sort()
    .slice(0, 16);
  return {
    assessmentComplete: true,
    requested: readiness.requested,
    target: readiness.target,
    integrationState: safeEnum(readiness.integrationState, INTEGRATION_STATES),
    readyTaskIds: readiness.readyTaskIds
      .map((id) => safeId(id) ?? "opaque-missing-task")
      .sort()
      .slice(0, outputLimit),
    waitingTaskIds: readiness.waitingTaskIds
      .map((id) => safeId(id) ?? "opaque-missing-task")
      .sort()
      .slice(0, outputLimit),
    mergedTaskIds: readiness.mergedTaskIds
      .map((id) => safeId(id) ?? "opaque-missing-task")
      .sort()
      .slice(0, outputLimit),
    blockerCodes,
    blockerCount: safeInteger(readiness.blockers.length),
    allTasksIntegrated: readiness.allTasksIntegrated,
    canFinalize: readiness.canFinalize,
  };
}

function attentionItems(
  run: FleetSupervisorRunSummary,
  tasks: FleetSupervisorTaskSummary[],
  workers: FleetSupervisorWorkerSummary[],
  merge: FleetSupervisorMergeSummary,
  gates: FleetSupervisorGateSummary,
  taskTruncated: boolean,
  workerTruncated: boolean,
  contractTruncated: boolean
): FleetSupervisorAttentionItem[] {
  const items: FleetSupervisorAttentionItem[] = [];
  const push = (
    rank: number,
    severity: FleetSupervisorAttentionItem["severity"],
    code: string,
    taskId: string | null = null,
    workerId: string | null = null
  ) => items.push({ rank, severity, code, taskId, workerId });

  if (run.recoveryRequired) push(0, "critical", "run_recovery_required");
  if (contractTruncated) {
    push(1, "critical", "execution_contract_exceeds_safety_bounds");
  }
  if (taskTruncated) {
    push(
      2,
      gates.tasks.awaitingOperator > 0 ||
        gates.tasks.failed > 0 ||
        gates.tasks.verificationFailed > 0 ||
        gates.tasks.reviewChangesRequested > 0
        ? "critical"
        : "info",
      "task_summary_truncated"
    );
  }
  if (workerTruncated) {
    push(
      3,
      gates.workers.failed > 0 || gates.workers.waitingForOperator > 0
        ? "warning"
        : "info",
      "worker_summary_truncated"
    );
  }
  if (run.approvalState === "needs_approval") {
    push(10, "warning", "plan_approval_required");
  } else if (run.approvalState === "blocked") {
    push(11, "critical", "plan_approval_blocked");
  }
  if (run.integrationState === "failed") {
    push(12, "critical", "integration_failed");
  }

  for (const task of tasks) {
    if (task.status === "needs_inspection") {
      push(20, "critical", "task_needs_inspection", task.id);
    } else if (task.status === "failed") {
      push(
        task.failureCategory === "provider" &&
          task.currentAttempt < task.maxAttempts
          ? 30
          : 21,
        task.failureCategory === "provider" &&
          task.currentAttempt < task.maxAttempts
          ? "warning"
          : "critical",
        task.failureCategory === "provider" &&
          task.currentAttempt < task.maxAttempts
          ? "task_retry_candidate"
          : "task_failed",
        task.id
      );
    } else if (task.status === "waiting_for_operator") {
      push(25, "warning", "task_waiting_for_operator", task.id);
    } else if (task.status === "needs_followup") {
      push(26, "warning", "task_needs_followup", task.id);
    } else if (task.status === "blocked") {
      push(27, "warning", "task_blocked", task.id);
    }
    if (
      task.verificationStatus === "fail" ||
      task.verificationStatus === "error"
    ) {
      push(22, "critical", "task_verification_failed", task.id);
    }
    if (task.reviewStatus === "changes_requested") {
      push(23, "critical", "task_review_changes_requested", task.id);
    }
    if (task.integrationState === "failed") {
      push(24, "critical", "task_integration_failed", task.id);
    }
    if (task.providerState === "backoff") {
      push(40, "info", "task_provider_backoff", task.id);
    }
  }

  for (const worker of workers) {
    if (worker.status === "waiting_for_operator") {
      push(
        35,
        "warning",
        "worker_waiting_for_operator",
        worker.taskId,
        worker.id
      );
    } else if (worker.status === "failed" || worker.status === "dead") {
      push(36, "warning", "worker_failed", worker.taskId, worker.id);
    }
  }

  if (merge.requested) {
    for (const code of merge.blockerCodes) {
      push(60, "warning", `merge_${code}`);
    }
  }
  if (run.status === "paused") push(90, "info", "run_paused");
  return items.sort(compareFleetSupervisorAttention);
}

function rowsWithHardCaps(db: Database.Database, runId: string) {
  const tasks = db
    .prepare(
      `SELECT * FROM fleet_tasks WHERE fleet_run_id = ?
       ORDER BY sort_order ASC, created_at ASC, id ASC LIMIT ?`
    )
    .all(runId, EXECUTION_TASK_CAP + 1) as FleetTaskRow[];
  const claims = db
    .prepare(
      `SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?
       ORDER BY task_id ASC, path ASC, id ASC LIMIT ?`
    )
    .all(runId, EXECUTION_CLAIM_CAP + 1) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(
      `SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?
       ORDER BY task_id ASC, depends_on_task_id ASC, dependency_type ASC, id ASC
       LIMIT ?`
    )
    .all(runId, EXECUTION_DEPENDENCY_CAP + 1) as FleetTaskDependencyRow[];
  const complete =
    tasks.length <= EXECUTION_TASK_CAP &&
    claims.length <= EXECUTION_CLAIM_CAP &&
    dependencies.length <= EXECUTION_DEPENDENCY_CAP;
  return { tasks, claims, dependencies, complete };
}

/**
 * Builds a bounded snapshot exclusively from durable SQLite state. User-authored
 * prose, paths, models, commands, errors, and artifact bodies are deliberately
 * excluded so this read model is safe to expose to observer transports.
 */
function buildFleetSupervisorSnapshot(
  runId: string,
  db: Database.Database,
  limitOverrides: FleetSupervisorLimits = {}
): FleetSupervisorSnapshot | null {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return null;
  const limits = resolveLimits(limitOverrides);
  const contract = rowsWithHardCaps(db, runId);
  const contractTasks = contract.tasks.slice(0, EXECUTION_TASK_CAP);
  const executionHash = contract.complete
    ? hashFleetExecutionContract({
        run,
        tasks: contractTasks,
        claims: contract.claims,
        dependencies: contract.dependencies,
      })
    : null;
  const bindings = currentBindings(run, executionHash, contract.complete);
  const gates = gateSummary(db, runId, bindings);
  const tasks = contractTasks.slice(0, limits.tasks).map(taskSummary);
  const workerRows = db
    .prepare(
      `SELECT * FROM fleet_workers WHERE fleet_run_id = ?
       ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .all(runId, limits.workers + 1) as FleetWorkerRow[];
  const workers = workerRows.slice(0, limits.workers).map(workerSummary);
  const merge = mergeSummary(db, run, tasks, contract.complete, limits.tasks);
  const taskTruncated = gates.tasks.total > limits.tasks;
  const workerTruncated = gates.workers.total > limits.workers;
  const allAttention = attentionItems(
    runSummary(run),
    tasks,
    workers,
    merge,
    gates,
    taskTruncated,
    workerTruncated,
    !contract.complete
  );
  const state: FleetSupervisorSnapshotState = {
    version: FLEET_SUPERVISOR_SNAPSHOT_VERSION,
    rulesVersion: FLEET_SUPERVISOR_RULES_VERSION,
    advisoryOnly: true,
    run: runSummary(run),
    bindings,
    gates,
    merge,
    tasks,
    workers,
    attention: allAttention.slice(0, limits.attention),
    truncation: {
      tasks: taskTruncated,
      workers: workerTruncated,
      attention: allAttention.length > limits.attention,
      recommendations: false,
      executionContract: !contract.complete,
    },
  };
  const allRecommendations = recommendFleetSupervisorActions(state);
  state.truncation.recommendations =
    allRecommendations.length > limits.recommendations;
  const recommendations = allRecommendations.slice(0, limits.recommendations);
  const snapshotHash = stableHash({ state, recommendations });
  return { ...state, recommendations, snapshotHash };
}

export function getFleetSupervisorSnapshot(
  runId: string,
  db: Database.Database = getDb(),
  limitOverrides: FleetSupervisorLimits = {}
): FleetSupervisorSnapshot | null {
  if (db.inTransaction) {
    return buildFleetSupervisorSnapshot(runId, db, limitOverrides);
  }
  db.exec("BEGIN");
  try {
    const snapshot = buildFleetSupervisorSnapshot(runId, db, limitOverrides);
    db.exec("COMMIT");
    return snapshot;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedText(
  value: unknown,
  maxLength: number,
  label: string
): { value: string } | { error: string } {
  if (typeof value !== "string") return { error: `${label} must be a string` };
  const text = value.trim();
  if (!text || text.length > maxLength || /\0/.test(text)) {
    return { error: `${label} must contain 1-${maxLength} safe characters` };
  }
  return { value: text };
}

function parseExternalAction(
  value: unknown,
  index: number
): { action: FleetExternalSupervisorAction } | { error: string } {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["kind", "taskId", "taskIds", "rationale"])
  ) {
    return { error: `actions[${index}] has unsupported fields` };
  }
  if (
    value.kind !== "approval" &&
    value.kind !== "retry" &&
    value.kind !== "inspect" &&
    value.kind !== "pause" &&
    value.kind !== "merge_readiness" &&
    value.kind !== "replan" &&
    value.kind !== "grouping" &&
    value.kind !== "merge_order"
  ) {
    return { error: `actions[${index}].kind is unsupported` };
  }
  const taskId = value.taskId == null ? null : value.taskId;
  if (
    taskId != null &&
    (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 128)
  ) {
    return { error: `actions[${index}].taskId is invalid` };
  }
  let taskIds: string[] | undefined;
  if (value.taskIds != null) {
    if (
      !Array.isArray(value.taskIds) ||
      value.taskIds.length === 0 ||
      value.taskIds.length > 16 ||
      value.taskIds.some(
        (taskId) =>
          typeof taskId !== "string" ||
          taskId.length === 0 ||
          taskId.length > 128 ||
          /\0/.test(taskId)
      )
    ) {
      return { error: `actions[${index}].taskIds is invalid` };
    }
    taskIds = value.taskIds as string[];
    if (new Set(taskIds).size !== taskIds.length) {
      return { error: `actions[${index}].taskIds contains duplicates` };
    }
  }
  if (taskId != null && taskIds != null) {
    return { error: `actions[${index}] cannot mix taskId and taskIds` };
  }
  if (value.kind === "retry" && taskId == null) {
    return { error: `actions[${index}].taskId is required for retry` };
  }
  if (
    (value.kind === "approval" ||
      value.kind === "pause" ||
      value.kind === "merge_readiness") &&
    (taskId != null || taskIds != null)
  ) {
    return { error: `actions[${index}].taskId is not allowed for this kind` };
  }
  if (
    (value.kind === "grouping" || value.kind === "merge_order") &&
    (!taskIds || taskIds.length < 2)
  ) {
    return {
      error: `actions[${index}].taskIds must contain at least two tasks for ${value.kind}`,
    };
  }
  if (
    value.kind !== "grouping" &&
    value.kind !== "merge_order" &&
    value.kind !== "replan" &&
    taskIds != null
  ) {
    return { error: `actions[${index}].taskIds is not allowed for this kind` };
  }
  const rationale = boundedText(
    value.rationale,
    512,
    `actions[${index}].rationale`
  );
  if ("error" in rationale) return rationale;
  return {
    action: {
      kind: value.kind,
      taskId: taskId as string | null,
      ...(taskIds ? { taskIds } : {}),
      rationale: rationale.value,
    },
  };
}

export function parseFleetSupervisorRecommendationInput(
  value: unknown
):
  | { input: AppendFleetSupervisorRecommendationInput }
  | { error: string; status: number } {
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, [
      "expectedSnapshotHash",
      "expectedPlanHash",
      "expectedPolicyHash",
      "expectedExecutionHash",
      "expectedBaseSha",
      "source",
      "summary",
      "actions",
    ])
  ) {
    return { error: "recommendation body has unsupported fields", status: 400 };
  }
  const expectedSnapshotHash = digest(value.expectedSnapshotHash);
  const expectedExecutionHash = digest(value.expectedExecutionHash);
  if (!expectedSnapshotHash || !expectedExecutionHash) {
    return {
      error: "snapshot and execution hashes must be SHA-256 values",
      status: 400,
    };
  }
  const expectedPlanHash =
    value.expectedPlanHash == null ? null : digest(value.expectedPlanHash);
  const expectedPolicyHash =
    value.expectedPolicyHash == null ? null : digest(value.expectedPolicyHash);
  const expectedBaseSha =
    value.expectedBaseSha == null ? null : gitSha(value.expectedBaseSha);
  if (
    (value.expectedPlanHash != null && !expectedPlanHash) ||
    (value.expectedPolicyHash != null && !expectedPolicyHash) ||
    (value.expectedBaseSha != null && !expectedBaseSha)
  ) {
    return { error: "plan, policy, or base hash is invalid", status: 400 };
  }
  if (value.source !== "external_ai" && value.source !== "conductor") {
    return { error: "source must be external_ai or conductor", status: 400 };
  }
  const summary = boundedText(value.summary, 1024, "summary");
  if ("error" in summary) return { ...summary, status: 400 };
  if (!Array.isArray(value.actions) || value.actions.length > 16) {
    return {
      error: "actions must be an array with at most 16 entries",
      status: 400,
    };
  }
  const actions: FleetExternalSupervisorAction[] = [];
  for (const [index, actionValue] of value.actions.entries()) {
    const parsed = parseExternalAction(actionValue, index);
    if ("error" in parsed) return { ...parsed, status: 400 };
    actions.push(parsed.action);
  }
  return {
    input: {
      expectedSnapshotHash,
      expectedPlanHash,
      expectedPolicyHash,
      expectedExecutionHash,
      expectedBaseSha,
      source: value.source,
      summary: summary.value,
      actions,
    },
  };
}

function bindingMismatch(
  input: AppendFleetSupervisorRecommendationInput,
  snapshot: FleetSupervisorSnapshot
): boolean {
  return (
    input.expectedSnapshotHash !== snapshot.snapshotHash ||
    input.expectedPlanHash !== snapshot.bindings.planHash ||
    input.expectedPolicyHash !== snapshot.bindings.policyHash ||
    input.expectedExecutionHash !== snapshot.bindings.executionHash ||
    input.expectedBaseSha !== snapshot.bindings.baseSha
  );
}

export interface FleetSupervisorWriteDeps {
  db?: Database.Database;
  now?: () => Date;
  id?: () => string;
}

export type AppendFleetSupervisorRecommendationResult =
  | {
      artifactId: string;
      contentHash: string;
      snapshotHash: string;
      advisoryOnly: true;
    }
  | { error: string; status: number };

/**
 * Appends advisory material only. The transaction deliberately contains no
 * lifecycle, scheduler, merge, capability, authorization, budget, or worker
 * mutation path.
 */
export function appendFleetSupervisorRecommendation(
  runId: string,
  rawInput: unknown,
  overrides: FleetSupervisorWriteDeps = {}
): AppendFleetSupervisorRecommendationResult {
  const parsed = parseFleetSupervisorRecommendationInput(rawInput);
  if ("error" in parsed) return parsed;
  const db = overrides.db ?? getDb();
  const now = overrides.now ?? (() => new Date());
  const id = overrides.id ?? randomUUID;
  db.exec("BEGIN IMMEDIATE");
  try {
    const snapshot = getFleetSupervisorSnapshot(runId, db);
    if (!snapshot) {
      db.exec("ROLLBACK");
      return { error: "Fleet run not found", status: 404 };
    }
    if (
      !snapshot.bindings.contractComplete ||
      !snapshot.bindings.executionHash
    ) {
      db.exec("ROLLBACK");
      return {
        error: "Fleet execution contract exceeds supervisor safety bounds",
        status: 409,
      };
    }
    if (bindingMismatch(parsed.input, snapshot)) {
      db.exec("ROLLBACK");
      return {
        error: "Fleet supervisor snapshot or execution binding is stale",
        status: 409,
      };
    }
    const actionTaskIds = [
      ...new Set(
        parsed.input.actions.flatMap((action) => [
          ...(action.taskId == null ? [] : [action.taskId]),
          ...(action.taskIds ?? []),
        ])
      ),
    ];
    for (const taskId of actionTaskIds) {
      const exists = db
        .prepare(
          `SELECT 1 FROM fleet_tasks WHERE fleet_run_id = ? AND id = ? LIMIT 1`
        )
        .get(runId, taskId);
      if (!exists) {
        db.exec("ROLLBACK");
        return {
          error: "recommendation references an unknown task",
          status: 400,
        };
      }
    }
    const existingCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM fleet_artifacts
         WHERE fleet_run_id = ? AND artifact_type = 'fleet_supervisor_recommendation'`
      )
      .get(runId) as { count: number };
    if (existingCount.count >= EXTERNAL_RECOMMENDATION_CAP) {
      db.exec("ROLLBACK");
      return {
        error: "Fleet supervisor recommendation history limit reached",
        status: 409,
      };
    }

    const preparedBody = prepareFleetArtifactBody(
      JSON.stringify({
        version: 1,
        advisoryOnly: true,
        source: parsed.input.source,
        summary: parsed.input.summary,
        actions: parsed.input.actions,
      })
    );
    const body = preparedBody.body;
    const bodyBytes = preparedBody.byteCount;
    if (bodyBytes > FLEET_SUPERVISOR_JSON_BODY_MAX) {
      db.exec("ROLLBACK");
      return {
        error: "Fleet supervisor recommendation is too large",
        status: 413,
      };
    }
    const contentHash = preparedBody.contentHash;
    const metadata = JSON.stringify({
      version: 1,
      immutable: true,
      advisoryOnly: true,
      source: parsed.input.source,
      snapshotHash: snapshot.snapshotHash,
      rulesVersion: snapshot.rulesVersion,
      bindings: {
        planHash: snapshot.bindings.planHash,
        policyHash: snapshot.bindings.policyHash,
        executionHash: snapshot.bindings.executionHash,
        baseSha: snapshot.bindings.baseSha,
      },
    });
    const artifactId = id();
    const createdAt = now().toISOString();
    const actor = `fleet-supervisor:${parsed.input.source}`;
    insertFleetArtifact(db, {
      id: artifactId,
      runId,
      planHash: snapshot.bindings.planHash,
      baseSha: snapshot.bindings.baseSha,
      contentHash,
      metadataJson: metadata,
      byteCount: bodyBytes,
      artifactType: "fleet_supervisor_recommendation",
      title: "External Fleet supervisor recommendation",
      body,
      severity: "info",
      actor,
      createdAt,
    });
    insertFleetEvent(db, {
      runId,
      eventType: "supervisor_recommendation_appended",
      actor,
      payload: JSON.stringify({
        artifactId,
        contentHash,
        snapshotHash: snapshot.snapshotHash,
        source: parsed.input.source,
        advisoryOnly: true,
        bindings: {
          planHash: snapshot.bindings.planHash,
          policyHash: snapshot.bindings.policyHash,
          executionHash: snapshot.bindings.executionHash,
          baseSha: snapshot.bindings.baseSha,
        },
      }),
      createdAt,
    });
    db.exec("COMMIT");
    return {
      artifactId,
      contentHash,
      snapshotHash: snapshot.snapshotHash,
      advisoryOnly: true,
    };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
