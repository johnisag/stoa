import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import {
  deleteWorktree,
  getMainRepoPath,
  isStoaWorktree,
  normalizeWorktreePath,
} from "@/lib/worktrees";
import type {
  FleetCleanupActionRow,
  FleetRunRow,
  FleetRunStatus,
  FleetTaskRow,
} from "./types";

const TERMINAL_RUN_STATUSES = new Set<FleetRunStatus>([
  "completed",
  "failed",
  "canceled",
]);
const READ_ONLY_TASK_TYPES = new Set([
  "explore",
  "review",
  "milestone",
  "planning",
]);
const TASK_FAILURE_STATES = new Set([
  "blocked",
  "needs_followup",
  "needs_inspection",
  "failed",
  "canceled",
]);
const TASK_REVIEW_STATES = new Set([
  "verifying",
  "reviewing",
  "fixing",
  "ready_to_merge",
]);
const ACTIVE_INTEGRATION_STATES = new Set([
  "initializing",
  "integrating",
  "final_verifying",
  "ready_to_finalize",
  "pushing",
  "waiting_ci",
  "merging",
]);

export const FLEET_CLEANUP_LEASE_MS = 5 * 60_000;
export const FLEET_CLEANUP_MAX_PER_TICK = 4;
export const FLEET_RETENTION_MIN_BODY_BYTES = 16 * 1024;
export const FLEET_RETENTION_MAX_ROWS_PER_TICK = 8;
export const FLEET_RETENTION_MAX_BYTES_PER_TICK = 1024 * 1024;

export interface FleetLifecycleDeps {
  db: Database.Database;
  now: () => Date;
  deleteWorktree: typeof deleteWorktree;
  getMainRepoPath: typeof getMainRepoPath;
  pathExists: (value: string) => boolean;
}

export interface FleetCleanupPreviewItem {
  workerId: string;
  worktreePath: string;
  projectPath: string;
  exists: boolean;
}

export interface FleetCleanupPreview {
  runId: string;
  archived: boolean;
  terminal: boolean;
  eligible: FleetCleanupPreviewItem[];
  skipped: Array<{
    workerId: string;
    worktreePath: string;
    reason: string;
  }>;
}

function lifecycleDeps(
  overrides: Partial<FleetLifecycleDeps>
): FleetLifecycleDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    deleteWorktree: overrides.deleteWorktree ?? deleteWorktree,
    getMainRepoPath: overrides.getMainRepoPath ?? getMainRepoPath,
    pathExists: overrides.pathExists ?? fs.existsSync,
  };
}

function transaction<T>(db: Database.Database, callback: () => T): T {
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

function cappedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function actor(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80)
    : "operator";
}

function exactConfirmation(
  runId: string,
  input: Record<string, unknown>
): boolean {
  return input.confirm === true && input.confirmation === runId;
}

function validRetentionDays(value: unknown): number | null | undefined {
  if (value == null) return null;
  return Number.isSafeInteger(value) &&
    Number(value) >= 1 &&
    Number(value) <= 3650
    ? Number(value)
    : undefined;
}

function runSummary(db: Database.Database, run: FleetRunRow): unknown {
  const tasks = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM fleet_tasks
       WHERE fleet_run_id = ? GROUP BY status ORDER BY status`
    )
    .all(run.id);
  const workers = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM fleet_workers
       WHERE fleet_run_id = ? GROUP BY status ORDER BY status`
    )
    .all(run.id);
  return {
    status: run.status,
    startedAt: run.started_at ?? null,
    endedAt: run.ended_at ?? null,
    budgetUsd: run.budget_usd,
    reservedBudgetUsd: run.reserved_budget_usd ?? 0,
    spentBudgetUsd: run.spent_budget_usd ?? 0,
    tasks,
    workers,
  };
}

