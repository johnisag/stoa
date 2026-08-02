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
import { redactAndCapFleetText } from "./redaction";
import {
  deleteFleetWorkerReportFile,
  isFleetOwnedWorkerReportPath,
  type FleetWorkerReportFileIdentity,
} from "./report-runtime";
import { stopFleetSession } from "./stop";
import type {
  FleetCleanupActionRow,
  FleetDestructiveActionPreview,
  FleetDestructiveOwnerType,
  FleetDestructivePreviewOwner,
  FleetDestructivePreviewOwnerRef,
  FleetDestructiveTargetOwnerType,
  FleetRunRow,
  FleetRunStatus,
  FleetTaskRow,
} from "./types";
import { reconcileFleetCancellationCleanup } from "./service";
import { fleetIntegrationIdentity } from "./merge-contract";
import { resolveFleetMergeTarget } from "./merge-readiness";

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
  "awaiting_operator",
]);

export const FLEET_CLEANUP_LEASE_MS = 5 * 60_000;
export const FLEET_CLEANUP_MAX_PER_TICK = 4;
export const FLEET_CLEANUP_MAX_ATTEMPTS = 3;
export const FLEET_RETENTION_MIN_BODY_BYTES = 16 * 1024;
export const FLEET_RETENTION_MAX_ROWS_PER_TICK = 8;
export const FLEET_RETENTION_MAX_BYTES_PER_TICK = 1024 * 1024;
const FLEET_RETENTION_PRUNABLE_ARTIFACT_TYPES = [
  "critic_finding",
  "plan_review_finding",
  "task_review_finding",
] as const;
const FLEET_RETENTION_ARTIFACT_TYPE_PARAMS =
  FLEET_RETENTION_PRUNABLE_ARTIFACT_TYPES.map(() => "?").join(", ");
const FLEET_DESTRUCTIVE_CANCEL_MAX_PER_TICK = 16;
const FLEET_CLEANUP_DISCOVERY_PAGE_SIZE = 128;
const FLEET_REPORT_CLEANUP_ENQUEUE_MAX_PER_TICK = 64;
export const FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT = 128;
const FLEET_DESTRUCTIVE_TARGET_TEXT_MAX = 4096;
const FLEET_DESTRUCTIVE_DIGEST = /^[0-9a-f]{64}$/;

export type FleetDestructiveAction = "cancel" | "cleanup";

export interface FleetConfirmedCleanupTarget {
  worktreePath: string;
  projectPath: string;
  workerId: string | null;
  primaryOwner: FleetDestructivePreviewOwnerRef;
}

export interface FleetConfirmedIntegrationTarget {
  worktreePath: string;
  projectPath: string;
  branchName: string;
  expectedHeadSha: string | null;
}

export interface FleetDestructiveConfirmation {
  preview: FleetDestructiveActionPreview;
  targetSetDigest: string;
  sessionIds: string[];
  cleanupTargets: FleetConfirmedCleanupTarget[];
  integrationTarget: FleetConfirmedIntegrationTarget | null;
}

export interface FleetLifecycleDeps {
  db: Database.Database;
  now: () => Date;
  deleteWorktree: typeof deleteWorktree;
  getMainRepoPath: typeof getMainRepoPath;
  pathExists: (value: string) => boolean;
  stopSession: typeof stopFleetSession;
  deleteReportFile: typeof deleteFleetWorkerReportFile;
}

export interface FleetCleanupPreviewItem {
  ownerType: CleanupOwnerType;
  ownerId: string;
  workerId: string | null;
  worktreePath: string;
  projectPath: string;
  exists: boolean;
  ownerCount: number;
}

