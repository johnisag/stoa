import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { claimsConflict, normalizeClaim } from "@/lib/dispatch/claims";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { getSessionBackend } from "@/lib/session-backend";
import { retryFleetCleanupForRepo } from "./cleanup";
import { composeFleetRunDetail } from "./engine";
import { pendingFleetLaunchCount, trackFleetLaunch } from "./launch-tracker";
import {
  cleanupFleetWorkerSpawn,
  spawnFleetWorkerSession,
  stopFleetWorkerSession,
} from "./spawn";
import type {
  FleetArtifactRow,
  FleetEventRow,
  FleetRunDetailDto,
  FleetRunRow,
  FleetSchedulerSummary,
  FleetSpawnInput,
  FleetSpawnResult,
  FleetTaskRow,
  FleetWorkerRow,
  FleetWorkerStatus,
} from "./types";

export type FleetSpawnAdapter = (
  input: FleetSpawnInput
) => Promise<FleetSpawnResult>;

export type FleetReconcileSummary = FleetSchedulerSummary;

export type FleetSpawnCleanupAdapter = (input: {
  db: Database.Database;
  result: FleetSpawnResult;
  repo: DispatchRepo;
  reason: string;
}) => Promise<void>;

export type FleetSessionStopAdapter = (
  sessionId: string,
  db: Database.Database
) => Promise<{ ok: boolean; error?: string }>;

export interface FleetReconcileOptions {
  db?: Database.Database;
  now?: Date;
  leaseMs?: number;
  spawnLeaseMs?: number;
  providerCap?: number;
  spawn?: FleetSpawnAdapter;
  cleanupSpawn?: FleetSpawnCleanupAdapter;
  liveSessionNames?: Set<string> | null;
  awaitLaunches?: boolean;
}

interface ClaimedWorkerLease {
  workerId: string;
  taskId: string;
  leaseToken: string;
}

interface TaskWithClaims extends FleetTaskRow {
  fileClaims: string[];
  unsafeClaims: boolean;
}

const ACTIVE_WORKER_STATUSES = new Set<FleetWorkerStatus>([
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "cleanup_pending",
]);

const READY_TASK_STATUSES = new Set(["draft", "queued"]);

const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_SPAWN_LEASE_MS = DEFAULT_LEASE_MS;