export function archiveFleetRun(
  runId: string,
  input: unknown,
  overrides: Partial<FleetLifecycleDeps> = {}
):
  | { archivedAt: string; retentionDays: number | null }
  | { error: string; status: number } {
  const runtime = lifecycleDeps(overrides);
  const body = payload(input);
  if (!exactConfirmation(runId, body)) {
    return {
      error:
        "archive requires confirm=true and confirmation equal to the run id",
      status: 400,
    };
  }
  const retentionDays = validRetentionDays(body.retentionDays);
  if (retentionDays === undefined) {
    return {
      error: "retentionDays must be null or an integer from 1 to 3650",
      status: 400,
    };
  }
  return transaction(runtime.db, () => {
    const run = queries.getFleetRun(runtime.db).get(runId) as
      FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (!TERMINAL_RUN_STATUSES.has(run.status)) {
      return { error: "only terminal fleet runs can be archived", status: 409 };
    }
    if (run.archived_at) {
      return {
        archivedAt: run.archived_at,
        retentionDays: run.retention_days ?? null,
      };
    }
    const nowIso = runtime.now().toISOString();
    const archivedBy = actor(body.actor);
    runtime.db
      .prepare(
        `UPDATE fleet_runs SET archived_at = ?, archived_by = ?, retention_days = ?,
         updated_at = ? WHERE id = ? AND archived_at IS NULL`
      )
      .run(nowIso, archivedBy, retentionDays, nowIso, runId);
    queries.createFleetEvent(runtime.db).run(
      runId,
      "run_archived",
      archivedBy,
      JSON.stringify({
        retentionDays,
        summary: runSummary(runtime.db, run),
      })
    );
    return { archivedAt: nowIso, retentionDays };
  });
}

interface CleanupCandidate {
  worker_id: string;
  worker_worktree_path: string;
  task_worktree_path: string | null;
  working_directory: string | null;
  lease_path: string | null;
}

async function evaluateCleanupCandidate(
  candidate: CleanupCandidate,
  runtime: FleetLifecycleDeps
): Promise<
  { ok: true; item: FleetCleanupPreviewItem } | { ok: false; reason: string }
> {
  const target = candidate.worker_worktree_path;
  if (
    !candidate.task_worktree_path ||
    normalizeWorktreePath(candidate.task_worktree_path) !==
      normalizeWorktreePath(target)
  ) {
    return { ok: false, reason: "task and worker worktree records differ" };
  }
  if (
    !candidate.lease_path ||
    normalizeWorktreePath(candidate.lease_path) !==
      normalizeWorktreePath(target)
  ) {
    return { ok: false, reason: "no exact Fleet-owned worktree lease" };
  }
  if (!isStoaWorktree(target)) {
    return { ok: false, reason: "path is outside the Stoa worktree root" };
  }
  const projectPath = candidate.working_directory;
  if (!projectPath) {
    return { ok: false, reason: "project path is not recorded" };
  }
  const exists = runtime.pathExists(target);
  if (exists) {
    const owner = await runtime.getMainRepoPath(target);
    if (
      !owner ||
      normalizeWorktreePath(owner) !== normalizeWorktreePath(projectPath)
    ) {
      return {
        ok: false,
        reason: "worktree project ownership could not be verified",
      };
    }
  }
  return {
    ok: true,
    item: {
      workerId: candidate.worker_id,
      worktreePath: target,
      projectPath,
      exists,
    },
  };
}

