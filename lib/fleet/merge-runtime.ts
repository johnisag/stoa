import { createHash, randomUUID } from "crypto";
import { mkdir, stat } from "fs/promises";
import { dirname } from "path";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { mergePR } from "@/lib/dispatch/merge";
import { runGit } from "@/lib/git";
import { expandHome, resolveBinary } from "@/lib/platform";
import { runVerify, type VerifyResult } from "@/lib/verification/runner";
import { execFile } from "child_process";
import { promisify } from "util";
import { deleteWorktree } from "@/lib/worktrees";
import { hashFleetAutomationPolicy, hashFleetTaskRows } from "./hash";
import { parseFleetAutomationPolicy } from "./automation-policy";
import type {
  FleetMergeOperationRow,
  FleetMergeOperationType,
  FleetMergeTarget,
  FleetTaskDependencyRow,
  FleetTaskRow,
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
  getFleetMergeStatus,
  inspectFleetMergeReadiness,
  resolveFleetMergeTarget,
  type FleetMergeReadiness,
  type FleetMergeRunRow,
  type FleetMergeTargetInfo,
} from "./merge-readiness";

export {
  buildFleetPrCreateArgs,
  buildFleetPrViewArgs,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
  summarizeGitHubChecks,
} from "./merge-contract";
export {
  FLEET_MERGE_REVIEW_LENSES,
  getFleetMergeStatus,
  inspectFleetMergeReadiness,
} from "./merge-readiness";
export type { FleetMergeReadiness, FleetMergeStatus } from "./merge-readiness";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const FLEET_MERGE_LEASE_MS = 15 * 60 * 1000;
const FLEET_MERGE_LIMIT = 20;
const FLEET_MERGE_ARTIFACT_MAX = 16_000;

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
  return value.slice(0, 1000);
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validSha(value: string | null | undefined): value is string {
  return typeof value === "string" && FULL_GIT_SHA.test(value);
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
  payload: unknown
): void {
  queries
    .createFleetEvent(db)
    .run(runId, type, "fleet-merge", JSON.stringify(payload));
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
): string {
  const id = deps.id();
  const body =
    input.body.length > FLEET_MERGE_ARTIFACT_MAX
      ? `…(truncated)…\n${input.body.slice(-FLEET_MERGE_ARTIFACT_MAX)}`
      : input.body;
  const metadata = JSON.stringify(input.metadata ?? {});
  deps.db
    .prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, task_id, plan_hash, base_sha, head_sha, content_hash,
        metadata_json, byte_count, artifact_type, title, body, severity, actor,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fleet-merge', ?)`
    )
    .run(
      id,
      input.run.id,
      input.taskId ?? null,
      input.run.approved_plan_hash,
      input.baseSha,
      input.headSha,
      hash(body),
      metadata,
      Buffer.byteLength(body, "utf8"),
      input.type,
      input.title,
      body,
      input.severity,
      deps.now().toISOString()
    );
  return id;
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
    return deps.db
      .prepare(`SELECT * FROM fleet_merge_operations WHERE id = ?`)
      .get(id) as FleetMergeOperationRow;
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
  const now = deps.now().toISOString();
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
      input.error?.slice(0, 1000) ?? null,
      now,
      input.state,
      now,
      operation.id,
      deps.leaseOwner
    );
  return changed.changes === 1;
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

  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN 'initializing' ELSE integration_state END,
       integration_branch = ?, integration_worktree = ?, integration_base_sha = ?,
       integration_head_sha = COALESCE(integration_head_sha, ?),
       integration_error = NULL, integration_updated_at = ?, updated_at = ?
       WHERE id = ? AND merge_requested_at IS NOT NULL
         AND (integration_base_sha IS NULL OR integration_base_sha = ?)`
    )
    .run(branch, worktree, baseSha, baseSha, now, now, run.id, baseSha);

  if (!(await deps.pathExists(worktree))) {
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
    deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET state = 'pending', lease_owner = NULL,
         lease_expires_at = NULL, error = 'recovered interrupted merge',
         updated_at = ? WHERE id = ? AND state = 'running'`
      )
      .run(now, interrupted.id);
  }
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = CASE
         WHEN integration_state IN ('idle','initializing','integrating')
           THEN 'integrating' ELSE integration_state END,
       integration_head_sha = CASE WHEN ? THEN integration_head_sha ELSE ? END,
       integration_error = NULL,
       integration_updated_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(recoveringOperation ? 1 : 0, head, now, now, run.id);
  createEvent(deps.db, run.id, "integration_workspace_ready", {
    branch,
    worktree,
    baseSha,
    headSha: recoveringOperation ? run.integration_head_sha : head,
    recoveringOperation,
  });
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
  try {
    await deps.git(cwd, ["merge", "--abort"], 30_000);
  } catch {
    // A conflict can fail before MERGE_HEAD exists. The workspace is Fleet-owned,
    // so restoring its durably recorded pre-operation head is safe and scoped.
    await deps.git(cwd, ["reset", "--hard", expectedHead], 30_000);
  }
  const restored = await gitSha(deps, cwd);
  if (restored !== expectedHead || !(await gitClean(deps, cwd))) {
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
    deps.db
      .prepare(
        `UPDATE fleet_tasks SET status = 'needs_inspection',
         integration_state = 'failed', integration_operation_id = ?,
         failure_code = 'integration_failed', updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND head_sha = ?`
      )
      .run(operation.id, now, task.id, run.id, task.head_sha);
    setRunError(deps.db, run.id, "awaiting_operator", error, now);
    createEvent(deps.db, run.id, "task_integration_failed", {
      taskId: task.id,
      operationId: operation.id,
      error: boundedError(error),
    });
  });
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
    // upstream. base_branch remains the human-readable Fleet integration branch;
    // the scheduler prefers base_sha when preparing the attempt.
    deps.db
      .prepare(
        `UPDATE fleet_tasks SET base_branch = ?, base_sha = ?, updated_at = ?
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
      .run(run.integration_branch, resultHead, now, run.id, task.id);
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
  try {
    const currentIntegrationHead = await gitSha(deps, run.integration_worktree);
    const alreadyApplied = await isAncestor(
      deps,
      run.integration_worktree,
      task.head_sha,
      currentIntegrationHead
    );
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

    let mergeApplied = alreadyApplied;
    if (!alreadyApplied) {
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET integration_state = 'integrating',
           integration_operation_id = ?, updated_at = ?
           WHERE id = ? AND status = 'ready_to_merge' AND head_sha = ?`
        )
        .run(claimed.id, deps.now().toISOString(), task.id, task.head_sha);
      try {
        await deps.git(
          run.integration_worktree,
          ["merge", "--no-ff", "--no-commit", task.head_sha],
          120_000
        );
        mergeApplied = true;
      } catch (error) {
        await abortMerge(
          deps,
          run.integration_worktree,
          operation.expected_base_sha
        );
        throw new Error(`task merge conflict: ${boundedError(error)}`);
      }
    }

    const verification = await deps.verify(run.integration_worktree, command);
    const verificationBody = JSON.stringify(
      {
        taskId: task.id,
        taskHeadSha: task.head_sha,
        integrationBaseSha: operation.expected_base_sha,
        command,
        status: verification.status,
        output: verification.output,
      },
      null,
      2
    );
    artifactId = insertArtifact(deps, {
      run,
      taskId: task.id,
      baseSha: operation.expected_base_sha,
      headSha: task.head_sha,
      type: "fleet_integration_verification",
      title: `Integration verification: ${task.title}`,
      body: verificationBody,
      severity: verification.status === "pass" ? "info" : "blocker",
      metadata: {
        operationId: claimed.id,
        command,
        status: verification.status,
      },
    });
    if (verification.status !== "pass") {
      if (!alreadyApplied && mergeApplied) {
        await abortMerge(
          deps,
          run.integration_worktree,
          operation.expected_base_sha
        );
      }
      throw new Error(`integration verification ${verification.status}`);
    }

    if (!alreadyApplied) {
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
    const resultHead = await gitSha(deps, run.integration_worktree);
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
    persistIntegratedTask(
      deps,
      run,
      task,
      claimed,
      resultHead,
      artifactId,
      hash(verificationBody)
    );
    return true;
  } catch (error) {
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
  try {
    if (
      (await gitSha(deps, run.integration_worktree)) !==
      run.integration_head_sha
    ) {
      throw new Error("integration head changed before final verification");
    }
    if (!(await gitClean(deps, run.integration_worktree))) {
      throw new Error(
        "integration worktree is dirty before final verification"
      );
    }
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'final_verifying',
         status = 'merging', integration_updated_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    const results: { command: string; status: string; output: string }[] = [];
    for (const command of commands) {
      renewOperationLease(deps, claimed);
      const result = await deps.verify(run.integration_worktree, command);
      results.push({ command, status: result.status, output: result.output });
      if (result.status !== "pass") break;
    }
    const passed =
      results.length === commands.length &&
      results.every((result) => result.status === "pass");
    const body = JSON.stringify(
      {
        integrationHeadSha: run.integration_head_sha,
        commands,
        results,
      },
      null,
      2
    );
    artifactId = insertArtifact(deps, {
      run,
      baseSha: run.integration_base_sha ?? run.integration_head_sha,
      headSha: run.integration_head_sha,
      type: "fleet_final_verification",
      title: "Final combined-head verification",
      body,
      severity: passed ? "info" : "blocker",
      metadata: { operationId: claimed.id, passed, commands },
    });
    if (!passed) throw new Error("final combined-head verification failed");
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
          hash(body),
          artifactId,
          now,
          now,
          claimed.id,
          deps.leaseOwner
        );
      if (op.changes !== 1) throw new Error("final verification lease changed");
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
): void {
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
    createEvent(deps.db, run.id, "fleet_merge_completed", {
      target: run.merge_target,
      integrationHeadSha: run.integration_head_sha,
      mergeSha,
      pr: pr ?? null,
      operationId: operation.id,
    });
  });
}

