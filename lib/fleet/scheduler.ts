import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { backendKeyForSession } from "@/lib/providers/registry";
import { computeSessionCosts } from "@/lib/session-cost";
import { persistCostSamples } from "@/lib/cost-history";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import {
  availableFleetSlots,
  FLEET_MAX_TOTAL_WORKERS,
  providerConcurrencyCap,
} from "./admission";
import {
  estimateFleetTaskReservation,
  evaluateFleetBudget,
  type FleetBudgetDecision,
  type FleetTaskReservation,
} from "./budgets";
import {
  fleetReservationHistory,
  finalizeFleetWorkerCost,
  reconcileFleetCostAccount,
  registerFleetCostAccount,
  settleFleetCostOwner,
  type FleetCostOwnerType,
} from "./cost-runtime";
import { fleetClaimsConflict } from "./conflicts";
import {
  FleetSpawnError,
  spawnFleetWorker,
  type FleetSpawnResult,
} from "./spawn";
import { executeFleetWorker } from "./executor";
import { fleetProviderRetryNotBefore } from "./backoff";
import { hashFleetExecutionContract, hashFleetTaskRows } from "./hash";
import { stopFleetSession } from "./stop";
import { parseFleetAutomationPolicy } from "./automation-policy";
import { insertFleetArtifact } from "./durable-write";
import {
  acquireFleetRuntimeResources,
  clearFleetProviderCooldown,
  fleetResourceLimitsForRun,
  fleetWorkerResourceRequest,
  looksLikeProviderRateLimit,
  recordFleetProviderCooldown,
  releaseFleetRuntimeResources,
} from "./resource-runtime";
import type { FleetResourceKind } from "./resource-admission";
import { reconcileFleetRenderedStatuses } from "./status-runtime";
import {
  FLEET_INTERRUPT_DEFAULT_GRACE_MS,
  FLEET_INTERRUPT_MAX_WORKERS,
  decideFleetInterruptAction,
} from "./interrupt-policy";
import {
  boundedFleetArtifactJson,
  collectFleetWorkerReport,
  nextFleetReportPollAt,
  prepareFleetWorkerAttempt,
  type FleetWorkerAttemptContract,
  type FleetWorkerReportCollectionResult,
} from "./report-runtime";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "./types";
import {
  fleetRecoveryUnavailable,
  isFleetSchedulerReady,
  setFleetSchedulerReady,
} from "./recovery-gate";

export { isFleetSchedulerReady } from "./recovery-gate";

const ACTIVE_WORKER_STATUSES = [
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "cleanup_pending",
] as const;
const TERMINAL_TASK_STATUSES = ["completed", "merged", "skipped"];
const ACTIVE_RUN_PHASE_STATUSES = ["running", "reviewing", "merging"];
const TERMINAL_RUN_STATUSES = ["completed", "failed", "canceled"];
const AUXILIARY_COST_OWNER_TYPES = new Set<FleetCostOwnerType>([
  "planner",
  "plan_review",
  "task_review",
  "fixer",
]);
const LEASE_MS = 2 * 60 * 1000;
const FLEET_COST_SAMPLE_INTERVAL_MS = 30_000;
const FLEET_COST_SAMPLE_MAX_PER_TICK = 8;
const runLocks = new Set<string>();
const launchingWorkers = new Set<string>();
const fleetCostSampleAt = new WeakMap<object, number>();
export interface FleetSchedulerDeps {
  db: Database.Database;
  now: () => Date;
  spawn: typeof spawnFleetWorker;
  sessionExists: (session: Session) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<void>;
  sendMessage: (sessionId: string, message: string) => Promise<void>;
  sampleCosts: (sessions: Session[], nowMs: number) => Promise<number>;
  prepareAttempt: typeof prepareFleetWorkerAttempt;
  collectReport: typeof collectFleetWorkerReport;
}

/** Resolve the same cross-platform backend key used by status, send, and stop. */
export async function fleetSessionBackendExists(
  session: Session,
  backend: Pick<
    ReturnType<typeof getSessionBackend>,
    "exists"
  > = getSessionBackend()
): Promise<boolean> {
  return backend.exists(backendKeyForSession(session));
}

function schedulerDeps(
  overrides: Partial<FleetSchedulerDeps>
): FleetSchedulerDeps {
  const db = overrides.db ?? getDb();
  return {
    db,
    now: overrides.now ?? (() => new Date()),
    spawn: overrides.spawn ?? executeFleetWorker,
    sessionExists:
      overrides.sessionExists ??
      ((session) => fleetSessionBackendExists(session)),
    stopSession:
      overrides.stopSession ??
      (async (sessionId, finalStatus = "failed") => {
        if (!(await stopFleetSession(sessionId, finalStatus))) {
          throw new Error("worker session remained alive after stop");
        }
      }),
    sendMessage:
      overrides.sendMessage ??
      (async (sessionId, message) => {
        const session = queries.getSession(db).get(sessionId) as
          Session | undefined;
        if (!session) throw new Error("worker session was not found");
        const backend = getSessionBackend();
        const backendKey = backendKeyForSession(session);
        await backend.sendKeysLiteral(backendKey, message);
        await backend.sendEnter(backendKey);
      }),
    sampleCosts:
      overrides.sampleCosts ??
      (async (sessions, nowMs) => {
        const costs = await computeSessionCosts(sessions);
        return persistCostSamples(db, sessions, costs, nowMs);
      }),
    prepareAttempt: overrides.prepareAttempt ?? prepareFleetWorkerAttempt,
    collectReport: overrides.collectReport ?? collectFleetWorkerReport,
  };
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function activePlaceholders(): string {
  return ACTIVE_WORKER_STATUSES.map(() => "?").join(", ");
}

function runAllowsFleetExecution(run: FleetRunRow): boolean {
  return (
    ACTIVE_RUN_PHASE_STATUSES.includes(run.status) &&
    run.desired_state === "running"
  );
}

function isAuxiliaryCostOwnerType(
  value: string
): value is Exclude<FleetCostOwnerType, "worker"> {
  return (
    value !== "worker" &&
    AUXILIARY_COST_OWNER_TYPES.has(value as FleetCostOwnerType)
  );
}

function activePlannerCount(db: Database.Database, provider?: string): number {
  const providerClause = provider
    ? ` AND json_extract(settings_json, '$.planner.provider') = ?`
    : "";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fleet_runs
       WHERE status = 'draft' AND json_valid(settings_json)
         AND json_extract(settings_json, '$.planner.state') IN
           ('starting', 'running', 'finalizing', 'cleanup_pending')${providerClause}`
    )
    .get(...(provider ? [provider] : [])) as { n: number };
  return row.n;
}

function reserveWorkerResources(
  db: Database.Database,
  input: {
    runId: string;
    workerId: string;
    provider: string;
    worktreeKey: string;
    nowIso: string;
  }
): void {
  const insert = db.prepare(`INSERT INTO fleet_resource_leases
    (id, fleet_run_id, worker_id, resource_type, resource_key, units, status, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 'reserved', ?)`);
  for (const [type, key] of [
    ["pty", "local"],
    ["provider", input.provider],
    ["git_operation", "local"],
    ["worktree", input.worktreeKey],
  ]) {
    insert.run(
      randomUUID(),
      input.runId,
      input.workerId,
      type,
      key,
      input.nowIso
    );
  }
}

function releaseWorkerResources(
  db: Database.Database,
  workerId: string,
  nowIso: string,
  resourceType?: string
): void {
  db.prepare(
    `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
    WHERE worker_id = ? AND status = 'reserved'
      AND (? IS NULL OR resource_type = ?)`
  ).run(nowIso, workerId, resourceType ?? null, resourceType ?? null);
  const runtimeType: FleetResourceKind | undefined =
    resourceType === "worktree"
      ? "repo_worktree"
      : resourceType === "pty" ||
          resourceType === "transport_host" ||
          resourceType === "provider" ||
          resourceType === "verifier" ||
          resourceType === "git_operation" ||
          resourceType === "merge_operation" ||
          resourceType === "repo_worktree" ||
          resourceType === "disk_bytes" ||
          resourceType === "output_bytes_per_minute" ||
          resourceType === "artifact_bytes_per_minute" ||
          resourceType === "event_bytes_per_minute" ||
          resourceType === "event_fanout_per_minute"
        ? resourceType
        : undefined;
  releaseFleetRuntimeResources(db, {
    ownerType: "worker",
    ownerId: workerId,
    now: new Date(nowIso),
    resourceTypes: runtimeType ? [runtimeType] : undefined,
  });
}

function releaseWorkerResourcesExceptWorktree(
  db: Database.Database,
  workerId: string,
  nowIso: string
): void {
  db.prepare(
    `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
     WHERE worker_id = ? AND status = 'reserved' AND resource_type <> 'worktree'`
  ).run(nowIso, workerId);
  releaseFleetRuntimeResources(db, {
    ownerType: "worker",
    ownerId: workerId,
    now: new Date(nowIso),
    preserveResourceTypes: ["repo_worktree", "disk_bytes"],
  });
}

function settleWorkerBudget(
  db: Database.Database,
  workerId: string,
  now: Date,
  chargeFallback: boolean
): void {
  const worker = db
    .prepare(`SELECT * FROM fleet_workers WHERE id = ?`)
    .get(workerId) as FleetWorkerRow | undefined;
  if (!worker || worker.cost_reconciled_at) return;
  finalizeFleetWorkerCost(db, worker, now, chargeFallback);
}

function fleetBudgetDecision(
  run: FleetRunRow,
  reservation?: FleetTaskReservation
): FleetBudgetDecision {
  return evaluateFleetBudget({
    config: {
      budgetUsd: run.budget_usd,
      budgetTokens: run.budget_tokens ?? null,
      warningThreshold: run.budget_warning_threshold ?? 0.8,
      stopMode: run.budget_stop_mode ?? "pause-new",
    },
    ledger: {
      spentUsd: run.spent_budget_usd ?? 0,
      reservedUsd: run.reserved_budget_usd ?? 0,
      spentTokens: run.spent_budget_tokens ?? 0,
      reservedTokens: run.reserved_budget_tokens ?? 0,
    },
    reservation,
  });
}

function recordFleetBudgetWarning(
  db: Database.Database,
  run: FleetRunRow,
  decision: FleetBudgetDecision,
  reservation: FleetTaskReservation | undefined,
  nowIso: string
): void {
  if (!decision.warning || run.budget_warning_emitted_at) return;
  const changed = db
    .prepare(
      `UPDATE fleet_runs SET budget_warning_emitted_at = ?, updated_at = ?
       WHERE id = ? AND budget_warning_emitted_at IS NULL`
    )
    .run(nowIso, nowIso, run.id);
  if (changed.changes !== 1) return;
  queries.createFleetEvent(db).run(
    run.id,
    "budget_warning_threshold_reached",
    "scheduler",
    JSON.stringify({
      reason: decision.reason,
      projectedUsd: decision.projectedUsd,
      projectedTokens: decision.projectedTokens,
      confidence: reservation?.confidence ?? run.cost_confidence ?? "unknown",
      threshold: run.budget_warning_threshold ?? 0.8,
    })
  );
}

function pauseFleetForBudget(
  db: Database.Database,
  run: FleetRunRow,
  decision: FleetBudgetDecision,
  reservation: FleetTaskReservation | undefined,
  now: Date
): void {
  const nowIso = now.toISOString();
  const pauseReason =
    decision.reason === "low-confidence"
      ? "budget_telemetry_low_confidence"
      : decision.stopAction === "ask-operator"
        ? "budget_operator_decision_required"
        : "budget_exhausted";
  const interrupt = decision.stopAction === "interrupt-active";
  const deadline = interrupt
    ? new Date(now.getTime() + FLEET_INTERRUPT_DEFAULT_GRACE_MS).toISOString()
    : null;
  const changed = db
    .prepare(
      `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused',
       pause_mode = ?, pause_reason = ?, budget_hard_limit_at = CASE WHEN ? THEN COALESCE(budget_hard_limit_at, ?) ELSE budget_hard_limit_at END,
       budget_interrupt_deadline_at = CASE WHEN ? THEN COALESCE(budget_interrupt_deadline_at, ?) ELSE budget_interrupt_deadline_at END,
       updated_at = ? WHERE id = ?
         AND status NOT IN ('completed', 'failed', 'canceled')
         AND (status <> 'paused' OR (? = 1 AND budget_interrupt_deadline_at IS NULL))`
    )
    .run(
      interrupt ? "pause-and-interrupt" : "pause-new",
      pauseReason,
      decision.hardLimitReached ? 1 : 0,
      nowIso,
      interrupt ? 1 : 0,
      deadline,
      nowIso,
      run.id,
      interrupt ? 1 : 0
    );
  if (changed.changes !== 1) return;
  let auxiliaryInterrupts = 0;
  if (interrupt && deadline) {
    db.prepare(
      `UPDATE fleet_workers SET interrupt_requested_at = COALESCE(interrupt_requested_at, ?),
       interrupt_deadline_at = COALESCE(interrupt_deadline_at, ?),
       interrupt_notice_state = CASE WHEN interrupt_requested_at IS NULL
         THEN 'unattempted' ELSE interrupt_notice_state END,
       interrupt_stop_state = CASE WHEN interrupt_requested_at IS NULL
         THEN 'unattempted' ELSE interrupt_stop_state END,
       interrupt_cause = COALESCE(interrupt_cause, 'budget_hard_limit')
       WHERE fleet_run_id = ? AND status IN ('running', 'waiting_for_operator')`
    ).run(nowIso, deadline, run.id);
    auxiliaryInterrupts = db
      .prepare(
        `UPDATE fleet_cost_accounts
         SET interrupt_requested_at = COALESCE(interrupt_requested_at, ?),
             interrupt_deadline_at = COALESCE(interrupt_deadline_at, ?),
             interrupt_notice_state = CASE WHEN interrupt_requested_at IS NULL
               THEN 'unattempted' ELSE interrupt_notice_state END,
             interrupt_stop_state = CASE WHEN interrupt_requested_at IS NULL
               THEN 'unattempted' ELSE interrupt_stop_state END,
             interrupt_cause = COALESCE(interrupt_cause, 'budget_hard_limit'),
             updated_at = ?
         WHERE fleet_run_id = ? AND owner_type <> 'worker'
           AND session_id IS NOT NULL AND terminal_at IS NULL
           AND reservation_released_at IS NULL`
      )
      .run(nowIso, deadline, nowIso, run.id).changes;
  }
  queries.createFleetEvent(db).run(
    run.id,
    decision.reason === "low-confidence"
      ? "budget_confidence_blocked"
      : decision.stopAction === "ask-operator"
        ? "budget_operator_action_required"
        : interrupt
          ? "budget_hard_limit_interrupt_scheduled"
          : "budget_reservation_blocked",
    "scheduler",
    JSON.stringify({
      reason: decision.reason,
      projectedUsd: decision.projectedUsd,
      projectedTokens: decision.projectedTokens,
      reservationUsd: reservation?.usd ?? null,
      reservationTokens: reservation?.tokens ?? null,
      reservationConfidence: reservation?.confidence ?? null,
      reservationBasis: reservation?.basis ?? null,
      interruptDeadlineAt: deadline,
      auxiliaryInterrupts,
    })
  );
}

function taskClaims(
  db: Database.Database,
  runId: string,
  taskId: string
): string[] {
  return (
    db
      .prepare(
        `SELECT path FROM fleet_task_claims WHERE fleet_run_id = ? AND task_id = ?`
      )
      .all(runId, taskId) as { path: string }[]
  ).map((row) => row.path);
}

function approvedExecutionHash(run: FleetRunRow): string | null {
  try {
    const settings = JSON.parse(run.settings_json) as {
      approvedExecutionHash?: unknown;
    };
    return typeof settings.approvedExecutionHash === "string"
      ? settings.approvedExecutionHash
      : null;
  } catch {
    return null;
  }
}

function taskDependencies(
  db: Database.Database,
  runId: string,
  taskId: string
): FleetTaskDependencyRow[] {
  return db
    .prepare(
      `SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ? AND task_id = ?`
    )
    .all(runId, taskId) as FleetTaskDependencyRow[];
}

function dependencySummaries(
  db: Database.Database,
  dependencies: FleetTaskDependencyRow[]
): string[] {
  const getTask = db.prepare(
    `SELECT title, status FROM fleet_tasks WHERE id = ?`
  );
  return dependencies.map((dependency) => {
    const task = getTask.get(dependency.depends_on_task_id) as
      { title: string; status: string } | undefined;
    return task
      ? `${dependency.depends_on_task_id}: ${task.title} (${task.status})`
      : dependency.depends_on_task_id;
  });
}

function dependenciesSatisfied(
  db: Database.Database,
  dependencies: FleetTaskDependencyRow[]
): boolean {
  if (dependencies.length === 0) return true;
  const getStatus = db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`);
  return dependencies.every((dependency) => {
    if (dependency.dependency_type !== "blocks") return true;
    const upstream = getStatus.get(dependency.depends_on_task_id) as
      { status: string } | undefined;
    return !!upstream && TERMINAL_TASK_STATUSES.includes(upstream.status);
  });
}