export async function previewFleetCleanup(
  runId: string,
  overrides: Partial<FleetLifecycleDeps> = {}
): Promise<FleetCleanupPreview | { error: string; status: number }> {
  const runtime = lifecycleDeps(overrides);
  const run = queries.getFleetRun(runtime.db).get(runId) as
    FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  const candidates = runtime.db
    .prepare(
      `SELECT w.id AS worker_id, w.worktree_path AS worker_worktree_path,
              t.worktree_path AS task_worktree_path, t.working_directory,
              l.resource_key AS lease_path
       FROM fleet_workers w
       LEFT JOIN fleet_tasks t ON t.id = w.task_id AND t.fleet_run_id = w.fleet_run_id
       LEFT JOIN fleet_resource_leases l ON l.worker_id = w.id
         AND l.resource_type = 'worktree'
       WHERE w.fleet_run_id = ? AND w.worktree_path IS NOT NULL
         AND w.status NOT IN ('leasing', 'spawning', 'running',
                              'waiting_for_operator', 'cleanup_pending')
       ORDER BY w.created_at, w.id`
    )
    .all(runId) as CleanupCandidate[];
  const eligible: FleetCleanupPreviewItem[] = [];
  const skipped: FleetCleanupPreview["skipped"] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.slice(0, 200)) {
    const normalized = normalizeWorktreePath(candidate.worker_worktree_path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const evaluated = await evaluateCleanupCandidate(candidate, runtime);
    if (evaluated.ok) eligible.push(evaluated.item);
    else {
      skipped.push({
        workerId: candidate.worker_id,
        worktreePath: candidate.worker_worktree_path,
        reason: evaluated.reason,
      });
    }
  }
  return {
    runId,
    archived: !!run.archived_at,
    terminal: TERMINAL_RUN_STATUSES.has(run.status),
    eligible,
    skipped,
  };
}

export async function requestFleetCleanup(
  runId: string,
  input: unknown,
  overrides: Partial<FleetLifecycleDeps> = {}
): Promise<
  | { dryRun: boolean; queued: number; preview: FleetCleanupPreview }
  | { error: string; status: number }
> {
  const runtime = lifecycleDeps(overrides);
  const body = payload(input);
  const preview = await previewFleetCleanup(runId, runtime);
  if ("error" in preview) return preview;
  if (body.dryRun === true) return { dryRun: true, queued: 0, preview };
  if (!exactConfirmation(runId, body)) {
    return {
      error:
        "cleanup requires confirm=true and confirmation equal to the run id",
      status: 400,
    };
  }
  if (!preview.terminal) {
    return { error: "only terminal fleet runs can be cleaned", status: 409 };
  }
  if (!preview.archived) {
    return {
      error: "archive the fleet run before requesting cleanup",
      status: 409,
    };
  }
  const requestedBy = actor(body.actor);
  const nowIso = runtime.now().toISOString();
  const queued = transaction(runtime.db, () => {
    let created = 0;
    const insert = runtime.db.prepare(
      `INSERT OR IGNORE INTO fleet_cleanup_actions
       (id, action_key, fleet_run_id, worker_id, action_type, state,
        target_path, project_path, requested_by, metadata_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 'delete_worktree', 'pending', ?, ?, ?, '{}', ?, ?)`
    );
    for (const item of preview.eligible) {
      const key = `delete-worktree:${runId}:${stableHash(
        normalizeWorktreePath(item.worktreePath)
      )}`;
      created += insert.run(
        randomUUID(),
        key,
        runId,
        item.workerId,
        item.worktreePath,
        item.projectPath,
        requestedBy,
        nowIso,
        nowIso
      ).changes;
    }
    if (created > 0) {
      queries.createFleetEvent(runtime.db).run(
        runId,
        "cleanup_requested",
        requestedBy,
        JSON.stringify({
          actionCount: created,
          skippedCount: preview.skipped.length,
        })
      );
    }
    return created;
  });
  return { dryRun: false, queued, preview };
}

export function claimFleetCleanupAction(input: {
  db: Database.Database;
  actionId: string;
  owner: string;
  now: Date;
  leaseMs?: number;
}): boolean {
  const nowIso = input.now.toISOString();
  const leaseExpiresAt = new Date(
    input.now.getTime() + (input.leaseMs ?? FLEET_CLEANUP_LEASE_MS)
  ).toISOString();
  return (
    input.db
      .prepare(
        `UPDATE fleet_cleanup_actions SET state = 'running', lease_owner = ?,
         lease_expires_at = ?, attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
         WHERE id = ? AND (
           state = 'pending' OR
           (state = 'running' AND
             (lease_expires_at IS NULL OR lease_expires_at <= ?))
         )`
      )
      .run(input.owner, leaseExpiresAt, nowIso, nowIso, input.actionId, nowIso)
      .changes === 1
  );
}

