import { createHash, randomUUID } from "crypto";
import { mkdir, stat } from "fs/promises";
import { dirname, resolve } from "path";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { mergePR } from "@/lib/dispatch/merge";
import { runGit } from "@/lib/git";
import { expandHome, isWindows, resolveBinary } from "@/lib/platform";
import { runVerify, type VerifyResult } from "@/lib/verification/runner";
import { execFile } from "child_process";
import { promisify } from "util";
import { deleteWorktree } from "@/lib/worktrees";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "./hash";
import { parseFleetAutomationPolicy } from "./automation-policy";
import {
  insertFleetArtifact as writeFleetArtifact,
  prepareFleetArtifactBody,
} from "./durable-write";
import { redactAndCapFleetText } from "./redaction";
import {
  acquireFleetRuntimeResources,
  fleetResourceLimitsForRun,
  releaseFleetRuntimeResources,
} from "./resource-runtime";
import type {
  FleetMergeOperationRow,
  FleetMergeOperationType,
  FleetMergeTarget,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetRunRow,
} from "./types";
import {
  buildFleetPrCreateArgs,
  buildFleetPrViewArgs,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
  type FleetPrStatus,
} from "./merge-contract";
import {
  approvedExecutionHash,
  getFleetMergeStatus as readFleetMergeStatus,
  inspectFleetMergeReadiness,
  resolveFleetMergeTarget,
  type FleetMergeReadiness,
  type FleetMergeRunRow,
  type FleetMergeStatus as FleetMergeStatusBase,
  type FleetMergeTargetInfo,
} from "./merge-readiness";
import {
  fleetLaunchBlockedResult,
  fleetRecoveryUnavailable,
} from "./recovery-gate";

export {
  buildFleetPrCreateArgs,
  buildFleetPrViewArgs,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
  summarizeGitHubChecks,
} from "./merge-contract";
export {
  FLEET_MERGE_REVIEW_LENSES,
  inspectFleetMergeReadiness,
} from "./merge-readiness";
export type { FleetMergeReadiness } from "./merge-readiness";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const FLEET_MERGE_LEASE_MS = 15 * 60 * 1000;
const FLEET_MERGE_LIMIT = 20;
const FLEET_MERGE_ARTIFACT_MAX = 16_000;
const FLEET_INTEGRATION_DISK_ESTIMATE_BYTES = 512 * 1024 ** 2;
const FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS = 3;

export interface FleetFinalVerificationRetryStatus {
  action: "retry_final_verification" | null;
  state: "not_applicable" | "available" | "blocked" | "exhausted";
  available: boolean;
  reason: string | null;
  operationId: string | null;
  attemptCount: number;
  maxAttempts: number;
  preconditions: {
    planHash: string;
    executionHash: string;
    baseSha: string;
    integrationHeadSha: string;
  } | null;
}

export interface FleetMergeStatus extends FleetMergeStatusBase {
  retry: FleetFinalVerificationRetryStatus;
}

class FleetMergeCapacityUnavailable extends Error {}

interface GitResult {
  stdout: string;
  stderr: string;
}