function failedBlockingDependency(
  db: Database.Database,
  dependencies: FleetTaskDependencyRow[]
): { id: string; status: string } | null {
  const getStatus = db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`);
  for (const dependency of dependencies) {
    if (dependency.dependency_type !== "blocks") continue;
    const upstream = getStatus.get(dependency.depends_on_task_id) as
      { status: string } | undefined;
    if (
      !upstream ||
      ["failed", "canceled", "blocked"].includes(upstream.status)
    ) {
      return {
        id: dependency.depends_on_task_id,
        status: upstream?.status ?? "missing",
      };
    }
  }
  return null;
}

function conflictsWithActiveTask(
  db: Database.Database,
  runId: string,
  candidateClaims: string[]
): boolean {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.id
       FROM fleet_tasks t
       JOIN fleet_workers w ON w.task_id = t.id AND w.fleet_run_id = t.fleet_run_id
       WHERE t.fleet_run_id = ? AND w.status IN (${activePlaceholders()})`
    )
    .all(runId, ...ACTIVE_WORKER_STATUSES) as { id: string }[];
  return rows.some((row) =>
    fleetClaimsConflict(candidateClaims, taskClaims(db, runId, row.id))
  );
}

function resolveWorkingDirectory(
  db: Database.Database,
  run: FleetRunRow,
  task: FleetTaskRow
): string | null {
  if (task.working_directory) return task.working_directory;
  if (run.repo_id) {
    const repo = queries.getDispatchRepo(db).get(run.repo_id) as
      DispatchRepo | undefined;
    if (repo?.repo_path) return repo.repo_path;
  }
  if (run.project_id) {
    const project = queries.getProject(db).get(run.project_id) as
      Project | undefined;
    if (project?.working_directory) return project.working_directory;
  }
  return null;
}

function resolveBaseBranch(
  db: Database.Database,
  run: FleetRunRow,
  task: FleetTaskRow
): string {
  if (task.base_branch) return task.base_branch;
  if (run.repo_id) {
    const repo = queries.getDispatchRepo(db).get(run.repo_id) as
      DispatchRepo | undefined;
    if (repo?.base_branch) return repo.base_branch;
  }
  return "main";
}

interface LeasedTask {
  run: FleetRunRow;
  task: FleetTaskRow;
  workerId: string;
  spawnRequestId: string;
  attempt: number;
  claims: string[];
  dependencies: string[];
  workingDirectory: string;
}