function finishCleanupAction(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow,
  owner: string,
  state: "completed" | "failed" | "skipped",
  error: string | null
): void {
  const nowIso = runtime.now().toISOString();
  transaction(runtime.db, () => {
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_cleanup_actions SET state = ?, error = ?, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(state, error, nowIso, nowIso, row.id, owner);
    if (changed.changes !== 1) return;
    queries.createFleetEvent(runtime.db).run(
      row.fleet_run_id,
      `cleanup_action_${state}`,
      "fleet-lifecycle",
      JSON.stringify({
        actionId: row.id,
        actionType: row.action_type,
        workerId: row.worker_id,
        artifactId: row.artifact_id,
        error,
      })
    );
  });
}

async function executeWorktreeCleanup(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow
): Promise<"completed" | "skipped"> {
  if (!row.worker_id || !row.target_path || !row.project_path) {
    throw new Error("cleanup action has incomplete recorded ownership");
  }
  const candidate = runtime.db
    .prepare(
      `SELECT w.id AS worker_id, w.worktree_path AS worker_worktree_path,
              t.worktree_path AS task_worktree_path, t.working_directory,
              l.resource_key AS lease_path
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       LEFT JOIN fleet_tasks t ON t.id = w.task_id AND t.fleet_run_id = w.fleet_run_id
       LEFT JOIN fleet_resource_leases l ON l.worker_id = w.id
         AND l.resource_type = 'worktree'
       WHERE w.id = ? AND w.fleet_run_id = ? AND r.archived_at IS NOT NULL
         AND r.status IN ('completed', 'failed', 'canceled')
         AND w.status NOT IN ('leasing', 'spawning', 'running',
                              'waiting_for_operator', 'cleanup_pending')`
    )
    .get(row.worker_id, row.fleet_run_id) as CleanupCandidate | undefined;
  if (
    !candidate ||
    normalizeWorktreePath(candidate.worker_worktree_path) !==
      normalizeWorktreePath(row.target_path) ||
    normalizeWorktreePath(candidate.working_directory ?? "") !==
      normalizeWorktreePath(row.project_path)
  ) {
    throw new Error("cleanup ownership records changed");
  }
  const evaluated = await evaluateCleanupCandidate(candidate, runtime);
  if (!evaluated.ok) throw new Error(evaluated.reason);
  if (!evaluated.item.exists) return "skipped";
  await runtime.deleteWorktree(
    evaluated.item.worktreePath,
    evaluated.item.projectPath,
    false
  );
  if (runtime.pathExists(evaluated.item.worktreePath)) {
    throw new Error("worktree still exists after cleanup");
  }
  runtime.db
    .prepare(
      `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
       WHERE worker_id = ? AND resource_type = 'worktree' AND status = 'reserved'`
    )
    .run(runtime.now().toISOString(), row.worker_id);
  return "completed";
}

function executeArtifactPrune(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow
): "completed" | "skipped" {
  if (!row.artifact_id || !row.expected_content_hash) {
    throw new Error("retention action has incomplete artifact identity");
  }
  const marker = JSON.stringify({
    pruned: true,
    contentHash: row.expected_content_hash,
    reason: "archived_fleet_retention",
  });
  const changed = runtime.db
    .prepare(
      `UPDATE fleet_artifacts SET body = ?, body_pruned_at = ?
       WHERE id = ? AND fleet_run_id = ? AND content_hash = ?
         AND body_pruned_at IS NULL AND artifact_type = 'critic_finding'`
    )
    .run(
      marker,
      runtime.now().toISOString(),
      row.artifact_id,
      row.fleet_run_id,
      row.expected_content_hash
    );
  return changed.changes === 1 ? "completed" : "skipped";
}