export interface FleetCleanupPreview {
  runId: string;
  archived: boolean;
  terminal: boolean;
  eligible: FleetCleanupPreviewItem[];
  skipped: Array<{
    ownerType: CleanupOwnerType;
    ownerId: string;
    workerId: string | null;
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
    stopSession: overrides.stopSession ?? stopFleetSession,
    deleteReportFile: overrides.deleteReportFile ?? deleteFleetWorkerReportFile,
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

/**
 * Hash every database field that can change the bounded destructive preview or
 * the executor's exact ownership decision. Callers compare this value again
 * inside the mutation transaction, closing the GET/POST time-of-check gap
 * without holding a database lock across filesystem ownership probes.
 */
export function fleetDestructiveDatabaseRevision(
  db: Database.Database,
  runId: string,
  action: FleetDestructiveAction
): string {
  const all = (sql: string, bindings = 1): unknown[] =>
    db.prepare(sql).all(...Array.from({ length: bindings }, () => runId));
  const snapshot = {
    schemaVersion: 1,
    action,
    run: all(
      `SELECT id, status, desired_state, archived_at, cancel_mode,
              retention_days, automation_policy_json, settings_json,
              integration_state, integration_branch, integration_worktree,
              integration_head_sha
       FROM fleet_runs WHERE id = ? ORDER BY id`
    ),
    tasks: all(
      `SELECT id, status, working_directory, worktree_path, branch_name
       FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY id`
    ),
    workers: all(
      `SELECT id, task_id, status, worktree_path, branch_name, session_id,
              ended_at
       FROM fleet_workers WHERE fleet_run_id = ? ORDER BY id`
    ),
    planReviews: all(
      `SELECT id, subject_type, state, request_id, project_path,
              worktree_path, branch_name, reviewer_session_id
       FROM fleet_reviews WHERE fleet_run_id = ? ORDER BY id`
    ),
    taskReviews: all(
      `SELECT id, task_id, worker_id, state, request_id, project_path,
              reviewer_worktree_path, reviewer_branch_name,
              reviewer_session_id
       FROM fleet_task_reviews WHERE fleet_run_id = ? ORDER BY id`
    ),
    fixes: all(
      `SELECT id, task_id, worker_id, state, request_id, project_path,
              worktree_path, branch_name, fixer_session_id
       FROM fleet_task_fixes WHERE fleet_run_id = ? ORDER BY id`
    ),
    costs: all(
      `SELECT owner_type, owner_id, task_id, session_id, terminal_at
       FROM fleet_cost_accounts WHERE fleet_run_id = ?
       ORDER BY owner_type, owner_id, id`
    ),
    sessions: all(
      `SELECT id, name, status, worktree_path, branch_name
       FROM sessions WHERE id IN (
         SELECT session_id FROM fleet_cost_accounts
          WHERE fleet_run_id = ? AND session_id IS NOT NULL
         UNION SELECT session_id FROM fleet_workers
          WHERE fleet_run_id = ? AND session_id IS NOT NULL
         UNION SELECT reviewer_session_id FROM fleet_reviews
          WHERE fleet_run_id = ? AND reviewer_session_id IS NOT NULL
         UNION SELECT reviewer_session_id FROM fleet_task_reviews
          WHERE fleet_run_id = ? AND reviewer_session_id IS NOT NULL
         UNION SELECT fixer_session_id FROM fleet_task_fixes
          WHERE fleet_run_id = ? AND fixer_session_id IS NOT NULL
       ) ORDER BY id`,
      5
    ),
    workerLeases: all(
      `SELECT worker_id, resource_type, resource_key, status
       FROM fleet_resource_leases WHERE fleet_run_id = ?
       ORDER BY worker_id, resource_type, resource_key, id`
    ),
    runtimeLeases: all(
      `SELECT owner_type, owner_id, resource_type, resource_key, units, status
       FROM fleet_runtime_leases WHERE fleet_run_id = ?
       ORDER BY owner_type, owner_id, resource_type, resource_key, id`
    ),
  };
  return stableHash(JSON.stringify(snapshot));
}

function destructivePreviewTargetDigest(
  preview: Omit<FleetDestructiveActionPreview, "targetDigest">
): string {
  const worktrees = preview.worktrees
    .map((worktree) => ({
      worktreePath: normalizeWorktreePath(worktree.worktreePath),
      projectPath: normalizeWorktreePath(worktree.projectPath),
      exists: worktree.exists,
      expectedHeadSha: worktree.expectedHeadSha,
      owners: [...worktree.owners].sort((left, right) => {
        const a = `${left.ownerType}\0${left.ownerId}`;
        const b = `${right.ownerType}\0${right.ownerId}`;
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    }))
    .sort((left, right) =>
      left.worktreePath < right.worktreePath
        ? -1
        : left.worktreePath > right.worktreePath
          ? 1
          : 0
    );
  const deletedBranches = preview.branches
    .filter((branch) => !branch.preserved)
    .map((branch) => ({
      branchName: branch.branchName,
      worktreePath: normalizeWorktreePath(branch.worktreePath),
      ownerType: branch.ownerType,
      ownerId: branch.ownerId,
      expectedHeadSha: branch.expectedHeadSha,
    }))
    .sort((left, right) => {
      const a = `${left.branchName}\0${left.ownerType}\0${left.ownerId}`;
      const b = `${right.branchName}\0${right.ownerType}\0${right.ownerId}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return stableHash(
    JSON.stringify({
      schemaVersion: 1,
      action: preview.action,
      runId: preview.runId,
      sessionIds:
        preview.action === "cancel"
          ? preview.sessions
              .filter((session) => session.active)
              .map((session) => session.id)
              .sort()
          : [],
      worktrees,
      deletedBranches,
    })
  );
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

function cancellationRetentionDays(run: FleetRunRow): number | null {
  if (run.retention_days != null) {
    const stored = validRetentionDays(run.retention_days);
    return stored === undefined ? null : stored;
  }
  try {
    const policy = payload(JSON.parse(run.automation_policy_json ?? "{}"));
    const configured = validRetentionDays(policy.retentionDays);
    return configured === undefined ? null : configured;
  } catch {
    return null;
  }
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
      }),
      { controlPlane: true }
    );
    return { archivedAt: nowIso, retentionDays };
  });
}

type CleanupOwnerType = "worker" | "plan_review" | "task_review" | "fixer";

interface CleanupOwnerRef {
  ownerType: CleanupOwnerType;
  ownerId: string;
  workerId: string | null;
  evidenceId: string;
}

interface CleanupCandidate {
  source_rank: number;
  owner_type: CleanupOwnerType;
  owner_id: string;
  evidence_id: string;
  worker_id: string | null;
  worktree_path: string;
  worker_worktree_path: string | null;
  task_worktree_path: string | null;
  project_path: string | null;
  session_worktree_path: string | null;
  worker_status: string | null;
  task_id: string | null;
  session_id: string | null;
  session_name: string | null;
  session_status: string | null;
  branch_name: string | null;
}

function candidateOwner(candidate: CleanupCandidate): CleanupOwnerRef {
  return {
    ownerType: candidate.owner_type,
    ownerId: candidate.owner_id,
    workerId: candidate.worker_id,
    evidenceId: candidate.evidence_id,
  };
}

function discoverCleanupCandidates(
  db: Database.Database,
  runId: string,
  options: {
    includeActiveWorkers?: boolean;
    maxCandidates?: number;
  } = {}
): CleanupCandidate[] {
  const workerStatusFilter = options.includeActiveWorkers
    ? ""
    : `AND w.status NOT IN ('leasing', 'spawning', 'running',
                            'waiting_for_operator', 'cleanup_pending')`;
  const page = db.prepare(
    `WITH cleanup_candidates AS (
       SELECT 1 AS source_rank, 'worker' AS owner_type, w.id AS owner_id,
              w.id AS evidence_id, w.id AS worker_id,
              w.worktree_path, w.worktree_path AS worker_worktree_path,
              t.worktree_path AS task_worktree_path,
              t.working_directory AS project_path,
              s.worktree_path AS session_worktree_path, w.status AS worker_status,
              w.task_id, w.session_id, s.name AS session_name,
              s.status AS session_status,
              COALESCE(w.branch_name, t.branch_name) AS branch_name
       FROM fleet_workers w
       LEFT JOIN fleet_tasks t
         ON t.id = w.task_id AND t.fleet_run_id = w.fleet_run_id
       LEFT JOIN sessions s ON s.id = w.session_id
       WHERE w.fleet_run_id = ? AND w.worktree_path IS NOT NULL
         ${workerStatusFilter}
       UNION ALL
       SELECT 2, 'plan_review', v.request_id, v.id, NULL,
              v.worktree_path, NULL, NULL, v.project_path, s.worktree_path, NULL,
              NULL, v.reviewer_session_id, s.name, s.status, v.branch_name
       FROM fleet_reviews v
       LEFT JOIN sessions s ON s.id = v.reviewer_session_id
       WHERE v.fleet_run_id = ? AND v.subject_type = 'plan'
         AND v.request_id <> '' AND v.worktree_path IS NOT NULL
       UNION ALL
       SELECT 3, 'task_review', v.request_id, v.id, v.worker_id,
              v.reviewer_worktree_path, NULL, NULL, v.project_path,
              s.worktree_path, NULL, v.task_id, v.reviewer_session_id,
              s.name, s.status, v.reviewer_branch_name
       FROM fleet_task_reviews v
       LEFT JOIN sessions s ON s.id = v.reviewer_session_id
       WHERE v.fleet_run_id = ? AND v.request_id <> ''
         AND v.reviewer_worktree_path IS NOT NULL
       UNION ALL
       SELECT 4, 'fixer', f.request_id, f.id, f.worker_id,
              f.worktree_path, w.worktree_path, t.worktree_path,
              COALESCE(f.project_path, t.working_directory), s.worktree_path,
              w.status, f.task_id, f.fixer_session_id, s.name, s.status,
              f.branch_name
       FROM fleet_task_fixes f
       LEFT JOIN fleet_tasks t
         ON t.id = f.task_id AND t.fleet_run_id = f.fleet_run_id
       LEFT JOIN fleet_workers w
         ON w.id = f.worker_id AND w.fleet_run_id = f.fleet_run_id
       LEFT JOIN sessions s ON s.id = f.fixer_session_id
       WHERE f.fleet_run_id = ? AND f.request_id <> ''
         AND f.worktree_path IS NOT NULL
     )
     SELECT * FROM cleanup_candidates
     WHERE source_rank > ? OR (source_rank = ? AND evidence_id > ?)
     ORDER BY source_rank, evidence_id
     LIMIT ?`
  );
  const discovered: CleanupCandidate[] = [];
  const maximum =
    options.maxCandidates && options.maxCandidates > 0
      ? options.maxCandidates
      : Number.POSITIVE_INFINITY;
  let rank = 0;
  let evidenceId = "";
  while (discovered.length < maximum) {
    const pageSize = Math.min(
      FLEET_CLEANUP_DISCOVERY_PAGE_SIZE,
      maximum - discovered.length
    );
    const rows = page.all(
      runId,
      runId,
      runId,
      runId,
      rank,
      rank,
      evidenceId,
      pageSize
    ) as CleanupCandidate[];
    discovered.push(...rows);
    if (rows.length < pageSize) break;
    const last = rows.at(-1)!;
    rank = last.source_rank;
    evidenceId = last.evidence_id;
  }
  return discovered;
}

function hasExactWorkerLease(
  db: Database.Database,
  runId: string,
  workerId: string,
  target: string
): boolean {
  const leases = db
    .prepare(
      `SELECT resource_key FROM fleet_resource_leases
       WHERE fleet_run_id = ? AND worker_id = ? AND resource_type = 'worktree'`
    )
    .all(runId, workerId) as Array<{ resource_key: string }>;
  const normalized = normalizeWorktreePath(target);
  return leases.some(
    (lease) => normalizeWorktreePath(lease.resource_key) === normalized
  );
}

function hasReviewRuntimeLease(
  db: Database.Database,
  runId: string,
  ownerType: "plan_review" | "task_review",
  ownerId: string
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM fleet_runtime_leases
         WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?
           AND resource_type = 'repo_worktree'
         LIMIT 1`
      )
      .get(runId, ownerType, ownerId)
  );
}

async function evaluateCleanupCandidate(
  runId: string,
  candidate: CleanupCandidate,
  runtime: FleetLifecycleDeps,
  ownershipCache: Map<string, Promise<boolean>> = new Map(),
  allowActiveWorker = false
): Promise<
  | {
      ok: true;
      item: Omit<FleetCleanupPreviewItem, "ownerCount">;
    }
  | { ok: false; reason: string }
> {
  const target = candidate.worktree_path;
  if (target.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX) {
    return { ok: false, reason: "worktree path exceeds the safety bound" };
  }
  const normalizedTarget = normalizeWorktreePath(target);
  if (candidate.owner_type === "worker" || candidate.owner_type === "fixer") {
    if (
      !candidate.worker_id ||
      !candidate.worker_status ||
      (!allowActiveWorker &&
        [
          "leasing",
          "spawning",
          "running",
          "waiting_for_operator",
          "cleanup_pending",
        ].includes(candidate.worker_status)) ||
      !candidate.worker_worktree_path ||
      !candidate.task_worktree_path ||
      normalizeWorktreePath(candidate.worker_worktree_path) !==
        normalizedTarget ||
      normalizeWorktreePath(candidate.task_worktree_path) !== normalizedTarget
    ) {
      return { ok: false, reason: "task and worker worktree records differ" };
    }
    if (!hasExactWorkerLease(runtime.db, runId, candidate.worker_id, target)) {
      return { ok: false, reason: "no exact Fleet-owned worktree lease" };
    }
  } else if (
    !hasReviewRuntimeLease(
      runtime.db,
      runId,
      candidate.owner_type,
      candidate.owner_id
    )
  ) {
    return { ok: false, reason: "no exact Fleet-owned review lease" };
  }
  if (
    candidate.session_worktree_path &&
    normalizeWorktreePath(candidate.session_worktree_path) !== normalizedTarget
  ) {
    return { ok: false, reason: "session and owner worktree records differ" };
  }
  if (!isStoaWorktree(target)) {
    return { ok: false, reason: "path is outside the Stoa worktree root" };
  }
  const projectPath = candidate.project_path;
  if (!projectPath) {
    return { ok: false, reason: "project path is not recorded" };
  }
  if (projectPath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX) {
    return { ok: false, reason: "project path exceeds the safety bound" };
  }
  const exists = runtime.pathExists(target);
  if (exists) {
    const cacheKey = `${normalizedTarget}\0${normalizeWorktreePath(projectPath)}`;
    let verified = ownershipCache.get(cacheKey);
    if (!verified) {
      verified = runtime
        .getMainRepoPath(target)
        .then(
          (owner) =>
            Boolean(owner) &&
            normalizeWorktreePath(owner!) === normalizeWorktreePath(projectPath)
        );
      ownershipCache.set(cacheKey, verified);
    }
    if (!(await verified)) {
      return {
        ok: false,
        reason: "worktree project ownership could not be verified",
      };
    }
  }
  return {
    ok: true,
    item: {
      ownerType: candidate.owner_type,
      ownerId: candidate.owner_id,
      workerId: candidate.worker_id,
      worktreePath: target,
      projectPath,
      exists,
    },
  };
}

/**
 * Build the bounded, ownership-verified impact inventory shown before a
 * destructive Fleet action. Recorded paths are included only after the same
 * lease, Stoa-root, session-binding, and repository-owner checks used by the
 * cleanup executor. A truncated inventory is explicitly incomplete so the UI
 * can fail closed instead of asking an operator to approve unseen objects.
 */
async function buildFleetDestructiveActionPreview(
  runId: string,
  overrides: Partial<FleetLifecycleDeps>,
  action: FleetDestructiveAction,
  revision: string
): Promise<FleetDestructiveActionPreview | { error: string; status: number }> {
  const runtime = lifecycleDeps(overrides);
  const run = queries.getFleetRun(runtime.db).get(runId) as
    FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };

  let integrationTarget: {
    worktreePath: string;
    projectPath: string;
    branchName: string;
    headSha: string | null;
  } | null = null;
  let integrationTargetUnsafe = false;
  if (
    action === "cancel" &&
    run.integration_worktree &&
    run.integration_branch
  ) {
    const identity = fleetIntegrationIdentity(runId);
    const tasks = queries
      .listFleetTasksForRun(runtime.db)
      .all(runId) as FleetTaskRow[];
    const target = resolveFleetMergeTarget(runtime.db, run, tasks);
    if (
      target &&
      normalizeWorktreePath(run.integration_worktree) ===
        normalizeWorktreePath(identity.worktree) &&
      run.integration_branch === identity.branch
    ) {
      if (
        run.integration_worktree.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
        target.repoPath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
        run.integration_branch.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX
      ) {
        integrationTargetUnsafe = true;
      } else {
        integrationTarget = {
          worktreePath: run.integration_worktree,
          projectPath: target.repoPath,
          branchName: run.integration_branch,
          headSha: run.integration_head_sha ?? null,
        };
      }
    }
  }

  const limit = FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT;
  const candidates = discoverCleanupCandidates(runtime.db, runId, {
    includeActiveWorkers: action === "cancel",
    maxCandidates: limit + 1,
  });
  const candidateTruncated = candidates.length > limit;
  const visibleCandidates = candidates.slice(0, limit);
  const ownershipCache = new Map<string, Promise<boolean>>();
  const verified: Array<{
    candidate: CleanupCandidate;
    item: Omit<FleetCleanupPreviewItem, "ownerCount">;
  }> = [];
  let excludedWorktreeCount = 0;
  for (const candidate of visibleCandidates) {
    const evaluated = await evaluateCleanupCandidate(
      runId,
      candidate,
      runtime,
      ownershipCache,
      true
    );
    if (evaluated.ok) verified.push({ candidate, item: evaluated.item });
    else excludedWorktreeCount += 1;
  }

  type CostOwnerRow = {
    owner_type: FleetDestructiveOwnerType;
    owner_id: string;
    task_id: string | null;
    session_id: string | null;
    terminal_at: string | null;
    session_name: string | null;
    session_status: string | null;
  };
  const costOwnerRows = runtime.db
    .prepare(
      `SELECT c.owner_type, c.owner_id, c.task_id, c.session_id, c.terminal_at,
              s.name AS session_name, s.status AS session_status
       FROM fleet_cost_accounts c
       LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.fleet_run_id = ?
          AND c.owner_type IN ('planner', 'plan_review', 'worker',
                               'task_review', 'fixer', 'supervisor')
       ORDER BY c.owner_type, c.owner_id
       LIMIT ?`
    )
    .all(runId, limit + 1) as CostOwnerRow[];
  const costOwnersTruncated = costOwnerRows.length > limit;

  const ownerMap = new Map<string, FleetDestructivePreviewOwner>();
  for (const row of costOwnerRows.slice(0, limit)) {
    ownerMap.set(`${row.owner_type}\0${row.owner_id}`, {
      ownerType: row.owner_type,
      ownerId: row.owner_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      sessionName: row.session_name,
      sessionStatus: row.session_status,
      active: row.terminal_at == null,
    });
  }
  for (const { candidate } of verified) {
    const key = `${candidate.owner_type}\0${candidate.owner_id}`;
    if (ownerMap.has(key)) continue;
    ownerMap.set(key, {
      ownerType: candidate.owner_type,
      ownerId: candidate.owner_id,
      taskId: candidate.task_id,
      sessionId: candidate.session_id,
      sessionName: candidate.session_name,
      sessionStatus: candidate.session_status,
      active: false,
    });
  }
  if (integrationTarget) {
    ownerMap.set(`integration_workspace\0${runId}`, {
      ownerType: "integration_workspace",
      ownerId: runId,
      taskId: null,
      sessionId: null,
      sessionName: null,
      sessionStatus: null,
      active: Boolean(
        run.integration_state &&
        ACTIVE_INTEGRATION_STATES.has(run.integration_state)
      ),
    });
  }
  const allOwners = [...ownerMap.values()].sort(
    (left, right) =>
      left.ownerType.localeCompare(right.ownerType) ||
      left.ownerId.localeCompare(right.ownerId)
  );
  const ownersTruncated =
    costOwnersTruncated || candidateTruncated || allOwners.length > limit;
  const owners = allOwners.slice(0, limit);

  const sessionMap = new Map<
    string,
    {
      id: string;
      name: string | null;
      status: string | null;
      active: boolean;
      owners: Array<{
        ownerType: FleetDestructiveTargetOwnerType;
        ownerId: string;
      }>;
    }
  >();
  for (const owner of allOwners) {
    if (!owner.sessionId) continue;
    const existing = sessionMap.get(owner.sessionId);
    const ref = { ownerType: owner.ownerType, ownerId: owner.ownerId };
    if (existing) {
      if (
        !existing.owners.some(
          (value) =>
            value.ownerType === ref.ownerType && value.ownerId === ref.ownerId
        )
      ) {
        existing.owners.push(ref);
      }
      existing.active ||= owner.active;
      existing.name ??= owner.sessionName;
      existing.status ??= owner.sessionStatus;
    } else {
      sessionMap.set(owner.sessionId, {
        id: owner.sessionId,
        name: owner.sessionName,
        status: owner.sessionStatus,
        active: owner.active,
        owners: [ref],
      });
    }
  }
  const allSessions = [...sessionMap.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const sessionsTruncated = ownersTruncated || allSessions.length > limit;
  const sessions = allSessions.slice(0, limit);

  const worktreeMap = new Map<
    string,
    {
      worktreePath: string;
      projectPath: string;
      exists: boolean;
      expectedHeadSha: string | null;
      owners: FleetDestructivePreviewOwnerRef[];
      branchNames: Set<string>;
      sessionIds: Set<string>;
    }
  >();
  const allBranches: FleetDestructiveActionPreview["branches"] = [];
  const branchKeys = new Set<string>();
  for (const { candidate, item } of verified) {
    const key = normalizeWorktreePath(item.worktreePath);
    let worktree = worktreeMap.get(key);
    if (!worktree) {
      worktree = {
        worktreePath: item.worktreePath,
        projectPath: item.projectPath,
        exists: item.exists,
        expectedHeadSha: null,
        owners: [],
        branchNames: new Set<string>(),
        sessionIds: new Set<string>(),
      };
      worktreeMap.set(key, worktree);
    }
    const owner = {
      ownerType: candidate.owner_type,
      ownerId: candidate.owner_id,
      workerId: candidate.worker_id,
      sessionId: candidate.session_id,
    };
    if (
      !worktree.owners.some(
        (value) =>
          value.ownerType === owner.ownerType && value.ownerId === owner.ownerId
      )
    ) {
      worktree.owners.push(owner);
    }
    if (candidate.session_id) worktree.sessionIds.add(candidate.session_id);
    if (candidate.branch_name) {
      worktree.branchNames.add(candidate.branch_name);
      const branchKey = `${candidate.owner_type}\0${candidate.owner_id}\0${candidate.branch_name}\0${key}`;
      if (!branchKeys.has(branchKey)) {
        branchKeys.add(branchKey);
        allBranches.push({
          branchName: candidate.branch_name,
          worktreePath: item.worktreePath,
          ownerType: candidate.owner_type,
          ownerId: candidate.owner_id,
          expectedHeadSha: null,
          preserved: true,
        });
      }
    }
  }
  if (integrationTarget) {
    const exists = runtime.pathExists(integrationTarget.worktreePath);
    const ownerVerified = exists
      ? await runtime
          .getMainRepoPath(integrationTarget.worktreePath)
          .then(
            (owner) =>
              Boolean(owner) &&
              normalizeWorktreePath(owner!) ===
                normalizeWorktreePath(integrationTarget!.projectPath)
          )
          .catch(() => false)
      : true;
    if (!ownerVerified) {
      integrationTargetUnsafe = true;
      excludedWorktreeCount += 1;
    } else {
      const key = normalizeWorktreePath(integrationTarget.worktreePath);
      worktreeMap.set(key, {
        worktreePath: integrationTarget.worktreePath,
        projectPath: integrationTarget.projectPath,
        exists,
        expectedHeadSha: integrationTarget.headSha,
        owners: [
          {
            ownerType: "integration_workspace",
            ownerId: runId,
            workerId: null,
            sessionId: null,
          },
        ],
        branchNames: new Set([integrationTarget.branchName]),
        sessionIds: new Set(),
      });
      allBranches.push({
        branchName: integrationTarget.branchName,
        worktreePath: integrationTarget.worktreePath,
        ownerType: "integration_workspace",
        ownerId: runId,
        expectedHeadSha: integrationTarget.headSha,
        preserved: false,
      });
    }
  }
  const allWorktrees = [...worktreeMap.values()]
    .map((item) => ({
      ...item,
      branchNames: [...item.branchNames].sort(),
      sessionIds: [...item.sessionIds].sort(),
    }))
    .sort((left, right) => left.worktreePath.localeCompare(right.worktreePath));
  allBranches.sort(
    (left, right) =>
      left.branchName.localeCompare(right.branchName) ||
      left.ownerId.localeCompare(right.ownerId)
  );
  const worktreesTruncated =
    candidateTruncated ||
    integrationTargetUnsafe ||
    allWorktrees.length > limit;
  const branchesTruncated =
    candidateTruncated || integrationTargetUnsafe || allBranches.length > limit;
  const worktrees = allWorktrees.slice(0, limit);
  const branches = allBranches.slice(0, limit);

  type ArtifactRow = Omit<
    FleetDestructiveActionPreview["artifacts"][number],
    "preserved"
  >;
  const artifactRows = runtime.db
    .prepare(
      `SELECT id, task_id AS taskId, worker_id AS workerId,
              artifact_type AS artifactType, title, byte_count AS byteCount,
              body_pruned_at AS bodyPrunedAt
       FROM fleet_artifacts WHERE fleet_run_id = ?
       ORDER BY created_at, id LIMIT ?`
    )
    .all(runId, limit + 1) as ArtifactRow[];
  const artifactsTruncated = artifactRows.length > limit;
  const artifacts = artifactRows.slice(0, limit).map((item) => ({
    ...item,
    preserved: true as const,
  }));

  const truncatedKinds: FleetDestructiveActionPreview["truncatedKinds"] = [];
  if (ownersTruncated) truncatedKinds.push("owners");
  if (sessionsTruncated) truncatedKinds.push("sessions");
  if (worktreesTruncated) truncatedKinds.push("worktrees");
  if (branchesTruncated) truncatedKinds.push("branches");
  if (artifactsTruncated) truncatedKinds.push("artifacts");

  const preview = {
    runId,
    action,
    revision,
    complete: truncatedKinds.some((kind) => kind !== "artifacts") === false,
    objectLimit: limit,
    truncatedKinds,
    excludedWorktreeCount,
    owners,
    sessions,
    worktrees,
    branches,
    artifacts,
    effects: {
      stopActiveSessions: action === "cancel",
      deleteVerifiedWorktrees: true,
      preserveBranches: !allBranches.some((branch) => !branch.preserved),
      preserveArtifactMetadata: true,
      artifactBodyRetentionDays: cancellationRetentionDays(run),
    },
  } satisfies Omit<FleetDestructiveActionPreview, "targetDigest">;
  return {
    ...preview,
    targetDigest: destructivePreviewTargetDigest(preview),
  };
}

export async function previewFleetDestructiveAction(
  runId: string,
  overrides: Partial<FleetLifecycleDeps> = {},
  action: FleetDestructiveAction = "cancel"
): Promise<FleetDestructiveActionPreview | { error: string; status: number }> {
  const runtime = lifecycleDeps(overrides);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = fleetDestructiveDatabaseRevision(runtime.db, runId, action);
    const preview = await buildFleetDestructiveActionPreview(
      runId,
      runtime,
      action,
      before
    );
    if ("error" in preview) return preview;
    const after = fleetDestructiveDatabaseRevision(runtime.db, runId, action);
    if (before === after) return preview;
  }
  return {
    error: "Fleet destructive targets changed while building the preview",
    status: 409,
  };
}

function confirmedTargetSetDigest(input: {
  action: FleetDestructiveAction;
  runId: string;
  sessionIds: string[];
  cleanupTargets: FleetConfirmedCleanupTarget[];
  integrationTarget: FleetConfirmedIntegrationTarget | null;
}): string {
  const canonicalTargets = {
    schemaVersion: 1,
    action: input.action,
    runId: input.runId,
    sessionIds: [...input.sessionIds].sort(),
    cleanupTargets: input.cleanupTargets.map((target) => ({
      worktreePath: normalizeWorktreePath(target.worktreePath),
      projectPath: normalizeWorktreePath(target.projectPath),
      workerId: target.workerId,
      primaryOwner: target.primaryOwner,
    })),
    integrationTarget: input.integrationTarget
      ? {
          ...input.integrationTarget,
          worktreePath: normalizeWorktreePath(
            input.integrationTarget.worktreePath
          ),
          projectPath: normalizeWorktreePath(
            input.integrationTarget.projectPath
          ),
        }
      : null,
  };
  return stableHash(JSON.stringify(canonicalTargets));
}

function exactConfirmedTargets(
  preview: FleetDestructiveActionPreview
):
  | Omit<FleetDestructiveConfirmation, "preview">
  | { error: string; status: number } {
  const cleanupTargets: FleetConfirmedCleanupTarget[] = [];
  let integrationTarget: FleetConfirmedIntegrationTarget | null = null;
  for (const worktree of preview.worktrees) {
    const integrationOwner = worktree.owners.find(
      (owner) => owner.ownerType === "integration_workspace"
    );
    if (integrationOwner) {
      const deletedBranches = preview.branches.filter(
        (branch) =>
          !branch.preserved &&
          branch.ownerType === "integration_workspace" &&
          branch.ownerId === integrationOwner.ownerId &&
          normalizeWorktreePath(branch.worktreePath) ===
            normalizeWorktreePath(worktree.worktreePath)
      );
      if (integrationTarget || deletedBranches.length !== 1) {
        return {
          error: "Fleet integration cleanup target set is ambiguous",
          status: 409,
        };
      }
      integrationTarget = {
        worktreePath: worktree.worktreePath,
        projectPath: worktree.projectPath,
        branchName: deletedBranches[0].branchName,
        expectedHeadSha: worktree.expectedHeadSha,
      };
      continue;
    }
    const primaryOwner = worktree.owners[0];
    if (!primaryOwner) {
      return {
        error: "Fleet cleanup target has no exact owner",
        status: 409,
      };
    }
    cleanupTargets.push({
      worktreePath: worktree.worktreePath,
      projectPath: worktree.projectPath,
      workerId: primaryOwner.workerId,
      primaryOwner,
    });
  }
  const sessionIds =
    preview.action === "cancel"
      ? preview.sessions
          .filter((session) => session.active)
          .map((session) => session.id)
          .sort()
      : [];
  const targetSet = {
    action: preview.action,
    runId: preview.runId,
    sessionIds,
    cleanupTargets,
    integrationTarget,
  };
  return {
    targetSetDigest: confirmedTargetSetDigest(targetSet),
    sessionIds,
    cleanupTargets,
    integrationTarget,
  };
}

/** Rebuild and bind a complete exact target set immediately before mutation. */
export async function confirmFleetDestructiveAction(
  runId: string,
  input: unknown,
  overrides: Partial<FleetLifecycleDeps> = {},
  action: FleetDestructiveAction = "cancel"
): Promise<FleetDestructiveConfirmation | { error: string; status: number }> {
  const body = payload(input);
  const expectedDigest = body.previewDigest;
  if (
    typeof expectedDigest !== "string" ||
    !FLEET_DESTRUCTIVE_DIGEST.test(expectedDigest)
  ) {
    return {
      error: "a valid destructive previewDigest is required",
      status: 400,
    };
  }
  const preview = await previewFleetDestructiveAction(runId, overrides, action);
  if ("error" in preview) return preview;
  if (!preview.complete) {
    return {
      error:
        "destructive preview is incomplete; no mutation or cleanup was queued",
      status: 409,
    };
  }
  if (preview.targetDigest !== expectedDigest) {
    return {
      error: "destructive targets changed; refresh and confirm the new preview",
      status: 409,
    };
  }
  const targets = exactConfirmedTargets(preview);
  return "error" in targets ? targets : { preview, ...targets };
}

export async function previewFleetCleanup(
  runId: string,
  overrides: Partial<FleetLifecycleDeps> = {}
): Promise<FleetCleanupPreview | { error: string; status: number }> {
  const runtime = lifecycleDeps(overrides);
  const run = queries.getFleetRun(runtime.db).get(runId) as
    FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  const candidates = discoverCleanupCandidates(runtime.db, runId);
  const eligible: FleetCleanupPreviewItem[] = [];
  const skipped: FleetCleanupPreview["skipped"] = [];
  const groups = new Map<
    string,
    {
      item: Omit<FleetCleanupPreviewItem, "ownerCount">;
      owners: CleanupOwnerRef[];
    }
  >();
  const ownershipCache = new Map<string, Promise<boolean>>();
  for (const candidate of candidates) {
    const evaluated = await evaluateCleanupCandidate(
      runId,
      candidate,
      runtime,
      ownershipCache
    );
    if (evaluated.ok) {
      const normalized = normalizeWorktreePath(evaluated.item.worktreePath);
      const current = groups.get(normalized);
      if (current) current.owners.push(candidateOwner(candidate));
      else {
        groups.set(normalized, {
          item: evaluated.item,
          owners: [candidateOwner(candidate)],
        });
      }
    } else {
      skipped.push({
        ownerType: candidate.owner_type,
        ownerId: candidate.owner_id,
        workerId: candidate.worker_id,
        worktreePath: candidate.worktree_path,
        reason: evaluated.reason,
      });
    }
  }
  for (const group of groups.values()) {
    eligible.push({
      ...group.item,
      ownerCount: group.owners.length,
    });
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
  const confirmation = await confirmFleetDestructiveAction(
    runId,
    body,
    runtime,
    "cleanup"
  );
  if ("error" in confirmation) return confirmation;
  if (!preview.terminal) {
    return { error: "only terminal fleet runs can be cleaned", status: 409 };
  }
  if (!preview.archived) {
    return {
      error: "archive the fleet run before requesting cleanup",
      status: 409,
    };
  }
  const eligibleKeys = new Set(
    preview.eligible.map(
      (item) =>
        `${normalizeWorktreePath(item.worktreePath)}\0${normalizeWorktreePath(
          item.projectPath
        )}`
    )
  );
  const confirmedKeys = new Set(
    confirmation.cleanupTargets.map(
      (item) =>
        `${normalizeWorktreePath(item.worktreePath)}\0${normalizeWorktreePath(
          item.projectPath
        )}`
    )
  );
  if (
    eligibleKeys.size !== confirmedKeys.size ||
    [...eligibleKeys].some((key) => !confirmedKeys.has(key))
  ) {
    return {
      error: "cleanup ownership changed; refresh and confirm the new preview",
      status: 409,
    };
  }
  const requestedBy = actor(body.actor);
  const nowIso = runtime.now().toISOString();
  const queued = transaction<number | { error: string; status: number }>(
    runtime.db,
    () => {
      if (
        fleetDestructiveDatabaseRevision(runtime.db, runId, "cleanup") !==
        confirmation.preview.revision
      ) {
        return {
          error: "cleanup targets changed; refresh and confirm the new preview",
          status: 409,
        };
      }
      let created = 0;
      const insert = runtime.db.prepare(
        `INSERT OR IGNORE INTO fleet_cleanup_actions
       (id, action_key, fleet_run_id, worker_id, action_type, state,
        target_path, project_path, requested_by, metadata_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 'delete_worktree', 'pending', ?, ?, ?, ?, ?, ?)`
      );
      for (const item of confirmation.cleanupTargets) {
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
          JSON.stringify({
            schemaVersion: 1,
            confirmationDigest: confirmation.preview.targetDigest,
            targetSetDigest: confirmation.targetSetDigest,
            primaryOwner: item.primaryOwner,
          }),
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
            confirmationDigest: confirmation.preview.targetDigest,
            targetSetDigest: confirmation.targetSetDigest,
          }),
          { controlPlane: true }
        );
      }
      return created;
    }
  );
  if (typeof queued !== "number") return queued;
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
         started_at = COALESCE(started_at, ?), completed_at = NULL,
         updated_at = ?, error = NULL
         WHERE id = ? AND (
           state = 'pending' OR
           (state = 'failed' AND attempt_count < ?) OR
           (state = 'running' AND attempt_count < ? AND
             (lease_expires_at IS NULL OR lease_expires_at <= ?))
         )`
      )
      .run(
        input.owner,
        leaseExpiresAt,
        nowIso,
        nowIso,
        input.actionId,
        FLEET_CLEANUP_MAX_ATTEMPTS,
        FLEET_CLEANUP_MAX_ATTEMPTS,
        nowIso
      ).changes === 1
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
  const safeError = error
    ? redactAndCapFleetText(error, 500).text || "cleanup failed"
    : null;
  transaction(runtime.db, () => {
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_cleanup_actions SET state = ?, error = ?, lease_owner = NULL,
         lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(state, safeError, nowIso, nowIso, row.id, owner);
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
        error: safeError,
      }),
      { controlPlane: true }
    );
  });
}

function failExhaustedCleanupClaims(runtime: FleetLifecycleDeps): number {
  const nowIso = runtime.now().toISOString();
  const rows = runtime.db
    .prepare(
      `SELECT id, fleet_run_id, action_type FROM fleet_cleanup_actions
       WHERE state = 'running' AND attempt_count >= ?
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
       ORDER BY updated_at, id LIMIT 16`
    )
    .all(FLEET_CLEANUP_MAX_ATTEMPTS, nowIso) as Array<{
    id: string;
    fleet_run_id: string;
    action_type: string;
  }>;
  let failed = 0;
  for (const row of rows) {
    const applied = transaction(runtime.db, () => {
      const changed = runtime.db
        .prepare(
          `UPDATE fleet_cleanup_actions
           SET state = 'failed', error = 'cleanup retry limit exhausted',
               lease_owner = NULL, lease_expires_at = NULL,
               completed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND attempt_count >= ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
        )
        .run(nowIso, nowIso, row.id, FLEET_CLEANUP_MAX_ATTEMPTS, nowIso);
      if (changed.changes !== 1) return false;
      queries.createFleetEvent(runtime.db).run(
        row.fleet_run_id,
        "cleanup_action_failed",
        "fleet-lifecycle",
        JSON.stringify({
          actionId: row.id,
          actionType: row.action_type,
          error: "cleanup retry limit exhausted",
        }),
        { controlPlane: true }
      );
      return true;
    });
    if (applied) failed += 1;
  }
  return failed;
}