function leaseOne(deps: FleetSchedulerDeps, runId: string): LeasedTask | null {
  const { db, now } = deps;
  return transaction(db, () => {
    const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
    if (
      !run ||
      !runAllowsFleetExecution(run) ||
      run.approval_state !== "approved"
    )
      return null;
    if (run.recovery_required === 1) return null;
    const resourceLimits = fleetResourceLimitsForRun(run);
    const approvedTasks = db
      .prepare(
        `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(runId) as FleetTaskRow[];
    const approvedClaims = db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskClaimRow[];
    const approvedDependencies = db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskDependencyRow[];
    const executionHash = approvedExecutionHash(run);
    if (
      !run.approved_plan_hash ||
      hashFleetTaskRows(approvedTasks, approvedDependencies) !==
        run.approved_plan_hash ||
      !executionHash ||
      hashFleetExecutionContract({
        run,
        tasks: approvedTasks,
        claims: approvedClaims,
        dependencies: approvedDependencies,
      }) !== executionHash
    ) {
      const changedAt = now().toISOString();
      db.prepare(
        `UPDATE fleet_runs SET status = 'paused', approval_state = 'blocked', pause_mode = 'pause-new', pause_reason = 'approval_changed', updated_at = ? WHERE id = ?`
      ).run(changedAt, runId);
      queries
        .createFleetEvent(db)
        .run(runId, "approved_plan_tamper_detected", "scheduler", null);
      return null;
    }

    const runActive = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers WHERE fleet_run_id = ? AND status IN (${activePlaceholders()})`
      )
      .get(runId, ...ACTIVE_WORKER_STATUSES) as { n: number };
    const localActive = db
      .prepare(
        `SELECT COALESCE(SUM(units), 0) AS n FROM fleet_resource_leases WHERE resource_type = 'pty' AND resource_key = 'local' AND status = 'reserved'`
      )
      .get() as { n: number };
    const totalActive = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers WHERE status IN (${activePlaceholders()})`
      )
      .get(...ACTIVE_WORKER_STATUSES) as { n: number };
    const plannersActive = activePlannerCount(db);
    if (
      runActive.n >= run.max_concurrency ||
      localActive.n + plannersActive >= resourceLimits.pty ||
      totalActive.n + plannersActive >= FLEET_MAX_TOTAL_WORKERS
    )
      return null;

    const admissionNowIso = now().toISOString();
    const candidates = db
      .prepare(
        `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? AND status = 'ready'
         AND approval_state = 'approved' AND current_attempt < max_attempts
         AND (retry_not_before IS NULL OR retry_not_before <= ?)
         ORDER BY priority DESC, sort_order ASC`
      )
      .all(runId, admissionNowIso) as FleetTaskRow[];
    const task = candidates.find((candidate) => {
      const dependencies = taskDependencies(db, runId, candidate.id);
      const failedDependency = failedBlockingDependency(db, dependencies);
      if (failedDependency) {
        const changedAt = now().toISOString();
        const changed = db
          .prepare(
            `UPDATE fleet_tasks SET status = 'blocked', failure_code = 'dependency_failed',
             ended_at = ?, updated_at = ? WHERE id = ? AND status = 'ready'`
          )
          .run(changedAt, changedAt, candidate.id);
        if (changed.changes === 1) {
          queries.createFleetEvent(db).run(
            runId,
            "task_blocked_by_dependency",
            "scheduler",
            JSON.stringify({
              taskId: candidate.id,
              dependencyTaskId: failedDependency.id,
              dependencyStatus: failedDependency.status,
            })
          );
        }
        return false;
      }
      if (!dependenciesSatisfied(db, dependencies)) return false;
      if (
        conflictsWithActiveTask(db, runId, taskClaims(db, runId, candidate.id))
      )
        return false;
      const candidateProvider = candidate.agent_type ?? run.provider;
      const providerActive = db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_workers WHERE provider = ? AND status IN (${activePlaceholders()})`
        )
        .get(candidateProvider, ...ACTIVE_WORKER_STATUSES) as { n: number };
      return (
        providerActive.n + activePlannerCount(db, candidateProvider) <
        providerConcurrencyCap(candidateProvider, resourceLimits.providerCaps)
      );
    });
    if (!task) return null;
    const effectiveProvider = task.agent_type ?? run.provider;
    const providerActive = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers WHERE provider = ? AND status IN (${activePlaceholders()})`
      )
      .get(effectiveProvider, ...ACTIVE_WORKER_STATUSES) as { n: number };
    const providerPlannersActive = activePlannerCount(db, effectiveProvider);
    if (
      availableFleetSlots({
        requestedConcurrency: run.max_concurrency,
        runActiveWorkers: runActive.n,
        localActiveWorkers: localActive.n + plannersActive,
        providerActiveWorkers: providerActive.n + providerPlannersActive,
        totalWorkers: totalActive.n + plannersActive,
        provider: effectiveProvider,
        providerCaps: resourceLimits.providerCaps,
        localCapacity: resourceLimits.pty,
      }) < 1
    )
      return null;
    const workingDirectory = resolveWorkingDirectory(db, run, task);
    if (!workingDirectory) {
      db.prepare(
        `UPDATE fleet_tasks SET status = 'failed', failure_code = 'working_directory_required', ended_at = ?, updated_at = ? WHERE id = ?`
      ).run(now().toISOString(), now().toISOString(), task.id);
      return null;
    }

    const effectiveModel = task.model ?? run.model;
    const reservation = estimateFleetTaskReservation({
      provider: effectiveProvider,
      model: effectiveModel,
      taskType: task.task_type || "implementation",
      history: fleetReservationHistory(db),
    });
    const budgetDecision = fleetBudgetDecision(run, reservation);
    const budgetNow = now();
    recordFleetBudgetWarning(
      db,
      run,
      budgetDecision,
      reservation,
      budgetNow.toISOString()
    );
    if (!budgetDecision.allowed) {
      pauseFleetForBudget(db, run, budgetDecision, reservation, budgetNow);
      return null;
    }

    const attempt = (task.current_attempt ?? 0) + 1;
    const spawnRequestId = `${runId}:${task.id}:${attempt}`;
    const workerId = randomUUID();
    const leaseOwner = randomUUID();
    const nowIso = now().toISOString();
    const leaseExpires = new Date(now().getTime() + LEASE_MS).toISOString();
    const epoch = (run.scheduler_epoch ?? 0) + 1;
    const runtimeResources = acquireFleetRuntimeResources(db, {
      runId,
      ownerType: "worker",
      ownerId: workerId,
      resources: fleetWorkerResourceRequest({
        provider: effectiveProvider,
        repositoryKey: run.repo_id ?? run.project_id ?? workingDirectory,
      }),
      limits: resourceLimits,
      now: new Date(nowIso),
      leaseExpiresAt: leaseExpires,
    });
    if (!runtimeResources.admitted) {
      if (runtimeResources.retryAt) {
        db.prepare(
          `UPDATE fleet_tasks SET retry_not_before = ?, provider_state = 'backoff',
           provider_last_error = 'provider cooldown active', provider_backoff_event_at = ?,
           updated_at = ? WHERE id = ? AND status = 'ready'`
        ).run(runtimeResources.retryAt, nowIso, nowIso, task.id);
        queries.createFleetEvent(db).run(
          runId,
          "provider_cooldown_admission_blocked",
          "scheduler",
          JSON.stringify({
            taskId: task.id,
            provider: effectiveProvider,
            retryNotBefore: runtimeResources.retryAt,
          })
        );
      }
      return null;
    }
    const claimed = db
      .prepare(
        `UPDATE fleet_tasks SET status = 'leasing', current_attempt = ?, lease_owner = ?,
         lease_expires_at = ?, scheduler_epoch = ?, spawn_request_id = ?,
         started_at = COALESCE(started_at, ?), updated_at = ?,
         retry_not_before = NULL, provider_state = 'spawning'
         WHERE id = ? AND status = 'ready'`
      )
      .run(
        attempt,
        leaseOwner,
        leaseExpires,
        epoch,
        spawnRequestId,
        nowIso,
        nowIso,
        task.id
      );
    if (claimed.changes !== 1) {
      releaseFleetRuntimeResources(db, {
        ownerType: "worker",
        ownerId: workerId,
        now: new Date(nowIso),
      });
      return null;
    }
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, provider, model, attempt, spawn_request_id,
        lease_owner, lease_expires_at, reservation_usd, reservation_tokens,
        reservation_confidence, reservation_basis, cost_confidence, created_at)
       VALUES (?, ?, ?, 'spawning', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workerId,
      runId,
      task.id,
      effectiveProvider,
      effectiveModel,
      attempt,
      spawnRequestId,
      leaseOwner,
      leaseExpires,
      reservation.usd,
      reservation.tokens,
      reservation.confidence,
      reservation.basis,
      reservation.confidence,
      nowIso
    );
    reserveWorkerResources(db, {
      runId,
      workerId,
      provider: effectiveProvider,
      worktreeKey: run.repo_id ?? run.project_id ?? workingDirectory,
      nowIso,
    });
    db.prepare(
      `UPDATE fleet_runs SET scheduler_epoch = ?,
       reserved_budget_usd = reserved_budget_usd + ?,
       reserved_budget_tokens = reserved_budget_tokens + ?, updated_at = ?
       WHERE id = ?`
    ).run(epoch, reservation.usd, reservation.tokens, nowIso, runId);
    queries.createFleetEvent(db).run(
      runId,
      "worker_leased",
      "scheduler",
      JSON.stringify({
        taskId: task.id,
        workerId,
        spawnRequestId,
        attempt,
        reservationUsd: reservation.usd,
        reservationTokens: reservation.tokens,
        reservationConfidence: reservation.confidence,
        reservationBasis: reservation.basis,
      })
    );
    return {
      run: { ...run, scheduler_epoch: epoch },
      task: {
        ...task,
        base_branch: resolveBaseBranch(db, run, task),
        current_attempt: attempt,
        spawn_request_id: spawnRequestId,
      },
      workerId,
      spawnRequestId,
      attempt,
      claims: taskClaims(db, runId, task.id),
      dependencies: dependencySummaries(
        db,
        taskDependencies(db, runId, task.id)
      ),
      workingDirectory,
    };
  });
}

async function launchLease(
  deps: FleetSchedulerDeps,
  lease: LeasedTask
): Promise<void> {
  let spawnedResult: FleetSpawnResult | null = null;
  try {
    launchingWorkers.add(lease.workerId);
    let attemptContract: FleetWorkerAttemptContract;
    let result: FleetSpawnResult;
    try {
      attemptContract = await deps.prepareAttempt({
        runId: lease.run.id,
        taskId: lease.task.id,
        attempt: lease.attempt,
        workingDirectory: lease.workingDirectory,
        // A dependency integration pins the exact combined head in base_sha.
        // Prefer it over the moving human-readable integration branch so a later
        // independent merge cannot silently change this task's execution base.
        baseRef: lease.task.base_sha ?? lease.task.base_branch ?? "main",
      });
      const prepared = transaction(deps.db, () => {
        const nowIso = deps.now().toISOString();
        const workerUpdate = deps.db
          .prepare(
            `UPDATE fleet_workers SET base_sha = ?, report_path = ?, report_nonce_hash = ?,
             report_state = 'pending', report_poll_count = 0, report_next_poll_at = ?,
             report_error = NULL
             WHERE id = ? AND spawn_request_id = ? AND status = 'spawning'`
          )
          .run(
            attemptContract.baseSha,
            attemptContract.reportPath,
            attemptContract.nonceHash,
            nowIso,
            lease.workerId,
            lease.spawnRequestId
          );
        if (workerUpdate.changes !== 1) return false;
        deps.db
          .prepare(`UPDATE fleet_tasks SET base_sha = ? WHERE id = ?`)
          .run(attemptContract.baseSha, lease.task.id);
        return true;
      });
      if (!prepared) {
        throw new Error(
          "Fleet worker state changed before attempt preparation"
        );
      }
      result = await deps.spawn({
        run: lease.run,
        task: {
          ...lease.task,
          base_branch: attemptContract.baseSha,
          base_sha: attemptContract.baseSha,
        },
        workingDirectory: lease.workingDirectory,
        claims: lease.claims,
        dependencies: lease.dependencies,
        attempt: lease.attempt,
        spawnRequestId: lease.spawnRequestId,
        reportContract: {
          ...attemptContract,
          workerId: lease.workerId,
        },
      });
      spawnedResult = result;
    } finally {
      launchingWorkers.delete(lease.workerId);
    }
    const launchOutcome = transaction<"accepted" | "idempotent" | "cleanup">(
      deps.db,
      () => {
        const nowIso = deps.now().toISOString();
        const queueLaunchCleanup = (cause: string) => {
          deps.db
            .prepare(
              `UPDATE fleet_workers SET status = 'cleanup_pending',
               terminal_cause = ?, failure_code = ?
               WHERE id = ? AND status = 'running'`
            )
            .run(cause, cause, lease.workerId);
          return "cleanup" as const;
        };
        const workerUpdate = deps.db
          .prepare(
            `UPDATE fleet_workers SET status = 'running', session_id = ?, worktree_path = ?,
             branch_name = ?, base_sha = ?, lease_owner = NULL, lease_expires_at = NULL,
             last_heartbeat_at = ? WHERE id = ? AND spawn_request_id = ? AND status = 'spawning'`
          )
          .run(
            result.sessionId,
            result.worktreePath,
            result.branchName ?? lease.task.branch_name ?? null,
            attemptContract.baseSha,
            nowIso,
            lease.workerId,
            lease.spawnRequestId
          );
        if (workerUpdate.changes !== 1) {
          const current = deps.db
            .prepare(
              `SELECT status, session_id, spawn_request_id FROM fleet_workers WHERE id = ?`
            )
            .get(lease.workerId) as
            | {
                status: string;
                session_id: string | null;
                spawn_request_id: string | null;
              }
            | undefined;
          deps.db
            .prepare(
              `UPDATE fleet_workers SET session_id = COALESCE(session_id, ?),
               worktree_path = COALESCE(worktree_path, ?), branch_name = COALESCE(branch_name, ?),
               base_sha = COALESCE(base_sha, ?) WHERE id = ?`
            )
            .run(
              result.sessionId,
              result.worktreePath,
              result.branchName ?? lease.task.branch_name ?? null,
              attemptContract.baseSha,
              lease.workerId
            );
          if (
            current?.status === "running" &&
            current.spawn_request_id === lease.spawnRequestId &&
            (current.session_id == null ||
              current.session_id === result.sessionId)
          ) {
            deps.db
              .prepare(
                `UPDATE fleet_runtime_leases SET lease_expires_at = NULL
                 WHERE owner_type = 'worker' AND owner_id = ? AND status = 'reserved'`
              )
              .run(lease.workerId);
            const session = queries
              .getSession(deps.db)
              .get(result.sessionId) as Session | undefined;
            if (!session) return queueLaunchCleanup("cost_session_missing");
            const currentWorker = deps.db
              .prepare(
                `SELECT reservation_usd, reservation_tokens,
                        reservation_confidence, reservation_basis
                 FROM fleet_workers WHERE id = ?`
              )
              .get(lease.workerId) as FleetWorkerRow | undefined;
            if (
              !registerFleetCostAccount(deps.db, {
                runId: lease.run.id,
                ownerType: "worker",
                ownerId: lease.workerId,
                taskId: lease.task.id,
                session,
                provider: lease.task.agent_type ?? lease.run.provider,
                model: lease.task.model ?? lease.run.model,
                confidence: currentWorker?.reservation_confidence,
                reservation: currentWorker
                  ? {
                      usd: currentWorker.reservation_usd ?? 0,
                      tokens: currentWorker.reservation_tokens ?? 0,
                      confidence:
                        currentWorker.reservation_confidence ?? "unknown",
                      basis: (currentWorker.reservation_basis ??
                        "unknown-provider") as FleetTaskReservation["basis"],
                      sampleCount: 0,
                    }
                  : undefined,
              })
            )
              return queueLaunchCleanup("cost_session_owner_collision");
            clearFleetProviderCooldown(
              deps.db,
              lease.task.agent_type ?? lease.run.provider
            );
            releaseWorkerResources(
              deps.db,
              lease.workerId,
              nowIso,
              "git_operation"
            );
            return "idempotent";
          }
          return "cleanup";
        }
        deps.db
          .prepare(
            `UPDATE fleet_runtime_leases SET lease_expires_at = NULL
             WHERE owner_type = 'worker' AND owner_id = ? AND status = 'reserved'`
          )
          .run(lease.workerId);
        const session = queries.getSession(deps.db).get(result.sessionId) as
          Session | undefined;
        if (!session) return queueLaunchCleanup("cost_session_missing");
        const currentWorker = deps.db
          .prepare(
            `SELECT reservation_usd, reservation_tokens,
                      reservation_confidence, reservation_basis
               FROM fleet_workers WHERE id = ?`
          )
          .get(lease.workerId) as FleetWorkerRow | undefined;
        if (
          !registerFleetCostAccount(deps.db, {
            runId: lease.run.id,
            ownerType: "worker",
            ownerId: lease.workerId,
            taskId: lease.task.id,
            session,
            provider: lease.task.agent_type ?? lease.run.provider,
            model: lease.task.model ?? lease.run.model,
            confidence: currentWorker?.reservation_confidence,
            reservation: currentWorker
              ? {
                  usd: currentWorker.reservation_usd ?? 0,
                  tokens: currentWorker.reservation_tokens ?? 0,
                  confidence: currentWorker.reservation_confidence ?? "unknown",
                  basis: (currentWorker.reservation_basis ??
                    "unknown-provider") as FleetTaskReservation["basis"],
                  sampleCount: 0,
                }
              : undefined,
          })
        )
          return queueLaunchCleanup("cost_session_owner_collision");
        clearFleetProviderCooldown(
          deps.db,
          lease.task.agent_type ?? lease.run.provider
        );
        releaseWorkerResources(
          deps.db,
          lease.workerId,
          nowIso,
          "git_operation"
        );
        deps.db
          .prepare(
            `UPDATE fleet_tasks SET status = 'running', worktree_path = ?, branch_name = ?,
             base_sha = ?, lease_owner = NULL, lease_expires_at = NULL,
             retry_not_before = NULL, provider_failure_count = 0,
             provider_state = 'running', provider_last_error = NULL,
             provider_backoff_event_at = NULL, updated_at = ?
             WHERE id = ? AND spawn_request_id = ? AND status = 'leasing'`
          )
          .run(
            result.worktreePath,
            result.branchName ?? lease.task.branch_name ?? null,
            attemptContract.baseSha,
            nowIso,
            lease.task.id,
            lease.spawnRequestId
          );
        deps.db
          .prepare(
            `UPDATE fleet_resource_leases SET resource_key = ?
             WHERE worker_id = ? AND resource_type = 'worktree'
               AND status = 'reserved'`
          )
          .run(result.worktreePath, lease.workerId);
        queries.createFleetEvent(deps.db).run(
          lease.run.id,
          "worker_started",
          "scheduler",
          JSON.stringify({
            taskId: lease.task.id,
            workerId: lease.workerId,
            sessionId: result.sessionId,
          }),
          { controlPlane: true }
        );
        return "accepted";
      }
    );
    if (launchOutcome === "cleanup") {
      try {
        await deps.stopSession(result.sessionId);
        transaction(deps.db, () => {
          const nowIso = deps.now().toISOString();
          const run = queries.getFleetRun(deps.db).get(lease.run.id) as
            FleetRunRow | undefined;
          const canceled = run?.status === "canceled";
          const changed = deps.db
            .prepare(
              `UPDATE fleet_workers SET status = ?, terminal_cause = ?,
               ended_at = ? WHERE id = ? AND status IN ('canceled', 'failed', 'cleanup_pending', 'cleanup_complete')`
            )
            .run(
              canceled ? "cleanup_complete" : "failed",
              canceled ? "operator_cancel" : "recovery_late_spawn_stopped",
              nowIso,
              lease.workerId
            );
          if (changed.changes !== 1) return;
          if (canceled) {
            releaseWorkerResourcesExceptWorktree(
              deps.db,
              lease.workerId,
              nowIso
            );
            settleWorkerBudget(
              deps.db,
              lease.workerId,
              new Date(nowIso),
              false
            );
          } else {
            releaseWorkerResourcesExceptWorktree(
              deps.db,
              lease.workerId,
              nowIso
            );
            settleWorkerBudget(deps.db, lease.workerId, new Date(nowIso), true);
            deps.db
              .prepare(
                `UPDATE fleet_tasks SET status = 'needs_inspection', failure_code = 'recovery_late_spawn',
                 worktree_path = COALESCE(worktree_path, ?), ended_at = ?, updated_at = ?
                 WHERE id = ? AND status <> 'canceled'`
              )
              .run(result.worktreePath, nowIso, nowIso, lease.task.id);
          }
          queries.createFleetEvent(deps.db).run(
            lease.run.id,
            canceled
              ? "cancel_cleanup_completed"
              : "recovery_late_spawn_stopped",
            "scheduler",
            JSON.stringify({
              workerId: lease.workerId,
              sessionId: result.sessionId,
            })
          );
        });
      } catch (stopError) {
        transaction(deps.db, () => {
          const run = queries.getFleetRun(deps.db).get(lease.run.id) as
            FleetRunRow | undefined;
          const canceled = run?.status === "canceled";
          const changed = deps.db
            .prepare(
              `UPDATE fleet_workers SET status = 'cleanup_pending', terminal_cause = ?,
               failure_code = ?, ended_at = NULL WHERE id = ? AND status IN ('canceled', 'failed', 'cleanup_pending', 'cleanup_complete')`
            )
            .run(
              canceled
                ? "cancel_stop_failed"
                : "recovery_late_spawn_stop_failed",
              stopError instanceof Error ? stopError.message : "stop failed",
              lease.workerId
            );
          if (changed.changes !== 1) return;
          deps.db
            .prepare(
              `UPDATE fleet_resource_leases SET status = 'reserved', released_at = NULL
               WHERE worker_id = ? AND resource_type <> 'git_operation'`
            )
            .run(lease.workerId);
          deps.db
            .prepare(
              `UPDATE fleet_runtime_leases SET status = 'reserved', released_at = NULL,
               lease_expires_at = NULL WHERE owner_type = 'worker' AND owner_id = ?
               AND resource_type <> 'git_operation'`
            )
            .run(lease.workerId);
          queries.createFleetEvent(deps.db).run(
            lease.run.id,
            canceled ? "cancel_cleanup_pending" : "spawn_cleanup_pending",
            "scheduler",
            JSON.stringify({
              workerId: lease.workerId,
              sessionId: result.sessionId,
            })
          );
        });
      }
    }
  } catch (error) {
    const failedSessionId =
      error instanceof FleetSpawnError
        ? error.sessionId
        : (spawnedResult?.sessionId ?? null);
    const failedWorktreePath =
      error instanceof FleetSpawnError
        ? error.worktreePath
        : (spawnedResult?.worktreePath ?? null);
    const failedBranchName = spawnedResult?.branchName ?? null;
    const preserved = failedSessionId != null || failedWorktreePath != null;
    const failureCount = (lease.task.provider_failure_count ?? 0) + 1;
    const retry = !preserved && lease.attempt < (lease.task.max_attempts ?? 2);
    let retryNotBefore = retry
      ? fleetProviderRetryNotBefore(deps.now(), failureCount)
      : null;
    const errorText =
      error instanceof Error ? error.message.slice(0, 500) : "spawn failed";
    let stopFailed = false;
    if (failedSessionId) {
      try {
        await deps.stopSession(failedSessionId);
      } catch {
        stopFailed = true;
      }
    }
    transaction(deps.db, () => {
      const nowIso = deps.now().toISOString();
      if (looksLikeProviderRateLimit(error)) {
        const cooldownUntil = recordFleetProviderCooldown(deps.db, {
          provider: lease.task.agent_type ?? lease.run.provider,
          reason: errorText,
          now: new Date(nowIso),
        });
        if (retry && (!retryNotBefore || cooldownUntil > retryNotBefore)) {
          retryNotBefore = cooldownUntil;
        }
      }
      const current = deps.db
        .prepare(`SELECT status FROM fleet_workers WHERE id = ?`)
        .get(lease.workerId) as { status: string } | undefined;
      if (current?.status !== "spawning") return;
      deps.db
        .prepare(
          `UPDATE fleet_workers SET status = ?, terminal_cause = ?, failure_code = ?,
           session_id = COALESCE(?, session_id), worktree_path = COALESCE(?, worktree_path),
           branch_name = COALESCE(?, branch_name),
           ended_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`
        )
        .run(
          stopFailed ? "cleanup_pending" : "failed",
          stopFailed
            ? "spawn_stop_failed"
            : preserved
              ? "spawn_failed_preserved"
              : "spawn_failed",
          errorText,
          failedSessionId,
          failedWorktreePath,
          failedBranchName,
          stopFailed ? null : nowIso,
          lease.workerId
        );
      if (preserved) {
        if (failedWorktreePath) {
          deps.db
            .prepare(
              `UPDATE fleet_resource_leases SET resource_key = ?
               WHERE worker_id = ? AND resource_type = 'worktree'
                 AND status = 'reserved'`
            )
            .run(failedWorktreePath, lease.workerId);
        }
        deps.db
          .prepare(
            `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
             WHERE worker_id = ? AND status = 'reserved'
               AND resource_type NOT IN ('worktree'${stopFailed ? ", 'pty', 'provider'" : ""})`
          )
          .run(nowIso, lease.workerId);
        if (stopFailed) {
          releaseFleetRuntimeResources(deps.db, {
            ownerType: "worker",
            ownerId: lease.workerId,
            now: new Date(nowIso),
            resourceTypes: ["git_operation"],
          });
          deps.db
            .prepare(
              `UPDATE fleet_runtime_leases SET lease_expires_at = NULL
               WHERE owner_type = 'worker' AND owner_id = ? AND status = 'reserved'`
            )
            .run(lease.workerId);
        } else {
          releaseWorkerResourcesExceptWorktree(deps.db, lease.workerId, nowIso);
        }
      } else {
        releaseWorkerResources(deps.db, lease.workerId, nowIso);
      }
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET status = ?, failure_code = 'spawn_failed',
           lease_owner = NULL, lease_expires_at = NULL, spawn_request_id = NULL,
           worktree_path = COALESCE(?, worktree_path),
           branch_name = COALESCE(?, branch_name),
           retry_not_before = ?, provider_failure_count = ?, provider_state = ?,
           provider_last_error = ?, provider_backoff_event_at = ?,
           ended_at = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`
        )
        .run(
          preserved ? "needs_inspection" : retry ? "ready" : "failed",
          failedWorktreePath,
          failedBranchName,
          retryNotBefore,
          failureCount,
          retry ? "backoff" : "failed",
          errorText,
          retry ? nowIso : null,
          retry ? 1 : 0,
          nowIso,
          nowIso,
          lease.task.id
        );
      if (!stopFailed) {
        settleWorkerBudget(
          deps.db,
          lease.workerId,
          new Date(nowIso),
          preserved
        );
      }
      queries.createFleetEvent(deps.db).run(
        lease.run.id,
        retry ? "provider_spawn_backoff_scheduled" : "worker_spawn_failed",
        "scheduler",
        JSON.stringify({
          taskId: lease.task.id,
          workerId: lease.workerId,
          retry,
          retryNotBefore,
          providerFailureCount: failureCount,
          preserved,
          stopFailed,
          message: errorText,
        })
      );
    });
  }
}