async function executeCleanupAction(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow,
  owner: string
): Promise<void> {
  try {
    const state =
      row.action_type === "delete_worktree"
        ? await executeWorktreeCleanup(runtime, row)
        : executeArtifactPrune(runtime, row);
    finishCleanupAction(runtime, row, owner, state, null);
  } catch (error) {
    finishCleanupAction(
      runtime,
      row,
      owner,
      "failed",
      error instanceof Error ? error.message.slice(0, 500) : "cleanup failed"
    );
  }
}

export function deriveFleetRunStatus(
  run: Pick<FleetRunRow, "status" | "integration_state" | "merge_requested_at">,
  tasks: Array<Pick<FleetTaskRow, "status" | "task_type">>
): FleetRunStatus {
  if (TERMINAL_RUN_STATUSES.has(run.status) || tasks.length === 0) {
    return run.status;
  }
  if (
    run.integration_state &&
    ACTIVE_INTEGRATION_STATES.has(run.integration_state)
  ) {
    return "merging";
  }
  const unresolved = tasks.some((task) => TASK_FAILURE_STATES.has(task.status));
  if (unresolved) return run.status === "paused" ? "paused" : "reviewing";
  if (run.merge_requested_at && run.integration_state !== "completed") {
    return "merging";
  }

  const allComplete = tasks.every((task) =>
    READ_ONLY_TASK_TYPES.has(task.task_type)
      ? task.status === "completed" || task.status === "skipped"
      : task.status === "merged"
  );
  if (allComplete) return "completed";
  if (tasks.some((task) => task.status === "merging")) return "merging";
  if (tasks.some((task) => TASK_REVIEW_STATES.has(task.status))) {
    return "reviewing";
  }
  return run.status === "paused" ? "paused" : "running";
}

export function reconcileFleetRunStatuses(
  overrides: Partial<FleetLifecycleDeps> = {},
  limit = 64
): number {
  const runtime = lifecycleDeps(overrides);
  const runs = runtime.db
    .prepare(
      `SELECT * FROM fleet_runs WHERE status IN ('running', 'reviewing', 'merging')
       ORDER BY updated_at, id LIMIT ?`
    )
    .all(cappedPositiveInteger(limit, 64, 200)) as FleetRunRow[];
  let changed = 0;
  for (const run of runs) {
    const tasks = runtime.db
      .prepare(
        `SELECT status, task_type FROM fleet_tasks WHERE fleet_run_id = ?`
      )
      .all(run.id) as FleetTaskRow[];
    const status = deriveFleetRunStatus(run, tasks);
    if (status === run.status) continue;
    const nowIso = runtime.now().toISOString();
    const update = runtime.db
      .prepare(
        `UPDATE fleet_runs SET status = ?,
         ended_at = CASE WHEN ? = 'completed' THEN COALESCE(ended_at, ?) ELSE ended_at END,
         updated_at = ? WHERE id = ? AND status = ?`
      )
      .run(status, status, nowIso, nowIso, run.id, run.status);
    if (update.changes !== 1) continue;
    changed += 1;
    queries
      .createFleetEvent(runtime.db)
      .run(
        run.id,
        status === "completed" ? "run_completed" : "run_phase_derived",
        "fleet-lifecycle",
        JSON.stringify({ from: run.status, to: status })
      );
  }
  return changed;
}