async function executeWorktreeCleanup(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow
): Promise<"completed" | "skipped"> {
  if (!row.target_path || !row.project_path) {
    throw new Error("cleanup action has incomplete recorded ownership");
  }
  const run = runtime.db
    .prepare(`SELECT status, archived_at FROM fleet_runs WHERE id = ?`)
    .get(row.fleet_run_id) as
    { status: FleetRunStatus; archived_at: string | null } | undefined;
  if (
    !run?.archived_at ||
    !TERMINAL_RUN_STATUSES.has(run.status as FleetRunStatus)
  ) {
    throw new Error("cleanup run ownership is no longer terminal and archived");
  }
  let primaryOwner: { ownerType: CleanupOwnerType; ownerId: string } | null =
    row.worker_id ? { ownerType: "worker", ownerId: row.worker_id } : null;
  try {
    const metadata = payload(JSON.parse(row.metadata_json || "{}"));
    const primary = payload(metadata.primaryOwner);
    if (
      ["worker", "plan_review", "task_review", "fixer"].includes(
        String(primary.ownerType)
      ) &&
      typeof primary.ownerId === "string" &&
      primary.ownerId
    ) {
      primaryOwner = {
        ownerType: primary.ownerType as CleanupOwnerType,
        ownerId: primary.ownerId,
      };
    }
  } catch {
    // Legacy worker actions remain bound by their worker_id foreign key.
  }
  if (!primaryOwner) {
    throw new Error("cleanup action has incomplete recorded owner identity");
  }
  const normalizedTarget = normalizeWorktreePath(row.target_path);
  const candidates = discoverCleanupCandidates(runtime.db, row.fleet_run_id);
  const ownershipCache = new Map<string, Promise<boolean>>();
  const verified: Array<{
    candidate: CleanupCandidate;
    item: Omit<FleetCleanupPreviewItem, "ownerCount">;
  }> = [];
  for (const candidate of candidates) {
    if (normalizeWorktreePath(candidate.worktree_path) !== normalizedTarget) {
      continue;
    }
    const evaluated = await evaluateCleanupCandidate(
      row.fleet_run_id,
      candidate,
      runtime,
      ownershipCache
    );
    if (evaluated.ok) verified.push({ candidate, item: evaluated.item });
  }
  const primary = verified.find(
    ({ candidate, item }) =>
      candidate.owner_type === primaryOwner.ownerType &&
      candidate.owner_id === primaryOwner.ownerId &&
      normalizeWorktreePath(item.projectPath) ===
        normalizeWorktreePath(row.project_path!)
  );
  if (!primary) {
    throw new Error("cleanup ownership records changed");
  }
  if (primary.item.exists) {
    await runtime.deleteWorktree(
      primary.item.worktreePath,
      primary.item.projectPath,
      false
    );
    if (runtime.pathExists(primary.item.worktreePath)) {
      throw new Error("worktree still exists after cleanup");
    }
  }
  const nowIso = runtime.now().toISOString();
  transaction(runtime.db, () => {
    const releaseWorkerLeases = runtime.db.prepare(
      `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
       WHERE fleet_run_id = ? AND worker_id = ? AND status = 'reserved'`
    );
    const releaseRuntimeLeases = runtime.db.prepare(
      `UPDATE fleet_runtime_leases SET status = 'released', released_at = ?
       WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?
         AND status = 'reserved'`
    );
    const releasedOwners = new Set<string>();
    for (const { candidate } of verified) {
      const owner = candidateOwner(candidate);
      const ownerKey = `${owner.ownerType}\0${owner.ownerId}`;
      if (releasedOwners.has(ownerKey)) continue;
      releasedOwners.add(ownerKey);
      if (
        owner.workerId &&
        (owner.ownerType === "worker" || owner.ownerType === "fixer")
      ) {
        releaseWorkerLeases.run(nowIso, row.fleet_run_id, owner.workerId);
      }
      releaseRuntimeLeases.run(
        nowIso,
        row.fleet_run_id,
        owner.ownerType,
        owner.ownerId
      );
    }
  });
  return primary.item.exists ? "completed" : "skipped";
}

