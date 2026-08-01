import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import {
  availableFleetSlots,
  canReserveFleetBudget,
  FLEET_DEFAULT_PARALLEL_WORKERS,
  FLEET_MAX_TOTAL_WORKERS,
  FLEET_WORKER_RESERVATION_USD,
  providerConcurrencyCap,
} from "./admission";
import { fleetClaimsConflict } from "./conflicts";
import {
  FleetSpawnError,
  spawnFleetWorker,
  type FleetSpawnResult,
} from "./spawn";
import { hashFleetExecutionContract, hashFleetTaskRows } from "./hash";
import { stopFleetSession } from "./stop";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "./types";

const ACTIVE_WORKER_STATUSES = [
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "cleanup_pending",
] as const;
const TERMINAL_TASK_STATUSES = ["completed", "merged", "skipped"];
const LEASE_MS = 2 * 60 * 1000;
const runLocks = new Set<string>();
const launchingWorkers = new Set<string>();
const fleetGlobal = globalThis as typeof globalThis & {
  __stoaFleetSchedulerReady?: boolean;
};
if (fleetGlobal.__stoaFleetSchedulerReady == null) {
  fleetGlobal.__stoaFleetSchedulerReady = false;
}

export function isFleetSchedulerReady(): boolean {
  return fleetGlobal.__stoaFleetSchedulerReady === true;
}

export interface FleetSchedulerDeps {
  db: Database.Database;
  now: () => Date;
  spawn: typeof spawnFleetWorker;
  sessionExists: (session: Session) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<void>;
}