interface FleetMergeRuntimeDeps {
  db: Database.Database;
  now: () => Date;
  id: () => string;
  leaseOwner: string;
  git: (
    cwd: string,
    args: string[],
    timeout?: number,
    maxBuffer?: number
  ) => Promise<GitResult>;
  verify: (cwd: string, command: string) => Promise<VerifyResult>;
  gh: (cwd: string, args: string[]) => Promise<GitResult>;
  mergePullRequest: typeof mergePR;
  removeWorktree: typeof deleteWorktree;
  ensureDirectory: (path: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return redactAndCapFleetText(value, 1000).text;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validSha(value: string | null | undefined): value is string {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
}

/**
 * Prefer Stoa's stable repository/project identity so workers, fixers, and the
 * integration workspace contend for the same capacity across runs. Unregistered
 * checkouts fall back to one normalized main-checkout path.
 */
function repositoryResourceKey(
  run: Pick<FleetRunRow, "repo_id" | "project_id">,
  repoPath: string
): string {
  if (run.repo_id) return run.repo_id;
  if (run.project_id) return run.project_id;
  const normalized = resolve(expandHome(repoPath)).replace(/\\/g, "/");
  return `path:${isWindows ? normalized.toLowerCase() : normalized}`;
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runtimeDeps(
  overrides: Partial<FleetMergeRuntimeDeps> = {}
): FleetMergeRuntimeDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    id: overrides.id ?? randomUUID,
    leaseOwner:
      overrides.leaseOwner ?? `fleet-merge-${process.pid}-${randomUUID()}`,
    git:
      overrides.git ??
      ((cwd, args, timeout = 60_000, maxBuffer = 8 * 1024 * 1024) =>
        runGit(cwd, args, timeout, maxBuffer)),
    verify: overrides.verify ?? runVerify,
    gh:
      overrides.gh ??
      (async (cwd, args) => {
        const ghBinary = resolveBinary("gh");
        if (!ghBinary) {
          throw new Error("GitHub CLI (gh) is not installed or not on PATH");
        }
        const result = await execFileAsync(ghBinary, args, {
          cwd,
          encoding: "utf-8",
          timeout: 60_000,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      }),
    mergePullRequest: overrides.mergePullRequest ?? mergePR,
    removeWorktree: overrides.removeWorktree ?? deleteWorktree,
    ensureDirectory:
      overrides.ensureDirectory ??
      (async (path) => {
        await mkdir(path, { recursive: true });
      }),
    pathExists:
      overrides.pathExists ??
      (async (path) => {
        try {
          await stat(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      }),
  };
}

async function gitSha(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  ref = "HEAD"
): Promise<string> {
  const { stdout } = await deps.git(
    cwd,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    15_000,
    4096
  );
  const sha = stdout.trim().toLowerCase();
  if (!validSha(sha)) throw new Error(`Git ref ${ref} is not a full commit ID`);
  return sha;
}

async function gitBranch(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<string> {
  const { stdout } = await deps.git(
    cwd,
    ["branch", "--show-current"],
    15_000,
    4096
  );
  return stdout.trim();
}

async function gitClean(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<boolean> {
  const { stdout } = await deps.git(
    cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    15_000,
    1024 * 1024
  );
  return stdout.length === 0;
}

async function assertExactCleanHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string,
  context: string
): Promise<void> {
  const actualHead = await gitSha(deps, cwd);
  if (actualHead !== expectedHead) {
    throw new Error(
      `${context}: HEAD changed from the committed verification target`
    );
  }
  if (!(await gitClean(deps, cwd))) {
    throw new Error(
      `${context}: index, tracked files, or untracked files changed`
    );
  }
}

async function restoreExactCleanHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string
): Promise<void> {
  await deps.git(cwd, ["reset", "--hard", expectedHead], 30_000);
  // The integration workspace starts clean and is Fleet-owned. Any untracked
  // path here was created after the exact-head boundary (for example by a
  // verifier), so remove it without relying on a platform shell.
  await deps.git(cwd, ["clean", "-fd"], 30_000);
  await assertExactCleanHead(
    deps,
    cwd,
    expectedHead,
    "exact-head restoration failed"
  );
}

async function isAncestor(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  ancestor: string,
  descendant: string
): Promise<boolean> {
  try {
    await deps.git(
      cwd,
      ["merge-base", "--is-ancestor", ancestor, descendant],
      15_000,
      4096
    );
    return true;
  } catch {
    return false;
  }
}

function setRunError(
  db: Database.Database,
  runId: string,
  state: "failed" | "awaiting_operator",
  error: unknown,
  now: string
): void {
  db.prepare(
    `UPDATE fleet_runs SET integration_state = ?, integration_error = ?,
       integration_updated_at = ?, updated_at = ? WHERE id = ?`
  ).run(state, boundedError(error), now, now, runId);
}

function createEvent(
  db: Database.Database,
  runId: string,
  type: string,
  payload: unknown,
  options: { controlPlane?: boolean } = {}
): void {
  queries
    .createFleetEvent(db)
    .run(runId, type, "fleet-merge", JSON.stringify(payload), options);
}

function insertArtifact(
  deps: FleetMergeRuntimeDeps,
  input: {
    run: FleetMergeRunRow;
    taskId?: string | null;
    baseSha: string;
    headSha: string | null;
    type: string;
    title: string;
    body: string;
    severity: "info" | "warning" | "blocker";
    metadata?: unknown;
  }
): { id: string; contentHash: string } {
  const id = deps.id();
  const marker = "\n…(truncated)…";
  const capped = redactAndCapFleetText(
    input.body,
    FLEET_MERGE_ARTIFACT_MAX - Buffer.byteLength(marker, "utf8")
  );
  const prepared = prepareFleetArtifactBody(
    capped.truncated ? `${capped.text}${marker}` : capped.text
  );
  const metadata = JSON.stringify(input.metadata ?? {});
  writeFleetArtifact(deps.db, {
    id,
    runId: input.run.id,
    taskId: input.taskId ?? null,
    planHash: input.run.approved_plan_hash,
    baseSha: input.baseSha,
    headSha: input.headSha,
    contentHash: prepared.contentHash,
    metadataJson: metadata,
    artifactType: input.type,
    title: input.title,
    body: prepared.body,
    severity: input.severity,
    actor: "fleet-merge",
    createdAt: deps.now().toISOString(),
  });
  return { id, contentHash: prepared.contentHash };
}

function operationKey(input: {
  runId: string;
  taskId: string | null;
  type: FleetMergeOperationType;
  baseSha: string;
  taskHeadSha: string | null;
}): string {
  return hash(
    JSON.stringify([
      input.runId,
      input.taskId,
      input.type,
      input.baseSha,
      input.taskHeadSha,
    ])
  );
}

function ensureOperation(
  deps: FleetMergeRuntimeDeps,
  input: {
    runId: string;
    taskId: string | null;
    type: FleetMergeOperationType;
    target?: FleetMergeTarget | null;
    baseSha: string;
    taskHeadSha?: string | null;
    commands?: string[];
  }
): FleetMergeOperationRow {
  const key = operationKey({
    runId: input.runId,
    taskId: input.taskId,
    type: input.type,
    baseSha: input.baseSha,
    taskHeadSha: input.taskHeadSha ?? null,
  });
  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `INSERT OR IGNORE INTO fleet_merge_operations
       (id, operation_key, fleet_run_id, task_id, operation_type, state, target,
        expected_base_sha, expected_task_head_sha, verification_commands_json,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      deps.id(),
      key,
      input.runId,
      input.taskId,
      input.type,
      input.target ?? null,
      input.baseSha,
      input.taskHeadSha ?? null,
      JSON.stringify(input.commands ?? []),
      now,
      now
    );
  const row = deps.db
    .prepare(`SELECT * FROM fleet_merge_operations WHERE operation_key = ?`)
    .get(key) as FleetMergeOperationRow | undefined;
  if (!row) throw new Error("failed to create Fleet merge operation");
  return row;
}

function claimOperation(
  deps: FleetMergeRuntimeDeps,
  id: string
): FleetMergeOperationRow | null {
  const now = deps.now();
  const nowIso = now.toISOString();
  const expiry = new Date(now.getTime() + FLEET_MERGE_LEASE_MS).toISOString();
  try {
    return transaction(deps.db, () => {
      const changed = deps.db
        .prepare(
          `UPDATE fleet_merge_operations
         SET state = 'running', lease_owner = ?, lease_expires_at = ?,
             attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
         WHERE id = ? AND (
           state IN ('pending', 'waiting') OR
           (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
         )`
        )
        .run(deps.leaseOwner, expiry, nowIso, nowIso, id, nowIso);
      if (changed.changes !== 1) return null;
      releaseOperationResources(deps, id, now);
      const operation = deps.db
        .prepare(`SELECT * FROM fleet_merge_operations WHERE id = ?`)
        .get(id) as FleetMergeOperationRow;
      const run = queries.getFleetRun(deps.db).get(operation.fleet_run_id) as
        FleetRunRow | undefined;
      if (!run) throw new Error("Fleet merge run changed while claiming");
      const tasks = queries
        .listFleetTasksForRun(deps.db)
        .all(operation.fleet_run_id) as FleetTaskRow[];
      const target = resolveFleetMergeTarget(deps.db, run, tasks);
      if (!target)
        throw new Error("Fleet merge repository changed while claiming");
      const repositoryKey = repositoryResourceKey(run, target.repoPath);
      const resources = [
        { kind: "merge_operation" as const, key: "host", units: 1 },
        { kind: "git_operation" as const, key: repositoryKey, units: 1 },
        ...(operation.operation_type === "final_verify"
          ? [{ kind: "verifier" as const, key: "host", units: 1 }]
          : []),
      ];
      const admitted = acquireFleetRuntimeResources(deps.db, {
        runId: operation.fleet_run_id,
        ownerType: "merge_operation",
        ownerId: operation.id,
        resources,
        limits: fleetResourceLimitsForRun(run),
        now,
        leaseExpiresAt: expiry,
      });
      if (!admitted.admitted) throw new FleetMergeCapacityUnavailable();
      return operation;
    });
  } catch (error) {
    if (error instanceof FleetMergeCapacityUnavailable) return null;
    throw error;
  }
}

function releaseOperationResources(
  deps: FleetMergeRuntimeDeps,
  operationId: string,
  now: Date
): void {
  releaseFleetRuntimeResources(deps.db, {
    ownerType: "merge_operation",
    ownerId: operationId,
    now,
  });
}

function ensureIntegrationWorkspaceResources(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): void {
  const repositoryKey = repositoryResourceKey(run, target.repoPath);
  const existing = deps.db
    .prepare(
      `SELECT resource_type, resource_key, units
       FROM fleet_runtime_leases
       WHERE owner_type = 'integration_workspace' AND owner_id = ?
         AND status = 'reserved'
       ORDER BY resource_type, resource_key`
    )
    .all(run.id) as Array<{
    resource_type: string;
    resource_key: string;
    units: number;
  }>;
  const exact =
    existing.length === 2 &&
    existing.some(
      (row) =>
        row.resource_type === "repo_worktree" &&
        row.resource_key === repositoryKey &&
        row.units === 1
    ) &&
    existing.some(
      (row) =>
        row.resource_type === "disk_bytes" &&
        row.resource_key === "fleet" &&
        row.units === FLEET_INTEGRATION_DISK_ESTIMATE_BYTES
    );
  if (exact) return;

  const admitted = transaction(deps.db, () => {
    releaseFleetRuntimeResources(deps.db, {
      ownerType: "integration_workspace",
      ownerId: run.id,
      now: deps.now(),
    });
    return acquireFleetRuntimeResources(deps.db, {
      runId: run.id,
      ownerType: "integration_workspace",
      ownerId: run.id,
      resources: [
        { kind: "repo_worktree", key: repositoryKey, units: 1 },
        {
          kind: "disk_bytes",
          key: "fleet",
          units: FLEET_INTEGRATION_DISK_ESTIMATE_BYTES,
        },
      ],
      limits: fleetResourceLimitsForRun(run),
      now: deps.now(),
    });
  });
  if (!admitted.admitted) {
    throw new FleetMergeCapacityUnavailable(
      "Fleet integration workspace resource capacity is full"
    );
  }
}

function releaseIntegrationWorkspaceResources(
  deps: FleetMergeRuntimeDeps,
  runId: string,
  now: Date
): number {
  return releaseFleetRuntimeResources(deps.db, {
    ownerType: "integration_workspace",
    ownerId: runId,
    now,
  });
}

function renewOperationLease(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow
): void {
  const now = deps.now();
  const changed = deps.db
    .prepare(
      `UPDATE fleet_merge_operations SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND lease_owner = ?`
    )
    .run(
      new Date(now.getTime() + FLEET_MERGE_LEASE_MS).toISOString(),
      now.toISOString(),
      operation.id,
      deps.leaseOwner
    );
  if (changed.changes !== 1)
    throw new Error("Fleet merge operation lease changed");
  deps.db
    .prepare(
      `UPDATE fleet_runtime_leases SET lease_expires_at = ?
       WHERE owner_type = 'merge_operation' AND owner_id = ?
         AND status = 'reserved'`
    )
    .run(
      new Date(now.getTime() + FLEET_MERGE_LEASE_MS).toISOString(),
      operation.id
    );
}

function finishOperation(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  input: {
    state: "completed" | "failed" | "waiting";
    resultHeadSha?: string | null;
    outputHash?: string | null;
    artifactId?: string | null;
    error?: string | null;
  }
): boolean {
  const finish = () => {
    const finishedAt = deps.now();
    const now = finishedAt.toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_merge_operations
         SET state = ?, result_head_sha = ?, verification_output_hash = ?,
             output_artifact_id = ?, error = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?,
             completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(
        input.state,
        input.resultHeadSha ?? null,
        input.outputHash ?? null,
        input.artifactId ?? null,
        input.error ? redactAndCapFleetText(input.error, 1000).text : null,
        now,
        input.state,
        now,
        operation.id,
        deps.leaseOwner
      );
    if (changed.changes === 1) {
      releaseOperationResources(deps, operation.id, finishedAt);
    }
    return changed.changes === 1;
  };
  return deps.db.inTransaction ? finish() : transaction(deps.db, finish);
}

function reopenFailedOperationForExactRecovery(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow
): FleetMergeOperationRow | null {
  const now = deps.now().toISOString();
  const changed = deps.db
    .prepare(
      `UPDATE fleet_merge_operations SET state = 'waiting',
       error = 'authoritative external completion recovered',
       completed_at = NULL, updated_at = ?
       WHERE id = ? AND state = 'failed'`
    )
    .run(now, operation.id);
  if (changed.changes !== 1) return null;
  return deps.db
    .prepare(`SELECT * FROM fleet_merge_operations WHERE id = ?`)
    .get(operation.id) as FleetMergeOperationRow;
}

async function ensureIntegrationWorkspace(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<FleetMergeRunRow> {
  const baseSha = run.integration_base_sha ?? run.automation_base_sha;
  if (!validSha(baseSha))
    throw new Error("Fleet integration base SHA is invalid");
  const identity = fleetIntegrationIdentity(run.id);
  const branch = run.integration_branch ?? identity.branch;
  const worktree = run.integration_worktree ?? identity.worktree;
  if (branch !== identity.branch || worktree !== identity.worktree) {
    throw new Error("Fleet integration workspace identity changed");
  }

  const worktreeExists = await deps.pathExists(worktree);
  ensureIntegrationWorkspaceResources(deps, run, target);

  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN 'initializing' ELSE integration_state END,
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = COALESCE(integration_head_sha, ?),
       integration_error = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN NULL ELSE integration_error END,
       integration_updated_at = ?, updated_at = ?
       WHERE id = ?
         AND (integration_base_sha IS NULL OR integration_base_sha = ?)`
    )
    .run(branch, worktree, baseSha, baseSha, now, now, run.id, baseSha);

  if (!worktreeExists) {
    try {
      await deps.ensureDirectory(dirname(worktree));
      let existingBranchSha: string | null = null;
      try {
        existingBranchSha = await gitSha(deps, target.repoPath, branch);
      } catch {
        existingBranchSha = null;
      }
      if (existingBranchSha && existingBranchSha !== baseSha) {
        throw new Error(
          "Fleet integration branch already exists at a different SHA"
        );
      }
      if (existingBranchSha) {
        await deps.git(
          target.repoPath,
          ["worktree", "add", worktree, branch],
          60_000
        );
      } else {
        await deps.git(
          target.repoPath,
          ["worktree", "add", "-b", branch, worktree, baseSha],
          60_000
        );
      }
    } catch (error) {
      releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
      throw error;
    }
  }
  const currentBranch = await gitBranch(deps, worktree);
  const head = await gitSha(deps, worktree);
  if (currentBranch !== branch) {
    throw new Error("Fleet integration worktree is on an unexpected branch");
  }
  if (!validSha(run.integration_head_sha) && head !== baseSha) {
    throw new Error(
      "Fleet integration worktree did not start at the bound base"
    );
  }
  let recoveringOperation = false;
  if (validSha(run.integration_head_sha) && head !== run.integration_head_sha) {
    const active = deps.db
      .prepare(
        `SELECT id FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND state = 'running' LIMIT 1`
      )
      .get(run.id);
    if (!active) {
      throw new Error(
        "Fleet integration head changed outside a leased operation"
      );
    }
    recoveringOperation = true;
  }
  if (!(await gitClean(deps, worktree))) {
    const interrupted = deps.db
      .prepare(
        `SELECT * FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND state = 'running'
           AND lease_expires_at <= ?
         ORDER BY started_at ASC, id ASC LIMIT 1`
      )
      .get(run.id, now) as FleetMergeOperationRow | undefined;
    if (
      !interrupted ||
      interrupted.operation_type !== "task_merge" ||
      interrupted.expected_base_sha !== head
    ) {
      throw new Error("Fleet integration worktree is dirty");
    }
    await abortMerge(deps, worktree, interrupted.expected_base_sha);
    const recovered = deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET state = 'pending', lease_owner = NULL,
         lease_expires_at = NULL, error = 'recovered interrupted merge',
         updated_at = ? WHERE id = ? AND state = 'running'`
      )
      .run(now, interrupted.id);
    if (recovered.changes === 1) {
      releaseOperationResources(deps, interrupted.id, deps.now());
    }
  }
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN 'integrating' ELSE integration_state END,
       integration_head_sha = CASE WHEN ? THEN integration_head_sha ELSE ? END,
       integration_error = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN NULL ELSE integration_error END,
       integration_updated_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(recoveringOperation ? 1 : 0, head, now, now, run.id);
  createEvent(
    deps.db,
    run.id,
    "integration_workspace_ready",
    {
      branch,
      worktree,
      baseSha,
      headSha: recoveringOperation ? run.integration_head_sha : head,
      recoveringOperation,
    },
    { controlPlane: true }
  );
  return queries.getFleetRun(deps.db).get(run.id) as FleetMergeRunRow;
}

function exactVerificationCommand(
  db: Database.Database,
  task: FleetTaskRow
): string | null {
  if (!task.verification_id || !task.head_sha) return null;
  const row = db
    .prepare(
      `SELECT command FROM fleet_verifications
       WHERE id = ? AND task_id = ? AND head_sha = ? AND status = 'pass'`
    )
    .get(task.verification_id, task.id, task.head_sha) as
    { command: string } | undefined;
  return row?.command?.trim() || null;
}

async function abortMerge(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string
): Promise<void> {
  let restored = false;
  try {
    await deps.git(cwd, ["merge", "--abort"], 30_000);
    restored =
      (await gitSha(deps, cwd)) === expectedHead && (await gitClean(deps, cwd));
  } catch {
    // Fall through to the exact Fleet-owned reset below.
  }
  if (!restored) {
    // A conflict can fail before MERGE_HEAD exists, and a nominally successful
    // abort is not trusted without exact HEAD/clean checks. The workspace is
    // Fleet-owned, so this reset is scoped to its durable pre-operation head.
    await restoreExactCleanHead(deps, cwd, expectedHead);
  }
  try {
    await assertExactCleanHead(
      deps,
      cwd,
      expectedHead,
      "integration restoration failed"
    );
  } catch {
    throw new Error(
      "Fleet could not restore the integration worktree after failure"
    );
  }
}

function markTaskMergeFailure(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow,
  operation: FleetMergeOperationRow,
  error: unknown,
  artifactId: string | null
): void {
  const now = deps.now().toISOString();
  transaction(deps.db, () => {
    const finished = deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET state = 'failed', error = ?,
         output_artifact_id = ?, lease_owner = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(
        boundedError(error),
        artifactId,
        now,
        now,
        operation.id,
        deps.leaseOwner
      );
    if (finished.changes !== 1) return;
    releaseOperationResources(deps, operation.id, new Date(now));
    deps.db
      .prepare(
        `UPDATE fleet_tasks SET status = 'needs_inspection',
         integration_state = 'failed', integration_operation_id = ?,
         failure_code = 'integration_failed', updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND head_sha = ?`
      )
      .run(operation.id, now, task.id, run.id, task.head_sha);
    setRunError(deps.db, run.id, "awaiting_operator", error, now);
    createEvent(
      deps.db,
      run.id,
      "task_integration_failed",
      {
        taskId: task.id,
        operationId: operation.id,
        error: boundedError(error),
      },
      { controlPlane: true }
    );
  });
}

function taskIntegrationWasPersisted(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow,
  operation: FleetMergeOperationRow,
  resultHead: string
): boolean {
  const durableOperation = deps.db
    .prepare(
      `SELECT state, result_head_sha FROM fleet_merge_operations WHERE id = ?`
    )
    .get(operation.id) as
    { state: string; result_head_sha: string | null } | undefined;
  const durableTask = deps.db
    .prepare(
      `SELECT status, integration_state, integrated_head_sha
       FROM fleet_tasks WHERE id = ? AND fleet_run_id = ?`
    )
    .get(task.id, run.id) as
    | {
        status: string;
        integration_state: string;
        integrated_head_sha: string | null;
      }
    | undefined;
  const durableRun = queries.getFleetRun(deps.db).get(run.id) as
    FleetMergeRunRow | undefined;
  return Boolean(
    durableOperation?.state === "completed" &&
    durableOperation.result_head_sha === resultHead &&
    durableTask?.status === "merged" &&
    durableTask.integration_state === "merged" &&
    durableTask.integrated_head_sha === resultHead &&
    durableRun?.integration_head_sha === resultHead
  );
}

function persistIntegratedTask(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow,
  operation: FleetMergeOperationRow,
  resultHead: string,
  artifactId: string,
  outputHash: string
): void {
  const now = deps.now().toISOString();
  transaction(deps.db, () => {
    const currentRun = queries.getFleetRun(deps.db).get(run.id) as
      FleetMergeRunRow | undefined;
    if (
      !currentRun ||
      currentRun.integration_head_sha !== operation.expected_base_sha ||
      currentRun.integration_branch !== run.integration_branch
    ) {
      throw new Error(
        "integration head changed before task result was persisted"
      );
    }
    const taskChanged = deps.db
      .prepare(
        `UPDATE fleet_tasks SET status = 'merged', integration_state = 'merged',
         integration_operation_id = ?, integrated_head_sha = ?, integrated_at = ?,
         failure_code = NULL, ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'ready_to_merge'
           AND head_sha = ? AND verified_head_sha = head_sha
           AND review_head_sha = head_sha AND review_status = 'clean'`
      )
      .run(
        operation.id,
        resultHead,
        now,
        now,
        now,
        task.id,
        run.id,
        operation.expected_task_head_sha
      );
    if (taskChanged.changes !== 1) {
      throw new Error("task evidence changed before integration was committed");
    }
    const opChanged = deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET state = 'completed', result_head_sha = ?,
         verification_output_hash = ?, output_artifact_id = ?, error = NULL,
         lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(
        resultHead,
        outputHash,
        artifactId,
        now,
        now,
        operation.id,
        deps.leaseOwner
      );
    if (opChanged.changes !== 1)
      throw new Error("merge operation lease changed");
    releaseOperationResources(deps, operation.id, new Date(now));
    const runChanged = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'integrating',
         integration_head_sha = ?, integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?`
      )
      .run(resultHead, now, now, run.id, operation.expected_base_sha);
    if (runChanged.changes !== 1) throw new Error("integration run CAS failed");

    // A dependent must start from the exact combined head that contains its
    // upstream. base_sha is authorized runtime state and is intentionally not
    // part of the approved execution hash; base_branch remains the immutable,
    // human-readable approval input.
    deps.db
      .prepare(
        `UPDATE fleet_tasks SET base_sha = ?, updated_at = ?
         WHERE fleet_run_id = ?
           AND status IN ('draft', 'planned', 'ready', 'blocked')
           AND NOT EXISTS (
             SELECT 1 FROM fleet_workers worker
             WHERE worker.task_id = fleet_tasks.id
               AND worker.status IN ('leasing','spawning','running','waiting_for_operator')
           )
           AND EXISTS (
             SELECT 1 FROM fleet_task_dependencies dependency
             WHERE dependency.fleet_run_id = fleet_tasks.fleet_run_id
               AND dependency.task_id = fleet_tasks.id
               AND dependency.depends_on_task_id = ?
               AND dependency.dependency_type = 'blocks'
           )`
      )
      .run(resultHead, now, run.id, task.id);
    createEvent(deps.db, run.id, "task_integrated", {
      taskId: task.id,
      taskHeadSha: task.head_sha,
      integrationHeadSha: resultHead,
      operationId: operation.id,
    });
  });
}

async function integrateTask(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow
): Promise<boolean> {
  if (
    !run.integration_worktree ||
    !run.integration_branch ||
    !validSha(run.integration_head_sha) ||
    !validSha(task.head_sha) ||
    !task.worktree_path
  ) {
    throw new Error("task integration contract is incomplete");
  }
  const command = exactVerificationCommand(deps.db, task);
  if (!command) throw new Error("task exact verification command is missing");
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: task.id,
    type: "task_merge",
    baseSha: run.integration_head_sha,
    taskHeadSha: task.head_sha,
    commands: [command],
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;

  let artifactId: string | null = null;
  let artifactContentHash: string | null = null;
  let integrationMutationStarted = false;
  let resultHead: string | null = null;
  try {
    const currentIntegrationHead = await gitSha(deps, run.integration_worktree);
    const alreadyApplied = await isAncestor(
      deps,
      run.integration_worktree,
      task.head_sha,
      currentIntegrationHead
    );
    integrationMutationStarted =
      currentIntegrationHead !== operation.expected_base_sha;
    if (
      currentIntegrationHead !== operation.expected_base_sha &&
      !alreadyApplied
    ) {
      throw new Error("integration head changed before exact task merge");
    }

    const taskWorktree = expandHome(task.worktree_path);
    if ((await gitSha(deps, taskWorktree)) !== task.head_sha) {
      throw new Error("task worktree head moved after review");
    }
    if (!(await gitClean(deps, taskWorktree))) {
      throw new Error("task worktree is dirty after review");
    }
    if (
      !validSha(task.base_sha) ||
      !(await isAncestor(deps, taskWorktree, task.base_sha, task.head_sha))
    ) {
      throw new Error("task head is not descended from its bound base");
    }

    if (!alreadyApplied) {
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET integration_state = 'integrating',
           integration_operation_id = ?, updated_at = ?
           WHERE id = ? AND status = 'ready_to_merge' AND head_sha = ?`
        )
        .run(claimed.id, deps.now().toISOString(), task.id, task.head_sha);
      try {
        // The command can leave MERGE_HEAD/index mutations even when it throws.
        // From this point every unsuccessful durable outcome restores baseSha.
        integrationMutationStarted = true;
        await deps.git(
          run.integration_worktree,
          ["merge", "--no-ff", "--no-commit", task.head_sha],
          120_000
        );
      } catch (error) {
        throw new Error(`task merge conflict: ${boundedError(error)}`);
      }
      await deps.git(
        run.integration_worktree,
        [
          "-c",
          "user.name=Stoa Fleet",
          "-c",
          "user.email=stoa-fleet@localhost",
          "commit",
          "--no-gpg-sign",
          "-m",
          `fleet: integrate ${task.id}`,
        ],
        120_000
      );
    }

    resultHead = await gitSha(deps, run.integration_worktree);
    if (
      !(await isAncestor(
        deps,
        run.integration_worktree,
        task.head_sha,
        resultHead
      ))
    ) {
      throw new Error("integration result does not contain exact task head");
    }
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      resultHead,
      "integration verification preflight"
    );

    let verification: VerifyResult | null = null;
    let verificationFailure: Error | null = null;
    try {
      verification = await deps.verify(run.integration_worktree, command);
      await assertExactCleanHead(
        deps,
        run.integration_worktree,
        resultHead,
        "integration verifier mutation"
      );
    } catch (error) {
      verificationFailure =
        error instanceof Error ? error : new Error(boundedError(error));
      try {
        await restoreExactCleanHead(deps, run.integration_worktree, resultHead);
      } catch (restoreError) {
        throw new Error(
          `integration verifier failed and exact committed-head restoration failed: ${boundedError(restoreError)}`
        );
      }
      verification = {
        status: "error",
        output: boundedError(verificationFailure),
      };
    }
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      resultHead,
      "integration verification artifact boundary"
    );
    const verificationBody = JSON.stringify(
      {
        taskId: task.id,
        taskHeadSha: task.head_sha,
        integrationBaseSha: operation.expected_base_sha,
        integrationHeadSha: resultHead,
        command,
        status: verification.status,
        output: verification.output,
      },
      null,
      2
    );
    const verificationArtifact = insertArtifact(deps, {
      run,
      taskId: task.id,
      baseSha: operation.expected_base_sha,
      headSha: resultHead,
      type: "fleet_integration_verification",
      title: `Integration verification: ${task.title}`,
      body: verificationBody,
      severity: verification.status === "pass" ? "info" : "blocker",
      metadata: {
        operationId: claimed.id,
        command,
        status: verification.status,
        integrationHeadSha: resultHead,
      },
    });
    artifactId = verificationArtifact.id;
    artifactContentHash = verificationArtifact.contentHash;
    if (verificationFailure) throw verificationFailure;
    if (verification.status !== "pass") {
      throw new Error(`integration verification ${verification.status}`);
    }
    if (!artifactId || !artifactContentHash) {
      throw new Error("integration verification artifact was not persisted");
    }
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      resultHead,
      "integration persistence boundary"
    );
    persistIntegratedTask(
      deps,
      run,
      task,
      claimed,
      resultHead,
      artifactId,
      artifactContentHash
    );
    return true;
  } catch (error) {
    if (resultHead) {
      try {
        if (taskIntegrationWasPersisted(deps, run, task, claimed, resultHead)) {
          return true;
        }
      } catch {
        // A failed recovery read is not evidence of success. Restore Git first;
        // the still-running durable operation can be reconciled on restart.
      }
    }
    if (integrationMutationStarted) {
      try {
        await abortMerge(
          deps,
          run.integration_worktree,
          operation.expected_base_sha
        );
      } catch (restoreError) {
        finishOperation(deps, claimed, {
          state: "waiting",
          artifactId,
          error: `integration failed and exact-head restoration is pending: ${boundedError(restoreError)}`,
        });
        setRunError(
          deps.db,
          run.id,
          "awaiting_operator",
          restoreError,
          deps.now().toISOString()
        );
        return false;
      }
    }
    markTaskMergeFailure(deps, run, task, claimed, error, artifactId);
    return false;
  }
}

function finalVerificationCommands(
  db: Database.Database,
  runId: string
): string[] {
  const rows = db
    .prepare(
      `SELECT verification.command
       FROM fleet_tasks task
       JOIN fleet_verifications verification ON verification.id = task.verification_id
       WHERE task.fleet_run_id = ? AND task.status = 'merged'
         AND verification.status = 'pass'
         AND verification.head_sha = task.head_sha
       ORDER BY task.sort_order ASC, task.id ASC`
    )
    .all(runId) as { command: string }[];
  return [...new Set(rows.map((row) => row.command.trim()).filter(Boolean))];
}

async function runFinalVerification(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow
): Promise<boolean> {
  if (!run.integration_worktree || !validSha(run.integration_head_sha)) {
    throw new Error("final integration verification contract is incomplete");
  }
  const commands = finalVerificationCommands(deps.db, run.id);
  if (commands.length === 0) {
    throw new Error("final integration verification has no approved commands");
  }
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "final_verify",
    baseSha: run.integration_head_sha,
    commands,
  });
  if (operation.state === "completed") {
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'ready_to_finalize',
         status = 'merging', integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?`
      )
      .run(
        deps.now().toISOString(),
        deps.now().toISOString(),
        run.id,
        run.integration_head_sha
      );
    return false;
  }
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let artifactId: string | null = null;
  let artifactContentHash: string | null = null;
  let verificationStarted = false;
  try {
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "final verification preflight"
    );
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'final_verifying',
         status = 'merging', integration_updated_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    const results: { command: string; status: string; output: string }[] = [];
    let verificationFailure: Error | null = null;
    for (const command of commands) {
      renewOperationLease(deps, claimed);
      verificationStarted = true;
      let result: VerifyResult;
      try {
        result = await deps.verify(run.integration_worktree, command);
        await assertExactCleanHead(
          deps,
          run.integration_worktree,
          run.integration_head_sha,
          "final verifier mutation"
        );
      } catch (error) {
        verificationFailure =
          error instanceof Error ? error : new Error(boundedError(error));
        try {
          await restoreExactCleanHead(
            deps,
            run.integration_worktree,
            run.integration_head_sha
          );
        } catch (restoreError) {
          throw new Error(
            `final verifier failed and exact committed-head restoration failed: ${boundedError(restoreError)}`
          );
        }
        result = {
          status: "error",
          output: boundedError(verificationFailure),
        };
      }
      results.push({ command, status: result.status, output: result.output });
      if (result.status !== "pass") break;
    }
    const passed =
      results.length === commands.length &&
      results.every((result) => result.status === "pass");
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "final verification artifact boundary"
    );
    const body = JSON.stringify(
      {
        integrationHeadSha: run.integration_head_sha,
        commands,
        results,
      },
      null,
      2
    );
    const verificationArtifact = insertArtifact(deps, {
      run,
      baseSha: run.integration_base_sha ?? run.integration_head_sha,
      headSha: run.integration_head_sha,
      type: "fleet_final_verification",
      title: "Final combined-head verification",
      body,
      severity: passed ? "info" : "blocker",
      metadata: { operationId: claimed.id, passed, commands },
    });
    artifactId = verificationArtifact.id;
    artifactContentHash = verificationArtifact.contentHash;
    if (verificationFailure) throw verificationFailure;
    if (!passed) throw new Error("final combined-head verification failed");
    if (!artifactId || !artifactContentHash) {
      throw new Error("final verification artifact was not persisted");
    }
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "final verification persistence boundary"
    );
    const now = deps.now().toISOString();
    transaction(deps.db, () => {
      const op = deps.db
        .prepare(
          `UPDATE fleet_merge_operations SET state = 'completed',
           result_head_sha = ?, verification_output_hash = ?, output_artifact_id = ?,
           error = NULL, lease_owner = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND lease_owner = ?`
        )
        .run(
          run.integration_head_sha,
          artifactContentHash,
          artifactId,
          now,
          now,
          claimed.id,
          deps.leaseOwner
        );
      if (op.changes !== 1) throw new Error("final verification lease changed");
      releaseOperationResources(deps, claimed.id, new Date(now));
      const updated = deps.db
        .prepare(
          `UPDATE fleet_runs SET integration_state = 'ready_to_finalize',
           status = 'merging', integration_error = NULL,
           integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND integration_head_sha = ?`
        )
        .run(now, now, run.id, run.integration_head_sha);
      if (updated.changes !== 1) {
        throw new Error("combined head changed after final verification");
      }
      createEvent(deps.db, run.id, "integration_final_verification_passed", {
        headSha: run.integration_head_sha,
        operationId: claimed.id,
        commands,
      });
    });
    return true;
  } catch (error) {
    if (verificationStarted) {
      try {
        await restoreExactCleanHead(
          deps,
          run.integration_worktree,
          run.integration_head_sha
        );
      } catch (restoreError) {
        const restorationError = new Error(
          `final verification failed and exact-head restoration is pending: ${boundedError(restoreError)}`
        );
        finishOperation(deps, claimed, {
          state: "waiting",
          artifactId,
          error: boundedError(restorationError),
        });
        setRunError(
          deps.db,
          run.id,
          "awaiting_operator",
          restorationError,
          deps.now().toISOString()
        );
        return false;
      }
    }
    finishOperation(deps, claimed, {
      state: "failed",
      artifactId,
      error: boundedError(error),
    });
    setRunError(
      deps.db,
      run.id,
      "awaiting_operator",
      error,
      deps.now().toISOString()
    );
    return false;
  }
}