function storedDestructiveConfirmation(
  run: FleetRunRow
): Omit<FleetDestructiveConfirmation, "preview"> | null {
  let stored: Record<string, unknown>;
  try {
    stored = payload(
      payload(JSON.parse(run.settings_json)).destructiveCancellation
    );
  } catch {
    return null;
  }
  if (
    stored.schemaVersion !== 1 ||
    typeof stored.targetSetDigest !== "string" ||
    !FLEET_DESTRUCTIVE_DIGEST.test(stored.targetSetDigest) ||
    !Array.isArray(stored.sessionIds) ||
    !Array.isArray(stored.cleanupTargets) ||
    stored.cleanupTargets.length > FLEET_DESTRUCTIVE_PREVIEW_OBJECT_LIMIT
  ) {
    return null;
  }
  const sessionIds = stored.sessionIds.filter(
    (value): value is string =>
      typeof value === "string" && value.length > 0 && value.length <= 160
  );
  if (sessionIds.length !== stored.sessionIds.length) return null;
  const cleanupTargets: FleetConfirmedCleanupTarget[] = [];
  for (const value of stored.cleanupTargets) {
    const row = payload(value);
    const primary = payload(row.primaryOwner);
    if (
      typeof row.worktreePath !== "string" ||
      row.worktreePath.length === 0 ||
      row.worktreePath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
      typeof row.projectPath !== "string" ||
      row.projectPath.length === 0 ||
      row.projectPath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
      !["worker", "plan_review", "task_review", "fixer"].includes(
        String(primary.ownerType)
      ) ||
      typeof primary.ownerId !== "string" ||
      !primary.ownerId
    ) {
      return null;
    }
    cleanupTargets.push({
      worktreePath: row.worktreePath,
      projectPath: row.projectPath,
      workerId: typeof row.workerId === "string" ? row.workerId : null,
      primaryOwner: {
        ownerType: primary.ownerType as CleanupOwnerType,
        ownerId: primary.ownerId,
        workerId:
          typeof primary.workerId === "string" ? primary.workerId : null,
        sessionId:
          typeof primary.sessionId === "string" ? primary.sessionId : null,
      },
    });
  }
  const rawIntegration = stored.integrationTarget;
  let integrationTarget: FleetConfirmedIntegrationTarget | null = null;
  if (rawIntegration != null) {
    const row = payload(rawIntegration);
    if (
      typeof row.worktreePath !== "string" ||
      row.worktreePath.length === 0 ||
      row.worktreePath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
      typeof row.projectPath !== "string" ||
      row.projectPath.length === 0 ||
      row.projectPath.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
      typeof row.branchName !== "string" ||
      row.branchName.length === 0 ||
      row.branchName.length > FLEET_DESTRUCTIVE_TARGET_TEXT_MAX ||
      (row.expectedHeadSha !== null && typeof row.expectedHeadSha !== "string")
    ) {
      return null;
    }
    integrationTarget = {
      worktreePath: row.worktreePath,
      projectPath: row.projectPath,
      branchName: row.branchName,
      expectedHeadSha: row.expectedHeadSha as string | null,
    };
  }
  const targetSet = {
    action: "cancel" as const,
    runId: run.id,
    sessionIds,
    cleanupTargets,
    integrationTarget,
  };
  if (confirmedTargetSetDigest(targetSet) !== stored.targetSetDigest)
    return null;
  return {
    targetSetDigest: stored.targetSetDigest,
    sessionIds,
    cleanupTargets,
    integrationTarget,
  };
}