function immediateTransaction<T>(db: Database.Database, callback: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function detailFromDb(
  db: Database.Database,
  id: string
): FleetRunDetailDto | null {
  const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
  if (!run) return null;
  const tasks = queries.listFleetTasksForRun(db).all(id) as FleetTaskRow[];
  const workers = queries
    .listFleetWorkersForRun(db)
    .all(id) as FleetWorkerRow[];
  const artifacts = queries
    .listFleetArtifactsForRun(db)
    .all(id, 100) as FleetArtifactRow[];
  const events = queries
    .listFleetEventsForRun(db)
    .all(id, 50) as FleetEventRow[];
  return composeFleetRunDetail({
    run,
    tasks,
    workers,
    artifacts,
    events,
    pendingLaunches: pendingFleetLaunchCount(id),
  });
}

function parseSettings(row: FleetRunRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(row.settings_json);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function settingsJson(
  row: FleetRunRow,
  updates: Record<string, unknown>
): string {
  return JSON.stringify({
    ...parseSettings(row),
    ...updates,
  });
}

function workerLeaseExpired(worker: FleetWorkerRow, now: Date): boolean {
  if (!worker.lease_expires_at) return true;
  const expiresAt = new Date(worker.lease_expires_at).getTime();
  return Number.isNaN(expiresAt) || expiresAt <= now.getTime();
}

function parseStoredRepoClaims(json: string | null | undefined): {
  claims: string[];
  unsafe: boolean;
} {
  try {
    if (!json) return { claims: [], unsafe: false };
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return { claims: [], unsafe: true };
    const rawClaims = parsed.filter(
      (claim): claim is string => typeof claim === "string"
    );
    if (rawClaims.length !== parsed.length) return { claims: [], unsafe: true };
    const claims: string[] = [];
    for (const raw of rawClaims) {
      const claim = normalizeClaim(raw);
      if (!claim) return { claims: [], unsafe: true };
      if (!claims.includes(claim)) claims.push(claim);
    }
    return { claims, unsafe: false };
  } catch {
    return { claims: [], unsafe: true };
  }
}

function parseFileClaims(row: FleetTaskRow): {
  claims: string[];
  unsafe: boolean;
} {
  return parseStoredRepoClaims(row.file_claims_json);
}

export function fleetClaimsConflict(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return claimsConflict(left, right);
}

function schedulingClaimsConflict(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return fleetClaimsConflict(left, right);
}

export function selectReadyFleetTasks(input: {
  tasks: FleetTaskRow[];
  workers: FleetWorkerRow[];
  activeClaims?: string[][];
  maxConcurrency: number;
  providerCap?: number;
}): { selected: FleetTaskRow[]; skipped: number; available: number } {
  const cap = Math.max(
    0,
    Math.min(input.maxConcurrency, input.providerCap ?? input.maxConcurrency)
  );
  const activeWorkers = input.workers.filter((worker) =>
    ACTIVE_WORKER_STATUSES.has(worker.status)
  );
  const available = Math.max(0, cap - activeWorkers.length);
  const activeTaskIds = new Set(
    activeWorkers
      .map((worker) => worker.task_id)
      .filter((id): id is string => Boolean(id))
  );
  const completedTaskIds = new Set(
    input.tasks
      .filter((task) => task.status === "completed")
      .map((task) => task.id)
  );
  const tasks = input.tasks.map((task): TaskWithClaims => {
    const parsed = parseFileClaims(task);
    return {
      ...task,
      fileClaims: parsed.claims,
      unsafeClaims: parsed.unsafe,
    };
  });
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const activeClaims = tasks
    .filter((task) => activeTaskIds.has(task.id))
    .map((task) => task.fileClaims);
  activeClaims.push(...(input.activeClaims ?? []));
  const selected: TaskWithClaims[] = [];
  let skipped = 0;

  for (const task of tasks) {
    if (selected.length >= available) break;
    if (!READY_TASK_STATUSES.has(task.status)) continue;
    if (activeTaskIds.has(task.id)) {
      skipped++;
      continue;
    }
    if (task.parent_task_id && !completedTaskIds.has(task.parent_task_id)) {
      skipped++;
      continue;
    }
    if (task.unsafeClaims) {
      skipped++;
      continue;
    }
    const conflictsActive = activeClaims.some((claims) =>
      schedulingClaimsConflict(task.fileClaims, claims)
    );
    const conflictsSelected = selected.some((other) =>
      schedulingClaimsConflict(task.fileClaims, other.fileClaims)
    );
    const parentExists =
      task.parent_task_id == null || taskById.has(task.parent_task_id);
    if (!parentExists || conflictsActive || conflictsSelected) {
      skipped++;
      continue;
    }
    selected.push(task);
  }

  return { selected, skipped, available };
}

function recoverBeforeLaunch(
  db: Database.Database,
  runId: string,
  now: Date,
  liveSessionNames: Set<string> | null
): number {
  const workers = queries
    .listFleetWorkersForRun(db)
    .all(runId) as FleetWorkerRow[];
  let recovered = 0;
  const activeTaskIds = new Set<string>();

  for (const worker of workers) {
    if (
      (worker.status === "leasing" ||
        worker.status === "spawning" ||
        worker.status === "running" ||
        worker.status === "waiting_for_operator") &&
      worker.session_id
    ) {
      const session = queries.getSession(db).get(worker.session_id) as
        Session | undefined;
      const sessionName = session?.tmux_name ?? null;
      const leaseExpired = workerLeaseExpired(worker, now);
      if (liveSessionNames === null) {
        if (worker.task_id) activeTaskIds.add(worker.task_id);
        continue;
      }
      if (sessionName && liveSessionNames.has(sessionName)) {
        if (
          worker.status === "running" ||
          worker.status === "waiting_for_operator" ||
          !leaseExpired
        ) {
          if (worker.task_id) activeTaskIds.add(worker.task_id);
          continue;
        }
        const promoted = queries
          .markFleetWorkerRunning(db)
          .run(worker.session_id, worker.id, worker.lease_token);
        if (worker.task_id) {
          queries
            .updateFleetTaskStatus(db)
            .run("running", worker.task_id, runId);
          activeTaskIds.add(worker.task_id);
        }
        if (promoted.changes > 0) recovered++;
        continue;
      }
      if (!leaseExpired && worker.status !== "running") {
        if (worker.task_id) activeTaskIds.add(worker.task_id);
        continue;
      }
      if (worker.status === "running") {
        queries
          .markFleetWorkerFailed(db)
          .run(
            "recovered missing backend session for running worker",
            worker.id
          );
        if (worker.task_id) {
          queries
            .updateFleetTaskStatus(db)
            .run("queued", worker.task_id, runId);
        }
      } else if (worker.status === "waiting_for_operator") {
        queries
          .markFleetWorkerFailed(db)
          .run(
            "recovered missing backend session for waiting worker",
            worker.id
          );
        if (worker.task_id) {
          queries
            .updateFleetTaskStatus(db)
            .run("queued", worker.task_id, runId);
        }
      } else {
        queries
          .markFleetWorkerFailed(db)
          .run(
            "recovered missing backend session before scheduler tick",
            worker.id
          );
        if (worker.task_id) {
          queries
            .updateFleetTaskStatus(db)
            .run("queued", worker.task_id, runId);
        }
      }
      recovered++;
      continue;
    }

    const leaseExpired = workerLeaseExpired(worker, now);
    if (worker.status === "waiting_for_operator" && !worker.session_id) {
      queries
        .markFleetWorkerFailed(db)
        .run(
          "recovered waiting worker without session before scheduler tick",
          worker.id
        );
      if (worker.task_id) {
        queries.updateFleetTaskStatus(db).run("queued", worker.task_id, runId);
      }
      recovered++;
      continue;
    }
    if (
      (worker.status === "leasing" || worker.status === "spawning") &&
      !worker.session_id &&
      leaseExpired
    ) {
      queries
        .markFleetWorkerFailed(db)
        .run("recovered stale launch lease before scheduler tick", worker.id);
      if (worker.task_id) {
        queries.updateFleetTaskStatus(db).run("queued", worker.task_id, runId);
      }
      recovered++;
      continue;
    }

    if (ACTIVE_WORKER_STATUSES.has(worker.status) && worker.task_id) {
      activeTaskIds.add(worker.task_id);
    }
  }

  const tasks = queries.listFleetTasksForRun(db).all(runId) as FleetTaskRow[];
  for (const task of tasks) {
    if (task.status === "running" && !activeTaskIds.has(task.id)) {
      queries.updateFleetTaskStatus(db).run("queued", task.id, runId);
      recovered++;
    }
  }

  if (recovered > 0) {
    queries
      .createFleetEvent(db)
      .run(
        runId,
        "scheduler_recovered",
        "scheduler",
        JSON.stringify({ recovered })
      );
  }
  return recovered;
}

function needsBackendSessionCheck(
  db: Database.Database,
  runId: string
): boolean {
  const workers = queries
    .listFleetWorkersForRun(db)
    .all(runId) as FleetWorkerRow[];
  return workers.some(
    (worker) =>
      (worker.status === "leasing" ||
        worker.status === "spawning" ||
        worker.status === "running" ||
        worker.status === "waiting_for_operator") &&
      Boolean(worker.session_id)
  );
}

async function liveSessionNamesForRecovery(input: {
  db: Database.Database;
  runId: string;
  override?: Set<string> | null;
}): Promise<Set<string> | null | { error: string }> {
  if (input.override !== undefined) return input.override;
  if (!needsBackendSessionCheck(input.db, input.runId)) return null;
  try {
    return new Set(await getSessionBackend().list());
  } catch (error) {
    console.error("[fleet] backend session recovery check failed:", error);
    return { error: "backend session recovery check failed" };
  }
}

function getRepoForRun(
  db: Database.Database,
  run: FleetRunRow
): DispatchRepo | null {
  if (!run.repo_id) return null;
  return queries.getDispatchRepo(db).get(run.repo_id) as DispatchRepo | null;
}

function countValue(row: unknown): number {
  return typeof row === "object" &&
    row !== null &&
    "n" in row &&
    typeof row.n === "number"
    ? row.n
    : 0;
}

function liveDispatchClaimsForRepo(
  db: Database.Database,
  repoId: string
): string[][] {
  return (
    queries.listLiveClaims(db).all(repoId) as {
      file_claims: string | null;
    }[]
  ).map((row) => {
    const claims = parseStoredRepoClaims(row.file_claims);
    return claims.unsafe ? [] : claims.claims;
  });
}

function liveFleetClaimsForRepoExcludingRun(
  db: Database.Database,
  repoId: string,
  runId: string
): string[][] {
  return (
    queries.listLiveFleetClaimsForRepoExcludingRun(db).all(repoId, runId) as {
      file_claims_json: string | null;
    }[]
  ).map((row) => {
    const claims = parseStoredRepoClaims(row.file_claims_json);
    return claims.unsafe ? [] : claims.claims;
  });
}

function fleetLaunchConcurrencyCap(
  db: Database.Database,
  run: FleetRunRow,
  repo: DispatchRepo,
  currentRunActive: number
): number {
  const otherFleetActive = countValue(
    queries.countActiveFleetWorkersForRepoExcludingRun(db).get(repo.id, run.id)
  );
  const dispatchActive = countValue(queries.countLiveInFlight(db).get(repo.id));
  const repoLaunchSlots = Math.max(
    0,
    repo.max_concurrency - otherFleetActive - dispatchActive - currentRunActive
  );
  const runLaunchSlots = Math.max(0, run.max_concurrency - currentRunActive);
  const dailyUsed =
    countValue(queries.countFleetWorkersCreatedTodayForRepo(db).get(repo.id)) +
    countValue(queries.countDispatchesToday(db).get(repo.id));
  const dailyLaunchSlots = Math.max(0, repo.daily_quota - dailyUsed);
  const launchSlots = Math.min(
    runLaunchSlots,
    repoLaunchSlots,
    dailyLaunchSlots
  );
  return Math.max(0, currentRunActive + launchSlots);
}

function fleetBudgetRemaining(
  db: Database.Database,
  run: FleetRunRow
): number | null {
  if (run.budget_usd == null) return null;
  if (!Number.isFinite(run.budget_usd) || run.budget_usd <= 0) return 0;
  const spent = countValue(queries.sumFleetWorkerCostForRun(db).get(run.id));
  return Math.max(0, run.budget_usd - spent);
}

function fleetBudgetLaunchSlots(
  db: Database.Database,
  run: FleetRunRow,
  currentRunActive: number
): number | null {
  const remaining = fleetBudgetRemaining(db, run);
  if (remaining === null) return null;
  if (remaining <= 0 || currentRunActive > 0) return 0;
  return 1;
}

async function claimLaunches(input: {
  db: Database.Database;
  runId: string;
  now: Date;
  leaseMs: number;
  providerCap?: number;
  liveSessionNames?: Set<string> | null;
}): Promise<
  | { leases: ClaimedWorkerLease[]; recovered: number; skipped: number }
  | {
      error: string;
      status?: number;
    }
> {
  const runForCleanup = queries.getFleetRun(input.db).get(input.runId) as
    FleetRunRow | undefined;
  const repoForCleanup = runForCleanup
    ? getRepoForRun(input.db, runForCleanup)
    : null;
  if (repoForCleanup) {
    await retryFleetCleanupForRepo(input.db, repoForCleanup);
  }

  const liveSessionNames = await liveSessionNamesForRecovery({
    db: input.db,
    runId: input.runId,
    override: input.liveSessionNames,
  });
  if (liveSessionNames && "error" in liveSessionNames) {
    return { error: liveSessionNames.error, status: 409 };
  }
  return immediateTransaction(input.db, () => {
    const run = queries.getFleetRun(input.db).get(input.runId) as
      FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };

    if (run.status === "canceled") {
      return { leases: [], recovered: 0, skipped: 0 };
    }
    if (run.status === "paused") {
      const recovered = recoverBeforeLaunch(
        input.db,
        input.runId,
        input.now,
        liveSessionNames
      );
      return { leases: [], recovered, skipped: 0 };
    }
    if (run.status !== "planned" && run.status !== "running") {
      return { error: "run is not ready for scheduling", status: 409 };
    }
    if (run.approval_state !== "approved") {
      return { error: "run plan is not approved", status: 409 };
    }
    const repo = getRepoForRun(input.db, run);
    if (!repo) {
      return {
        error: "fleet run needs a repository before launch",
        status: 409,
      };
    }
    const recovered = recoverBeforeLaunch(
      input.db,
      input.runId,
      input.now,
      liveSessionNames
    );
    const settings = settingsJson(run, {
      phase: "scheduling",
      canSpawnWorkers: true,
      lastSchedulerTickAt: input.now.toISOString(),
    });
    const started = queries
      .startFleetRunForScheduling(input.db)
      .run(settings, input.runId);
    if (started.changes !== 1) {
      return { error: "run state changed before scheduling", status: 409 };
    }

    const tasks = queries
      .listFleetTasksForRun(input.db)
      .all(input.runId) as FleetTaskRow[];
    const workers = queries
      .listFleetWorkersForRun(input.db)
      .all(input.runId) as FleetWorkerRow[];
    const currentRunActive = workers.filter((worker) =>
      ACTIVE_WORKER_STATUSES.has(worker.status)
    ).length;
    const budgetSlots = fleetBudgetLaunchSlots(input.db, run, currentRunActive);
    if (budgetSlots === 0) {
      queries
        .createFleetEvent(input.db)
        .run(
          input.runId,
          "scheduler_budget_blocked",
          "scheduler",
          JSON.stringify({ budgetUsd: run.budget_usd })
        );
      return { leases: [], recovered, skipped: 0 };
    }
    let maxConcurrency = fleetLaunchConcurrencyCap(
      input.db,
      run,
      repo,
      currentRunActive
    );
    if (budgetSlots !== null) {
      maxConcurrency = Math.min(maxConcurrency, currentRunActive + budgetSlots);
    }
    const decision = selectReadyFleetTasks({
      tasks,
      workers,
      activeClaims: [
        ...liveDispatchClaimsForRepo(input.db, repo.id),
        ...liveFleetClaimsForRepoExcludingRun(input.db, repo.id, input.runId),
      ],
      maxConcurrency,
      providerCap: input.providerCap,
    });
    const leaseExpiresAt = new Date(
      input.now.getTime() + input.leaseMs
    ).toISOString();
    const leases: ClaimedWorkerLease[] = [];

    for (const task of decision.selected) {
      const workerId = randomUUID();
      const leaseToken = randomUUID();
      const attempt =
        workers.filter((worker) => worker.task_id === task.id).length + 1;
      queries
        .createFleetWorkerLease(input.db)
        .run(
          workerId,
          input.runId,
          task.id,
          run.provider,
          run.model,
          attempt,
          leaseToken,
          leaseExpiresAt
        );
      queries
        .updateFleetTaskStatus(input.db)
        .run("running", task.id, input.runId);
      leases.push({ workerId, taskId: task.id, leaseToken });
    }

    if (leases.length > 0 || recovered > 0) {
      queries.createFleetEvent(input.db).run(
        input.runId,
        "scheduler_tick",
        "scheduler",
        JSON.stringify({
          launched: leases.length,
          recovered,
          skipped: decision.skipped,
        })
      );
    }

    return { leases, recovered, skipped: decision.skipped };
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function releaseWorkerForRunState(input: {
  db: Database.Database;
  workerId: string;
  taskId: string;
  runId: string;
  runStatus: FleetRunRow["status"];
  reason: string;
}): void {
  queries.markFleetWorkerCanceled(input.db).run(input.reason, input.workerId);
  if (input.runStatus === "canceled") {
    queries
      .updateFleetTaskStatus(input.db)
      .run("canceled", input.taskId, input.runId);
  } else {
    queries
      .updateFleetTaskStatus(input.db)
      .run("queued", input.taskId, input.runId);
  }
}

async function launchLease(input: {
  db: Database.Database;
  runId: string;
  workerId: string;
  taskId: string;
  leaseToken: string;
  spawnLeaseMs: number;
  spawn: FleetSpawnAdapter;
  cleanupSpawn: FleetSpawnCleanupAdapter;
}): Promise<void> {
  const claimed = immediateTransaction(input.db, () => {
    const worker = queries.getFleetWorker(input.db).get(input.workerId) as
      FleetWorkerRow | undefined;
    if (!worker || worker.lease_token !== input.leaseToken) return null;
    if (worker.status !== "leasing") return null;
    const run = queries.getFleetRun(input.db).get(input.runId) as
      FleetRunRow | undefined;
    const task = queries
      .getFleetTaskForRun(input.db)
      .get(input.runId, input.taskId) as FleetTaskRow | undefined;
    if (!run || !task) return null;
    if (run.status !== "running") {
      releaseWorkerForRunState({
        db: input.db,
        workerId: input.workerId,
        taskId: input.taskId,
        runId: input.runId,
        runStatus: run.status,
        reason: `run ${run.status} before worker launch`,
      });
      return null;
    }
    const repo = getRepoForRun(input.db, run);
    if (!repo) return null;
    const spawnLeaseExpiresAt = new Date(
      Date.now() + input.spawnLeaseMs
    ).toISOString();
    const update = queries
      .markFleetWorkerSpawning(input.db)
      .run(spawnLeaseExpiresAt, input.workerId, input.leaseToken);
    if (update.changes !== 1) return null;
    return { run, task, repo };
  });

  if (!claimed) return;

  try {
    const result = await input.spawn({
      run: claimed.run,
      task: claimed.task,
      repo: claimed.repo,
      workerId: input.workerId,
      leaseToken: input.leaseToken,
    });
    if (!result.worktreePath) {
      throw new Error("fleet worker launched without an isolated worktree");
    }
    const accepted = immediateTransaction<true | { reason: string }>(
      input.db,
      () => {
        const worker = queries.getFleetWorker(input.db).get(input.workerId) as
          FleetWorkerRow | undefined;
        const run = queries.getFleetRun(input.db).get(input.runId) as
          FleetRunRow | undefined;
        if (
          worker &&
          run?.status === "running" &&
          worker.status === "running" &&
          worker.session_id === result.sessionId
        ) {
          return true;
        }
        if (
          !worker ||
          !run ||
          worker.status !== "spawning" ||
          worker.lease_token !== input.leaseToken ||
          run.status !== "running"
        ) {
          return {
            reason: `worker launch superseded before commit (${run?.status ?? "missing run"})`,
          };
        }
        const update = queries
          .markFleetWorkerRunning(input.db)
          .run(result.sessionId, input.workerId, input.leaseToken);
        if (update.changes !== 1) {
          return { reason: "worker launch lease changed before commit" };
        }
        queries
          .updateFleetTaskStatus(input.db)
          .run("running", input.taskId, input.runId);
        queries.createFleetEvent(input.db).run(
          input.runId,
          "worker_spawned",
          "scheduler",
          JSON.stringify({
            workerId: input.workerId,
            taskId: input.taskId,
            sessionId: result.sessionId,
            branchName: result.branchName,
            worktreePath: result.worktreePath,
          })
        );
        return true;
      }
    );
    if (accepted !== true) {
      await input.cleanupSpawn({
        db: input.db,
        result,
        repo: claimed.repo,
        reason: accepted.reason,
      });
    }
  } catch (error) {
    immediateTransaction(input.db, () => {
      const worker = queries.getFleetWorker(input.db).get(input.workerId) as
        FleetWorkerRow | undefined;
      const run = queries.getFleetRun(input.db).get(input.runId) as
        FleetRunRow | undefined;
      if (!worker || worker.status === "canceled") return;
      if (worker.status === "cleanup_pending") {
        if (worker.task_id) {
          queries
            .updateFleetTaskStatus(input.db)
            .run("blocked", worker.task_id, input.runId);
        }
        queries.createFleetEvent(input.db).run(
          input.runId,
          "worker_cleanup_pending",
          "scheduler",
          JSON.stringify({
            workerId: input.workerId,
            taskId: input.taskId,
            error: errorText(error),
          })
        );
        return;
      }
      if (run?.status === "canceled") return;
      if (run?.status === "paused") {
        releaseWorkerForRunState({
          db: input.db,
          workerId: input.workerId,
          taskId: input.taskId,
          runId: input.runId,
          runStatus: run.status,
          reason: `worker launch failed after run paused: ${errorText(error)}`,
        });
        return;
      }
      queries
        .markFleetWorkerFailed(input.db)
        .run(errorText(error), input.workerId);
      queries
        .updateFleetTaskStatus(input.db)
        .run("blocked", input.taskId, input.runId);
      queries.createFleetEvent(input.db).run(
        input.runId,
        "worker_spawn_failed",
        "scheduler",
        JSON.stringify({
          workerId: input.workerId,
          taskId: input.taskId,
          error: errorText(error),
        })
      );
    });
  }
}

export async function reconcileFleetRun(
  id: string,
  options: FleetReconcileOptions = {}
): Promise<
  | { run: FleetRunDetailDto; summary: FleetReconcileSummary }
  | { error: string; status?: number }
> {
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();
  const claim = claimLaunches({
    db,
    runId: id,
    now,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    liveSessionNames: options.liveSessionNames,
    providerCap: options.providerCap,
  });
  const resolvedClaim = await claim;
  if ("error" in resolvedClaim) return resolvedClaim;

  const spawn = options.spawn ?? spawnFleetWorkerSession;
  const cleanupSpawn = options.cleanupSpawn ?? cleanupFleetWorkerSpawn;
  const launchPromises = resolvedClaim.leases.map((lease) =>
    trackFleetLaunch(
      id,
      launchLease({
        db,
        runId: id,
        spawn,
        cleanupSpawn,
        spawnLeaseMs: options.spawnLeaseMs ?? DEFAULT_SPAWN_LEASE_MS,
        ...lease,
      })
    )
  );
  if (options.awaitLaunches === false) {
    for (const promise of launchPromises) {
      void promise.catch((error) => {
        console.error("[fleet] background worker launch failed:", error);
      });
    }
  } else {
    await Promise.all(launchPromises);
  }

  const detail = detailFromDb(db, id);
  if (!detail) return { error: "failed to read reconciled run" };
  return {
    run: detail,
    summary: {
      launched: resolvedClaim.leases.length,
      recovered: resolvedClaim.recovered,
      skipped: resolvedClaim.skipped,
    },
  };
}

export async function startFleetRun(
  id: string,
  options: FleetReconcileOptions & { actor?: string } = {}
): Promise<
  | { run: FleetRunDetailDto; summary: FleetReconcileSummary }
  | { error: string; status?: number }
> {
  const db = options.db ?? getDb();
  const actor = options.actor ?? "operator";
  const preflight = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.approval_state !== "approved") {
      return { error: "run plan is not approved", status: 409 };
    }
    if (
      run.status !== "planned" &&
      run.status !== "paused" &&
      run.status !== "running"
    ) {
      return {
        error: "run cannot be started from its current state",
        status: 409,
      };
    }
    if (!getRepoForRun(db, run)) {
      return {
        error: "fleet run needs a repository before launch",
        status: 409,
      };
    }
    return { ok: true };
  });
  if ("error" in preflight) return preflight;
  const liveSessionNames = await liveSessionNamesForRecovery({
    db,
    runId: id,
    override: options.liveSessionNames,
  });
  if (liveSessionNames && "error" in liveSessionNames) {
    return { error: liveSessionNames.error, status: 409 };
  }
  const started = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.approval_state !== "approved") {
      return { error: "run plan is not approved", status: 409 };
    }
    if (
      run.status !== "planned" &&
      run.status !== "paused" &&
      run.status !== "running"
    ) {
      return {
        error: "run cannot be started from its current state",
        status: 409,
      };
    }
    if (!getRepoForRun(db, run)) {
      return {
        error: "fleet run needs a repository before launch",
        status: 409,
      };
    }
    if (run.status !== "running") {
      queries
        .updateFleetRunStatus(db)
        .run("running", settingsJson(run, { phase: "scheduling" }), id);
      queries
        .createFleetEvent(db)
        .run(id, "fleet_started", actor, JSON.stringify({ actor }));
    }
    return { ok: true };
  });
  if ("error" in started) return started;
  return reconcileFleetRun(id, { ...options, db, liveSessionNames });
}