function completeRun(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  mergeSha: string,
  pr?: { number: number; url: string; headSha: string } | null
): boolean {
  const durableRun = queries.getFleetRun(deps.db).get(run.id) as
    FleetMergeRunRow | undefined;
  const durableOperation = deps.db
    .prepare(
      `SELECT state, result_head_sha FROM fleet_merge_operations WHERE id = ?`
    )
    .get(operation.id) as
    { state: string; result_head_sha: string | null } | undefined;
  if (
    durableRun?.status === "completed" &&
    durableRun.integration_state === "completed" &&
    durableRun.integration_merge_sha === mergeSha &&
    durableOperation?.state === "completed" &&
    durableOperation.result_head_sha === mergeSha
  ) {
    releaseOperationResources(deps, operation.id, deps.now());
    return true;
  }
  const now = deps.now().toISOString();
  transaction(deps.db, () => {
    const op = deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET state = 'completed', result_head_sha = ?,
         error = NULL, lease_owner = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(mergeSha, now, now, operation.id, deps.leaseOwner);
    if (op.changes !== 1)
      throw new Error("final merge operation lease changed");
    releaseOperationResources(deps, operation.id, new Date(now));
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET status = 'completed', integration_state = 'completed',
         integration_merge_sha = ?, integration_pr_number = COALESCE(?, integration_pr_number),
         integration_pr_url = COALESCE(?, integration_pr_url),
         integration_pr_head_sha = COALESCE(?, integration_pr_head_sha),
         integration_error = NULL, ended_at = COALESCE(ended_at, ?),
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ? AND status = 'merging'`
      )
      .run(
        mergeSha,
        pr?.number ?? null,
        pr?.url ?? null,
        pr?.headSha ?? null,
        now,
        now,
        now,
        run.id,
        run.integration_head_sha
      );
    if (changed.changes !== 1) throw new Error("final merge run CAS failed");
    createEvent(
      deps.db,
      run.id,
      "fleet_merge_completed",
      {
        target: run.merge_target,
        integrationHeadSha: run.integration_head_sha,
        mergeSha,
        pr: pr ?? null,
        operationId: operation.id,
      },
      { controlPlane: true }
    );
  });
  return true;
}

function leaveExternallyCompletedOperationRecoverable(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  error: unknown
): void {
  finishOperation(deps, operation, {
    state: "waiting",
    error: `external action completed; durable recovery pending: ${boundedError(error)}`,
  });
  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = 'merging',
       integration_error = ?, integration_updated_at = ?, updated_at = ?
       WHERE id = ? AND status <> 'completed'`
    )
    .run(
      "external action completed; durable recovery pending",
      now,
      now,
      run.id
    );
}

async function finalizeLocal(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !validSha(run.integration_base_sha) ||
    !validSha(run.integration_head_sha) ||
    !run.integration_branch ||
    !run.integration_worktree
  ) {
    throw new Error("local finalization contract is incomplete");
  }
  let operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "local_finalize",
    target: "local",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") {
    try {
      if (
        (await gitBranch(deps, target.repoPath)) !== target.baseBranch ||
        (await gitSha(deps, target.repoPath)) !== run.integration_head_sha ||
        !(await gitClean(deps, target.repoPath))
      ) {
        return false;
      }
    } catch {
      return false;
    }
    operation =
      reopenFailedOperationForExactRecovery(deps, operation) ?? operation;
    if (operation.state === "failed") return false;
  }
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let externalActionStarted = false;
  try {
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "local landing preflight"
    );
    const branch = await gitBranch(deps, target.repoPath);
    const sourceHead = await gitSha(deps, target.repoPath);
    const clean = await gitClean(deps, target.repoPath);
    if (branch !== target.baseBranch) {
      throw new Error(
        `local checkout is on ${branch || "detached HEAD"}, expected ${target.baseBranch}`
      );
    }
    if (!clean) throw new Error("local checkout is dirty");
    if (
      sourceHead !== run.integration_base_sha &&
      sourceHead !== run.integration_head_sha
    ) {
      throw new Error("local checkout base moved after Fleet bound it");
    }
    if (
      !(await isAncestor(
        deps,
        target.repoPath,
        run.integration_base_sha,
        run.integration_head_sha
      ))
    ) {
      throw new Error("integration head is not descended from the bound base");
    }
    if (sourceHead !== run.integration_head_sha) {
      // A git process may apply the fast-forward and still report an I/O error.
      // Once invoked, authoritative HEAD recovery decides the durable outcome.
      externalActionStarted = true;
      await deps.git(
        target.repoPath,
        ["merge", "--ff-only", run.integration_head_sha],
        120_000
      );
    }
    const mergedHead = await gitSha(deps, target.repoPath);
    if (mergedHead !== run.integration_head_sha) {
      throw new Error(
        "local fast-forward did not land the exact integration head"
      );
    }
    completeRun(deps, run, claimed, mergedHead);
    return true;
  } catch (error) {
    try {
      const branch = await gitBranch(deps, target.repoPath);
      const head = await gitSha(deps, target.repoPath);
      const clean = await gitClean(deps, target.repoPath);
      if (
        branch === target.baseBranch &&
        head === run.integration_head_sha &&
        clean
      ) {
        try {
          completeRun(deps, run, claimed, head);
          return true;
        } catch (persistenceError) {
          leaveExternallyCompletedOperationRecoverable(
            deps,
            run,
            claimed,
            persistenceError
          );
          return false;
        }
      }
    } catch {
      // If the fast-forward process ran, absence of a readable authoritative
      // head is ambiguous. Retry discovery instead of recording false failure.
      if (externalActionStarted) {
        leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
        return false;
      }
    }
    if (externalActionStarted) {
      leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
      return false;
    }
    finishOperation(deps, claimed, {
      state: "failed",
      error: boundedError(error),
    });
    setRunError(
      deps.db,
      run.id,
      "awaiting_operator",
      error,
      deps.now().toISOString()
    );
    return false;
  }
}