function queueConfirmedCleanupTargets(
  runtime: FleetLifecycleDeps,
  runId: string,
  confirmation: Omit<FleetDestructiveConfirmation, "preview">,
  requestedBy: string,
  nowIso: string
): number {
  const insert = runtime.db.prepare(
    `INSERT OR IGNORE INTO fleet_cleanup_actions
     (id, action_key, fleet_run_id, worker_id, action_type, state,
      target_path, project_path, requested_by, metadata_json,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, 'delete_worktree', 'pending', ?, ?, ?, ?, ?, ?)`
  );
  let created = 0;
  for (const item of confirmation.cleanupTargets) {
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
      JSON.stringify({
        schemaVersion: 1,
        targetSetDigest: confirmation.targetSetDigest,
        primaryOwner: item.primaryOwner,
      }),
      nowIso,
      nowIso
    ).changes;
  }
  return created;
}

/**
 * Destructive cancellation authorization is persisted before sessions stop.
 * Once every owned paid session is terminal, recovery may safely archive and
 * enqueue the same ownership-verified cleanup that the explicit HTTP flow uses.
 * Re-running this is harmless: both archive and cleanup action keys are
 * idempotent, which closes the crash window between those two operations.
 */
async function reconcileDestructiveCancelCleanup(
  runtime: FleetLifecycleDeps
): Promise<void> {
  const runs = runtime.db
    .prepare(
      `SELECT r.* FROM fleet_runs r
       WHERE r.status = 'canceled'
         AND r.cancel_mode = 'cancel-and-clean-owned-worktrees'
         AND NOT EXISTS (
           SELECT 1 FROM fleet_workers w
           WHERE w.fleet_run_id = r.id
             AND w.status IN ('leasing', 'spawning', 'running',
                              'waiting_for_operator', 'cleanup_pending')
         )
         AND NOT EXISTS (
           SELECT 1 FROM fleet_cost_accounts c
           WHERE c.fleet_run_id = r.id AND c.terminal_at IS NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM fleet_events e
           WHERE e.fleet_run_id = r.id
             AND e.event_type = 'destructive_cancel_cleanup_reconciled'
         )
       ORDER BY COALESCE(r.ended_at, r.updated_at), r.id
       LIMIT ?`
    )
    .all(FLEET_DESTRUCTIVE_CANCEL_MAX_PER_TICK) as FleetRunRow[];
  for (const run of runs) {
    const authorization = storedDestructiveConfirmation(run);
    if (!authorization) {
      throw new Error(
        "destructive cancel has no valid exact target authorization"
      );
    }
    const confirmation = {
      confirm: true,
      confirmation: run.id,
      actor: "cancel-recovery",
    };
    const archived = archiveFleetRun(
      run.id,
      {
        ...confirmation,
        retentionDays: cancellationRetentionDays(run),
      },
      runtime
    );
    if ("error" in archived) {
      throw new Error(`destructive cancel archive failed: ${archived.error}`);
    }
    const queued = transaction(runtime.db, () =>
      queueConfirmedCleanupTargets(
        runtime,
        run.id,
        authorization,
        "cancel-recovery",
        runtime.now().toISOString()
      )
    );
    transaction(runtime.db, () => {
      const alreadyRecorded = runtime.db
        .prepare(
          `SELECT 1 FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'destructive_cancel_cleanup_reconciled'
           LIMIT 1`
        )
        .get(run.id);
      if (alreadyRecorded) return;
      queries.createFleetEvent(runtime.db).run(
        run.id,
        "destructive_cancel_cleanup_reconciled",
        "cancel-recovery",
        JSON.stringify({
          queued,
          targetSetDigest: authorization.targetSetDigest,
        })
      );
    });
  }
}