export function enqueueFleetRetentionActions(
  overrides: Partial<FleetLifecycleDeps> = {}
): number {
  const runtime = lifecycleDeps(overrides);
  const nowIso = runtime.now().toISOString();
  const candidates = runtime.db
    .prepare(
      `SELECT a.id, a.fleet_run_id, a.content_hash, a.byte_count
       FROM fleet_artifacts a
       JOIN fleet_runs r ON r.id = a.fleet_run_id
       WHERE r.archived_at IS NOT NULL
         AND r.status IN ('completed', 'failed', 'canceled')
         AND r.retention_days IS NOT NULL AND r.retention_days > 0
         AND datetime(r.archived_at, '+' || r.retention_days || ' days') <= datetime(?)
         AND a.artifact_type = 'critic_finding'
         AND a.body_pruned_at IS NULL AND a.content_hash IS NOT NULL
         AND a.byte_count >= ? AND a.byte_count <= ?
       ORDER BY r.archived_at, a.created_at, a.id
       LIMIT ?`
    )
    .all(
      nowIso,
      FLEET_RETENTION_MIN_BODY_BYTES,
      FLEET_RETENTION_MAX_BYTES_PER_TICK,
      FLEET_RETENTION_MAX_ROWS_PER_TICK * 4
    ) as Array<{
    id: string;
    fleet_run_id: string;
    content_hash: string;
    byte_count: number;
  }>;
  let bytes = 0;
  let queued = 0;
  const touchedRuns = new Set<string>();
  const insert = runtime.db.prepare(
    `INSERT OR IGNORE INTO fleet_cleanup_actions
     (id, action_key, fleet_run_id, artifact_id, action_type, state,
      expected_content_hash, requested_by, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'prune_artifact_body', 'pending', ?,
      'retention-policy', ?, ?, ?)`
  );
  for (const candidate of candidates) {
    if (queued >= FLEET_RETENTION_MAX_ROWS_PER_TICK) break;
    if (bytes + candidate.byte_count > FLEET_RETENTION_MAX_BYTES_PER_TICK) {
      continue;
    }
    const created = insert.run(
      randomUUID(),
      `retention:${candidate.id}:${candidate.content_hash}`,
      candidate.fleet_run_id,
      candidate.id,
      candidate.content_hash,
      JSON.stringify({ originalByteCount: candidate.byte_count }),
      nowIso,
      nowIso
    ).changes;
    if (created !== 1) continue;
    queued += 1;
    bytes += candidate.byte_count;
    touchedRuns.add(candidate.fleet_run_id);
  }
  for (const runId of touchedRuns) {
    queries
      .createFleetEvent(runtime.db)
      .run(
        runId,
        "artifact_retention_queued",
        "retention-policy",
        JSON.stringify({ bounded: true })
      );
  }
  return queued;
}

export async function reconcileFleetLifecycle(
  overrides: Partial<FleetLifecycleDeps> = {},
  options: { owner?: string; maxActions?: number } = {}
): Promise<number> {
  const runtime = lifecycleDeps(overrides);
  reconcileFleetRunStatuses(runtime);
  enqueueFleetRetentionActions(runtime);
  const owner = options.owner ?? `fleet-lifecycle-${randomUUID()}`;
  const maxActions = cappedPositiveInteger(
    options.maxActions,
    FLEET_CLEANUP_MAX_PER_TICK,
    16
  );
  const candidates = runtime.db
    .prepare(
      `SELECT id FROM fleet_cleanup_actions
       WHERE state = 'pending' OR
         (state = 'running' AND
          (lease_expires_at IS NULL OR lease_expires_at <= ?))
       ORDER BY created_at, id LIMIT ?`
    )
    .all(runtime.now().toISOString(), maxActions * 2) as { id: string }[];
  let processed = 0;
  for (const candidate of candidates) {
    if (processed >= maxActions) break;
    if (
      !claimFleetCleanupAction({
        db: runtime.db,
        actionId: candidate.id,
        owner,
        now: runtime.now(),
      })
    ) {
      continue;
    }
    const row = runtime.db
      .prepare(`SELECT * FROM fleet_cleanup_actions WHERE id = ?`)
      .get(candidate.id) as FleetCleanupActionRow;
    await executeCleanupAction(runtime, row, owner);
    processed += 1;
  }
  return processed;
}