function reportEvidence(
  collection: Exclude<FleetWorkerReportCollectionResult, { kind: "missing" }>
) {
  const gitState = collection.gitState;
  const diff = gitState
    ? {
        baseSha: gitState.baseSha,
        headSha: gitState.headSha,
        branchName: gitState.currentBranch,
        committedChanges: gitState.committedChanges,
        stagedChanges: gitState.stagedChanges,
        unstagedChanges: gitState.unstagedChanges,
        untrackedPaths: gitState.untrackedPaths,
        sensitivePaths: gitState.sensitivePaths,
        summary: gitState.summary,
      }
    : { unavailable: true };
  return {
    report: boundedFleetArtifactJson(
      collection.kind === "collected"
        ? collection.report
        : { rejected: true, error: collection.error }
    ),
    diff: boundedFleetArtifactJson(diff),
    actualClaims: boundedFleetArtifactJson(gitState?.allTouchedPaths ?? []),
  };
}

function finalizeFleetReportCleanup(
  deps: FleetSchedulerDeps,
  input: {
    worker: FleetWorkerRow;
    finalWorkerStatus: "completed" | "failed";
    terminalCause: string;
    nowIso: string;
  }
): boolean {
  return transaction(deps.db, () => {
    const changed = deps.db
      .prepare(
        `UPDATE fleet_workers SET status = ?, terminal_cause = ?, ended_at = ?,
         lease_owner = NULL, lease_expires_at = NULL
         WHERE id = ? AND status = 'cleanup_pending'
           AND terminal_cause = 'report_collection_pending'`
      )
      .run(
        input.finalWorkerStatus,
        input.terminalCause,
        input.nowIso,
        input.worker.id
      );
    if (changed.changes !== 1) return false;
    releaseWorkerResourcesExceptWorktree(
      deps.db,
      input.worker.id,
      input.nowIso
    );
    settleWorkerBudget(deps.db, input.worker.id, new Date(input.nowIso), true);
    queries.createFleetEvent(deps.db).run(
      input.worker.fleet_run_id,
      "worker_report_cleanup_completed",
      "scheduler",
      JSON.stringify({
        workerId: input.worker.id,
        status: input.finalWorkerStatus,
        terminalCause: input.terminalCause,
      })
    );
    return true;
  });
}