interface ReportCleanupCandidate {
  worker_id: string;
  task_id: string;
  attempt: number;
  report_path: string;
}

function reportCleanupActionKey(workerId: string, attempt: number): string {
  return `delete-report:${workerId}:${attempt}`;
}

/**
 * Once the report has been copied into durable evidence (accepted/invalid), or
 * its exact attempt is terminal, enqueue deletion of the raw nonce-bearing
 * report. The unique action key makes this restart-safe and lets later pages
 * advance while earlier actions are still pending or retrying.
 */
export function enqueueFleetReportCleanupActions(
  overrides: Partial<FleetLifecycleDeps> = {}
): number {
  const runtime = lifecycleDeps(overrides);
  const candidates = runtime.db
    .prepare(
      `SELECT w.id AS worker_id, w.task_id, w.attempt, w.report_path
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       LEFT JOIN fleet_cleanup_actions a
         ON a.action_key = 'delete-report:' || w.id || ':' || w.attempt
       WHERE w.report_path IS NOT NULL AND w.report_path <> ''
         AND w.task_id IS NOT NULL AND w.report_state <> 'legacy'
         AND a.id IS NULL
         AND (
           w.report_state IN ('accepted', 'invalid') OR
           w.status IN ('completed', 'failed', 'canceled', 'dead',
                        'cleanup_complete') OR
           r.status IN ('completed', 'failed', 'canceled')
         )
       ORDER BY COALESCE(w.report_collected_at, w.ended_at, w.created_at), w.id
       LIMIT ?`
    )
    .all(FLEET_REPORT_CLEANUP_ENQUEUE_MAX_PER_TICK) as ReportCleanupCandidate[];
  if (candidates.length === 0) return 0;
  const nowIso = runtime.now().toISOString();
  return transaction(runtime.db, () => {
    let queued = 0;
    const insert = runtime.db.prepare(
      `INSERT OR IGNORE INTO fleet_cleanup_actions
       (id, action_key, fleet_run_id, worker_id, action_type, state,
        target_path, requested_by, metadata_json, created_at, updated_at)
       SELECT ?, ?, fleet_run_id, id, 'delete_report_file', 'pending',
              report_path, 'report-retention', ?, ?, ?
       FROM fleet_workers
       WHERE id = ? AND task_id = ? AND attempt = ? AND report_path = ?`
    );
    for (const candidate of candidates) {
      queued += insert.run(
        randomUUID(),
        reportCleanupActionKey(candidate.worker_id, candidate.attempt),
        JSON.stringify({
          schemaVersion: 1,
          taskId: candidate.task_id,
          attempt: candidate.attempt,
        }),
        nowIso,
        nowIso,
        candidate.worker_id,
        candidate.task_id,
        candidate.attempt,
        candidate.report_path
      ).changes;
    }
    return queued;
  });
}