async function remoteBranchHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  branch: string
): Promise<string | null> {
  const { stdout } = await deps.git(
    cwd,
    ["ls-remote", "--heads", "origin", `refs/heads/${branch}`],
    30_000,
    64 * 1024
  );
  const line = stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!line) return null;
  const sha = line.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!validSha(sha)) throw new Error("origin returned an invalid branch head");
  return sha;
}

function persistGitHubPush(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  confirmedHead: string
): void {
  transaction(deps.db, () => {
    if (
      !finishOperation(deps, operation, {
        state: "completed",
        resultHeadSha: confirmedHead,
      })
    ) {
      throw new Error("GitHub push operation lease changed");
    }
    const now = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'pushing',
         integration_error = NULL, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?`
      )
      .run(now, now, run.id, confirmedHead);
    if (changed.changes !== 1) {
      throw new Error("GitHub push run CAS changed");
    }
  });
}

async function ensureGitHubPush(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !run.integration_branch ||
    !run.integration_worktree ||
    !validSha(run.integration_head_sha)
  ) {
    throw new Error("GitHub push contract is incomplete");
  }
  let operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_push",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") {
    const remote = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch
    ).catch(() => null);
    if (remote !== run.integration_head_sha) return false;
    operation =
      reopenFailedOperationForExactRecovery(deps, operation) ?? operation;
    if (operation.state === "failed") return false;
  }
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let pushAttempted = false;
  try {
    await assertExactCleanHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "GitHub landing preflight"
    );
    const remote = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch
    );
    if (remote && remote !== run.integration_head_sha) {
      throw new Error("remote integration branch exists at a different head");
    }
    if (!remote) {
      pushAttempted = true;
      await deps.git(
        run.integration_worktree,
        ["push", "--set-upstream", "origin", run.integration_branch],
        120_000
      );
    }
    const confirmed = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch
    );
    if (confirmed !== run.integration_head_sha) {
      throw new Error("remote integration branch did not reach the exact head");
    }
    persistGitHubPush(deps, run, claimed, confirmed);
    return true;
  } catch (error) {
    try {
      const confirmed = await remoteBranchHead(
        deps,
        target.repoPath,
        run.integration_branch
      );
      if (confirmed === run.integration_head_sha) {
        try {
          persistGitHubPush(deps, run, claimed, confirmed);
          return true;
        } catch (persistenceError) {
          leaveExternallyCompletedOperationRecoverable(
            deps,
            run,
            claimed,
            persistenceError
          );
          return false;
        }
      }
    } catch {
      if (pushAttempted) {
        leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
        return false;
      }
    }
    if (pushAttempted) {
      leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
      return false;
    }
    finishOperation(deps, claimed, {
      state: "failed",
      error: boundedError(error),
    });
    setRunError(
      deps.db,
      run.id,
      "awaiting_operator",
      error,
      deps.now().toISOString()
    );
    return false;
  }
}

async function readFleetPr(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  selector: string | number,
  repoSlug: string
): Promise<FleetPrStatus | null> {
  try {
    const result = await deps.gh(cwd, buildFleetPrViewArgs(selector, repoSlug));
    return parseFleetPrStatus(result.stdout);
  } catch {
    return null;
  }
}

function persistGitHubPr(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  pr: { number: number; url: string; headSha: string }
): void {
  transaction(deps.db, () => {
    if (
      !finishOperation(deps, operation, {
        state: "completed",
        resultHeadSha: pr.headSha,
      })
    ) {
      throw new Error("GitHub PR operation lease changed");
    }
    const now = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'waiting_ci',
         integration_pr_number = ?, integration_pr_url = ?,
         integration_pr_head_sha = ?, integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?`
      )
      .run(
        pr.number,
        pr.url,
        pr.headSha,
        now,
        now,
        run.id,
        run.integration_head_sha
      );
    if (changed.changes !== 1) throw new Error("GitHub PR run CAS changed");
    createEvent(
      deps.db,
      run.id,
      "integration_pr_ready",
      {
        prNumber: pr.number,
        prUrl: pr.url,
        headSha: pr.headSha,
      },
      { controlPlane: true }
    );
  });
}