export async function pauseFleetRun(
  id: string,
  options: {
    db?: Database.Database;
    actor?: string;
    stopSession?: FleetSessionStopAdapter;
  } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = options.db ?? getDb();
  const actor = options.actor ?? "operator";
  const stopSession = options.stopSession ?? stopFleetWorkerSession;
  const result = immediateTransaction<
    { ok: true; sessionIds: string[] } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.status !== "planned" && run.status !== "running") {
      return {
        error: "run cannot be paused from its current state",
        status: 409,
      };
    }
    const workers = queries
      .listFleetWorkersForRun(db)
      .all(id) as FleetWorkerRow[];
    queries
      .updateFleetRunStatus(db)
      .run("paused", settingsJson(run, { phase: "paused" }), id);
    let released = 0;
    const sessionIds: string[] = [];
    for (const worker of workers) {
      if (worker.status !== "leasing" && worker.status !== "spawning") {
        continue;
      }
      if (worker.session_id) sessionIds.push(worker.session_id);
      queries
        .markFleetWorkerCanceled(db)
        .run("run paused before launch", worker.id);
      if (worker.task_id) {
        queries.updateFleetTaskStatus(db).run("queued", worker.task_id, id);
      }
      released++;
    }
    queries
      .createFleetEvent(db)
      .run(id, "fleet_paused", actor, JSON.stringify({ actor, released }));
    return { ok: true, sessionIds };
  });
  if ("error" in result) return result;
  for (const sessionId of result.sessionIds) {
    const stopped = await stopSession(sessionId, db);
    if (!stopped.ok) {
      queries
        .markFleetWorkerCleanupPendingForSession(db)
        .run(stopped.error ?? "failed to stop fleet worker session", sessionId);
      queries
        .createFleetEvent(db)
        .run(
          id,
          "fleet_worker_stop_failed",
          "scheduler",
          JSON.stringify({ sessionId, error: stopped.error })
        );
    }
  }
  const detail = detailFromDb(db, id);
  if (!detail) return { error: "failed to read paused run" };
  return { run: detail };
}