async function pollFleetWorkerReport(
  deps: FleetSchedulerDeps,
  run: FleetRunRow,
  task: FleetTaskRow,
  worker: FleetWorkerRow,
  session: Session | undefined,
  force = false
): Promise<boolean> {
  if (
    worker.report_state !== "pending" ||
    !worker.report_path ||
    !worker.report_nonce_hash ||
    !worker.base_sha ||
    !worker.spawn_request_id ||
    !worker.worktree_path
  ) {
    return false;
  }
  const now = deps.now();
  const nowIso = now.toISOString();
  if (
    !force &&
    worker.report_next_poll_at &&
    worker.report_next_poll_at > nowIso
  ) {
    return false;
  }

  const collection = await deps.collectReport({
    reportPath: worker.report_path,
    worktreePath: worker.worktree_path,
    expected: {
      runId: run.id,
      taskId: task.id,
      workerId: worker.id,
      attempt: worker.attempt,
      spawnRequestId: worker.spawn_request_id,
      nonceHash: worker.report_nonce_hash,
      baseSha: worker.base_sha,
      spawnedAt: worker.created_at,
    },
    plannedClaims: taskClaims(deps.db, run.id, task.id),
    allowSensitivePaths: parseFleetAutomationPolicy(run.automation_policy_json)
      .policy.allowSensitivePaths,
    nowMs: now.getTime(),
  });
  if (collection.kind === "missing") {
    deps.db
      .prepare(
        `UPDATE fleet_workers SET report_poll_count = report_poll_count + 1,
         report_last_polled_at = ?, report_next_poll_at = ?, last_heartbeat_at = ?
         WHERE id = ? AND status IN ('running', 'waiting_for_operator')
           AND report_state = 'pending'`
      )
      .run(
        nowIso,
        nextFleetReportPollAt(worker.report_poll_count ?? 0, now.getTime()),
        nowIso,
        worker.id
      );
    return false;
  }

  let evidence: ReturnType<typeof reportEvidence>;
  try {
    evidence = reportEvidence(collection);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "report evidence is too large";
    evidence = {
      report: boundedFleetArtifactJson({ rejected: true, error: message }),
      diff: boundedFleetArtifactJson({ unavailable: true, error: message }),
      actualClaims: boundedFleetArtifactJson([]),
    };
  }
  const taskStatus =
    collection.kind === "collected"
      ? collection.taskStatus
      : "needs_inspection";
  const failureCode =
    collection.kind === "collected" ? collection.failureCode : "report_invalid";
  const gitState = collection.gitState;
  const reportArtifactId = `${worker.id}:${worker.attempt}:report`;
  const diffArtifactId = `${worker.id}:${worker.attempt}:diff`;
  const accepted = collection.kind === "collected";
  const reportStatus = accepted ? collection.report.status : null;
  const reportSubmittedAt = accepted ? collection.report.submittedAt : null;
  const terminalCause = accepted
    ? taskStatus === "verifying" || taskStatus === "completed"
      ? "report_collected"
      : `report_attention_${failureCode ?? taskStatus}`
    : "report_invalid";
  const finalWorkerStatus =
    accepted && collection.report.status === "succeeded"
      ? "completed"
      : "failed";
  const claimed = transaction(deps.db, () => {
    const workerUpdate = deps.db
      .prepare(
        `UPDATE fleet_workers SET status = 'cleanup_pending',
         terminal_cause = 'report_collection_pending', report_state = ?,
         report_status = ?, report_submitted_at = ?, report_collected_at = ?,
         report_bytes = ?, head_sha = ?, actual_claims_json = ?,
         diff_summary_json = ?, report_poll_count = report_poll_count + 1,
         report_last_polled_at = ?, report_next_poll_at = NULL, report_error = ?
         WHERE id = ? AND status IN ('running', 'waiting_for_operator')
           AND report_state = 'pending'`
      )
      .run(
        accepted ? "accepted" : "invalid",
        reportStatus,
        reportSubmittedAt,
        nowIso,
        collection.reportBytes,
        gitState?.headSha ?? null,
        evidence.actualClaims.body,
        JSON.stringify(gitState?.summary ?? null),
        nowIso,
        accepted ? null : collection.error.slice(0, 500),
        worker.id
      );
    if (workerUpdate.changes !== 1) return false;

    const severity =
      taskStatus === "verifying" || taskStatus === "completed"
        ? "info"
        : "blocker";
    insertFleetArtifact(
      deps.db,
      {
        id: reportArtifactId,
        runId: run.id,
        taskId: task.id,
        workerId: worker.id,
        attempt: worker.attempt,
        planHash: run.approved_plan_hash,
        baseSha: worker.base_sha,
        headSha: gitState?.headSha ?? null,
        contentHash: evidence.report.contentHash,
        metadataJson: JSON.stringify({
          accepted,
          status: reportStatus,
          failureCode,
        }),
        artifactType: accepted ? "worker_report" : "worker_report_rejected",
        title: accepted ? "Worker completion report" : "Rejected worker report",
        body: evidence.report.body,
        severity,
        actor: accepted ? "worker" : "scheduler",
        createdAt: nowIso,
      },
      { orIgnore: true }
    );
    insertFleetArtifact(
      deps.db,
      {
        id: diffArtifactId,
        runId: run.id,
        taskId: task.id,
        workerId: worker.id,
        attempt: worker.attempt,
        planHash: run.approved_plan_hash,
        baseSha: worker.base_sha,
        headSha: gitState?.headSha ?? null,
        contentHash: evidence.diff.contentHash,
        metadataJson: JSON.stringify({
          claimDrift:
            collection.kind === "collected" ? collection.claimDrift : null,
        }),
        artifactType: "worker_git_state",
        title: "Authoritative worker Git state",
        body: evidence.diff.body,
        severity,
        actor: "scheduler",
        createdAt: nowIso,
      },
      { orIgnore: true }
    );
    deps.db
      .prepare(
        `UPDATE fleet_tasks SET status = ?, failure_code = ?, head_sha = ?,
         branch_name = COALESCE(branch_name, ?), actual_file_claims_json = ?,
         report_artifact_id = ?, diff_artifact_id = ?,
         ended_at = CASE WHEN ? IN ('verifying') THEN NULL ELSE ? END,
         updated_at = ?
         WHERE id = ? AND status IN ('running', 'waiting_for_operator')`
      )
      .run(
        taskStatus,
        failureCode,
        gitState?.headSha ?? null,
        gitState?.currentBranch ?? worker.branch_name ?? null,
        evidence.actualClaims.body,
        reportArtifactId,
        diffArtifactId,
        taskStatus,
        nowIso,
        nowIso,
        task.id
      );
    queries.createFleetEvent(deps.db).run(
      run.id,
      accepted ? "worker_report_collected" : "worker_report_rejected",
      "scheduler",
      JSON.stringify({
        taskId: task.id,
        workerId: worker.id,
        attempt: worker.attempt,
        taskStatus,
        failureCode,
        baseSha: worker.base_sha,
        headSha: gitState?.headSha ?? null,
      })
    );
    return true;
  });
  if (!claimed) return true;

  let stopped = session == null;
  if (session) {
    try {
      await deps.stopSession(session.id, finalWorkerStatus);
      stopped = true;
    } catch {
      stopped = false;
    }
  }
  if (stopped) {
    finalizeFleetReportCleanup(deps, {
      worker,
      finalWorkerStatus,
      terminalCause,
      nowIso,
    });
  } else {
    queries
      .createFleetEvent(deps.db)
      .run(
        run.id,
        "worker_report_cleanup_pending",
        "scheduler",
        JSON.stringify({ workerId: worker.id, sessionId: session?.id ?? null })
      );
  }
  return true;
}