async function ensureGitHubPr(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !target.repoSlug ||
    !run.integration_branch ||
    !validSha(run.integration_head_sha)
  ) {
    throw new Error("GitHub PR contract is incomplete");
  }
  let operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_pr",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") {
    const existing = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_branch,
      target.repoSlug
    );
    if (
      existing?.headSha !== run.integration_head_sha ||
      (existing.state !== "OPEN" && existing.state !== "MERGED")
    ) {
      return false;
    }
    operation =
      reopenFailedOperationForExactRecovery(deps, operation) ?? operation;
    if (operation.state === "failed") return false;
  }
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let createAttempted = false;
  try {
    let pr = run.integration_pr_number
      ? await readFleetPr(
          deps,
          target.repoPath,
          run.integration_pr_number,
          target.repoSlug
        )
      : await readFleetPr(
          deps,
          target.repoPath,
          run.integration_branch,
          target.repoSlug
        );
    if (!pr) {
      createAttempted = true;
      await deps.gh(
        target.repoPath,
        buildFleetPrCreateArgs({
          repoSlug: target.repoSlug,
          branch: run.integration_branch,
          baseBranch: target.baseBranch,
          title: `[Fleet] ${run.name}`.slice(0, 200),
          body: [
            "Server-owned Stoa Fleet integration result.",
            "",
            `Run: ${run.id}`,
            `Plan: ${run.approved_plan_hash ?? "unknown"}`,
            `Base: ${run.integration_base_sha ?? "unknown"}`,
            `Exact integration head: ${run.integration_head_sha}`,
          ].join("\n"),
        })
      );
      // A crash after create is recovered by the branch lookup above; always
      // re-read authoritative PR metadata rather than parsing CLI prose.
      pr = await readFleetPr(
        deps,
        target.repoPath,
        run.integration_branch,
        target.repoSlug
      );
    }
    if (!pr) throw new Error("GitHub PR could not be created or recovered");
    if (pr.baseSha !== run.integration_base_sha) {
      throw new Error("GitHub PR base changed after fleet integration began");
    }
    if (pr.headSha !== run.integration_head_sha) {
      throw new Error(
        "GitHub PR head differs from the verified integration head"
      );
    }
    if (pr.state !== "OPEN" && pr.state !== "MERGED") {
      throw new Error(`GitHub PR is not open (state ${pr.state ?? "unknown"})`);
    }
    persistGitHubPr(deps, run, claimed, {
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
    });
    return true;
  } catch (error) {
    const recovered = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_branch,
      target.repoSlug
    );
    if (
      recovered?.baseSha === run.integration_base_sha &&
      recovered.headSha === run.integration_head_sha &&
      (recovered.state === "OPEN" || recovered.state === "MERGED")
    ) {
      try {
        persistGitHubPr(deps, run, claimed, {
          number: recovered.number,
          url: recovered.url,
          headSha: recovered.headSha,
        });
        return true;
      } catch (persistenceError) {
        leaveExternallyCompletedOperationRecoverable(
          deps,
          run,
          claimed,
          persistenceError
        );
        return false;
      }
    }
    if (createAttempted && !recovered) {
      leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
      return false;
    }
    finishOperation(deps, claimed, {
      state: "failed",
      error: boundedError(error),
    });
    setRunError(
      deps.db,
      run.id,
      "awaiting_operator",
      error,
      deps.now().toISOString()
    );
    return false;
  }
}