function schedulerDeps(
  overrides: Partial<FleetSchedulerDeps>
): FleetSchedulerDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    spawn: overrides.spawn ?? spawnFleetWorker,
    sessionExists:
      overrides.sessionExists ??
      (async (session) => getSessionBackend().exists(session.tmux_name)),
    stopSession:
      overrides.stopSession ??
      (async (sessionId, finalStatus = "failed") => {
        if (!(await stopFleetSession(sessionId, finalStatus))) {
          throw new Error("worker session remained alive after stop");
        }
      }),
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
      | { title: string; status: string }
      | undefined;
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
      | { status: string }
      | undefined;
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
      | { status: string }
      | undefined;
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
      | DispatchRepo
      | undefined;
    if (repo?.repo_path) return repo.repo_path;
  }
  if (run.project_id) {
    const project = queries.getProject(db).get(run.project_id) as
      | Project
      | undefined;
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
      | DispatchRepo
      | undefined;
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
    if (!run || run.status !== "running" || run.approval_state !== "approved")
      return null;
    if (run.recovery_required === 1) return null;
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
      hashFleetTaskRows(approvedTasks) !== run.approved_plan_hash ||
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
    if (
      runActive.n >= run.max_concurrency ||
      localActive.n >= FLEET_DEFAULT_PARALLEL_WORKERS ||
      totalActive.n >= FLEET_MAX_TOTAL_WORKERS
    )
      return null;
    if (
      !canReserveFleetBudget({
        budgetUsd: run.budget_usd,
        reservedBudgetUsd: run.reserved_budget_usd ?? 0,
        spentBudgetUsd: run.spent_budget_usd ?? 0,
      })
    ) {
      const ready = db
        .prepare(
          `SELECT 1 FROM fleet_tasks WHERE fleet_run_id = ? AND status = 'ready' LIMIT 1`
        )
        .get(runId);
      if (ready) {
        const changedAt = now().toISOString();
        db.prepare(
          `UPDATE fleet_runs SET status = 'paused', pause_mode = 'pause-new', pause_reason = 'budget_exhausted', updated_at = ? WHERE id = ?`
        ).run(changedAt, runId);
        queries.createFleetEvent(db).run(
          runId,
          "budget_reservation_blocked",
          "scheduler",
          JSON.stringify({
            budgetUsd: run.budget_usd,
            reservedBudgetUsd: run.reserved_budget_usd ?? 0,
            spentBudgetUsd: run.spent_budget_usd ?? 0,
            requestedReservationUsd: FLEET_WORKER_RESERVATION_USD,
          })
        );
      }
      return null;
    }

    const candidates = db
      .prepare(
        `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? AND status = 'ready'
         AND approval_state = 'approved' AND current_attempt < max_attempts
         ORDER BY priority DESC, sort_order ASC`
      )
      .all(runId) as FleetTaskRow[];
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
      return providerActive.n < providerConcurrencyCap(candidateProvider);
    });
    if (!task) return null;
    const effectiveProvider = task.agent_type ?? run.provider;
    const providerActive = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers WHERE provider = ? AND status IN (${activePlaceholders()})`
      )
      .get(effectiveProvider, ...ACTIVE_WORKER_STATUSES) as { n: number };
    if (
      availableFleetSlots({
        requestedConcurrency: run.max_concurrency,
        runActiveWorkers: runActive.n,
        localActiveWorkers: localActive.n,
        providerActiveWorkers: providerActive.n,
        totalWorkers: totalActive.n,
        provider: effectiveProvider,
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

    const attempt = (task.current_attempt ?? 0) + 1;
    const spawnRequestId = `${runId}:${task.id}:${attempt}`;
    const workerId = randomUUID();
    const leaseOwner = randomUUID();
    const nowIso = now().toISOString();
    const leaseExpires = new Date(now().getTime() + LEASE_MS).toISOString();
    const epoch = (run.scheduler_epoch ?? 0) + 1;
    const claimed = db
      .prepare(
        `UPDATE fleet_tasks SET status = 'leasing', current_attempt = ?, lease_owner = ?,
       lease_expires_at = ?, scheduler_epoch = ?, spawn_request_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
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
    if (claimed.changes !== 1) return null;
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, provider, model, attempt, spawn_request_id,
        lease_owner, lease_expires_at, reservation_usd, created_at)
       VALUES (?, ?, ?, 'spawning', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      workerId,
      runId,
      task.id,
      effectiveProvider,
      task.model ?? run.model,
      attempt,
      spawnRequestId,
      leaseOwner,
      leaseExpires,
      FLEET_WORKER_RESERVATION_USD,
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
      `UPDATE fleet_runs SET scheduler_epoch = ?, reserved_budget_usd = reserved_budget_usd + ?, updated_at = ? WHERE id = ?`
    ).run(epoch, FLEET_WORKER_RESERVATION_USD, nowIso, runId);
    queries
      .createFleetEvent(db)
      .run(
        runId,
        "worker_leased",
        "scheduler",
        JSON.stringify({ taskId: task.id, workerId, spawnRequestId, attempt })
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
  try {
    launchingWorkers.add(lease.workerId);
    const result: FleetSpawnResult = await Promise.resolve()
      .then(() =>
        deps.spawn({
          run: lease.run,
          task: lease.task,
          workingDirectory: lease.workingDirectory,
          claims: lease.claims,
          dependencies: lease.dependencies,
          attempt: lease.attempt,
          spawnRequestId: lease.spawnRequestId,
        })
      )
      .finally(() => launchingWorkers.delete(lease.workerId));
    const launchOutcome = transaction<"accepted" | "idempotent" | "cleanup">(
      deps.db,
      () => {
        const nowIso = deps.now().toISOString();
        const workerUpdate = deps.db
          .prepare(
            `UPDATE fleet_workers SET status = 'running', session_id = ?, worktree_path = ?, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = ? WHERE id = ? AND spawn_request_id = ? AND status = 'spawning'`
          )
          .run(
            result.sessionId,
            result.worktreePath,
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
              `UPDATE fleet_workers SET session_id = COALESCE(session_id, ?), worktree_path = COALESCE(worktree_path, ?) WHERE id = ?`
            )
            .run(result.sessionId, result.worktreePath, lease.workerId);
          if (
            current?.status === "running" &&
            current.spawn_request_id === lease.spawnRequestId &&
            (current.session_id == null ||
              current.session_id === result.sessionId)
          ) {
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
        releaseWorkerResources(
          deps.db,
          lease.workerId,
          nowIso,
          "git_operation"
        );
        deps.db
          .prepare(
            `UPDATE fleet_tasks SET status = 'running', worktree_path = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND spawn_request_id = ? AND status = 'leasing'`
          )
          .run(
            result.worktreePath,
            nowIso,
            lease.task.id,
            lease.spawnRequestId
          );
        queries.createFleetEvent(deps.db).run(
          lease.run.id,
          "worker_started",
          "scheduler",
          JSON.stringify({
            taskId: lease.task.id,
            workerId: lease.workerId,
            sessionId: result.sessionId,
          })
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
            | FleetRunRow
            | undefined;
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
            releaseWorkerResources(deps.db, lease.workerId, nowIso);
          } else {
            deps.db
              .prepare(
                `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
                 WHERE worker_id = ? AND status = 'reserved' AND resource_type <> 'worktree'`
              )
              .run(nowIso, lease.workerId);
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
            | FleetRunRow
            | undefined;
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
      error instanceof FleetSpawnError ? error.sessionId : null;
    const failedWorktreePath =
      error instanceof FleetSpawnError ? error.worktreePath : null;
    const preserved = failedSessionId != null || failedWorktreePath != null;
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
      const current = deps.db
        .prepare(`SELECT status FROM fleet_workers WHERE id = ?`)
        .get(lease.workerId) as { status: string } | undefined;
      if (current?.status !== "spawning") return;
      const retry =
        !preserved && lease.attempt < (lease.task.max_attempts ?? 2);
      deps.db
        .prepare(
          `UPDATE fleet_workers SET status = ?, terminal_cause = ?, failure_code = ?,
           session_id = COALESCE(?, session_id), worktree_path = COALESCE(?, worktree_path),
           ended_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`
        )
        .run(
          stopFailed ? "cleanup_pending" : "failed",
          stopFailed
            ? "spawn_stop_failed"
            : preserved
              ? "spawn_failed_preserved"
              : "spawn_failed",
          error instanceof Error ? error.message.slice(0, 500) : "spawn failed",
          failedSessionId,
          failedWorktreePath,
          stopFailed ? null : nowIso,
          lease.workerId
        );
      if (preserved) {
        deps.db
          .prepare(
            `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
             WHERE worker_id = ? AND status = 'reserved'
               AND resource_type NOT IN ('worktree'${stopFailed ? ", 'pty', 'provider'" : ""})`
          )
          .run(nowIso, lease.workerId);
      } else {
        releaseWorkerResources(deps.db, lease.workerId, nowIso);
      }
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET status = ?, failure_code = 'spawn_failed', lease_owner = NULL, lease_expires_at = NULL, spawn_request_id = NULL, ended_at = CASE WHEN ? THEN NULL ELSE ? END, updated_at = ? WHERE id = ?`
        )
        .run(
          preserved ? "needs_inspection" : retry ? "ready" : "failed",
          retry ? 1 : 0,
          nowIso,
          nowIso,
          lease.task.id
        );
      deps.db
        .prepare(
          `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
           spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
        )
        .run(
          FLEET_WORKER_RESERVATION_USD,
          preserved ? FLEET_WORKER_RESERVATION_USD : 0,
          nowIso,
          lease.run.id
        );
      queries.createFleetEvent(deps.db).run(
        lease.run.id,
        "worker_spawn_failed",
        "scheduler",
        JSON.stringify({
          taskId: lease.task.id,
          workerId: lease.workerId,
          retry,
          preserved,
          stopFailed,
          message: error instanceof Error ? error.message : "spawn failed",
        })
      );
    });
  }
}

async function pollActiveWorkers(
  deps: FleetSchedulerDeps,
  runId: string
): Promise<void> {
  const workers = deps.db
    .prepare(
      `SELECT * FROM fleet_workers
       WHERE fleet_run_id = ? AND status IN ('running', 'waiting_for_operator')`
    )
    .all(runId) as FleetWorkerRow[];
  for (const worker of workers) {
    const session = worker.session_id
      ? (queries.getSession(deps.db).get(worker.session_id) as
          | Session
          | undefined)
      : undefined;
    let terminalStatus: "completed" | "failed" | "dead" | null = null;
    let terminalCause: string | null = null;
    let claimedForCleanup = false;
    let claimedCleanupCause: string | null = null;
    if (!session) {
      terminalStatus = "dead";
      terminalCause = "session_missing";
    } else if (
      session.worker_status === "completed" ||
      session.worker_status === "failed"
    ) {
      terminalStatus = session.worker_status;
      terminalCause = `session_${session.worker_status}`;
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
    } else if (!(await deps.sessionExists(session))) {
      terminalStatus = "dead";
      terminalCause = "backend_missing";
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
      deps.db
        .prepare(
          `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
           WHERE worker_id = ? AND status = 'reserved' AND resource_type <> 'worktree'`
        )
        .run(nowIso, worker.id);
      deps.db
        .prepare(
          `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
           spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
        )
        .run(
          worker.reservation_usd ?? 0,
          worker.reservation_usd ?? 0,
          nowIso,
          runId
        );
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
    const completionCleanup =
      worker.terminal_cause?.startsWith("operator_completion") === true ||
      worker.terminal_cause?.startsWith("session_completed") === true;
    let session = worker.session_id
      ? (queries.getSession(deps.db).get(worker.session_id) as
          | Session
          | undefined)
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
        worker.terminal_cause?.startsWith("session_failed") === true;
      const finalStatus =
        worker.run_status === "canceled"
          ? "cleanup_complete"
          : completionCleanup
            ? "completed"
            : "failed";
      const finalCause =
        worker.run_status === "canceled"
          ? "operator_cancel"
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
        deps.db
          .prepare(
            `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
             WHERE worker_id = ? AND status = 'reserved' AND resource_type <> 'worktree'`
          )
          .run(nowIso, worker.id);
      }
      if (terminalSessionCleanup) {
        deps.db
          .prepare(
            `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
             spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
          )
          .run(
            worker.reservation_usd ?? 0,
            worker.reservation_usd ?? 0,
            nowIso,
            worker.fleet_run_id
          );
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
    await pollActiveWorkers(deps, runId);
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
  const runs = deps.db
    .prepare(
      `SELECT id FROM fleet_runs
       WHERE status = 'running' OR (status = 'paused' AND EXISTS (
         SELECT 1 FROM fleet_workers
         WHERE fleet_workers.fleet_run_id = fleet_runs.id
           AND fleet_workers.status IN ('running', 'waiting_for_operator')
       ))`
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
         WHERE (status = 'running' OR (status = 'paused' AND EXISTS (
           SELECT 1 FROM fleet_workers
           WHERE fleet_workers.fleet_run_id = fleet_runs.id
             AND fleet_workers.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')
         )))${options.runId ? " AND id = ?" : ""}`
      )
      .run(...(options.runId ? [options.runId] : []));
  }
  const runs = deps.db
    .prepare(
      `SELECT * FROM fleet_runs WHERE status IN ('running', 'paused') AND recovery_required = 1${options.runId ? " AND id = ?" : ""}`
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
            | Session
            | undefined)
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
              `UPDATE fleet_workers SET status = 'running', session_id = ?, worktree_path = ?, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = ? WHERE id = ? AND status IN ('leasing', 'spawning')`
            )
            .run(session.id, session.worktree_path, nowIso, worker.id);
          if (workerUpdate.changes !== 1) return;
          deps.db
            .prepare(
              `UPDATE fleet_tasks SET status = 'running', worktree_path = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('leasing', 'spawning')`
            )
            .run(session.worktree_path, nowIso, worker.task_id);
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
          deps.db
            .prepare(
              `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
               WHERE worker_id = ? AND status = 'reserved' AND resource_type <> 'worktree'`
            )
            .run(nowIso, worker.id);
        } else {
          releaseWorkerResources(deps.db, worker.id, nowIso);
        }
        deps.db
          .prepare(
            `UPDATE fleet_tasks SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
             spawn_request_id = CASE WHEN ? THEN NULL ELSE spawn_request_id END,
             failure_code = 'recovery_expired', ended_at = CASE WHEN ? THEN NULL ELSE ? END,
             updated_at = ? WHERE id = ? AND status IN ('leasing', 'spawning')`
          )
          .run(
            committed ? "needs_inspection" : retry ? "ready" : "failed",
            retry ? 1 : 0,
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
        deps.db
          .prepare(
            `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
             spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
          )
          .run(
            worker.reservation_usd ?? 0,
            committed ? (worker.reservation_usd ?? 0) : 0,
            nowIso,
            run.id
          );
        queries
          .createFleetEvent(deps.db)
          .run(
            run.id,
            "recovery_expired",
            "recovery",
            JSON.stringify({ workerId: worker.id, retry, committed })
          );
      });
    }
    await pollActiveWorkers(deps, run.id);
    if (unresolved) {
      transaction(deps.db, () => {
        const paused = deps.db
          .prepare(
            `UPDATE fleet_runs SET status = 'paused', pause_mode = 'pause-new', pause_reason = 'recovery_unresolved', updated_at = ?
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
  fleetGlobal.__stoaFleetSchedulerReady = false;
  await recoverFleetRuns();
  fleetGlobal.__stoaFleetSchedulerReady = true;
}