function reportIdentityFromAction(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow
): FleetWorkerReportFileIdentity {
  if (!row.worker_id || !row.target_path) {
    throw new Error("report cleanup action has incomplete attempt identity");
  }
  const worker = runtime.db
    .prepare(
      `SELECT w.task_id, w.attempt, w.report_path, w.report_state, w.status,
              r.status AS run_status
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE w.id = ? AND w.fleet_run_id = ?`
    )
    .get(row.worker_id, row.fleet_run_id) as
    | {
        task_id: string | null;
        attempt: number;
        report_path: string | null;
        report_state: string;
        status: string;
        run_status: string;
      }
    | undefined;
  if (
    !worker?.task_id ||
    (worker.report_path !== row.target_path && worker.report_path !== null) ||
    !(
      ["accepted", "invalid"].includes(worker.report_state) ||
      ["completed", "failed", "canceled", "dead", "cleanup_complete"].includes(
        worker.status
      ) ||
      ["completed", "failed", "canceled"].includes(worker.run_status)
    )
  ) {
    throw new Error("report cleanup attempt ownership changed");
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = payload(JSON.parse(row.metadata_json || "{}"));
  } catch {
    throw new Error("report cleanup metadata is invalid");
  }
  if (
    metadata.taskId !== worker.task_id ||
    metadata.attempt !== worker.attempt
  ) {
    throw new Error("report cleanup durable identity changed");
  }
  const identity = {
    runId: row.fleet_run_id,
    taskId: worker.task_id,
    attempt: worker.attempt,
    reportPath: row.target_path,
  };
  if (!isFleetOwnedWorkerReportPath(identity)) {
    throw new Error("report path is outside its exact Fleet attempt directory");
  }
  return identity;
}