async function finalizeGitHub(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !target.repoSlug ||
    !run.integration_pr_number ||
    !validSha(run.integration_head_sha)
  ) {
    throw new Error("GitHub merge contract is incomplete");
  }
  let operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_merge",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") {
    const existing = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    if (
      existing?.state !== "MERGED" ||
      existing.headSha !== run.integration_head_sha ||
      !validSha(existing.mergeSha)
    ) {
      return false;
    }
    operation =
      reopenFailedOperationForExactRecovery(deps, operation) ?? operation;
    if (operation.state === "failed") return false;
  }
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let mergeAttempted = false;
  try {
    let pr = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    if (!pr) throw new Error("GitHub PR status is unavailable");
    if (pr.state !== "MERGED" && pr.baseSha !== run.integration_base_sha) {
      throw new Error("GitHub PR base changed after final verification");
    }
    if (pr.headSha !== run.integration_head_sha) {
      throw new Error("GitHub PR head changed after final verification");
    }
    if (pr.state === "MERGED") {
      if (!validSha(pr.mergeSha)) {
        throw new Error("merged GitHub PR has no authoritative merge commit");
      }
      completeRun(deps, run, claimed, pr.mergeSha, {
        number: pr.number,
        url: pr.url,
        headSha: pr.headSha,
      });
      return true;
    }
    if (pr.state !== "OPEN") {
      throw new Error(`GitHub PR is not open (state ${pr.state ?? "unknown"})`);
    }
    if (
      pr.mergeable !== "MERGEABLE" ||
      pr.checks === "pending" ||
      pr.checks === "failing"
    ) {
      finishOperation(deps, claimed, {
        state: "waiting",
        error:
          pr.checks === "failing"
            ? "GitHub checks are failing"
            : "GitHub mergeability or checks are pending",
      });
      deps.db
        .prepare(
          `UPDATE fleet_runs SET integration_state = 'waiting_ci',
           integration_error = ?, integration_updated_at = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          pr.checks === "failing" ? "GitHub checks are failing" : null,
          deps.now().toISOString(),
          deps.now().toISOString(),
          run.id
        );
      return false;
    }
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'merging',
         integration_updated_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    mergeAttempted = true;
    await deps.mergePullRequest({
      cwd: target.repoPath,
      prNumber: pr.number,
      method: "merge",
      matchHeadCommit: run.integration_head_sha,
      repoSlug: target.repoSlug,
    });
    pr = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    if (
      !pr ||
      pr.state !== "MERGED" ||
      pr.headSha !== run.integration_head_sha ||
      !validSha(pr.mergeSha)
    ) {
      // Do not claim success from the gh command alone. A following tick recovers
      // by reading the same PR and only persists an authoritative merged state.
      finishOperation(deps, claimed, {
        state: "waiting",
        error: "waiting for authoritative GitHub merged state",
      });
      return false;
    }
    completeRun(deps, run, claimed, pr.mergeSha, {
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
    });
    return true;
  } catch (error) {
    const recovered = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    if (
      recovered?.state === "MERGED" &&
      recovered.headSha === run.integration_head_sha &&
      validSha(recovered.mergeSha)
    ) {
      try {
        completeRun(deps, run, claimed, recovered.mergeSha, {
          number: recovered.number,
          url: recovered.url,
          headSha: recovered.headSha,
        });
        return true;
      } catch (persistenceError) {
        leaveExternallyCompletedOperationRecoverable(
          deps,
          run,
          claimed,
          persistenceError
        );
        return false;
      }
    }
    if (mergeAttempted) {
      leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
      return false;
    }
    finishOperation(deps, claimed, {
      state: "failed",
      error: boundedError(error),
    });
    setRunError(
      deps.db,
      run.id,
      "awaiting_operator",
      error,
      deps.now().toISOString()
    );
    return false;
  }
}

interface ExactApprovedFleetExecution {
  run: FleetMergeRunRow;
  executionHash: string;
}

function exactApprovedFleetExecution(
  db: Database.Database,
  runId: string
): ExactApprovedFleetExecution | null {
  const run = queries.getFleetRun(db).get(runId) as
    FleetMergeRunRow | undefined;
  if (
    !run ||
    !validSha(run.automation_base_sha) ||
    run.approval_state !== "approved" ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash ||
    !approvedExecutionHash(run)
  ) {
    return null;
  }
  const tasks = queries.listFleetTasksForRun(db).all(run.id) as FleetTaskRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskDependencyRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskClaimRow[];
  const executionHash = approvedExecutionHash(run)!;
  if (
    hashFleetTaskRows(tasks, dependencies) !== run.plan_hash ||
    hashFleetExecutionContract({ run, tasks, claims, dependencies }) !==
      executionHash
  ) {
    return null;
  }
  return { run, executionHash };
}

function unavailableFinalVerificationRetry(
  input: Partial<FleetFinalVerificationRetryStatus> = {}
): FleetFinalVerificationRetryStatus {
  return {
    action: input.action ?? null,
    state: input.state ?? "not_applicable",
    available: false,
    reason: input.reason ?? null,
    operationId: input.operationId ?? null,
    attemptCount: input.attemptCount ?? 0,
    maxAttempts: FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS,
    preconditions: null,
  };
}

function parseExactStringArray(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 256 ||
      parsed.some(
        (item) =>
          typeof item !== "string" ||
          item.length === 0 ||
          Buffer.byteLength(item, "utf8") > 16_384
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Describe the one manual retry that is safe to expose. A failed final
 * verifier is deterministic for the exact integration head, unlike Git/PR
 * operations whose external side effects need their own authoritative
 * recovery paths.
 */
function inspectManualFinalVerificationRetry(
  db: Database.Database,
  runId: string
): FleetFinalVerificationRetryStatus {
  const run = queries.getFleetRun(db).get(runId) as
    FleetMergeRunRow | undefined;
  if (
    !run ||
    run.merge_requested_at !== null ||
    run.merge_request_kind !== "manual" ||
    (run.merge_target !== "local" && run.merge_target !== "github_pr")
  ) {
    return unavailableFinalVerificationRetry();
  }

  const operation = db
    .prepare(
      `SELECT * FROM fleet_merge_operations
       WHERE fleet_run_id = ? AND operation_type = 'final_verify'
         AND state = 'failed'
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(runId) as FleetMergeOperationRow | undefined;
  if (!operation) return unavailableFinalVerificationRetry();

  const blocked = (
    reason: string,
    state: "blocked" | "exhausted" = "blocked"
  ) =>
    unavailableFinalVerificationRetry({
      action: "retry_final_verification",
      state,
      reason,
      operationId: operation.id,
      attemptCount: operation.attempt_count,
    });

  if (["completed", "failed", "canceled"].includes(run.status)) {
    return blocked(`Fleet run cannot retry from ${run.status}`);
  }
  if (
    (run.desired_state ?? "running") !== "running" ||
    !["running", "reviewing", "merging"].includes(run.status)
  ) {
    return blocked("Resume the Fleet run before retrying final verification");
  }
  if (run.recovery_required === 1) {
    return blocked("Fleet startup recovery must finish before retrying");
  }
  if (!["failed", "awaiting_operator"].includes(run.integration_state)) {
    return blocked("Final verification is not waiting for an operator retry");
  }

  const exact = exactApprovedFleetExecution(db, runId);
  if (!exact) {
    return blocked("The approved plan or execution contract changed");
  }
  const current = exact.run;
  if (
    !validSha(current.automation_base_sha) ||
    current.integration_base_sha !== current.automation_base_sha ||
    !validSha(current.integration_head_sha)
  ) {
    return blocked("The bound base or integration head changed");
  }
  if (
    operation.task_id !== null ||
    operation.target !== null ||
    operation.expected_base_sha !== current.integration_head_sha ||
    operation.expected_task_head_sha !== null ||
    operation.result_head_sha !== null ||
    operation.verification_output_hash !== null ||
    operation.lease_owner !== null ||
    operation.lease_expires_at !== null
  ) {
    return blocked("Failed final verification evidence is not retry-safe");
  }
  const reservedResources = db
    .prepare(
      `SELECT 1 FROM fleet_runtime_leases
       WHERE owner_type = 'merge_operation' AND owner_id = ?
         AND status = 'reserved' LIMIT 1`
    )
    .get(operation.id);
  if (reservedResources) {
    return blocked("Final verification resource cleanup is still pending");
  }
  if (
    !Number.isSafeInteger(operation.attempt_count) ||
    operation.attempt_count < 1
  ) {
    return blocked("Failed final verification attempt state is invalid");
  }
  if (operation.attempt_count >= FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS) {
    return blocked(
      `Final verification exhausted ${FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS} attempts`,
      "exhausted"
    );
  }

  const commands = finalVerificationCommands(db, runId);
  const operationCommands = parseExactStringArray(
    operation.verification_commands_json
  );
  if (
    commands.length === 0 ||
    !operationCommands ||
    JSON.stringify(operationCommands) !== JSON.stringify(commands)
  ) {
    return blocked("Approved final verification commands changed");
  }
  const readiness = inspectFleetMergeReadiness(db, runId);
  if (!readiness?.canFinalize || !readiness.allTasksIntegrated) {
    return blocked("Exact-head merge readiness changed");
  }

  if (operation.output_artifact_id) {
    const artifact = db
      .prepare(
        `SELECT fleet_run_id, task_id, plan_hash, base_sha, head_sha,
                content_hash, metadata_json, artifact_type, severity, actor
         FROM fleet_artifacts WHERE id = ?`
      )
      .get(operation.output_artifact_id) as
      | {
          fleet_run_id: string;
          task_id: string | null;
          plan_hash: string | null;
          base_sha: string | null;
          head_sha: string | null;
          content_hash: string | null;
          metadata_json: string;
          artifact_type: string;
          severity: string;
          actor: string;
        }
      | undefined;
    let metadata: Record<string, unknown> | null = null;
    try {
      const parsed = artifact ? JSON.parse(artifact.metadata_json) : null;
      metadata =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      metadata = null;
    }
    if (
      !artifact ||
      artifact.fleet_run_id !== runId ||
      artifact.task_id !== null ||
      artifact.plan_hash !== current.plan_hash ||
      artifact.base_sha !== current.integration_base_sha ||
      artifact.head_sha !== current.integration_head_sha ||
      !artifact.content_hash ||
      !/^[0-9a-f]{64}$/i.test(artifact.content_hash) ||
      artifact.artifact_type !== "fleet_final_verification" ||
      artifact.actor !== "fleet-merge" ||
      (artifact.severity !== "info" && artifact.severity !== "blocker") ||
      metadata?.operationId !== operation.id ||
      typeof metadata.passed !== "boolean" ||
      JSON.stringify(metadata.commands) !== JSON.stringify(commands)
    ) {
      return blocked("Failed final verification artifact changed");
    }
  }

  return {
    action: "retry_final_verification",
    state: "available",
    available: true,
    reason: null,
    operationId: operation.id,
    attemptCount: operation.attempt_count,
    maxAttempts: FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS,
    preconditions: {
      planHash: current.plan_hash!,
      executionHash: exact.executionHash,
      baseSha: current.automation_base_sha,
      integrationHeadSha: current.integration_head_sha,
    },
  };
}

export function getFleetMergeStatus(
  runId: string,
  db: Database.Database = getDb()
): FleetMergeStatus | null {
  const status = readFleetMergeStatus(runId, db);
  return status
    ? { ...status, retry: inspectManualFinalVerificationRetry(db, runId) }
    : null;
}

function autoMergeEligible(
  db: Database.Database,
  runId: string
): {
  run: FleetMergeRunRow;
  target: FleetMergeTarget;
  policyHash: string;
  executionHash: string;
} | null {
  const exact = exactApprovedFleetExecution(db, runId);
  if (!exact) return null;
  const { run } = exact;
  if (
    (run.desired_state ?? "running") !== "running" ||
    !["running", "reviewing", "merging"].includes(run.status)
  ) {
    return null;
  }
  const parsed = parseFleetAutomationPolicy(run.automation_policy_json);
  if (
    !parsed.valid ||
    hashFleetAutomationPolicy(parsed.policy) !== run.automation_policy_hash ||
    !parsed.policy.automaticMerge ||
    !parsed.policy.automaticStart
  ) {
    return null;
  }
  const authorization = db
    .prepare(
      `SELECT status FROM fleet_action_authorizations
       WHERE fleet_run_id = ? AND action = 'merge' AND policy_hash = ?`
    )
    .get(run.id, run.automation_policy_hash) as { status: string } | undefined;
  return authorization?.status === "authorized"
    ? {
        run,
        target: parsed.policy.mergeTarget,
        policyHash: run.automation_policy_hash,
        executionHash: exact.executionHash,
      }
    : null;
}

function consumeAutomaticMergeAuthorization(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTarget,
  policyHash: string
): boolean {
  return transaction(deps.db, () => {
    const exact = exactApprovedFleetExecution(deps.db, run.id);
    if (!exact) return false;
    const current = exact.run;
    const parsed = parseFleetAutomationPolicy(current.automation_policy_json);
    if (
      !parsed.valid ||
      !parsed.policy.automaticMerge ||
      !parsed.policy.automaticStart ||
      parsed.policy.mergeTarget !== target ||
      current.automation_policy_hash !== policyHash ||
      hashFleetAutomationPolicy(parsed.policy) !== policyHash ||
      (current.desired_state ?? "running") !== "running" ||
      !["running", "reviewing", "merging"].includes(current.status) ||
      current.integration_state !== "ready_to_finalize" ||
      !validSha(current.integration_head_sha)
    ) {
      return false;
    }
    const verified = deps.db
      .prepare(
        `SELECT 1
         FROM fleet_merge_operations operation
         JOIN fleet_artifacts artifact ON artifact.id = operation.output_artifact_id
         WHERE operation.fleet_run_id = ?
           AND operation.operation_type = 'final_verify'
           AND operation.state = 'completed'
           AND operation.expected_base_sha = ?
           AND operation.result_head_sha = ?
           AND operation.verification_output_hash IS NOT NULL
           AND artifact.fleet_run_id = operation.fleet_run_id
           AND artifact.artifact_type = 'fleet_final_verification'
           AND artifact.head_sha = operation.result_head_sha
           AND artifact.content_hash = operation.verification_output_hash
         ORDER BY operation.created_at DESC LIMIT 1`
      )
      .get(
        current.id,
        current.integration_head_sha,
        current.integration_head_sha
      );
    if (!verified) return false;
    const now = deps.now().toISOString();
    const authorization = deps.db
      .prepare(
        `UPDATE fleet_action_authorizations
         SET status = 'consumed', plan_hash = ?, execution_hash = ?, base_sha = ?,
         consumed_by = 'fleet-merge', consumed_at = ?, attempt_count = attempt_count + 1,
         last_error = NULL, updated_at = ?
         WHERE fleet_run_id = ? AND action = 'merge' AND policy_hash = ?
           AND status = 'authorized'`
      )
      .run(
        current.approved_plan_hash,
        exact.executionHash,
        current.automation_base_sha,
        now,
        now,
        current.id,
        policyHash
      );
    if (authorization.changes !== 1) return false;
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET merge_requested_at = ?,
         merge_requested_by = 'fleet-automation', merge_request_kind = 'automatic',
         merge_target = ?, integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND merge_requested_at IS NULL
           AND automation_policy_hash = ? AND automation_base_sha = ?
           AND integration_state = 'ready_to_finalize'
           AND integration_head_sha = ?`
      )
      .run(
        now,
        target,
        now,
        now,
        current.id,
        policyHash,
        current.automation_base_sha,
        current.integration_head_sha
      );
    if (changed.changes !== 1) {
      throw new Error("automatic merge request CAS changed");
    }
    createEvent(
      deps.db,
      current.id,
      "automatic_merge_requested",
      {
        target,
        policyHash,
        baseSha: current.automation_base_sha,
        integrationHeadSha: current.integration_head_sha,
        executionHash: exact.executionHash,
      },
      { controlPlane: true }
    );
    return true;
  });
}

function consumeManualMergeIntent(
  deps: FleetMergeRuntimeDeps,
  runId: string
): boolean {
  return transaction(deps.db, () => {
    const exact = exactApprovedFleetExecution(deps.db, runId);
    if (!exact) return false;
    const current = exact.run;
    if (
      current.merge_requested_at !== null ||
      current.merge_request_kind !== "manual" ||
      (current.merge_target !== "local" &&
        current.merge_target !== "github_pr") ||
      !current.merge_requested_by ||
      (current.desired_state ?? "running") !== "running" ||
      !["running", "reviewing", "merging"].includes(current.status) ||
      current.recovery_required === 1 ||
      current.integration_state !== "ready_to_finalize" ||
      !validSha(current.automation_base_sha) ||
      current.integration_base_sha !== current.automation_base_sha ||
      !validSha(current.integration_head_sha)
    ) {
      return false;
    }
    const verified = deps.db
      .prepare(
        `SELECT 1
         FROM fleet_merge_operations operation
         JOIN fleet_artifacts artifact ON artifact.id = operation.output_artifact_id
         WHERE operation.fleet_run_id = ?
           AND operation.operation_type = 'final_verify'
           AND operation.state = 'completed'
           AND operation.expected_base_sha = ?
           AND operation.result_head_sha = ?
           AND operation.verification_output_hash IS NOT NULL
           AND artifact.fleet_run_id = operation.fleet_run_id
           AND artifact.artifact_type = 'fleet_final_verification'
           AND artifact.head_sha = operation.result_head_sha
           AND artifact.content_hash = operation.verification_output_hash
         ORDER BY operation.created_at DESC LIMIT 1`
      )
      .get(
        current.id,
        current.integration_head_sha,
        current.integration_head_sha
      );
    if (!verified) return false;
    const now = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET merge_requested_at = ?,
         integration_error = NULL, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND merge_requested_at IS NULL
           AND merge_request_kind = 'manual' AND merge_target = ?
           AND merge_requested_by = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0
           AND approval_state = 'approved'
           AND plan_hash = ? AND approved_plan_hash = ?
           AND automation_base_sha = ? AND integration_base_sha = ?
           AND integration_state = 'ready_to_finalize'
           AND integration_head_sha = ?`
      )
      .run(
        now,
        now,
        now,
        current.id,
        current.merge_target,
        current.merge_requested_by,
        current.plan_hash,
        current.plan_hash,
        current.automation_base_sha,
        current.automation_base_sha,
        current.integration_head_sha
      );
    if (changed.changes !== 1) return false;
    createEvent(
      deps.db,
      current.id,
      "manual_merge_landing_authorized",
      {
        target: current.merge_target,
        actor: current.merge_requested_by,
        planHash: current.plan_hash,
        executionHash: exact.executionHash,
        baseSha: current.automation_base_sha,
        integrationHeadSha: current.integration_head_sha,
      },
      { controlPlane: true }
    );
    return true;
  });
}

interface FleetMergeRequestPreconditions {
  planHash: string;
  executionHash?: string;
  baseSha: string | null;
  integrationHeadSha: string | null;
}

function mergeRequestPreconditionsMatch(
  db: Database.Database,
  run: FleetMergeRunRow,
  expected: FleetMergeRequestPreconditions
): boolean {
  if (
    run.plan_hash !== expected.planHash ||
    run.automation_base_sha !== expected.baseSha ||
    run.integration_head_sha !== expected.integrationHeadSha
  ) {
    return false;
  }
  if (expected.executionHash === undefined) return true;
  const exact = exactApprovedFleetExecution(db, run.id);
  return (
    exact !== null &&
    exact.run.plan_hash === expected.planHash &&
    exact.run.automation_base_sha === expected.baseSha &&
    exact.run.integration_head_sha === expected.integrationHeadSha &&
    exact.executionHash === expected.executionHash
  );
}

function reopenFailedManualFinalVerification(
  deps: FleetMergeRuntimeDeps,
  runId: string,
  target: FleetMergeTarget,
  actor: string,
  expected: FleetMergeRequestPreconditions | undefined
): { reopened: true } | { error: string } {
  return transaction(deps.db, () => {
    const retry = inspectManualFinalVerificationRetry(deps.db, runId);
    if (!retry.available || !retry.operationId || !retry.preconditions) {
      return {
        error: retry.reason ?? "Final verification is not available for retry",
      };
    }
    if (
      !expected ||
      expected.planHash !== retry.preconditions.planHash ||
      expected.executionHash !== retry.preconditions.executionHash ||
      expected.baseSha !== retry.preconditions.baseSha ||
      expected.integrationHeadSha !== retry.preconditions.integrationHeadSha
    ) {
      return { error: "Fleet merge retry preconditions changed" };
    }

    const now = deps.now().toISOString();
    const operation = deps.db
      .prepare(
        `UPDATE fleet_merge_operations
         SET state = 'waiting', result_head_sha = NULL,
             verification_output_hash = NULL, output_artifact_id = NULL,
             lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL,
             error = 'operator requested exact final verification retry',
             updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND task_id IS NULL
           AND operation_type = 'final_verify' AND state = 'failed'
           AND expected_base_sha = ? AND expected_task_head_sha IS NULL
           AND result_head_sha IS NULL AND verification_output_hash IS NULL
           AND lease_owner IS NULL AND lease_expires_at IS NULL
           AND attempt_count = ? AND attempt_count < ?`
      )
      .run(
        now,
        retry.operationId,
        runId,
        retry.preconditions.integrationHeadSha,
        retry.attemptCount,
        FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS
      );
    if (operation.changes !== 1) {
      throw new Error("Fleet final verification retry operation changed");
    }
    const run = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'integrating',
         integration_error = NULL, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND merge_requested_at IS NULL
           AND merge_request_kind = 'manual' AND merge_target = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0
           AND integration_state IN ('failed','awaiting_operator')
           AND approval_state = 'approved'
           AND plan_hash = ? AND approved_plan_hash = ?
           AND automation_base_sha = ? AND integration_base_sha = ?
           AND integration_head_sha = ?`
      )
      .run(
        now,
        now,
        runId,
        target,
        retry.preconditions.planHash,
        retry.preconditions.planHash,
        retry.preconditions.baseSha,
        retry.preconditions.baseSha,
        retry.preconditions.integrationHeadSha
      );
    if (run.changes !== 1) {
      throw new Error("Fleet final verification retry run changed");
    }
    createEvent(
      deps.db,
      runId,
      "manual_final_verification_retry_requested",
      {
        target,
        actor: actor.trim().slice(0, 80) || "operator",
        operationId: retry.operationId,
        attempt: retry.attemptCount + 1,
        planHash: retry.preconditions.planHash,
        executionHash: retry.preconditions.executionHash,
        baseSha: retry.preconditions.baseSha,
        integrationHeadSha: retry.preconditions.integrationHeadSha,
      },
      { controlPlane: true }
    );
    return { reopened: true };
  });
}

export async function requestFleetMerge(
  runId: string,
  target: FleetMergeTarget,
  actor = "operator",
  overrides: Partial<FleetMergeRuntimeDeps> = {},
  expected?: FleetMergeRequestPreconditions
): Promise<
  { readiness: FleetMergeReadiness } | { error: string; status?: number }
> {
  const deps = runtimeDeps(overrides);
  const recoveryBlocked = fleetLaunchBlockedResult(deps.db, runId);
  if (recoveryBlocked) return recoveryBlocked;
  if (target !== "local" && target !== "github_pr") {
    return { error: "merge target must be local or github_pr" };
  }
  const run = queries.getFleetRun(deps.db).get(runId) as
    FleetMergeRunRow | undefined;
  if (!run) return { error: "Fleet run not found" };
  if (expected && !mergeRequestPreconditionsMatch(deps.db, run, expected)) {
    return { error: "Fleet merge request preconditions changed" };
  }
  if (["completed", "failed", "canceled"].includes(run.status)) {
    return { error: `Fleet run cannot merge from ${run.status}` };
  }
  const existingManualIntent =
    run.merge_request_kind === "manual" && run.merge_target
      ? run.merge_target
      : null;
  if (run.merge_requested_at) {
    if (run.merge_target !== target) {
      return { error: "Fleet merge target is already durably bound" };
    }
    const readiness = inspectFleetMergeReadiness(deps.db, runId);
    return readiness ? { readiness } : { error: "Fleet run not found" };
  }
  if (existingManualIntent) {
    if (existingManualIntent !== target) {
      return { error: "Fleet merge target is already durably bound" };
    }
    const finalVerificationRetry = inspectManualFinalVerificationRetry(
      deps.db,
      runId
    );
    if (finalVerificationRetry.action === "retry_final_verification") {
      try {
        const reopened = reopenFailedManualFinalVerification(
          deps,
          runId,
          target,
          actor,
          expected
        );
        if ("error" in reopened) return reopened;
      } catch (error) {
        return { error: boundedError(error) };
      }
      const readiness = inspectFleetMergeReadiness(deps.db, runId);
      return readiness ? { readiness } : { error: "Fleet run not found" };
    }
    if (["failed", "awaiting_operator"].includes(run.integration_state)) {
      const now = deps.now().toISOString();
      transaction(deps.db, () => {
        const changed = deps.db
          .prepare(
            `UPDATE fleet_runs SET integration_state = CASE
               WHEN integration_worktree IS NULL THEN 'idle' ELSE 'integrating' END,
             integration_error = NULL, integration_updated_at = ?, updated_at = ?
             WHERE id = ? AND merge_requested_at IS NULL
               AND merge_request_kind = 'manual' AND merge_target = ?
               AND integration_state = ?
               AND status NOT IN ('completed','failed','canceled')`
          )
          .run(now, now, runId, target, run.integration_state);
        if (changed.changes === 1) {
          createEvent(
            deps.db,
            runId,
            "manual_merge_staging_retry_requested",
            { target, actor: actor.trim().slice(0, 80) || "operator" },
            { controlPlane: true }
          );
        }
      });
    }
    const readiness = inspectFleetMergeReadiness(deps.db, runId);
    return readiness ? { readiness } : { error: "Fleet run not found" };
  }
  if (
    run.approval_state !== "approved" ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash
  ) {
    return { error: "Fleet run does not have an exact approved plan" };
  }
  const tasks = queries
    .listFleetTasksForRun(deps.db)
    .all(runId) as FleetTaskRow[];
  const targetInfo = resolveFleetMergeTarget(deps.db, run, tasks);
  if (!targetInfo)
    return { error: "Fleet run has no source repository checkout" };
  if (target === "github_pr" && !targetInfo.repoSlug) {
    return { error: "github_pr merge requires a registered GitHub repository" };
  }
  let baseSha = run.automation_base_sha;
  try {
    if (!validSha(baseSha)) {
      baseSha = await gitSha(deps, targetInfo.repoPath, targetInfo.baseBranch);
    }
  } catch (error) {
    return { error: boundedError(error) };
  }
  const now = deps.now().toISOString();
  const safeActor = actor.trim().slice(0, 80) || "operator";
  const snapshotPlanHash = run.plan_hash;
  const snapshotBaseSha = run.automation_base_sha;
  const snapshotIntegrationHeadSha = run.integration_head_sha;
  try {
    transaction(deps.db, () => {
      if (expected) {
        const current = queries.getFleetRun(deps.db).get(runId) as
          FleetMergeRunRow | undefined;
        if (
          !current ||
          !mergeRequestPreconditionsMatch(deps.db, current, expected)
        ) {
          throw new Error("Fleet merge request preconditions changed");
        }
      }
      const changed = deps.db
        .prepare(
          `UPDATE fleet_runs SET automation_base_sha = COALESCE(automation_base_sha, ?),
           merge_requested_at = NULL, merge_requested_by = ?,
           merge_request_kind = 'manual', merge_target = ?,
           integration_error = NULL,
           integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND merge_requested_at IS NULL
             AND merge_request_kind IS NULL AND merge_target IS NULL
             AND approval_state = 'approved' AND approved_plan_hash = plan_hash
             AND plan_hash IS ? AND automation_base_sha IS ?
             AND integration_head_sha IS ?`
        )
        .run(
          baseSha,
          safeActor,
          target,
          now,
          now,
          runId,
          snapshotPlanHash,
          snapshotBaseSha,
          snapshotIntegrationHeadSha
        );
      if (changed.changes !== 1) throw new Error("Fleet merge request changed");
      createEvent(
        deps.db,
        runId,
        "manual_merge_requested",
        {
          phase: "staging",
          target,
          baseSha,
          actor: safeActor,
          expectedPlanHash: snapshotPlanHash,
          expectedBaseSha: snapshotBaseSha,
          expectedIntegrationHeadSha: snapshotIntegrationHeadSha,
        },
        { controlPlane: true }
      );
    });
  } catch (error) {
    return { error: boundedError(error) };
  }
  const readiness = inspectFleetMergeReadiness(deps.db, runId);
  return readiness ? { readiness } : { error: "Fleet run not found" };
}

function normalizedIntegrationPath(value: string): string {
  const normalized = resolve(expandHome(value)).replace(/\\/g, "/");
  return isWindows ? normalized.toLowerCase() : normalized;
}

function hasExactDestructiveIntegrationAuthorization(
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): boolean {
  try {
    const settings = JSON.parse(run.settings_json) as Record<string, unknown>;
    const raw = settings.destructiveCancellation;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const authorization = raw as Record<string, unknown>;
    const value = authorization.integrationTarget;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const integration = value as Record<string, unknown>;
    return (
      integration.worktreePath === run.integration_worktree &&
      integration.branchName === run.integration_branch &&
      integration.expectedHeadSha === run.integration_head_sha &&
      typeof integration.projectPath === "string" &&
      normalizedIntegrationPath(integration.projectPath) ===
        normalizedIntegrationPath(target.repoPath)
    );
  } catch {
    return false;
  }
}

async function cleanupTerminalIntegration(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<void> {
  const terminalStatus = run.status;
  if (terminalStatus !== "completed" && terminalStatus !== "canceled") {
    releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
    return;
  }
  if (
    terminalStatus === "canceled" &&
    run.cancel_mode !== "cancel-and-clean-owned-worktrees"
  ) {
    releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
    return;
  }
  if (run.integration_state === "cleanup_complete") {
    releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
    return;
  }
  const expected = fleetIntegrationIdentity(run.id);
  if (!run.integration_branch && !run.integration_worktree) {
    const finishedAt = deps.now();
    transaction(deps.db, () => {
      deps.db
        .prepare(
          `UPDATE fleet_runs SET integration_state = 'cleanup_complete',
           integration_error = NULL, integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND status = ?`
        )
        .run(
          finishedAt.toISOString(),
          finishedAt.toISOString(),
          run.id,
          terminalStatus
        );
      releaseIntegrationWorkspaceResources(deps, run.id, finishedAt);
    });
    return;
  }
  if (
    terminalStatus === "canceled" &&
    !hasExactDestructiveIntegrationAuthorization(run, target)
  ) {
    const now = deps.now();
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
         integration_error = ?, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = 'canceled'`
      )
      .run(
        "refusing integration cleanup without exact destructive confirmation",
        now.toISOString(),
        now.toISOString(),
        run.id
      );
    releaseIntegrationWorkspaceResources(deps, run.id, now);
    return;
  }
  if (
    run.integration_branch !== expected.branch ||
    run.integration_worktree !== expected.worktree
  ) {
    const now = deps.now();
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
         integration_error = ?, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`
      )
      .run(
        "refusing cleanup of a non-Fleet integration workspace",
        now.toISOString(),
        now.toISOString(),
        run.id,
        terminalStatus
      );
    releaseIntegrationWorkspaceResources(deps, run.id, now);
    return;
  }
  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
       integration_updated_at = ?, updated_at = ?
       WHERE id = ? AND status = ?
         AND integration_state <> 'cleanup_complete'`
    )
    .run(now, now, run.id, terminalStatus);
  try {
    const branchResult = await deps.git(
      target.repoPath,
      [
        "for-each-ref",
        "--format=%(objectname)",
        "--count=2",
        `refs/heads/${expected.branch}`,
      ],
      15_000,
      4096
    );
    const branchHeads = branchResult.stdout
      .split(/\r?\n/)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (branchHeads.length > 1 || branchHeads.some((head) => !validSha(head))) {
      throw new Error("Fleet integration branch lookup was invalid");
    }
    const branchHead = branchHeads[0] ?? null;
    const worktreeExists = await deps.pathExists(expected.worktree);
    if ((branchHead || worktreeExists) && !validSha(run.integration_head_sha)) {
      throw new Error("Fleet integration cleanup has no exact expected head");
    }
    if (branchHead && branchHead !== run.integration_head_sha) {
      throw new Error(
        "refusing cleanup of a Fleet integration branch at an unexpected head"
      );
    }
    if (worktreeExists) {
      const worktreeHead = await gitSha(deps, expected.worktree);
      if (worktreeHead !== run.integration_head_sha) {
        throw new Error(
          "refusing cleanup of a Fleet integration worktree at an unexpected head"
        );
      }
      if (!(await gitClean(deps, expected.worktree))) {
        throw new Error(
          "refusing cleanup of a dirty Fleet integration worktree"
        );
      }
      await deps.removeWorktree(expected.worktree, target.repoPath, false);
    }
    if (branchHead) {
      await deps.git(
        target.repoPath,
        ["branch", "-D", "--", expected.branch],
        30_000,
        4096
      );
      const remaining = await deps.git(
        target.repoPath,
        [
          "for-each-ref",
          "--format=%(objectname)",
          "--count=1",
          `refs/heads/${expected.branch}`,
        ],
        15_000,
        4096
      );
      if (remaining.stdout.trim()) {
        throw new Error("Fleet integration branch cleanup was not confirmed");
      }
    }
    transaction(deps.db, () => {
      const finishedAt = deps.now();
      const changed = deps.db
        .prepare(
          `UPDATE fleet_runs SET integration_state = 'cleanup_complete',
           integration_error = NULL, integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND status = ?
             AND integration_branch = ? AND integration_worktree = ?`
        )
        .run(
          finishedAt.toISOString(),
          finishedAt.toISOString(),
          run.id,
          terminalStatus,
          expected.branch,
          expected.worktree
        );
      if (changed.changes !== 1) {
        throw new Error("Fleet integration cleanup CAS changed");
      }
      releaseIntegrationWorkspaceResources(deps, run.id, finishedAt);
      createEvent(
        deps.db,
        run.id,
        "integration_workspace_cleaned",
        {
          worktree: expected.worktree,
          branch: expected.branch,
          terminalStatus,
        },
        { controlPlane: true }
      );
    });
  } catch (error) {
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
         integration_error = ?, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = ?`
      )
      .run(
        boundedError(error),
        deps.now().toISOString(),
        deps.now().toISOString(),
        run.id,
        terminalStatus
      );
    if (terminalStatus === "canceled") {
      releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
    }
  }
}

const mergeLocks = new Set<string>();

async function reconcileOneMerge(
  deps: FleetMergeRuntimeDeps,
  initial: FleetMergeRunRow
): Promise<void> {
  if (mergeLocks.has(initial.id)) return;
  mergeLocks.add(initial.id);
  try {
    let run = queries.getFleetRun(deps.db).get(initial.id) as
      FleetMergeRunRow | undefined;
    if (!run) return;
    if (run.status === "failed") {
      releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
      return;
    }
    if (
      run.status === "canceled" &&
      run.cancel_mode !== "cancel-and-clean-owned-worktrees"
    ) {
      releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
      return;
    }
    const tasks = queries
      .listFleetTasksForRun(deps.db)
      .all(run.id) as FleetTaskRow[];
    const target = resolveFleetMergeTarget(deps.db, run, tasks);
    if (!target) {
      if (run.status === "canceled") {
        releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
        deps.db
          .prepare(
            `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
             integration_error = ?, integration_updated_at = ?, updated_at = ?
             WHERE id = ? AND status = 'canceled'`
          )
          .run(
            "Fleet source repository is unavailable for exact integration cleanup",
            deps.now().toISOString(),
            deps.now().toISOString(),
            run.id
          );
        return;
      }
      setRunError(
        deps.db,
        run.id,
        "awaiting_operator",
        new Error("Fleet source repository is unavailable"),
        deps.now().toISOString()
      );
      return;
    }
    if (run.status === "canceled") {
      await cleanupTerminalIntegration(deps, run, target);
      return;
    }
    if (
      run.status === "completed" &&
      ["completed", "cleanup_pending"].includes(run.integration_state)
    ) {
      await cleanupTerminalIntegration(deps, run, target);
      return;
    }
    if (run.status === "completed") {
      releaseIntegrationWorkspaceResources(deps, run.id, deps.now());
      return;
    }
    if (
      run.recovery_required === 1 ||
      (run.desired_state ?? "running") !== "running" ||
      !["running", "reviewing", "merging"].includes(run.status)
    ) {
      return;
    }
    const manualTarget =
      !run.merge_requested_at && run.merge_request_kind === "manual"
        ? run.merge_target
        : null;
    const automatic =
      run.merge_requested_at || manualTarget
        ? null
        : autoMergeEligible(deps.db, run.id);
    const mergeTarget = run.merge_requested_at
      ? run.merge_target
      : (manualTarget ?? automatic?.target);
    if (!mergeTarget) return;
    if (run.integration_state === "failed") return;
    if (mergeTarget === "github_pr" && !target.repoSlug) {
      setRunError(
        deps.db,
        run.id,
        "awaiting_operator",
        new Error("GitHub merge requires a registered repository slug"),
        deps.now().toISOString()
      );
      return;
    }

    let readiness = inspectFleetMergeReadiness(deps.db, run.id);
    if (!readiness) return;
    if (readiness.readyTaskIds.length === 0 && !readiness.allTasksIntegrated) {
      return;
    }
    try {
      run = await ensureIntegrationWorkspace(deps, run, target);
    } catch (error) {
      setRunError(
        deps.db,
        run.id,
        "awaiting_operator",
        error,
        deps.now().toISOString()
      );
      return;
    }
    readiness = inspectFleetMergeReadiness(deps.db, run.id);
    if (!readiness) return;
    if (readiness.readyTaskIds.length > 0) {
      const candidates = queries
        .listFleetTasksForRun(deps.db)
        .all(run.id) as FleetTaskRow[];
      const task = candidates.find((item) =>
        readiness?.readyTaskIds.includes(item.id)
      );
      if (task) await integrateTask(deps, run, task);
      return;
    }
    if (!readiness.canFinalize) return;

    const finalVerification = deps.db
      .prepare(
        `SELECT state FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND operation_type = 'final_verify'
           AND expected_base_sha = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(run.id, run.integration_head_sha) as { state: string } | undefined;
    if (finalVerification?.state !== "completed") {
      await runFinalVerification(deps, run);
      return;
    }
    run = queries.getFleetRun(deps.db).get(run.id) as FleetMergeRunRow;
    if (!run.merge_requested_at) {
      if (run.merge_request_kind === "manual") {
        consumeManualMergeIntent(deps, run.id);
      } else {
        const eligible = autoMergeEligible(deps.db, run.id);
        if (eligible) {
          consumeAutomaticMergeAuthorization(
            deps,
            eligible.run,
            eligible.target,
            eligible.policyHash
          );
        }
      }
      return;
    }
    if (run.merge_target === "local") {
      await finalizeLocal(deps, run, target);
      return;
    }
    if (run.merge_target !== "github_pr") return;
    const push = deps.db
      .prepare(
        `SELECT state FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND operation_type = 'github_push'
           AND expected_base_sha = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(run.id, run.integration_head_sha) as { state: string } | undefined;
    if (push?.state !== "completed") {
      await ensureGitHubPush(deps, run, target);
      return;
    }
    const pr = deps.db
      .prepare(
        `SELECT state FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND operation_type = 'github_pr'
           AND expected_base_sha = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(run.id, run.integration_head_sha) as { state: string } | undefined;
    if (pr?.state !== "completed") {
      await ensureGitHubPr(deps, run, target);
      return;
    }
    run = queries.getFleetRun(deps.db).get(run.id) as FleetMergeRunRow;
    await finalizeGitHub(deps, run, target);
  } finally {
    mergeLocks.delete(initial.id);
  }
}

/**
 * Restart-safe merge reconciler. Each run advances at most one durable external
 * operation per call; frequent server ticks make progress while keeping the
 * crash/retry boundary small and observable.
 */
export async function reconcileFleetMerges(
  overrides: Partial<FleetMergeRuntimeDeps> = {},
  onlyRunId?: string
): Promise<void> {
  const deps = runtimeDeps(overrides);
  const launchBlocked = fleetRecoveryUnavailable(deps.db, onlyRunId);
  const automaticCandidates = deps.db
    .prepare(
      `SELECT * FROM fleet_runs
       WHERE merge_requested_at IS NULL
         AND merge_request_kind IS NULL
         AND status NOT IN ('completed','failed','canceled')
         AND desired_state = 'running' AND recovery_required = 0
         AND automation_policy_hash IS NOT NULL
       ORDER BY updated_at ASC, id ASC LIMIT ?`
    )
    .all(FLEET_MERGE_LIMIT) as FleetMergeRunRow[];
  const requestedCandidates = onlyRunId
    ? ([queries.getFleetRun(deps.db).get(onlyRunId)].filter(
        Boolean
      ) as FleetMergeRunRow[])
    : (deps.db
        .prepare(
          `SELECT * FROM fleet_runs
           WHERE (
             (merge_requested_at IS NOT NULL
               AND status NOT IN ('completed','failed','canceled')
               AND desired_state = 'running' AND recovery_required = 0
               AND integration_state <> 'cleanup_complete') OR
             (merge_requested_at IS NULL
               AND merge_request_kind = 'manual'
               AND merge_target IN ('local','github_pr')
               AND status NOT IN ('completed','failed','canceled')
               AND desired_state = 'running' AND recovery_required = 0
               AND integration_state <> 'cleanup_complete') OR
             (status = 'completed'
               AND integration_state IN ('completed','cleanup_pending')) OR
             (status = 'canceled'
               AND cancel_mode = 'cancel-and-clean-owned-worktrees'
               AND integration_state <> 'cleanup_complete'
               AND (integration_worktree IS NOT NULL OR EXISTS (
                 SELECT 1 FROM fleet_runtime_leases lease
                 WHERE lease.owner_type = 'integration_workspace'
                   AND lease.owner_id = fleet_runs.id
                   AND lease.status = 'reserved'
               ))) OR
             (status IN ('failed','canceled') AND EXISTS (
               SELECT 1 FROM fleet_runtime_leases lease
               WHERE lease.owner_type = 'integration_workspace'
                 AND lease.owner_id = fleet_runs.id
                 AND lease.status = 'reserved'
             ))
           )
           ORDER BY updated_at ASC, id ASC LIMIT ?`
        )
        .all(FLEET_MERGE_LIMIT) as FleetMergeRunRow[]);
  const candidates = new Map<string, FleetMergeRunRow>();
  for (const run of launchBlocked ? [] : automaticCandidates) {
    if (onlyRunId && run.id !== onlyRunId) continue;
    const eligible = autoMergeEligible(deps.db, run.id);
    if (eligible) candidates.set(run.id, eligible.run);
  }
  for (const run of requestedCandidates) {
    if (
      !launchBlocked ||
      ["completed", "failed", "canceled"].includes(run.status)
    ) {
      candidates.set(run.id, run);
    }
  }
  for (const run of candidates.values()) {
    await reconcileOneMerge(deps, run);
  }
}

export const __fleetMergeTesting = {
  runtimeDeps,
  ensureOperation,
  claimOperation,
  finishOperation,
  integrateTask,
  runFinalVerification,
  consumeAutomaticMergeAuthorization,
  consumeManualMergeIntent,
  finalizeLocal,
  ensureGitHubPush,
  ensureGitHubPr,
  finalizeGitHub,
};