async function pollActiveWorkers(
  deps: FleetSchedulerDeps,
  runId: string
): Promise<void> {
  const run = queries.getFleetRun(deps.db).get(runId) as
    FleetRunRow | undefined;
  if (!run) return;
  const workers = deps.db
    .prepare(
      `SELECT * FROM fleet_workers
       WHERE fleet_run_id = ? AND status IN ('running', 'waiting_for_operator')`
    )
    .all(runId) as FleetWorkerRow[];
  for (const worker of workers) {
    const session = worker.session_id
      ? (queries.getSession(deps.db).get(worker.session_id) as
          Session | undefined)
      : undefined;
    const task = worker.task_id
      ? (deps.db
          .prepare(
            `SELECT * FROM fleet_tasks WHERE id = ? AND fleet_run_id = ?`
          )
          .get(worker.task_id, runId) as FleetTaskRow | undefined)
      : undefined;
    if (
      task &&
      (await pollFleetWorkerReport(deps, run, task, worker, session))
    ) {
      continue;
    }
    let terminalStatus: "completed" | "failed" | "dead" | null = null;
    let terminalCause: string | null = null;
    const interruptStopStarted = ["requested", "confirmed"].includes(
      worker.interrupt_stop_state ?? "unattempted"
    );
    const interruptTerminalCause = !interruptStopStarted
      ? null
      : worker.interrupt_cause === "budget_hard_limit"
        ? "budget_hard_limit_stop_requested"
        : worker.interrupt_cause === "operator_pause"
          ? "operator_interrupt_stop_requested"
          : "interrupt_state_invalid";
    let claimedForCleanup = false;
    let claimedCleanupCause: string | null = null;
    if (!session) {
      terminalStatus = "dead";
      terminalCause = interruptTerminalCause ?? "session_missing";
    } else if (
      session.worker_status === "completed" ||
      session.worker_status === "failed"
    ) {
      terminalStatus = session.worker_status;
      terminalCause =
        interruptTerminalCause ?? `session_${session.worker_status}`;
      let backendAlive = true;
      try {
        backendAlive = await deps.sessionExists(session);
      } catch {
        backendAlive = true;
      }
      if (backendAlive) {
        claimedCleanupCause = `${terminalCause}_cleanup_pending`;
        claimedForCleanup = transaction(deps.db, () => {
          const changed = deps.db
            .prepare(
              `UPDATE fleet_workers SET status = 'cleanup_pending', terminal_cause = ?,
               ended_at = NULL WHERE id = ? AND status IN ('running', 'waiting_for_operator')`
            )
            .run(claimedCleanupCause, worker.id);
          if (changed.changes !== 1) return false;
          queries
            .createFleetEvent(deps.db)
            .run(
              runId,
              "worker_terminal_cleanup_requested",
              "scheduler",
              JSON.stringify({ workerId: worker.id, terminalCause })
            );
          return true;
        });
        if (!claimedForCleanup) continue;
        try {
          await deps.stopSession(
            session.id,
            terminalStatus === "completed" ? "completed" : "failed"
          );
        } catch {
          continue;
        }
      }
    } else {
      let backendAlive = true;
      try {
        backendAlive = await deps.sessionExists(session);
      } catch {
        // A transient backend probe failure is not evidence that the exact
        // session died. Keep the worker active and retry on the next tick.
        backendAlive = true;
      }
      if (!backendAlive) {
        terminalStatus = "dead";
        terminalCause = interruptTerminalCause ?? "backend_missing";
      }
    }
    if (!terminalStatus || !terminalCause) continue;
    transaction(deps.db, () => {
      const nowIso = deps.now().toISOString();
      const changed = deps.db
        .prepare(
          `UPDATE fleet_workers SET status = ?, terminal_cause = ?, ended_at = ?,
           lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND status IN (${claimedForCleanup ? "'cleanup_pending'" : "'running', 'waiting_for_operator'"})
             AND (? IS NULL OR terminal_cause = ?)`
        )
        .run(
          terminalStatus,
          terminalCause,
          nowIso,
          worker.id,
          claimedCleanupCause,
          claimedCleanupCause
        );
      if (changed.changes !== 1) return;
      releaseWorkerResourcesExceptWorktree(deps.db, worker.id, nowIso);
      settleWorkerBudget(deps.db, worker.id, new Date(nowIso), true);
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET status = ?, failure_code = ?, ended_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('running', 'waiting_for_operator')`
        )
        .run(
          terminalStatus === "failed" ? "failed" : "needs_inspection",
          terminalCause,
          nowIso,
          nowIso,
          worker.task_id
        );
      queries.createFleetEvent(deps.db).run(
        runId,
        "worker_terminal_observed",
        "scheduler",
        JSON.stringify({
          workerId: worker.id,
          taskId: worker.task_id,
          status: terminalStatus,
          terminalCause,
        })
      );
    });
  }
}

function enforceFleetBudget(deps: FleetSchedulerDeps, runId: string): void {
  transaction(deps.db, () => {
    const run = queries.getFleetRun(deps.db).get(runId) as
      FleetRunRow | undefined;
    if (!run || TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const decision = fleetBudgetDecision(run);
    const now = deps.now();
    recordFleetBudgetWarning(
      deps.db,
      run,
      decision,
      undefined,
      now.toISOString()
    );
    if (!decision.allowed) {
      pauseFleetForBudget(deps.db, run, decision, undefined, now);
    }
  });
}

function enforceAllFleetBudgets(deps: FleetSchedulerDeps): void {
  const runs = deps.db
    .prepare(
      `SELECT id FROM fleet_runs
       WHERE status NOT IN ('completed', 'failed', 'canceled')
         AND (budget_usd IS NOT NULL OR budget_tokens IS NOT NULL)
       ORDER BY updated_at, id`
    )
    .all() as { id: string }[];
  for (const run of runs) enforceFleetBudget(deps, run.id);
}

async function processFleetInterrupts(
  deps: FleetSchedulerDeps,
  runId: string
): Promise<void> {
  const recordAttention = (worker: FleetWorkerRow, reason: string) => {
    transaction(deps.db, () => {
      const alreadyRecorded = deps.db
        .prepare(
          `SELECT 1 FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'worker_interrupt_attention_required'
             AND json_valid(payload)
             AND json_extract(payload, '$.workerId') = ?
             AND json_extract(payload, '$.requestedAt') IS ?
           LIMIT 1`
        )
        .get(runId, worker.id, worker.interrupt_requested_at ?? null);
      if (alreadyRecorded) return;
      queries.createFleetEvent(deps.db).run(
        runId,
        "worker_interrupt_attention_required",
        "scheduler",
        JSON.stringify({
          workerId: worker.id,
          requestedAt: worker.interrupt_requested_at,
          reason,
        })
      );
    });
  };
  const workers = deps.db
    .prepare(
      `SELECT * FROM fleet_workers WHERE fleet_run_id = ?
       AND status IN ('running', 'waiting_for_operator')
       AND interrupt_requested_at IS NOT NULL
       AND interrupt_deadline_at IS NOT NULL`
    )
    .all(runId) as FleetWorkerRow[];
  for (const worker of workers) {
    const now = deps.now();
    const cause = worker.interrupt_cause;
    if (cause !== "budget_hard_limit" && cause !== "operator_pause") {
      recordAttention(worker, "interrupt cause is invalid");
      continue;
    }
    const activeSessionOwners = worker.session_id
      ? (
          deps.db
            .prepare(
              `SELECT COUNT(*) AS count FROM fleet_workers
             WHERE session_id = ?
               AND status IN ('running', 'waiting_for_operator')`
            )
            .get(worker.session_id) as { count: number }
        ).count
      : 0;
    if (activeSessionOwners !== 1) {
      recordAttention(
        worker,
        "interrupt session is not bound to exactly one active worker"
      );
      continue;
    }
    const decision = decideFleetInterruptAction(
      {
        runId,
        workerId: worker.id,
        sessionId: worker.session_id,
        workerStatus: worker.status,
        interruptRequestedAt: worker.interrupt_requested_at ?? null,
        interruptDeadlineAt: worker.interrupt_deadline_at ?? null,
        noticeState: worker.interrupt_notice_state ?? "unattempted",
        stopState: worker.interrupt_stop_state ?? "unattempted",
      },
      now
    );
    if (decision.kind === "operator_attention") {
      recordAttention(worker, decision.reason);
      continue;
    }
    if (decision.kind === "none" || decision.kind === "wait_for_deadline") {
      continue;
    }
    if (decision.kind === "deliver_notice") {
      const claimed = transaction(deps.db, () => {
        if (decision.replay) {
          return Boolean(
            deps.db
              .prepare(
                `SELECT 1 FROM fleet_workers
                 WHERE id = ? AND fleet_run_id = ? AND session_id = ?
                   AND status IN ('running', 'waiting_for_operator')
                   AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
                   AND interrupt_notice_state = 'requested'
                   AND 1 = (
                     SELECT COUNT(*) FROM fleet_workers bound
                     WHERE bound.session_id = ?
                       AND bound.status IN ('running', 'waiting_for_operator')
                   )`
              )
              .get(
                worker.id,
                runId,
                worker.session_id,
                decision.requestedAt,
                decision.deadlineAt,
                worker.session_id
              )
          );
        }
        const changed = deps.db
          .prepare(
            `UPDATE fleet_workers SET interrupt_notice_state = 'requested'
             WHERE id = ? AND fleet_run_id = ? AND session_id = ?
               AND status IN ('running', 'waiting_for_operator')
               AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
               AND interrupt_notice_state = 'unattempted'
               AND 1 = (
                 SELECT COUNT(*) FROM fleet_workers bound
                 WHERE bound.session_id = ?
                   AND bound.status IN ('running', 'waiting_for_operator')
               )`
          )
          .run(
            worker.id,
            runId,
            worker.session_id,
            decision.requestedAt,
            decision.deadlineAt,
            worker.session_id
          );
        if (changed.changes !== 1) return false;
        queries.createFleetEvent(deps.db).run(
          runId,
          "worker_interrupt_notice_claimed",
          "scheduler",
          JSON.stringify({
            workerId: worker.id,
            sessionId: worker.session_id,
            operationKey: decision.operationKey,
            cause,
            requestedAt: decision.requestedAt,
            deadlineAt: decision.deadlineAt,
          })
        );
        return true;
      });
      if (!claimed || !worker.session_id) continue;
      let delivered = false;
      try {
        await deps.sendMessage(
          worker.session_id,
          cause === "budget_hard_limit"
            ? "[Stoa Fleet] The configured hard budget limit has been reached. Reach a safe stopping point and submit your report now; Stoa will stop this worker after the grace period."
            : "[Stoa Fleet] This run was paused with interruption requested. Reach a safe stopping point and submit your report now; Stoa will stop this worker after the grace period."
        );
        delivered = true;
      } catch {
        delivered = false;
      }
      transaction(deps.db, () => {
        deps.db
          .prepare(
            `UPDATE fleet_workers SET interrupt_notice_state = ?
             WHERE id = ? AND fleet_run_id = ? AND session_id = ?
               AND interrupt_requested_at = ?
               AND interrupt_notice_state = 'requested'
               AND 1 = (
                 SELECT COUNT(*) FROM fleet_workers bound
                 WHERE bound.session_id = ?
                   AND bound.status IN ('running', 'waiting_for_operator')
               )`
          )
          .run(
            delivered ? "delivered" : "failed",
            worker.id,
            runId,
            worker.session_id,
            decision.requestedAt,
            worker.session_id
          );
        queries.createFleetEvent(deps.db).run(
          runId,
          delivered
            ? "worker_interrupt_notice_delivered"
            : "worker_interrupt_notice_failed",
          "scheduler",
          JSON.stringify({
            workerId: worker.id,
            sessionId: worker.session_id,
            operationKey: decision.operationKey,
            cause,
            requestedAt: decision.requestedAt,
            deadlineAt: decision.deadlineAt,
          })
        );
      });
      continue;
    }
    const stopClaimed = transaction(deps.db, () => {
      if (decision.replay) {
        return Boolean(
          deps.db
            .prepare(
              `SELECT 1 FROM fleet_workers
               WHERE id = ? AND fleet_run_id = ? AND session_id = ?
                 AND status IN ('running', 'waiting_for_operator')
                 AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
                 AND interrupt_stop_state = 'requested'
                 AND 1 = (
                   SELECT COUNT(*) FROM fleet_workers bound
                   WHERE bound.session_id = ?
                     AND bound.status IN ('running', 'waiting_for_operator')
                 )`
            )
            .get(
              worker.id,
              runId,
              worker.session_id,
              decision.requestedAt,
              decision.deadlineAt,
              worker.session_id
            )
        );
      }
      const changed = deps.db
        .prepare(
          `UPDATE fleet_workers SET interrupt_stop_state = 'requested'
           WHERE id = ? AND fleet_run_id = ? AND session_id = ?
             AND status IN ('running', 'waiting_for_operator')
             AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
             AND interrupt_stop_state = 'unattempted'
             AND 1 = (
               SELECT COUNT(*) FROM fleet_workers bound
               WHERE bound.session_id = ?
                 AND bound.status IN ('running', 'waiting_for_operator')
             )`
        )
        .run(
          worker.id,
          runId,
          worker.session_id,
          decision.requestedAt,
          decision.deadlineAt,
          worker.session_id
        );
      if (changed.changes !== 1) return false;
      queries.createFleetEvent(deps.db).run(
        runId,
        "worker_interrupt_stop_requested",
        "scheduler",
        JSON.stringify({
          workerId: worker.id,
          sessionId: worker.session_id,
          operationKey: decision.operationKey,
          cause,
          requestedAt: decision.requestedAt,
          deadlineAt: decision.deadlineAt,
        })
      );
      return true;
    });
    if (!stopClaimed || !worker.session_id) continue;
    try {
      await deps.stopSession(worker.session_id, "failed");
    } catch {
      continue;
    }
    transaction(deps.db, () => {
      const changed = deps.db
        .prepare(
          `UPDATE fleet_workers SET interrupt_stop_state = 'confirmed',
           terminal_cause = ?
           WHERE id = ? AND fleet_run_id = ? AND session_id = ?
             AND status IN ('running', 'waiting_for_operator')
             AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
             AND interrupt_stop_state = 'requested'
             AND 1 = (
               SELECT COUNT(*) FROM fleet_workers bound
               WHERE bound.session_id = ?
                 AND bound.status IN ('running', 'waiting_for_operator')
             )`
        )
        .run(
          cause === "budget_hard_limit"
            ? "budget_hard_limit_stop_requested"
            : "operator_interrupt_stop_requested",
          worker.id,
          runId,
          worker.session_id,
          decision.requestedAt,
          decision.deadlineAt,
          worker.session_id
        );
      if (changed.changes !== 1) return;
      queries.createFleetEvent(deps.db).run(
        runId,
        "worker_interrupt_stop_confirmed",
        "scheduler",
        JSON.stringify({
          workerId: worker.id,
          sessionId: worker.session_id,
          operationKey: decision.operationKey,
          cause,
          requestedAt: decision.requestedAt,
          deadlineAt: decision.deadlineAt,
        }),
        { controlPlane: true }
      );
    });
  }
}

interface FleetAuxiliaryInterruptRow {
  id: string;
  fleet_run_id: string;
  session_id: string | null;
  owner_type: string;
  owner_id: string;
  interrupt_requested_at: string | null;
  interrupt_deadline_at: string | null;
  interrupt_notice_state: string;
  interrupt_stop_state: string;
  interrupt_cause: string | null;
}

function auxiliarySessionHasExactOwner(
  db: Database.Database,
  account: FleetAuxiliaryInterruptRow
): boolean {
  if (!account.session_id) return false;
  const activeAccounts = db
    .prepare(
      `SELECT COUNT(*) AS count FROM fleet_cost_accounts
       WHERE session_id = ? AND terminal_at IS NULL
         AND reservation_released_at IS NULL`
    )
    .get(account.session_id) as { count: number };
  const activeWorkers = db
    .prepare(
      `SELECT COUNT(*) AS count FROM fleet_workers
       WHERE session_id = ? AND status IN ('running', 'waiting_for_operator')`
    )
    .get(account.session_id) as { count: number };
  return activeAccounts.count === 1 && activeWorkers.count === 0;
}

function recordAuxiliaryInterruptAttention(
  deps: FleetSchedulerDeps,
  account: FleetAuxiliaryInterruptRow,
  reason: string
): void {
  transaction(deps.db, () => {
    const exists = deps.db
      .prepare(
        `SELECT 1 FROM fleet_events
         WHERE fleet_run_id = ?
           AND event_type = 'auxiliary_interrupt_attention_required'
           AND json_valid(payload)
           AND json_extract(payload, '$.accountId') = ?
           AND json_extract(payload, '$.requestedAt') IS ?
         LIMIT 1`
      )
      .get(account.fleet_run_id, account.id, account.interrupt_requested_at);
    if (exists) return;
    queries.createFleetEvent(deps.db).run(
      account.fleet_run_id,
      "auxiliary_interrupt_attention_required",
      "scheduler",
      JSON.stringify({
        accountId: account.id,
        ownerType: account.owner_type,
        ownerId: account.owner_id,
        sessionId: account.session_id,
        requestedAt: account.interrupt_requested_at,
        reason,
      })
    );
  });
}

function confirmAuxiliaryInterruptStop(
  deps: FleetSchedulerDeps,
  account: FleetAuxiliaryInterruptRow,
  requestedAt: string,
  deadlineAt: string,
  operationKey: string
): boolean {
  const ownerType = account.owner_type;
  if (!isAuxiliaryCostOwnerType(ownerType)) return false;
  return transaction(deps.db, () => {
    const now = deps.now();
    let changed = deps.db
      .prepare(
        `UPDATE fleet_cost_accounts SET interrupt_stop_state = 'confirmed',
         updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND owner_type = ? AND owner_id = ?
           AND session_id = ? AND terminal_at IS NULL
           AND reservation_released_at IS NULL
           AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
           AND interrupt_stop_state = 'requested'
           AND 1 = (
             SELECT COUNT(*) FROM fleet_cost_accounts bound
             WHERE bound.session_id = ? AND bound.terminal_at IS NULL
               AND bound.reservation_released_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM fleet_workers worker
             WHERE worker.session_id = ?
               AND worker.status IN ('running', 'waiting_for_operator')
           )`
      )
      .run(
        now.toISOString(),
        account.id,
        account.fleet_run_id,
        ownerType,
        account.owner_id,
        account.session_id,
        requestedAt,
        deadlineAt,
        account.session_id,
        account.session_id
      );
    let settledByOwner = false;
    if (changed.changes !== 1) {
      // The owning runtime may observe the stopped session and settle while the
      // external stop call is in flight. That terminal account is authoritative
      // completion; persist the interrupt confirmation without charging again.
      changed = deps.db
        .prepare(
          `UPDATE fleet_cost_accounts SET interrupt_stop_state = 'confirmed',
           updated_at = ?
           WHERE id = ? AND fleet_run_id = ? AND owner_type = ? AND owner_id = ?
             AND session_id = ? AND terminal_at IS NOT NULL
             AND reservation_released_at IS NOT NULL
             AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
             AND interrupt_stop_state = 'requested'`
        )
        .run(
          now.toISOString(),
          account.id,
          account.fleet_run_id,
          ownerType,
          account.owner_id,
          account.session_id,
          requestedAt,
          deadlineAt
        );
      if (changed.changes !== 1) return false;
      settledByOwner = true;
    }
    if (!settledByOwner) {
      if (
        !settleFleetCostOwner(deps.db, {
          runId: account.fleet_run_id,
          ownerType,
          ownerId: account.owner_id,
          now,
        })
      ) {
        throw new Error("auxiliary interrupt cost settlement changed");
      }
    }
    releaseFleetRuntimeResources(deps.db, {
      ownerType,
      ownerId: account.owner_id,
      now,
    });
    queries.createFleetEvent(deps.db).run(
      account.fleet_run_id,
      "auxiliary_interrupt_stop_confirmed",
      "scheduler",
      JSON.stringify({
        accountId: account.id,
        ownerType,
        ownerId: account.owner_id,
        sessionId: account.session_id,
        operationKey,
        cause: account.interrupt_cause,
        requestedAt,
        deadlineAt,
        settledByOwner,
      }),
      { controlPlane: true }
    );
    return true;
  });
}

async function processFleetAuxiliaryInterrupts(
  deps: FleetSchedulerDeps,
  runId: string
): Promise<void> {
  const accounts = deps.db
    .prepare(
      `SELECT id, fleet_run_id, session_id, owner_type, owner_id,
              interrupt_requested_at, interrupt_deadline_at,
              interrupt_notice_state, interrupt_stop_state, interrupt_cause
       FROM fleet_cost_accounts
       WHERE fleet_run_id = ? AND owner_type <> 'worker'
         AND terminal_at IS NULL AND reservation_released_at IS NULL
         AND interrupt_requested_at IS NOT NULL
         AND interrupt_deadline_at IS NOT NULL
       ORDER BY interrupt_requested_at, id LIMIT ?`
    )
    .all(runId, FLEET_INTERRUPT_MAX_WORKERS) as FleetAuxiliaryInterruptRow[];

  for (const account of accounts) {
    if (!isAuxiliaryCostOwnerType(account.owner_type)) {
      recordAuxiliaryInterruptAttention(
        deps,
        account,
        "auxiliary interrupt owner type is invalid"
      );
      continue;
    }
    if (!auxiliarySessionHasExactOwner(deps.db, account)) {
      recordAuxiliaryInterruptAttention(
        deps,
        account,
        "interrupt session is not bound to exactly one active auxiliary owner"
      );
      continue;
    }
    if (
      account.interrupt_cause !== "budget_hard_limit" &&
      account.interrupt_cause !== "operator_pause"
    ) {
      recordAuxiliaryInterruptAttention(
        deps,
        account,
        "auxiliary interrupt cause is invalid"
      );
      continue;
    }
    const decision = decideFleetInterruptAction(
      {
        runId,
        workerId: account.id,
        sessionId: account.session_id,
        workerStatus: "running",
        interruptRequestedAt: account.interrupt_requested_at,
        interruptDeadlineAt: account.interrupt_deadline_at,
        noticeState: account.interrupt_notice_state,
        stopState: account.interrupt_stop_state,
      },
      deps.now()
    );
    if (decision.kind === "operator_attention") {
      recordAuxiliaryInterruptAttention(deps, account, decision.reason);
      continue;
    }
    if (decision.kind === "none" || decision.kind === "wait_for_deadline") {
      continue;
    }
    if (decision.kind === "deliver_notice") {
      const claimed = transaction(deps.db, () => {
        if (decision.replay) {
          return Boolean(
            deps.db
              .prepare(
                `SELECT 1 FROM fleet_cost_accounts
                 WHERE id = ? AND fleet_run_id = ? AND session_id = ?
                   AND terminal_at IS NULL AND reservation_released_at IS NULL
                   AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
                   AND interrupt_notice_state = 'requested'`
              )
              .get(
                account.id,
                runId,
                account.session_id,
                decision.requestedAt,
                decision.deadlineAt
              )
          );
        }
        const changed = deps.db
          .prepare(
            `UPDATE fleet_cost_accounts SET interrupt_notice_state = 'requested',
             updated_at = ?
             WHERE id = ? AND fleet_run_id = ? AND session_id = ?
               AND terminal_at IS NULL AND reservation_released_at IS NULL
               AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
               AND interrupt_notice_state = 'unattempted'`
          )
          .run(
            deps.now().toISOString(),
            account.id,
            runId,
            account.session_id,
            decision.requestedAt,
            decision.deadlineAt
          );
        if (changed.changes !== 1) return false;
        queries.createFleetEvent(deps.db).run(
          runId,
          "auxiliary_interrupt_notice_claimed",
          "scheduler",
          JSON.stringify({
            accountId: account.id,
            ownerType: account.owner_type,
            ownerId: account.owner_id,
            sessionId: account.session_id,
            operationKey: decision.operationKey,
            cause: account.interrupt_cause,
            requestedAt: decision.requestedAt,
            deadlineAt: decision.deadlineAt,
          })
        );
        return true;
      });
      if (!claimed || !account.session_id) continue;
      let delivered = false;
      try {
        await deps.sendMessage(
          account.session_id,
          account.interrupt_cause === "budget_hard_limit"
            ? "[Stoa Fleet] The configured hard budget limit has been reached. Reach a safe stopping point now; Stoa will stop this auxiliary agent after the grace period."
            : "[Stoa Fleet] This run was paused with interruption requested. Reach a safe stopping point now; Stoa will stop this auxiliary agent after the grace period."
        );
        delivered = true;
      } catch {
        delivered = false;
      }
      transaction(deps.db, () => {
        const changed = deps.db
          .prepare(
            `UPDATE fleet_cost_accounts SET interrupt_notice_state = ?,
             updated_at = ?
             WHERE id = ? AND fleet_run_id = ? AND session_id = ?
               AND terminal_at IS NULL AND reservation_released_at IS NULL
               AND interrupt_requested_at = ?
               AND interrupt_notice_state = 'requested'`
          )
          .run(
            delivered ? "delivered" : "failed",
            deps.now().toISOString(),
            account.id,
            runId,
            account.session_id,
            decision.requestedAt
          );
        if (changed.changes !== 1) return;
        queries.createFleetEvent(deps.db).run(
          runId,
          delivered
            ? "auxiliary_interrupt_notice_delivered"
            : "auxiliary_interrupt_notice_failed",
          "scheduler",
          JSON.stringify({
            accountId: account.id,
            ownerType: account.owner_type,
            ownerId: account.owner_id,
            sessionId: account.session_id,
            operationKey: decision.operationKey,
            cause: account.interrupt_cause,
            requestedAt: decision.requestedAt,
            deadlineAt: decision.deadlineAt,
          })
        );
      });
      continue;
    }

    const stopClaimed = transaction(deps.db, () => {
      if (decision.replay) {
        return Boolean(
          deps.db
            .prepare(
              `SELECT 1 FROM fleet_cost_accounts
               WHERE id = ? AND fleet_run_id = ? AND session_id = ?
                 AND terminal_at IS NULL AND reservation_released_at IS NULL
                 AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
                 AND interrupt_stop_state = 'requested'`
            )
            .get(
              account.id,
              runId,
              account.session_id,
              decision.requestedAt,
              decision.deadlineAt
            )
        );
      }
      const changed = deps.db
        .prepare(
          `UPDATE fleet_cost_accounts SET interrupt_stop_state = 'requested',
           updated_at = ?
           WHERE id = ? AND fleet_run_id = ? AND session_id = ?
             AND terminal_at IS NULL AND reservation_released_at IS NULL
             AND interrupt_requested_at = ? AND interrupt_deadline_at = ?
             AND interrupt_stop_state = 'unattempted'`
        )
        .run(
          deps.now().toISOString(),
          account.id,
          runId,
          account.session_id,
          decision.requestedAt,
          decision.deadlineAt
        );
      if (changed.changes !== 1) return false;
      queries.createFleetEvent(deps.db).run(
        runId,
        "auxiliary_interrupt_stop_requested",
        "scheduler",
        JSON.stringify({
          accountId: account.id,
          ownerType: account.owner_type,
          ownerId: account.owner_id,
          sessionId: account.session_id,
          operationKey: decision.operationKey,
          cause: account.interrupt_cause,
          requestedAt: decision.requestedAt,
          deadlineAt: decision.deadlineAt,
        })
      );
      return true;
    });
    if (!stopClaimed || !account.session_id) continue;

    const session = queries.getSession(deps.db).get(account.session_id) as
      Session | undefined;
    let knownStopped = false;
    if (decision.replay && session) {
      try {
        knownStopped = !(await deps.sessionExists(session));
      } catch {
        knownStopped = false;
      }
    }
    if (!knownStopped) {
      try {
        await deps.stopSession(account.session_id, "failed");
        knownStopped = true;
      } catch {
        if (session) {
          try {
            knownStopped = !(await deps.sessionExists(session));
          } catch {
            knownStopped = false;
          }
        }
      }
    }
    if (!knownStopped) continue;
    confirmAuxiliaryInterruptStop(
      deps,
      account,
      decision.requestedAt,
      decision.deadlineAt,
      decision.operationKey
    );
  }
}

async function reconcileFleetCostTelemetryWithDeps(
  deps: FleetSchedulerDeps
): Promise<number> {
  const now = deps.now();
  const previous = fleetCostSampleAt.get(deps.db);
  if (
    previous != null &&
    now.getTime() - previous < FLEET_COST_SAMPLE_INTERVAL_MS
  ) {
    return 0;
  }
  // Advance before transcript reads so a persistent failure backs off instead of
  // turning the scheduler cadence into a tight cost-reader retry loop.
  fleetCostSampleAt.set(deps.db, now.getTime());
  const accounts = deps.db
    .prepare(
      `SELECT a.fleet_run_id, a.owner_type, a.owner_id, a.session_id
       FROM fleet_cost_accounts a
       JOIN sessions s ON s.id = a.session_id
       WHERE a.terminal_at IS NULL
       ORDER BY COALESCE(a.last_sample_at, '') ASC, a.updated_at ASC, a.id ASC
       LIMIT ?`
    )
    .all(FLEET_COST_SAMPLE_MAX_PER_TICK) as Array<{
    fleet_run_id: string;
    owner_type: string;
    owner_id: string;
    session_id: string;
  }>;
  if (accounts.length === 0) return 0;
  const getSession = queries.getSession(deps.db);
  const sessions = accounts
    .map((account) => getSession.get(account.session_id) as Session | undefined)
    .filter((session): session is Session => session != null);
  if (sessions.length === 0) return 0;
  await deps.sampleCosts(sessions, now.getTime());
  for (const account of accounts) {
    reconcileFleetCostAccount(deps.db, {
      runId: account.fleet_run_id,
      ownerType: account.owner_type,
      ownerId: account.owner_id,
      now,
    });
  }
  return sessions.length;
}

/** Bounded Fleet-owned sampling, independent of the opt-in global cost loop. */
export async function reconcileFleetCostTelemetry(
  overrides: Partial<FleetSchedulerDeps> = {}
): Promise<number> {
  return reconcileFleetCostTelemetryWithDeps(schedulerDeps(overrides));
}

async function reconcilePendingCleanup(
  deps: FleetSchedulerDeps
): Promise<void> {
  const workers = deps.db
    .prepare(
      `SELECT w.*, r.status AS run_status FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE w.status = 'cleanup_pending'`
    )
    .all() as (FleetWorkerRow & { run_status: string })[];
  for (const worker of workers) {
    const reportCleanup = worker.terminal_cause === "report_collection_pending";
    const successfulReport =
      worker.report_state === "accepted" &&
      worker.report_status === "succeeded";
    const completionCleanup =
      worker.terminal_cause?.startsWith("operator_completion") === true ||
      worker.terminal_cause?.startsWith("session_completed") === true ||
      (reportCleanup && successfulReport);
    let session = worker.session_id
      ? (queries.getSession(deps.db).get(worker.session_id) as
          Session | undefined)
      : undefined;
    if (!session && worker.spawn_request_id) {
      session = deps.db
        .prepare(
          `SELECT * FROM sessions WHERE worker_task LIKE ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(`%${worker.spawn_request_id}%`) as Session | undefined;
    }
    let stopped = !session;
    if (!session && launchingWorkers.has(worker.id)) {
      stopped = false;
    }
    if (session) {
      try {
        await deps.stopSession(
          session.id,
          completionCleanup ? "completed" : "failed"
        );
        stopped = true;
      } catch {
        stopped = false;
      }
    }
    transaction(deps.db, () => {
      const nowIso = deps.now().toISOString();
      if (!stopped) return;
      const terminalSessionCleanup =
        completionCleanup ||
        reportCleanup ||
        worker.terminal_cause?.startsWith("session_failed") === true;
      const finalStatus =
        worker.run_status === "canceled"
          ? "cleanup_complete"
          : reportCleanup
            ? successfulReport
              ? "completed"
              : "failed"
            : completionCleanup
              ? "completed"
              : "failed";
      const finalCause =
        worker.run_status === "canceled"
          ? "operator_cancel"
          : reportCleanup
            ? successfulReport
              ? "report_collected"
              : worker.report_state === "invalid"
                ? "report_invalid"
                : `report_attention_${worker.report_status ?? "unknown"}`
            : completionCleanup
              ? "session_completed"
              : terminalSessionCleanup
                ? "session_failed"
                : "spawn_failed_preserved";
      const cleanupUpdate = deps.db
        .prepare(
          `UPDATE fleet_workers SET status = ?, terminal_cause = ?,
           session_id = COALESCE(session_id, ?), worktree_path = COALESCE(worktree_path, ?), ended_at = ?
           WHERE id = ? AND status = 'cleanup_pending' AND terminal_cause IS ?`
        )
        .run(
          finalStatus,
          finalCause,
          session?.id ?? null,
          session?.worktree_path ?? null,
          nowIso,
          worker.id,
          worker.terminal_cause ?? null
        );
      if (cleanupUpdate.changes !== 1) return;
      if (worker.run_status === "canceled") {
        releaseWorkerResources(deps.db, worker.id, nowIso);
      } else {
        releaseWorkerResourcesExceptWorktree(deps.db, worker.id, nowIso);
      }
      if (terminalSessionCleanup) {
        settleWorkerBudget(
          deps.db,
          worker.id,
          new Date(nowIso),
          worker.run_status !== "canceled"
        );
        if (!reportCleanup) {
          deps.db
            .prepare(
              `UPDATE fleet_tasks SET status = ?, failure_code = ?, ended_at = ?, updated_at = ?
               WHERE id = ? AND status IN ('running', 'waiting_for_operator')`
            )
            .run(
              completionCleanup ? "needs_inspection" : "failed",
              finalCause,
              nowIso,
              nowIso,
              worker.task_id
            );
        }
      } else if (worker.run_status === "canceled") {
        settleWorkerBudget(deps.db, worker.id, new Date(nowIso), false);
      }
      queries.createFleetEvent(deps.db).run(
        worker.fleet_run_id,
        worker.run_status === "canceled"
          ? "cancel_cleanup_completed"
          : terminalSessionCleanup
            ? "worker_terminal_cleanup_completed"
            : "spawn_cleanup_completed",
        "recovery",
        JSON.stringify({
          workerId: worker.id,
          sessionId: session?.id ?? null,
        })
      );
    });
  }
}

/** Collect one worker's authenticated report without leasing additional work. */
export async function reconcileFleetWorkerReport(
  runId: string,
  workerId: string,
  overrides: Partial<FleetSchedulerDeps> = {}
): Promise<boolean> {
  if (Object.keys(overrides).length === 0 && !isFleetSchedulerReady()) {
    throw new Error("fleet scheduler recovery has not completed");
  }
  if (runLocks.has(runId)) return false;
  runLocks.add(runId);
  const deps = schedulerDeps(overrides);
  try {
    const run = queries.getFleetRun(deps.db).get(runId) as
      FleetRunRow | undefined;
    const worker = deps.db
      .prepare(`SELECT * FROM fleet_workers WHERE id = ? AND fleet_run_id = ?`)
      .get(workerId, runId) as FleetWorkerRow | undefined;
    const task = worker?.task_id
      ? (deps.db
          .prepare(
            `SELECT * FROM fleet_tasks WHERE id = ? AND fleet_run_id = ?`
          )
          .get(worker.task_id, runId) as FleetTaskRow | undefined)
      : undefined;
    if (!run || !worker || !task) return false;
    const session = worker.session_id
      ? (queries.getSession(deps.db).get(worker.session_id) as
          Session | undefined)
      : undefined;
    return pollFleetWorkerReport(deps, run, task, worker, session, true);
  } finally {
    runLocks.delete(runId);
  }
}

export async function reconcileFleetRun(
  runId: string,
  overrides: Partial<FleetSchedulerDeps> = {}
): Promise<number> {
  if (Object.keys(overrides).length === 0 && !isFleetSchedulerReady()) {
    throw new Error("fleet scheduler recovery has not completed");
  }
  if (runLocks.has(runId)) return 0;
  runLocks.add(runId);
  const deps = schedulerDeps(overrides);
  try {
    // A run still being recovered is deliberately inert. Public launch
    // surfaces perform their own 503 boundary before reaching the scheduler;
    // the internal reconciler instead reports that it launched no work so the
    // recovery loop can continue settling persisted leases.
    if (fleetRecoveryUnavailable(deps.db, runId)) return 0;
    await reconcileFleetCostTelemetryWithDeps(deps);
    await pollActiveWorkers(deps, runId);
    enforceFleetBudget(deps, runId);
    await processFleetInterrupts(deps, runId);
    await processFleetAuxiliaryInterrupts(deps, runId);
    const leases: LeasedTask[] = [];
    while (true) {
      const lease = leaseOne(deps, runId);
      if (!lease) break;
      leases.push(lease);
    }
    await Promise.all(leases.map((lease) => launchLease(deps, lease)));
    return leases.length;
  } finally {
    runLocks.delete(runId);
  }
}

export async function reconcileFleetRuns(
  overrides: Partial<FleetSchedulerDeps> = {}
): Promise<number> {
  if (Object.keys(overrides).length === 0 && !isFleetSchedulerReady()) {
    throw new Error("fleet scheduler recovery has not completed");
  }
  const deps = schedulerDeps(overrides);
  await reconcilePendingCleanup(deps);
  // Sampling and aggregate budget enforcement are control-plane work, not a
  // worker phase. Planners and reviewers can accrue cost while a run is still
  // draft, and fixers remain paid owners while the presentation status is
  // reviewing. Run this once before selecting worker-bearing runs.
  await reconcileFleetCostTelemetryWithDeps(deps);
  enforceAllFleetBudgets(deps);
  // The automatic scheduler owns one global rendered-screen batch. Calling the
  // collector from each run would multiply terminal IPC and defeat its hard
  // cross-run cap; injected test/runtime dependencies may exercise it directly.
  if (Object.keys(overrides).length === 0) {
    await reconcileFleetRenderedStatuses({ db: deps.db, now: deps.now });
  }
  const runs = deps.db
    .prepare(
      `SELECT id FROM fleet_runs
       WHERE (
         status IN ('running', 'reviewing', 'merging')
           AND desired_state = 'running' AND recovery_required = 0
       ) OR (
         status = 'paused' AND recovery_required = 0 AND (
           EXISTS (
             SELECT 1 FROM fleet_workers
             WHERE fleet_workers.fleet_run_id = fleet_runs.id
               AND fleet_workers.status IN ('running', 'waiting_for_operator')
           ) OR EXISTS (
             SELECT 1 FROM fleet_cost_accounts account
             WHERE account.fleet_run_id = fleet_runs.id
               AND account.owner_type <> 'worker'
               AND account.terminal_at IS NULL
               AND account.reservation_released_at IS NULL
               AND account.interrupt_requested_at IS NOT NULL
           )
         )
       )`
    )
    .all() as { id: string }[];
  const results = await Promise.all(
    runs.map((run) => reconcileFleetRun(run.id, deps))
  );
  return results.reduce((total, count) => total + count, 0);
}

export async function recoverFleetRuns(
  overrides: Partial<FleetSchedulerDeps> = {},
  options: { runId?: string; markActive?: boolean } = {}
): Promise<void> {
  const deps = schedulerDeps(overrides);
  const nowIso = deps.now().toISOString();
  await reconcilePendingCleanup(deps);
  if (options.markActive !== false) {
    deps.db
      .prepare(
        `UPDATE fleet_runs SET recovery_required = 1
         WHERE ((status IN ('running', 'reviewing', 'merging')
                  AND desired_state = 'running')
           OR (status = 'paused' AND EXISTS (
             SELECT 1 FROM fleet_workers
             WHERE fleet_workers.fleet_run_id = fleet_runs.id
               AND fleet_workers.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')
           )))${options.runId ? " AND id = ?" : ""}`
      )
      .run(...(options.runId ? [options.runId] : []));
  }
  const runs = deps.db
    .prepare(
      `SELECT * FROM fleet_runs
       WHERE status IN ('running', 'reviewing', 'merging', 'paused')
         AND recovery_required = 1${options.runId ? " AND id = ?" : ""}`
    )
    .all(...(options.runId ? [options.runId] : [])) as FleetRunRow[];
  for (const run of runs) {
    const workers = deps.db
      .prepare(
        `SELECT * FROM fleet_workers WHERE fleet_run_id = ? AND status IN ('leasing', 'spawning')`
      )
      .all(run.id) as FleetWorkerRow[];
    let unresolved = false;
    for (const worker of workers) {
      let session = worker.session_id
        ? (queries.getSession(deps.db).get(worker.session_id) as
            Session | undefined)
        : undefined;
      if (!session && worker.spawn_request_id) {
        session = deps.db
          .prepare(
            `SELECT * FROM sessions WHERE worker_task LIKE ? ORDER BY created_at DESC LIMIT 1`
          )
          .get(`%${worker.spawn_request_id}%`) as Session | undefined;
      }
      if (session && (await deps.sessionExists(session))) {
        transaction(deps.db, () => {
          const workerUpdate = deps.db
            .prepare(
              `UPDATE fleet_workers SET status = 'running', session_id = ?, worktree_path = ?,
               branch_name = COALESCE(branch_name, ?), lease_owner = NULL,
               lease_expires_at = NULL, last_heartbeat_at = ?
               WHERE id = ? AND status IN ('leasing', 'spawning')`
            )
            .run(
              session.id,
              session.worktree_path,
              session.branch_name,
              nowIso,
              worker.id
            );
          if (workerUpdate.changes !== 1) return;
          deps.db
            .prepare(
              `UPDATE fleet_tasks SET status = 'running', worktree_path = ?,
               branch_name = COALESCE(branch_name, ?), lease_owner = NULL,
               lease_expires_at = NULL, retry_not_before = NULL,
               provider_failure_count = 0, provider_state = 'running',
               provider_last_error = NULL, provider_backoff_event_at = NULL,
               updated_at = ?
               WHERE id = ? AND status IN ('leasing', 'spawning')`
            )
            .run(
              session.worktree_path,
              session.branch_name,
              nowIso,
              worker.task_id
            );
          if (session.worktree_path) {
            deps.db
              .prepare(
                `UPDATE fleet_resource_leases SET resource_key = ?
                 WHERE worker_id = ? AND resource_type = 'worktree'
                   AND status = 'reserved'`
              )
              .run(session.worktree_path, worker.id);
          }
          deps.db
            .prepare(
              `UPDATE fleet_runtime_leases SET lease_expires_at = NULL
               WHERE owner_type = 'worker' AND owner_id = ? AND status = 'reserved'`
            )
            .run(worker.id);
          if (
            !registerFleetCostAccount(deps.db, {
              runId: run.id,
              ownerType: "worker",
              ownerId: worker.id,
              taskId: worker.task_id,
              session,
              provider: worker.provider ?? run.provider,
              model: worker.model ?? run.model,
              confidence: worker.reservation_confidence,
              reservation: {
                usd: worker.reservation_usd ?? 0,
                tokens: worker.reservation_tokens ?? 0,
                confidence: worker.reservation_confidence ?? "unknown",
                basis: (worker.reservation_basis ??
                  "unknown-provider") as FleetTaskReservation["basis"],
                sampleCount: 0,
              },
            })
          ) {
            throw new Error(
              "recovered worker session is already owned by another Fleet cost account"
            );
          }
          clearFleetProviderCooldown(deps.db, worker.provider ?? run.provider);
          releaseWorkerResources(deps.db, worker.id, nowIso, "git_operation");
        });
        continue;
      }
      const expired =
        !worker.lease_expires_at || worker.lease_expires_at <= nowIso;
      if (!expired) {
        unresolved = true;
        continue;
      }
      const task = deps.db
        .prepare(`SELECT * FROM fleet_tasks WHERE id = ?`)
        .get(worker.task_id) as FleetTaskRow | undefined;
      const committed = session != null || worker.worktree_path != null;
      const retry =
        !committed &&
        !!task &&
        (task.current_attempt ?? worker.attempt) < (task.max_attempts ?? 2);
      const providerFailureCount = (task?.provider_failure_count ?? 0) + 1;
      const retryNotBefore = retry
        ? fleetProviderRetryNotBefore(new Date(nowIso), providerFailureCount)
        : null;
      transaction(deps.db, () => {
        const workerUpdate = deps.db
          .prepare(
            `UPDATE fleet_workers SET status = 'failed', terminal_cause = 'recovery_expired',
             session_id = COALESCE(session_id, ?), worktree_path = COALESCE(worktree_path, ?),
             ended_at = ?, lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ? AND status IN ('leasing', 'spawning')`
          )
          .run(
            session?.id ?? null,
            session?.worktree_path ?? worker.worktree_path ?? null,
            nowIso,
            worker.id
          );
        if (workerUpdate.changes !== 1) return;
        if (committed) {
          releaseWorkerResourcesExceptWorktree(deps.db, worker.id, nowIso);
        } else {
          releaseWorkerResources(deps.db, worker.id, nowIso);
        }
        deps.db
          .prepare(
            `UPDATE fleet_tasks SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
             spawn_request_id = CASE WHEN ? THEN NULL ELSE spawn_request_id END,
             retry_not_before = ?, provider_failure_count = ?, provider_state = ?,
             provider_last_error = 'spawn lease expired during recovery',
             provider_backoff_event_at = ?,
             failure_code = 'recovery_expired', ended_at = CASE WHEN ? THEN NULL ELSE ? END,
             updated_at = ? WHERE id = ? AND status IN ('leasing', 'spawning')`
          )
          .run(
            committed ? "needs_inspection" : retry ? "ready" : "failed",
            retry ? 1 : 0,
            retryNotBefore,
            providerFailureCount,
            retry ? "backoff" : "failed",
            retry ? nowIso : null,
            retry ? 1 : 0,
            nowIso,
            nowIso,
            worker.task_id
          );
        if (committed) {
          deps.db
            .prepare(
              `UPDATE fleet_tasks SET worktree_path = COALESCE(worktree_path, ?) WHERE id = ?`
            )
            .run(
              session?.worktree_path ?? worker.worktree_path ?? null,
              worker.task_id
            );
        }
        settleWorkerBudget(deps.db, worker.id, new Date(nowIso), committed);
        queries.createFleetEvent(deps.db).run(
          run.id,
          "recovery_expired",
          "recovery",
          JSON.stringify({
            workerId: worker.id,
            retry,
            retryNotBefore,
            providerFailureCount,
            committed,
          })
        );
      });
    }
    await pollActiveWorkers(deps, run.id);
    if (unresolved) {
      transaction(deps.db, () => {
        const paused = deps.db
          .prepare(
            `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused',
             pause_mode = 'pause-new', pause_reason = 'recovery_unresolved', updated_at = ?
             WHERE id = ? AND (status <> 'paused' OR pause_reason IS NOT 'recovery_unresolved')`
          )
          .run(nowIso, run.id);
        if (paused.changes === 1) {
          queries
            .createFleetEvent(deps.db)
            .run(run.id, "recovery_needs_operator", "recovery", null);
        }
      });
    } else {
      transaction(deps.db, () => {
        const cleared = deps.db
          .prepare(
            `UPDATE fleet_runs SET recovery_required = 0, updated_at = ?
             WHERE id = ? AND recovery_required = 1`
          )
          .run(nowIso, run.id);
        if (cleared.changes === 1) {
          queries
            .createFleetEvent(deps.db)
            .run(run.id, "recovery_completed", "recovery", null);
        }
      });
    }
  }
}

export async function recoverFleetRun(
  runId: string,
  overrides: Partial<FleetSchedulerDeps> = {}
): Promise<void> {
  await recoverFleetRuns(overrides, { runId, markActive: false });
}

export async function initializeFleetScheduler(): Promise<void> {
  setFleetSchedulerReady(false);
  await recoverFleetRuns();
  setFleetSchedulerReady(true);
}