async function finalizeLocal(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !validSha(run.integration_base_sha) ||
    !validSha(run.integration_head_sha) ||
    !run.integration_branch
  ) {
    throw new Error("local finalization contract is incomplete");
  }
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "local_finalize",
    target: "local",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  try {
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

async function ensureGitHubPush(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (!run.integration_branch || !validSha(run.integration_head_sha)) {
    throw new Error("GitHub push contract is incomplete");
  }
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_push",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  try {
    const remote = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch
    );
    if (remote && remote !== run.integration_head_sha) {
      throw new Error("remote integration branch exists at a different head");
    }
    if (!remote) {
      await deps.git(
        run.integration_worktree ?? target.repoPath,
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
    finishOperation(deps, claimed, {
      state: "completed",
      resultHeadSha: confirmed,
    });
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'pushing',
         integration_updated_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    return true;
  } catch (error) {
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
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_pr",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
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
    if (pr.headSha !== run.integration_head_sha) {
      throw new Error(
        "GitHub PR head differs from the verified integration head"
      );
    }
    if (pr.state !== "OPEN" && pr.state !== "MERGED") {
      throw new Error(`GitHub PR is not open (state ${pr.state ?? "unknown"})`);
    }
    const now = deps.now().toISOString();
    transaction(deps.db, () => {
      const finished = deps.db
        .prepare(
          `UPDATE fleet_merge_operations SET state = 'completed',
           result_head_sha = ?, error = NULL, lease_owner = NULL,
           lease_expires_at = NULL, completed_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND lease_owner = ?`
        )
        .run(pr?.headSha, now, now, claimed.id, deps.leaseOwner);
      if (finished.changes !== 1) throw new Error("GitHub PR lease changed");
      deps.db
        .prepare(
          `UPDATE fleet_runs SET integration_state = 'waiting_ci',
           integration_pr_number = ?, integration_pr_url = ?,
           integration_pr_head_sha = ?, integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND integration_head_sha = ?`
        )
        .run(
          pr?.number,
          pr?.url,
          pr?.headSha,
          now,
          now,
          run.id,
          run.integration_head_sha
        );
      createEvent(deps.db, run.id, "integration_pr_ready", {
        prNumber: pr?.number,
        prUrl: pr?.url,
        headSha: pr?.headSha,
      });
    });
    return true;
  } catch (error) {
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
  const operation = ensureOperation(deps, {
    runId: run.id,
    taskId: null,
    type: "github_merge",
    target: "github_pr",
    baseSha: run.integration_head_sha,
  });
  if (operation.state === "completed") return false;
  if (operation.state === "failed") return false;
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  try {
    let pr = await readFleetPr(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    if (!pr) throw new Error("GitHub PR status is unavailable");
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

function autoMergeEligible(
  db: Database.Database,
  run: FleetMergeRunRow
): { target: FleetMergeTarget; policyHash: string } | null {
  if (!run.automation_policy_hash || !run.automation_base_sha) return null;
  const parsed = parseFleetAutomationPolicy(run.automation_policy_json);
  if (
    !parsed.valid ||
    hashFleetAutomationPolicy(parsed.policy) !== run.automation_policy_hash ||
    !parsed.policy.automaticMerge ||
    !parsed.policy.automaticStart ||
    !parsed.policy.automaticFixes ||
    parsed.policy.maxAutomaticFixRounds < 1
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
        target: parsed.policy.mergeTarget,
        policyHash: run.automation_policy_hash,
      }
    : null;
}

function consumeAutomaticMergeAuthorization(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTarget,
  policyHash: string
): boolean {
  const tasks = queries
    .listFleetTasksForRun(deps.db)
    .all(run.id) as FleetTaskRow[];
  const dependencies = deps.db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskDependencyRow[];
  const executionHash = approvedExecutionHash(run);
  if (
    !executionHash ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash ||
    hashFleetTaskRows(tasks, dependencies) !== run.plan_hash
  ) {
    return false;
  }
  const now = deps.now().toISOString();
  return transaction(deps.db, () => {
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
        run.approved_plan_hash,
        executionHash,
        run.automation_base_sha,
        now,
        now,
        run.id,
        policyHash
      );
    if (authorization.changes !== 1) return false;
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET merge_requested_at = ?,
         merge_requested_by = 'fleet-automation', merge_request_kind = 'automatic',
         merge_target = ?, integration_state = 'idle', integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND merge_requested_at IS NULL
           AND automation_policy_hash = ? AND automation_base_sha = ?`
      )
      .run(now, target, now, now, run.id, policyHash, run.automation_base_sha);
    if (changed.changes !== 1) {
      throw new Error("automatic merge request CAS changed");
    }
    createEvent(deps.db, run.id, "automatic_merge_requested", {
      target,
      policyHash,
      baseSha: run.automation_base_sha,
      executionHash,
    });
    return true;
  });
}

export async function requestFleetMerge(
  runId: string,
  target: FleetMergeTarget,
  actor = "operator",
  overrides: Partial<FleetMergeRuntimeDeps> = {},
  expected?: {
    planHash: string;
    baseSha: string | null;
    integrationHeadSha: string | null;
  }
): Promise<{ readiness: FleetMergeReadiness } | { error: string }> {
  const deps = runtimeDeps(overrides);
  if (target !== "local" && target !== "github_pr") {
    return { error: "merge target must be local or github_pr" };
  }
  const run = queries.getFleetRun(deps.db).get(runId) as
    FleetMergeRunRow | undefined;
  if (!run) return { error: "Fleet run not found" };
  if (
    expected &&
    (run.plan_hash !== expected.planHash ||
      run.automation_base_sha !== expected.baseSha ||
      run.integration_head_sha !== expected.integrationHeadSha)
  ) {
    return { error: "Fleet merge request preconditions changed" };
  }
  if (["completed", "failed", "canceled"].includes(run.status)) {
    return { error: `Fleet run cannot merge from ${run.status}` };
  }
  if (
    run.approval_state !== "approved" ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash
  ) {
    return { error: "Fleet run does not have an exact approved plan" };
  }
  if (run.merge_requested_at) {
    if (run.merge_target !== target) {
      return { error: "Fleet merge target is already durably bound" };
    }
    const readiness = inspectFleetMergeReadiness(deps.db, runId);
    return readiness ? { readiness } : { error: "Fleet run not found" };
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
      const changed = deps.db
        .prepare(
          `UPDATE fleet_runs SET automation_base_sha = COALESCE(automation_base_sha, ?),
           merge_requested_at = ?, merge_requested_by = ?,
           merge_request_kind = 'manual', merge_target = ?,
           integration_state = 'idle', integration_error = NULL,
           integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND merge_requested_at IS NULL
             AND approval_state = 'approved' AND approved_plan_hash = plan_hash
             AND plan_hash IS ? AND automation_base_sha IS ?
             AND integration_head_sha IS ?`
        )
        .run(
          baseSha,
          now,
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
      createEvent(deps.db, runId, "manual_merge_requested", {
        target,
        baseSha,
        actor: safeActor,
        expectedPlanHash: snapshotPlanHash,
        expectedBaseSha: snapshotBaseSha,
        expectedIntegrationHeadSha: snapshotIntegrationHeadSha,
      });
    });
  } catch (error) {
    return { error: boundedError(error) };
  }
  const readiness = inspectFleetMergeReadiness(deps.db, runId);
  return readiness ? { readiness } : { error: "Fleet run not found" };
}

async function cleanupCompletedIntegration(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<void> {
  const expected = fleetIntegrationIdentity(run.id);
  if (
    run.integration_branch !== expected.branch ||
    run.integration_worktree !== expected.worktree
  ) {
    setRunError(
      deps.db,
      run.id,
      "failed",
      new Error("refusing cleanup of a non-Fleet integration workspace"),
      deps.now().toISOString()
    );
    return;
  }
  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
       integration_updated_at = ?, updated_at = ?
       WHERE id = ? AND status = 'completed'
         AND integration_state IN ('completed', 'cleanup_pending')`
    )
    .run(now, now, run.id);
  try {
    if (await deps.pathExists(expected.worktree)) {
      await deps.removeWorktree(expected.worktree, target.repoPath, true);
    }
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'cleanup_complete',
         integration_error = NULL, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = 'completed'`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    createEvent(deps.db, run.id, "integration_workspace_cleaned", {
      worktree: expected.worktree,
      branch: expected.branch,
    });
  } catch (error) {
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'cleanup_pending',
         integration_error = ?, integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND status = 'completed'`
      )
      .run(
        boundedError(error),
        deps.now().toISOString(),
        deps.now().toISOString(),
        run.id
      );
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
    const tasks = queries
      .listFleetTasksForRun(deps.db)
      .all(run.id) as FleetTaskRow[];
    const target = resolveFleetMergeTarget(deps.db, run, tasks);
    if (!target) {
      setRunError(
        deps.db,
        run.id,
        "awaiting_operator",
        new Error("Fleet source repository is unavailable"),
        deps.now().toISOString()
      );
      return;
    }
    if (
      run.status === "completed" &&
      ["completed", "cleanup_pending"].includes(run.integration_state)
    ) {
      await cleanupCompletedIntegration(deps, run, target);
      return;
    }
    if (!run.merge_requested_at || !run.merge_target) return;
    if (run.integration_state === "failed") return;
    if (run.merge_target === "github_pr" && !target.repoSlug) {
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
    if (run.merge_target === "local") {
      await finalizeLocal(deps, run, target);
      return;
    }
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
  const automaticCandidates = deps.db
    .prepare(
      `SELECT * FROM fleet_runs
       WHERE merge_requested_at IS NULL
         AND status NOT IN ('completed','failed','canceled')
         AND automation_policy_hash IS NOT NULL
       ORDER BY updated_at ASC, id ASC LIMIT ?`
    )
    .all(FLEET_MERGE_LIMIT) as FleetMergeRunRow[];
  for (const run of automaticCandidates) {
    if (onlyRunId && run.id !== onlyRunId) continue;
    const eligible = autoMergeEligible(deps.db, run);
    if (eligible) {
      consumeAutomaticMergeAuthorization(
        deps,
        run,
        eligible.target,
        eligible.policyHash
      );
    }
  }

  const candidates = onlyRunId
    ? ([queries.getFleetRun(deps.db).get(onlyRunId)].filter(
        Boolean
      ) as FleetMergeRunRow[])
    : (deps.db
        .prepare(
          `SELECT * FROM fleet_runs
           WHERE (merge_requested_at IS NOT NULL OR
                  (status = 'completed' AND integration_state IN ('completed','cleanup_pending')))
             AND integration_state NOT IN ('cleanup_complete')
           ORDER BY updated_at ASC, id ASC LIMIT ?`
        )
        .all(FLEET_MERGE_LIMIT) as FleetMergeRunRow[]);
  for (const run of candidates) {
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
  finalizeLocal,
  ensureGitHubPush,
  ensureGitHubPr,
  finalizeGitHub,
};