async function executeReportFileCleanup(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow
): Promise<"completed" | "skipped"> {
  const identity = reportIdentityFromAction(runtime, row);
  const result = await runtime.deleteReportFile(identity);
  const changed = runtime.db
    .prepare(
      `UPDATE fleet_workers SET report_path = NULL
       WHERE id = ? AND fleet_run_id = ? AND task_id = ? AND attempt = ?
         AND (report_path = ? OR report_path IS NULL)`
    )
    .run(
      row.worker_id,
      row.fleet_run_id,
      identity.taskId,
      identity.attempt,
      identity.reportPath
    );
  if (changed.changes !== 1) {
    throw new Error("report cleanup acknowledgement lost its exact attempt");
  }
  return result === "deleted" ? "completed" : "skipped";
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
         AND body_pruned_at IS NULL
         AND artifact_type IN (${FLEET_RETENTION_ARTIFACT_TYPE_PARAMS})`
    )
    .run(
      marker,
      runtime.now().toISOString(),
      row.artifact_id,
      row.fleet_run_id,
      row.expected_content_hash,
      ...FLEET_RETENTION_PRUNABLE_ARTIFACT_TYPES
    );
  return changed.changes === 1 ? "completed" : "skipped";
}

async function executeCleanupAction(
  runtime: FleetLifecycleDeps,
  row: FleetCleanupActionRow,
  owner: string
): Promise<void> {
  try {
    let state: "completed" | "skipped";
    if (row.action_type === "delete_worktree") {
      state = await executeWorktreeCleanup(runtime, row);
    } else if (row.action_type === "delete_report_file") {
      state = await executeReportFileCleanup(runtime, row);
    } else if (row.action_type === "prune_artifact_body") {
      state = executeArtifactPrune(runtime, row);
    } else {
      throw new Error("unsupported cleanup action type");
    }
    finishCleanupAction(runtime, row, owner, state, null);
  } catch (error) {
    finishCleanupAction(
      runtime,
      row,
      owner,
      "failed",
      error instanceof Error ? error.message : "cleanup failed"
    );
  }
}

export function deriveFleetRunStatus(
  run: Pick<
    FleetRunRow,
    | "status"
    | "integration_state"
    | "merge_requested_at"
    | "merge_request_kind"
    | "merge_target"
  >,
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
  if (
    run.merge_request_kind === "manual" &&
    (run.merge_target === "local" || run.merge_target === "github_pr")
  ) {
    return run.status === "paused" ? "paused" : "merging";
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
    const applied = transaction(runtime.db, () => {
      const update = runtime.db
        .prepare(
          `UPDATE fleet_runs SET status = ?,
           ended_at = CASE WHEN ? = 'completed' THEN COALESCE(ended_at, ?) ELSE ended_at END,
           updated_at = ? WHERE id = ? AND status = ?`
        )
        .run(status, status, nowIso, nowIso, run.id, run.status);
      if (update.changes !== 1) return false;
      queries
        .createFleetEvent(runtime.db)
        .run(
          run.id,
          status === "completed" ? "run_completed" : "run_phase_derived",
          "fleet-lifecycle",
          JSON.stringify({ from: run.status, to: status })
        );
      return true;
    });
    if (!applied) continue;
    changed += 1;
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
         AND a.artifact_type IN (${FLEET_RETENTION_ARTIFACT_TYPE_PARAMS})
         AND a.body_pruned_at IS NULL AND a.content_hash IS NOT NULL
         AND a.byte_count >= ? AND a.byte_count <= ?
       ORDER BY r.archived_at, a.created_at, a.id
       LIMIT ?`
    )
    .all(
      nowIso,
      ...FLEET_RETENTION_PRUNABLE_ARTIFACT_TYPES,
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
  await reconcileFleetCancellationCleanup({
    db: runtime.db,
    stopSession: runtime.stopSession,
  });
  reconcileFleetRunStatuses(runtime);
  await reconcileDestructiveCancelCleanup(runtime);
  failExhaustedCleanupClaims(runtime);
  enqueueFleetReportCleanupActions(runtime);
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
         (state = 'failed' AND attempt_count < ?) OR
         (state = 'running' AND attempt_count < ? AND
          (lease_expires_at IS NULL OR lease_expires_at <= ?))
       ORDER BY created_at, id LIMIT ?`
    )
    .all(
      FLEET_CLEANUP_MAX_ATTEMPTS,
      FLEET_CLEANUP_MAX_ATTEMPTS,
      runtime.now().toISOString(),
      maxActions * 2
    ) as { id: string }[];
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