export async function cancelFleetRun(
  id: string,
  options: {
    db?: Database.Database;
    actor?: string;
    stopSession?: FleetSessionStopAdapter;
  } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const db = options.db ?? getDb();
  const actor = options.actor ?? "operator";
  const stopSession = options.stopSession ?? stopFleetWorkerSession;
  const result = immediateTransaction<
    { ok: true; sessionIds: string[] } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.status === "completed" || run.status === "canceled") {
      return { error: "run is already terminal", status: 409 };
    }
    const workers = queries
      .listFleetWorkersForRun(db)
      .all(id) as FleetWorkerRow[];
    const sessionIds = workers
      .filter(
        (worker) =>
          worker.session_id && ACTIVE_WORKER_STATUSES.has(worker.status)
      )
      .map((worker) => worker.session_id as string);
    queries
      .updateFleetRunStatus(db)
      .run("canceled", settingsJson(run, { phase: "canceled" }), id);
    queries.cancelOpenFleetTasksForRun(db).run(id);
    queries.markFleetWorkerCanceledForRun(db).run(id);
    queries
      .createFleetEvent(db)
      .run(
        id,
        "fleet_canceled",
        actor,
        JSON.stringify({ actor, stoppedSessions: sessionIds.length })
      );
    return { ok: true, sessionIds };
  });
  if ("error" in result) return result;
  for (const sessionId of result.sessionIds) {
    const stopped = await stopSession(sessionId, db);
    if (!stopped.ok) {
      queries
        .markFleetWorkerCleanupPendingForSession(db)
        .run(stopped.error ?? "failed to stop fleet worker session", sessionId);
      queries
        .createFleetEvent(db)
        .run(
          id,
          "fleet_worker_stop_failed",
          "scheduler",
          JSON.stringify({ sessionId, error: stopped.error })
        );
    }
  }
  const detail = detailFromDb(db, id);
  if (!detail) return { error: "failed to read canceled run" };
  return { run: detail };
}
