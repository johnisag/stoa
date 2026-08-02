import { createHash, randomUUID } from "crypto";
import { mkdir, stat } from "fs/promises";
import { dirname, resolve } from "path";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { parseGitHubSlug, runGit } from "@/lib/git";
import { expandHome, isWindows, resolveBinary } from "@/lib/platform";
import {
  runVerify,
  VERIFY_TIMEOUT_MS,
  type VerifyResult,
} from "@/lib/verification/runner";
import { execFile } from "child_process";
import { promisify } from "util";
import { deleteWorktree } from "@/lib/worktrees";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "./hash";
import { parseFleetAutomationPolicy } from "./automation-policy";
import { prepareFleetFairnessCursor } from "./fairness-cursor";
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
  buildFleetRequiredCheckRulesArgs,
  FLEET_REQUIRED_RULES_MAX_PAGE_BYTES,
  FLEET_REQUIRED_RULES_MAX_PAGES,
  FLEET_REQUIRED_RULES_PAGE_SIZE,
  fleetIntegrationIdentity,
  parseFleetPrStatus,
  parseFleetRequiredCheckRulePages,
  type FleetPrStatus,
  type FleetRequiredCheckSet,
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
  parseFleetRequiredCheckRules,
  summarizeGitHubChecks,
} from "./merge-contract";
export {
  FLEET_MERGE_REVIEW_LENSES,
  inspectFleetMergeReadiness,
} from "./merge-readiness";
export type { FleetMergeReadiness } from "./merge-readiness";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
function fleetMergeLeaseDuration(verifyTimeoutMs: number): number {
  const verificationLeaseMs = Math.min(
    Math.max(verifyTimeoutMs + 60_000, 2 * 60_000),
    24 * 60 * 60 * 1000
  );
  return Math.max(15 * 60 * 1000, verificationLeaseMs);
}

const FLEET_MERGE_LEASE_MS = fleetMergeLeaseDuration(VERIFY_TIMEOUT_MS);
const FLEET_MERGE_LIMIT = 20;
const FLEET_MERGE_ARTIFACT_MAX = 16_000;
const FLEET_INTEGRATION_DISK_ESTIMATE_BYTES = 512 * 1024 ** 2;
const FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS = 3;
const FLEET_LANDING_RETRY_BASE_MS = 1_000;
const FLEET_LANDING_RETRY_MAX_MS = 5 * 60_000;
// A merge operation already owns a durable Git resource lease. This additional
// repository-keyed guard prevents two local landing commands from different
// Fleet runs entering the same checkout concurrently inside this server process.
const localLandingRepositories = new Set<string>();

export interface FleetFinalVerificationRetryStatus {
  action: "retry_final_verification" | "retry_landing" | null;
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
  target: FleetMergeTarget | null;
  targetRef: string | null;
  requiredTargetSha: string | null;
  integrationHeadSha: string | null;
  instructions: string | null;
}

export interface FleetMergeStatus extends FleetMergeStatusBase {
  retry: FleetFinalVerificationRetryStatus;
}

class FleetMergeCapacityUnavailable extends Error {}
class FleetMergeRecoveryInProgress extends Error {}
class FleetMergeRunInactive extends Error {}
class FleetMergeClaimStale extends Error {}
class FleetMergeLandingContractViolation extends Error {}
class FleetMergeLandingRetryable extends Error {
  constructor(
    message: string,
    readonly integrationState: "waiting_ci" | "merging" = "merging"
  ) {
    super(message);
  }
}

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
  removeWorktree: typeof deleteWorktree;
  ensureDirectory: (path: string) => Promise<void>;
  pathExists: (path: string) => Promise<boolean>;
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return redactAndCapFleetText(value, 1000).text;
}

function retryableLandingError(
  context: string,
  error: unknown,
  integrationState: "waiting_ci" | "merging" = "merging"
): FleetMergeLandingRetryable {
  return new FleetMergeLandingRetryable(
    `${context}: ${boundedError(error)}`,
    integrationState
  );
}

function landingRetryNotBefore(now: Date, attemptCount: number): string {
  const safeAttempt = Number.isSafeInteger(attemptCount)
    ? Math.max(1, attemptCount)
    : 1;
  const exponent = Math.min(20, safeAttempt - 1);
  const delay = Math.min(
    FLEET_LANDING_RETRY_MAX_MS,
    FLEET_LANDING_RETRY_BASE_MS * 2 ** exponent
  );
  return new Date(now.getTime() + delay).toISOString();
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
  return `path:${normalizedRepositoryPath(repoPath)}`;
}

function normalizedRepositoryPath(repoPath: string): string {
  const normalized = resolve(expandHome(repoPath)).replace(/\\/g, "/");
  return isWindows ? normalized.toLowerCase() : normalized;
}

function transaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
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

async function assertDirectGitRef(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  ref: string
): Promise<void> {
  const { stdout } = await deps.git(
    cwd,
    ["for-each-ref", "--format=%(symref)", ref],
    15_000,
    4096
  );
  if (stdout.trim()) {
    throw new FleetMergeLandingContractViolation(
      `Git target ${ref} is symbolic`
    );
  }
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

async function gitMergeInProgress(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<boolean> {
  const { stdout } = await deps.git(
    cwd,
    ["rev-parse", "--git-path", "MERGE_HEAD"],
    15_000,
    4096
  );
  const mergeHeadPath = stdout.trim();
  if (!mergeHeadPath || /[\r\n\0]/.test(mergeHeadPath)) {
    throw new Error("Git did not return a valid MERGE_HEAD path");
  }
  return deps.pathExists(resolve(cwd, mergeHeadPath));
}

interface GitCheckoutSnapshot {
  branch: string;
  head: string;
  clean: boolean;
}

/** Read branch, exact HEAD, and cleanliness through one Git status snapshot. */
async function gitCheckoutSnapshot(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<GitCheckoutSnapshot> {
  const { stdout } = await deps.git(
    cwd,
    ["status", "--porcelain=v2", "--branch", "--untracked-files=all"],
    15_000,
    1024 * 1024
  );
  let branch: string | null = null;
  let head: string | null = null;
  let clean = true;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("# branch.oid ")) {
      head = line.slice("# branch.oid ".length).trim().toLowerCase();
    } else if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      branch = value === "(detached)" ? "" : value;
    } else if (line.length > 0 && !line.startsWith("# ")) {
      clean = false;
    }
  }
  if (branch === null || !validSha(head)) {
    // Test adapters and older Git-compatible wrappers may omit porcelain-v2
    // branch headers. Keep the fail-closed checks while falling back to the
    // existing direct branch/HEAD queries for that compatibility surface.
    branch = await gitBranch(deps, cwd);
    head = await gitSha(deps, cwd);
  }
  return { branch, head, clean };
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
  if (await gitMergeInProgress(deps, cwd)) {
    throw new Error(`${context}: an unfinished merge is still present`);
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

async function gitHasIgnoredPaths(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<boolean> {
  const { stdout } = await deps.git(
    cwd,
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ],
    15_000,
    1024 * 1024
  );
  return stdout.length > 0;
}

async function assertExactIsolatedHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string,
  context: string
): Promise<void> {
  await assertExactCleanHead(deps, cwd, expectedHead, context);
  if (await gitHasIgnoredPaths(deps, cwd)) {
    throw new Error(`${context}: ignored workspace content is not isolated`);
  }
}

async function cleanIgnoredVerificationOutputs(
  deps: FleetMergeRuntimeDeps,
  cwd: string
): Promise<void> {
  await deps.git(cwd, ["clean", "-fdx"], 30_000, 1024 * 1024);
  if (await gitHasIgnoredPaths(deps, cwd)) {
    throw new Error("ignored verification output cleanup was incomplete");
  }
}

async function restoreExactIsolatedHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string
): Promise<void> {
  await restoreExactCleanHead(deps, cwd, expectedHead);
  await cleanIgnoredVerificationOutputs(deps, cwd);
  await assertExactIsolatedHead(
    deps,
    cwd,
    expectedHead,
    "isolated exact-head restoration failed"
  );
}

async function sanitizeExactVerificationHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedHead: string,
  context: string
): Promise<void> {
  // Reject tracked, untracked, index, or HEAD mutations before removing only
  // ignored verifier output from the operation-owned isolated workspace.
  await assertExactCleanHead(deps, cwd, expectedHead, context);
  await cleanIgnoredVerificationOutputs(deps, cwd);
  await assertExactIsolatedHead(deps, cwd, expectedHead, context);
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
): boolean {
  return (
    db
      .prepare(
        `UPDATE fleet_runs SET integration_state = ?, integration_error = ?,
       integration_updated_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running','reviewing','merging')
         AND desired_state = 'running' AND recovery_required = 0`
      )
      .run(state, boundedError(error), now, now, runId).changes === 1
  );
}

function fleetMergeRunIsActive(
  run: Pick<
    FleetRunRow,
    "status" | "desired_state" | "recovery_required" | "approval_state"
  >
): boolean {
  return (
    ["running", "reviewing", "merging"].includes(run.status) &&
    (run.desired_state ?? "running") === "running" &&
    run.recovery_required === 0 &&
    run.approval_state === "approved"
  );
}

function assertFleetMergeRunActive(
  deps: FleetMergeRuntimeDeps,
  runId: string
): FleetMergeRunRow {
  const current = queries.getFleetRun(deps.db).get(runId) as
    FleetMergeRunRow | undefined;
  if (!current || !fleetMergeRunIsActive(current)) {
    throw new FleetMergeRunInactive(
      "Fleet merge run is no longer active; terminal or paused state wins"
    );
  }
  return current;
}

function settleInactiveOperation(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  error: unknown
): void {
  const current = queries.getFleetRun(deps.db).get(operation.fleet_run_id) as
    FleetMergeRunRow | undefined;
  const terminal =
    !current || ["completed", "failed", "canceled"].includes(current.status);
  finishOperation(deps, operation, {
    state: terminal ? "failed" : "waiting",
    error: boundedError(error),
  });
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

interface FleetMergeArtifactInput {
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

function insertArtifact(
  deps: FleetMergeRuntimeDeps,
  input: FleetMergeArtifactInput
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

interface TaskMergeClaimGuard {
  integrationBranch: string;
  integrationWorktree: string;
}

function bindClaimedTaskMerge(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  guard: TaskMergeClaimGuard,
  nowIso: string
): void {
  if (
    operation.operation_type !== "task_merge" ||
    !operation.task_id ||
    !validSha(operation.expected_task_head_sha)
  ) {
    throw new FleetMergeClaimStale("task merge claim contract changed");
  }
  const changed = deps.db
    .prepare(
      `UPDATE fleet_tasks SET integration_state = 'integrating',
       integration_operation_id = ?, updated_at = ?
       WHERE id = ? AND fleet_run_id = ? AND status = 'ready_to_merge'
         AND head_sha = ? AND verified_head_sha = head_sha
         AND review_head_sha = head_sha AND review_status = 'clean'
         AND integration_state IN ('pending','integrating')
         AND (integration_operation_id IS NULL OR integration_operation_id = ?)
         AND EXISTS (
           SELECT 1 FROM fleet_runs run
           WHERE run.id = fleet_tasks.fleet_run_id
             AND run.status IN ('running','reviewing','merging')
             AND run.desired_state = 'running' AND run.recovery_required = 0
             AND run.approval_state = 'approved'
             AND run.integration_state = 'integrating'
             AND run.integration_head_sha = ?
             AND run.integration_branch = ? AND run.integration_worktree = ?
         )`
    )
    .run(
      operation.id,
      nowIso,
      operation.task_id,
      operation.fleet_run_id,
      operation.expected_task_head_sha,
      operation.id,
      operation.expected_base_sha,
      guard.integrationBranch,
      guard.integrationWorktree
    );
  if (changed.changes !== 1) {
    throw new FleetMergeClaimStale(
      "task merge operation no longer owns the current integration head"
    );
  }
}

function claimOperation(
  deps: FleetMergeRuntimeDeps,
  id: string,
  taskMergeGuard?: TaskMergeClaimGuard
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
            state = 'pending' OR
            (state = 'waiting' AND
              (lease_expires_at IS NULL OR lease_expires_at <= ?)) OR
            (state = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )`
        )
        .run(deps.leaseOwner, expiry, nowIso, nowIso, id, nowIso, nowIso);
      if (changed.changes !== 1) return null;
      releaseOperationResources(deps, id, now);
      const operation = deps.db
        .prepare(`SELECT * FROM fleet_merge_operations WHERE id = ?`)
        .get(id) as FleetMergeOperationRow;
      if (taskMergeGuard) {
        bindClaimedTaskMerge(deps, operation, taskMergeGuard, nowIso);
      }
      acquireOperationResources(deps, operation, now, expiry);
      return operation;
    });
  } catch (error) {
    if (
      error instanceof FleetMergeCapacityUnavailable ||
      error instanceof FleetMergeClaimStale
    ) {
      return null;
    }
    throw error;
  }
}

function acquireOperationResources(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  now: Date,
  leaseExpiresAt: string
): void {
  const { run, resources } = operationRuntimeResources(deps, operation);
  const admitted = acquireFleetRuntimeResources(deps.db, {
    runId: operation.fleet_run_id,
    ownerType: "merge_operation",
    ownerId: operation.id,
    resources,
    limits: fleetResourceLimitsForRun(run),
    now,
    leaseExpiresAt,
  });
  if (!admitted.admitted) throw new FleetMergeCapacityUnavailable();
}

function operationRuntimeResources(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow
) {
  const run = queries.getFleetRun(deps.db).get(operation.fleet_run_id) as
    FleetRunRow | undefined;
  if (!run) throw new Error("Fleet merge run changed while claiming");
  const tasks = queries
    .listFleetTasksForRun(deps.db)
    .all(operation.fleet_run_id) as FleetTaskRow[];
  const target = resolveFleetMergeTarget(deps.db, run, tasks);
  if (!target) throw new Error("Fleet merge repository changed while claiming");
  const repositoryKey = repositoryResourceKey(run, target.repoPath);
  const resources = [
    { kind: "merge_operation" as const, key: "host", units: 1 },
    { kind: "git_operation" as const, key: repositoryKey, units: 1 },
    ...(operation.operation_type === "final_verify"
      ? [{ kind: "verifier" as const, key: "host", units: 1 }]
      : []),
  ];
  return { run, resources };
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

function assertInterruptedOperationOwnsCurrentIntegrationState(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow
): void {
  const identity = fleetIntegrationIdentity(operation.fleet_run_id);
  const owned = deps.db
    .prepare(
      `SELECT 1
       FROM fleet_merge_operations operation
       JOIN fleet_runs run ON run.id = operation.fleet_run_id
       WHERE operation.id = ? AND operation.state = 'running'
         AND operation.operation_type IN ('task_merge','final_verify')
         AND operation.expected_base_sha = run.integration_head_sha
         AND run.status IN ('running','reviewing','merging')
         AND run.desired_state = 'running' AND run.recovery_required = 0
         AND run.approval_state = 'approved'
         AND run.integration_branch = ? AND run.integration_worktree = ?
         AND (
           operation.operation_type = 'final_verify' OR EXISTS (
             SELECT 1 FROM fleet_tasks task
             WHERE task.id = operation.task_id
               AND task.fleet_run_id = operation.fleet_run_id
               AND task.head_sha = operation.expected_task_head_sha
               AND task.integration_state = 'integrating'
               AND task.integration_operation_id = operation.id
           )
         )`
    )
    .get(operation.id, identity.branch, identity.worktree);
  if (!owned) {
    throw new FleetMergeRunInactive(
      "interrupted merge operation no longer owns the current integration state"
    );
  }
}

function claimInterruptedOperationRecovery(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  now: Date
): { owner: string; expiresAt: string } | null {
  const nowIso = now.toISOString();
  const owner = `${deps.leaseOwner}:recovery:${operation.id}:${now.getTime()}`;
  const expiresAt = new Date(
    now.getTime() + FLEET_MERGE_LEASE_MS
  ).toISOString();
  try {
    return transaction(deps.db, () => {
      assertInterruptedOperationOwnsCurrentIntegrationState(deps, operation);
      const changed = deps.db
        .prepare(
          `UPDATE fleet_merge_operations
         SET lease_owner = ?, lease_expires_at = ?, updated_at = ?,
              error = 'recovering interrupted Fleet merge operation'
          WHERE id = ? AND state = 'running'
            AND operation_type IN ('task_merge','final_verify')
            AND lease_owner IS ? AND lease_expires_at IS ?
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
        )
        .run(
          owner,
          expiresAt,
          nowIso,
          operation.id,
          operation.lease_owner,
          operation.lease_expires_at,
          nowIso
        );
      if (changed.changes !== 1) return null;

      // The old runtime leases may already have expired and another run may now
      // own the repository. Releasing and reacquiring the complete resource set
      // in this same IMMEDIATE transaction prevents recovery from mutating Git
      // unless it has fresh host and repository admission.
      releaseOperationResources(deps, operation.id, now);
      const claimed = deps.db
        .prepare(`SELECT * FROM fleet_merge_operations WHERE id = ?`)
        .get(operation.id) as FleetMergeOperationRow;
      acquireOperationResources(deps, claimed, now, expiresAt);
      return { owner, expiresAt };
    });
  } catch (error) {
    if (error instanceof FleetMergeCapacityUnavailable) return null;
    throw error;
  }
}

function finishInterruptedOperationRecovery(
  deps: FleetMergeRuntimeDeps,
  operationId: string,
  recovery: { owner: string; expiresAt: string },
  input: { recovered: boolean; error?: unknown }
): boolean {
  return transaction(deps.db, () => {
    const now = deps.now();
    const nowIso = now.toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_merge_operations
         SET state = CASE WHEN ? = 1 THEN 'pending' ELSE 'running' END,
             lease_owner = NULL,
             lease_expires_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
             error = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?
           AND lease_expires_at = ?`
      )
      .run(
        input.recovered ? 1 : 0,
        input.recovered ? 1 : 0,
        nowIso,
        input.recovered
          ? "recovered interrupted Fleet merge operation"
          : `interrupted Fleet merge recovery failed: ${boundedError(input.error)}`,
        nowIso,
        operationId,
        recovery.owner,
        recovery.expiresAt
      );
    if (changed.changes !== 1) return false;
    releaseOperationResources(deps, operationId, now);
    return true;
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
  const nowIso = now.toISOString();
  const expiry = new Date(now.getTime() + FLEET_MERGE_LEASE_MS).toISOString();
  transaction(deps.db, () => {
    const { resources: expectedResources } = operationRuntimeResources(
      deps,
      operation
    );
    const leases = deps.db
      .prepare(
        `SELECT resource_type, resource_key, units
         FROM fleet_runtime_leases
         WHERE owner_type = 'merge_operation' AND owner_id = ?
           AND status = 'reserved' AND lease_expires_at > ?`
      )
      .all(operation.id, nowIso) as Array<{
      resource_type: string;
      resource_key: string;
      units: number;
    }>;
    if (
      leases.length !== expectedResources.length ||
      expectedResources.some(
        (expected) =>
          !leases.some(
            (lease) =>
              lease.resource_type === expected.kind &&
              lease.resource_key === expected.key &&
              lease.units === expected.units
          )
      )
    ) {
      throw new Error("Fleet merge runtime resource lease changed");
    }
    const changed = deps.db
      .prepare(
        `UPDATE fleet_merge_operations SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?
           AND lease_expires_at > ?`
      )
      .run(expiry, nowIso, operation.id, deps.leaseOwner, nowIso);
    if (changed.changes !== 1) {
      throw new Error("Fleet merge operation lease changed");
    }
    const resourcesChanged = deps.db
      .prepare(
        `UPDATE fleet_runtime_leases SET lease_expires_at = ?
         WHERE owner_type = 'merge_operation' AND owner_id = ?
           AND status = 'reserved' AND lease_expires_at > ?`
      )
      .run(expiry, operation.id, nowIso);
    if (resourcesChanged.changes !== expectedResources.length) {
      throw new Error("Fleet merge runtime lease renewal changed");
    }
  });
}

function renewTaskMergeMutationOwnership(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow,
  operation: FleetMergeOperationRow,
  requireActive: boolean
): void {
  renewOperationLease(deps, operation);
  const owned = deps.db
    .prepare(
      `SELECT run.status, run.desired_state, run.recovery_required,
              run.approval_state, run.integration_state,
              task.status AS task_status
       FROM fleet_merge_operations operation
       JOIN fleet_runs run ON run.id = operation.fleet_run_id
       JOIN fleet_tasks task ON task.id = operation.task_id
         AND task.fleet_run_id = operation.fleet_run_id
       WHERE operation.id = ? AND operation.operation_type = 'task_merge'
         AND operation.state = 'running' AND operation.lease_owner = ?
         AND operation.lease_expires_at > ?
         AND operation.expected_base_sha = run.integration_head_sha
         AND operation.expected_task_head_sha = task.head_sha
         AND run.integration_branch = ? AND run.integration_worktree = ?
         AND task.integration_state = 'integrating'
         AND task.integration_operation_id = operation.id`
    )
    .get(
      operation.id,
      deps.leaseOwner,
      deps.now().toISOString(),
      run.integration_branch,
      run.integration_worktree
    ) as
    | (Pick<
        FleetRunRow,
        | "status"
        | "desired_state"
        | "recovery_required"
        | "approval_state"
        | "integration_state"
      > & { task_status: string })
    | undefined;
  if (
    !owned ||
    (requireActive &&
      (!fleetMergeRunIsActive(owned) ||
        owned.integration_state !== "integrating" ||
        owned.task_status !== "ready_to_merge"))
  ) {
    throw new FleetMergeRunInactive(
      "task merge operation no longer owns the current integration state"
    );
  }
  if (
    task.id !== operation.task_id ||
    task.head_sha !== operation.expected_task_head_sha
  ) {
    throw new FleetMergeRunInactive("task merge evidence binding changed");
  }
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
    retryNotBefore?: string | null;
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
              lease_expires_at = CASE WHEN ? = 'waiting' THEN ? ELSE NULL END,
              updated_at = ?,
              completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(
        input.state,
        input.resultHeadSha ?? null,
        input.outputHash ?? null,
        input.artifactId ?? null,
        input.error ? redactAndCapFleetText(input.error, 1000).text : null,
        input.state,
        input.retryNotBefore ?? null,
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

/**
 * Preserve a consumed one-shot landing authorization while a correctable,
 * precondition-read failure clears. `lease_expires_at` doubles as the durable
 * not-before timestamp only while the operation is in `waiting`; claimOperation
 * checks it before reacquiring the exact same operation after a restart.
 */
function leaveLandingOperationRetryable(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  error: unknown,
  integrationState: "waiting_ci" | "merging"
): boolean {
  const now = deps.now();
  const retryNotBefore = landingRetryNotBefore(now, operation.attempt_count);
  const message = `landing retry scheduled for ${retryNotBefore}: ${boundedError(error)}`;
  return transaction(deps.db, () => {
    if (
      !finishOperation(deps, operation, {
        state: "waiting",
        error: message,
        retryNotBefore,
      })
    ) {
      return false;
    }
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = ?, integration_error = ?,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0`
      )
      .run(
        integrationState,
        message,
        now.toISOString(),
        now.toISOString(),
        run.id,
        run.integration_head_sha
      );
    if (changed.changes === 1) {
      createEvent(
        deps.db,
        run.id,
        "fleet_landing_retry_scheduled",
        {
          operationId: operation.id,
          operationType: operation.operation_type,
          attempt: operation.attempt_count,
          retryNotBefore,
          error: boundedError(error),
        },
        { controlPlane: true }
      );
    }
    return true;
  });
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
  const workspaceIdentityChanged =
    run.integration_branch !== branch ||
    run.integration_worktree !== worktree ||
    run.integration_base_sha !== baseSha ||
    !validSha(run.integration_head_sha);
  const workspaceStateTransition = ["idle", "initializing"].includes(
    run.integration_state
  );
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
  let recoveredInterruptedOperation = false;
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
  const workspaceClean = await gitClean(deps, worktree);
  const mergeInProgress = await gitMergeInProgress(deps, worktree);
  const ignoredWorkspaceContent = await gitHasIgnoredPaths(deps, worktree);
  if (!workspaceClean || mergeInProgress || ignoredWorkspaceContent) {
    const runningOperations = deps.db
      .prepare(
        `SELECT * FROM fleet_merge_operations
         WHERE fleet_run_id = ? AND state = 'running'
           AND operation_type IN ('task_merge','final_verify')
          ORDER BY started_at ASC, id ASC`
      )
      .all(run.id) as FleetMergeOperationRow[];
    const interrupted = runningOperations.find(
      (operation) =>
        operation.expected_base_sha === head ||
        (validSha(operation.expected_result_head_sha) &&
          operation.expected_result_head_sha === head)
    );
    if (!interrupted) {
      throw new Error("Fleet integration worktree is dirty");
    }
    if (interrupted.lease_expires_at && interrupted.lease_expires_at > now) {
      throw new FleetMergeRecoveryInProgress(
        "Fleet integration workspace is owned by a live merge operation"
      );
    }
    const expectedRecoveryHead =
      validSha(interrupted.expected_result_head_sha) &&
      interrupted.expected_result_head_sha === head
        ? interrupted.expected_result_head_sha
        : interrupted.expected_base_sha;
    const recovery = claimInterruptedOperationRecovery(
      deps,
      interrupted,
      new Date(now)
    );
    if (!recovery) {
      throw new FleetMergeRecoveryInProgress(
        "Fleet integration recovery was claimed by another reconciler"
      );
    }
    try {
      if (
        interrupted.operation_type === "task_merge" &&
        expectedRecoveryHead === interrupted.expected_base_sha
      ) {
        await abortMerge(deps, worktree, expectedRecoveryHead);
      } else {
        // A verifier may have dirtied the exact durably-bound result after the
        // branch moved. Restore that result, not the prior base, so the next
        // claim resumes the same immutable merge commit.
        await restoreExactIsolatedHead(deps, worktree, expectedRecoveryHead);
      }
    } catch (error) {
      finishInterruptedOperationRecovery(deps, interrupted.id, recovery, {
        recovered: false,
        error,
      });
      throw error;
    }
    if (
      !finishInterruptedOperationRecovery(deps, interrupted.id, recovery, {
        recovered: true,
      })
    ) {
      throw new Error("Fleet integration recovery lease changed");
    }
    recoveredInterruptedOperation = true;
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
  if (
    !worktreeExists ||
    workspaceIdentityChanged ||
    workspaceStateTransition ||
    recoveredInterruptedOperation
  ) {
    createEvent(
      deps.db,
      run.id,
      "integration_workspace_ready",
      {
        branch,
        worktree,
        baseSha,
        headSha: recoveringOperation ? run.integration_head_sha : head,
        recoveringOperation: recoveredInterruptedOperation,
      },
      { controlPlane: true }
    );
  }
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
    await restoreExactIsolatedHead(deps, cwd, expectedHead);
  } else {
    await cleanIgnoredVerificationOutputs(deps, cwd);
  }
  try {
    await assertExactIsolatedHead(
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
    const currentRun = queries.getFleetRun(deps.db).get(run.id) as
      FleetMergeRunRow | undefined;
    if (!currentRun || !fleetMergeRunIsActive(currentRun)) {
      settleInactiveOperation(deps, operation, error);
      return;
    }
    if (
      currentRun.integration_head_sha !== operation.expected_base_sha ||
      currentRun.integration_branch !== run.integration_branch ||
      currentRun.integration_worktree !== run.integration_worktree
    ) {
      settleInactiveOperation(
        deps,
        operation,
        new FleetMergeRunInactive(
          "integration head changed before merge failure persistence"
        )
      );
      return;
    }
    const taskChanged = deps.db
      .prepare(
        `UPDATE fleet_tasks SET status = 'needs_inspection',
         integration_state = 'failed', integration_operation_id = ?,
         failure_code = 'integration_failed', updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND head_sha = ?
           AND status = 'ready_to_merge'`
      )
      .run(operation.id, now, task.id, run.id, task.head_sha);
    if (taskChanged.changes !== 1) {
      settleInactiveOperation(
        deps,
        operation,
        new FleetMergeRunInactive(
          "task state changed before merge failure persistence"
        )
      );
      return;
    }
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
    if (finished.changes !== 1) {
      throw new Error("task merge operation lease changed during failure");
    }
    releaseOperationResources(deps, operation.id, new Date(now));
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
      `SELECT state, expected_result_head_sha, result_head_sha
       FROM fleet_merge_operations WHERE id = ?`
    )
    .get(operation.id) as
    | {
        state: string;
        expected_result_head_sha: string | null;
        result_head_sha: string | null;
      }
    | undefined;
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
    durableOperation.expected_result_head_sha === resultHead &&
    durableOperation.result_head_sha === resultHead &&
    durableTask?.status === "merged" &&
    durableTask.integration_state === "merged" &&
    durableTask.integrated_head_sha === resultHead &&
    durableRun?.integration_head_sha === resultHead
  );
}

function persistExpectedTaskMergeResult(
  deps: FleetMergeRuntimeDeps,
  operation: FleetMergeOperationRow,
  expectedResultHead: string
): void {
  if (!validSha(expectedResultHead)) {
    throw new Error("task merge produced an invalid expected result commit");
  }
  const changed = deps.db
    .prepare(
      `UPDATE fleet_merge_operations
       SET expected_result_head_sha = ?, updated_at = ?
       WHERE id = ? AND state = 'running' AND lease_owner = ?
         AND expected_base_sha = ? AND expected_task_head_sha = ?
         AND expected_result_head_sha IS NULL`
    )
    .run(
      expectedResultHead,
      deps.now().toISOString(),
      operation.id,
      deps.leaseOwner,
      operation.expected_base_sha,
      operation.expected_task_head_sha
    );
  if (changed.changes !== 1) {
    const durable = deps.db
      .prepare(
        `SELECT expected_result_head_sha FROM fleet_merge_operations
         WHERE id = ? AND state = 'running' AND lease_owner = ?`
      )
      .get(operation.id, deps.leaseOwner) as
      { expected_result_head_sha: string | null } | undefined;
    if (durable?.expected_result_head_sha !== expectedResultHead) {
      throw new Error("task merge expected result changed before publication");
    }
  }
}

function persistIntegratedTask(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  task: FleetTaskRow,
  operation: FleetMergeOperationRow,
  resultHead: string,
  artifactInput: FleetMergeArtifactInput
): { id: string; contentHash: string } {
  const now = deps.now().toISOString();
  return transaction(deps.db, () => {
    const currentRun = queries.getFleetRun(deps.db).get(run.id) as
      FleetMergeRunRow | undefined;
    if (
      !currentRun ||
      !fleetMergeRunIsActive(currentRun) ||
      currentRun.integration_head_sha !== operation.expected_base_sha ||
      currentRun.integration_branch !== run.integration_branch
    ) {
      throw new FleetMergeRunInactive(
        "integration run changed before task result was persisted"
      );
    }
    const artifact = insertArtifact(deps, artifactInput);
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
         WHERE id = ? AND state = 'running' AND lease_owner = ?
           AND expected_result_head_sha = ?`
      )
      .run(
        resultHead,
        artifact.contentHash,
        artifact.id,
        now,
        now,
        operation.id,
        deps.leaseOwner,
        resultHead
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
    return artifact;
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
  const claimed = claimOperation(deps, operation.id, {
    integrationBranch: run.integration_branch,
    integrationWorktree: run.integration_worktree,
  });
  if (!claimed) return false;

  let artifactId: string | null = null;
  let integrationMutationStarted = false;
  let resultHead: string | null = null;
  try {
    const currentIntegrationHead = await gitSha(deps, run.integration_worktree);
    if (
      claimed.expected_result_head_sha !== null &&
      !validSha(claimed.expected_result_head_sha)
    ) {
      throw new Error("persisted task merge result is not a full commit ID");
    }
    if (
      currentIntegrationHead !== operation.expected_base_sha &&
      currentIntegrationHead !== claimed.expected_result_head_sha
    ) {
      throw new Error(
        "integration head does not match the bound base or expected task merge result"
      );
    }

    const taskWorktree = expandHome(task.worktree_path);
    if ((await gitSha(deps, taskWorktree)) !== task.head_sha) {
      throw new Error("task worktree head moved after review");
    }
    if (!(await gitClean(deps, taskWorktree))) {
      throw new Error("task worktree is dirty after review");
    }
    if (await gitMergeInProgress(deps, taskWorktree)) {
      throw new Error("task worktree has an unfinished merge after review");
    }
    if (
      !validSha(task.base_sha) ||
      !(await isAncestor(deps, taskWorktree, task.base_sha, task.head_sha))
    ) {
      throw new Error("task head is not descended from its bound base");
    }

    if (claimed.expected_result_head_sha === null) {
      await assertExactIsolatedHead(
        deps,
        run.integration_worktree,
        operation.expected_base_sha,
        "task merge construction preflight"
      );
      renewTaskMergeMutationOwnership(deps, run, task, claimed, true);
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
      const { stdout: treeOutput } = await deps.git(
        run.integration_worktree,
        ["write-tree"],
        30_000,
        4096
      );
      const mergeTree = treeOutput.trim().toLowerCase();
      if (!validSha(mergeTree)) {
        throw new Error("task merge produced an invalid tree ID");
      }
      const { stdout: commitOutput } = await deps.git(
        run.integration_worktree,
        [
          "-c",
          "user.name=Stoa Fleet",
          "-c",
          "user.email=stoa-fleet@localhost",
          "commit-tree",
          mergeTree,
          "-p",
          operation.expected_base_sha,
          "-p",
          task.head_sha,
          "-m",
          `fleet: integrate ${task.id}`,
        ],
        120_000
      );
      resultHead = commitOutput.trim().toLowerCase();
      if (!validSha(resultHead)) {
        throw new Error("task merge produced an invalid commit ID");
      }
      // The exact merge commit is durable before the Fleet-owned integration
      // branch moves. Recovery may publish only this commit, never an arbitrary
      // descendant that happens to contain the task head.
      persistExpectedTaskMergeResult(deps, claimed, resultHead);
      renewOperationLease(deps, claimed);
    } else {
      resultHead = claimed.expected_result_head_sha;
    }

    renewTaskMergeMutationOwnership(deps, run, task, claimed, true);
    integrationMutationStarted = true;
    await restoreExactIsolatedHead(deps, run.integration_worktree, resultHead);
    if ((await gitSha(deps, run.integration_worktree)) !== resultHead) {
      throw new Error("integration branch did not publish the expected result");
    }
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
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      resultHead,
      "integration verification preflight"
    );
    renewTaskMergeMutationOwnership(deps, run, task, claimed, true);

    let verification: VerifyResult | null = null;
    let verificationFailure: Error | null = null;
    try {
      verification = await deps.verify(run.integration_worktree, command);
      await sanitizeExactVerificationHead(
        deps,
        run.integration_worktree,
        resultHead,
        "integration verifier mutation"
      );
    } catch (error) {
      verificationFailure =
        error instanceof Error ? error : new Error(boundedError(error));
      try {
        renewTaskMergeMutationOwnership(deps, run, task, claimed, false);
        await restoreExactIsolatedHead(
          deps,
          run.integration_worktree,
          resultHead
        );
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
    renewTaskMergeMutationOwnership(deps, run, task, claimed, true);
    await assertExactIsolatedHead(
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
    const verificationArtifactInput: FleetMergeArtifactInput = {
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
    };
    if (verificationFailure || verification.status !== "pass") {
      const verificationArtifact = transaction(deps.db, () => {
        assertFleetMergeRunActive(deps, run.id);
        return insertArtifact(deps, verificationArtifactInput);
      });
      artifactId = verificationArtifact.id;
    }
    if (verificationFailure) throw verificationFailure;
    if (verification.status !== "pass") {
      throw new Error(`integration verification ${verification.status}`);
    }
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      resultHead,
      "integration persistence boundary"
    );
    renewTaskMergeMutationOwnership(deps, run, task, claimed, true);
    const verificationArtifact = persistIntegratedTask(
      deps,
      run,
      task,
      claimed,
      resultHead,
      verificationArtifactInput
    );
    artifactId = verificationArtifact.id;
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
    if (!integrationMutationStarted) {
      try {
        renewTaskMergeMutationOwnership(deps, run, task, claimed, false);
      } catch (ownershipError) {
        settleInactiveOperation(deps, claimed, ownershipError);
        return false;
      }
    }
    if (integrationMutationStarted) {
      try {
        renewTaskMergeMutationOwnership(deps, run, task, claimed, false);
        const currentHead = await gitSha(deps, run.integration_worktree);
        if (
          currentHead !== operation.expected_base_sha &&
          (!validSha(resultHead) || currentHead !== resultHead)
        ) {
          throw new FleetMergeRunInactive(
            "refusing to reset an integration head not owned by this task merge"
          );
        }
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

function persistFinalVerificationPass(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  commands: string[],
  artifactInput: FleetMergeArtifactInput
): { id: string; contentHash: string } {
  const now = deps.now().toISOString();
  return transaction(deps.db, () => {
    const current = assertFleetMergeRunActive(deps, run.id);
    if (current.integration_head_sha !== run.integration_head_sha) {
      throw new FleetMergeRunInactive(
        "combined head changed after final verification"
      );
    }
    const artifact = insertArtifact(deps, artifactInput);
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
        artifact.contentHash,
        artifact.id,
        now,
        now,
        operation.id,
        deps.leaseOwner
      );
    if (op.changes !== 1) throw new Error("final verification lease changed");
    releaseOperationResources(deps, operation.id, new Date(now));
    const updated = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'ready_to_finalize',
         status = 'merging', integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0
           AND approval_state = 'approved'`
      )
      .run(now, now, run.id, run.integration_head_sha);
    if (updated.changes !== 1) {
      throw new FleetMergeRunInactive(
        "combined head or run state changed after final verification"
      );
    }
    createEvent(deps.db, run.id, "integration_final_verification_passed", {
      headSha: run.integration_head_sha,
      operationId: operation.id,
      commands,
    });
    return artifact;
  });
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
         WHERE id = ? AND integration_head_sha = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0
           AND approval_state = 'approved'`
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
  let verificationStarted = false;
  try {
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "final verification preflight"
    );
    assertFleetMergeRunActive(deps, run.id);
    const started = deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'final_verifying',
         status = 'merging', integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND integration_head_sha = ?
           AND status IN ('running','reviewing','merging')
           AND desired_state = 'running' AND recovery_required = 0
           AND approval_state = 'approved'`
      )
      .run(
        deps.now().toISOString(),
        deps.now().toISOString(),
        run.id,
        run.integration_head_sha
      );
    if (started.changes !== 1) {
      throw new FleetMergeRunInactive(
        "Fleet merge run changed before final verification"
      );
    }
    const results: { command: string; status: string; output: string }[] = [];
    let verificationFailure: Error | null = null;
    for (const command of commands) {
      assertFleetMergeRunActive(deps, run.id);
      renewOperationLease(deps, claimed);
      verificationStarted = true;
      let result: VerifyResult;
      try {
        result = await deps.verify(run.integration_worktree, command);
        await sanitizeExactVerificationHead(
          deps,
          run.integration_worktree,
          run.integration_head_sha,
          "final verifier mutation"
        );
      } catch (error) {
        verificationFailure =
          error instanceof Error ? error : new Error(boundedError(error));
        try {
          await restoreExactIsolatedHead(
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
    await assertExactIsolatedHead(
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
    const verificationArtifactInput: FleetMergeArtifactInput = {
      run,
      baseSha: run.integration_base_sha ?? run.integration_head_sha,
      headSha: run.integration_head_sha,
      type: "fleet_final_verification",
      title: "Final combined-head verification",
      body,
      severity: passed ? "info" : "blocker",
      metadata: { operationId: claimed.id, passed, commands },
    };
    if (verificationFailure || !passed) {
      const verificationArtifact = transaction(deps.db, () => {
        assertFleetMergeRunActive(deps, run.id);
        return insertArtifact(deps, verificationArtifactInput);
      });
      artifactId = verificationArtifact.id;
    }
    if (verificationFailure) throw verificationFailure;
    if (!passed) throw new Error("final combined-head verification failed");
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "final verification persistence boundary"
    );
    assertFleetMergeRunActive(deps, run.id);
    renewOperationLease(deps, claimed);
    const verificationArtifact = persistFinalVerificationPass(
      deps,
      run,
      claimed,
      commands,
      verificationArtifactInput
    );
    artifactId = verificationArtifact.id;
    return true;
  } catch (error) {
    if (verificationStarted) {
      try {
        await restoreExactIsolatedHead(
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
    const currentRun = queries.getFleetRun(deps.db).get(run.id) as
      FleetMergeRunRow | undefined;
    if (!currentRun || !fleetMergeRunIsActive(currentRun)) {
      settleInactiveOperation(deps, claimed, error);
      return false;
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

async function localLandingTargetHead(
  deps: FleetMergeRuntimeDeps,
  repoPath: string,
  targetRef: string
): Promise<string> {
  try {
    await assertDirectGitRef(deps, repoPath, targetRef);
    return await gitSha(deps, repoPath, targetRef);
  } catch (error) {
    if (error instanceof FleetMergeLandingContractViolation) throw error;
    throw retryableLandingError(
      "local target ref is temporarily unreadable",
      error
    );
  }
}

async function localLandingCheckoutSnapshot(
  deps: FleetMergeRuntimeDeps,
  repoPath: string
): Promise<GitCheckoutSnapshot> {
  try {
    return await gitCheckoutSnapshot(deps, repoPath);
  } catch (error) {
    throw retryableLandingError(
      "local checkout status is temporarily unavailable",
      error
    );
  }
}

async function finalizeLocal(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  const repositoryKey = normalizedRepositoryPath(target.repoPath);
  if (localLandingRepositories.has(repositoryKey)) return false;
  localLandingRepositories.add(repositoryKey);
  try {
    return await finalizeLocalLocked(deps, run, target);
  } finally {
    localLandingRepositories.delete(repositoryKey);
  }
}

async function finalizeLocalLocked(
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
      const targetRef = `refs/heads/${target.baseBranch}`;
      const targetHead = await localLandingTargetHead(
        deps,
        target.repoPath,
        targetRef
      );
      if (targetHead !== run.integration_head_sha) {
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
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "local landing preflight"
    );
    const targetRef = `refs/heads/${target.baseBranch}`;
    const targetHead = await localLandingTargetHead(
      deps,
      target.repoPath,
      targetRef
    );
    if (
      targetHead !== run.integration_base_sha &&
      targetHead !== run.integration_head_sha
    ) {
      throw new Error("local target branch moved after Fleet bound it");
    }
    if (targetHead === run.integration_base_sha) {
      const source = await localLandingCheckoutSnapshot(deps, target.repoPath);
      if (source.branch !== target.baseBranch) {
        throw new FleetMergeLandingRetryable(
          `local checkout is on ${source.branch || "detached HEAD"}, expected ${target.baseBranch}`
        );
      }
      if (!source.clean) {
        throw new FleetMergeLandingRetryable("local checkout is dirty");
      }
      if (await gitMergeInProgress(deps, target.repoPath)) {
        throw new FleetMergeLandingRetryable(
          "local checkout has an unfinished merge"
        );
      }
      if (source.head !== run.integration_base_sha) {
        throw new Error("local checkout base moved after Fleet bound it");
      }
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
    if (targetHead !== run.integration_head_sha) {
      // Move the exact target ref with an old-OID compare-and-swap. A plain
      // `git merge --ff-only` acts on whichever branch happens to be checked
      // out when the process starts; an external checkout between our preflight
      // and that command could therefore advance an unrelated branch. The
      // explicit ref CAS can only advance the approved base branch.
      externalActionStarted = true;
      await deps.git(
        target.repoPath,
        [
          "update-ref",
          "--no-deref",
          targetRef,
          run.integration_head_sha,
          run.integration_base_sha,
        ],
        120_000
      );
    }
    // Never run an index/worktree command in the ambient source checkout after
    // the ref CAS. Another process can switch branches between Git processes;
    // a later read-tree/reset/checkout could then overwrite unrelated work.
    // The explicit target ref is the authoritative local merge result.
    const mergedHead = await gitSha(deps, target.repoPath, targetRef);
    if (mergedHead !== run.integration_head_sha) {
      throw new Error(
        "local fast-forward did not land the exact integration head"
      );
    }
    completeRun(deps, run, claimed, mergedHead);
    return true;
  } catch (error) {
    let observedTargetHead: string | undefined;
    try {
      const targetRef = `refs/heads/${target.baseBranch}`;
      const targetHead = await localLandingTargetHead(
        deps,
        target.repoPath,
        targetRef
      );
      observedTargetHead = targetHead;
      if (targetHead === run.integration_head_sha) {
        try {
          completeRun(deps, run, claimed, targetHead);
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
      if (observedTargetHead === run.integration_base_sha) {
        leaveLandingOperationRetryable(deps, run, claimed, error, "merging");
      } else {
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
      }
      return false;
    }
    if (error instanceof FleetMergeLandingRetryable) {
      leaveLandingOperationRetryable(
        deps,
        run,
        claimed,
        error,
        error.integrationState
      );
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
  branch: string,
  remote = "origin"
): Promise<string | null> {
  const { stdout } = await deps.git(
    cwd,
    ["ls-remote", "--heads", remote, `refs/heads/${branch}`],
    30_000,
    64 * 1024
  );
  const line = stdout.trim().split(/\r?\n/, 1)[0] ?? "";
  if (!line) return null;
  const sha = line.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!validSha(sha)) {
    throw new FleetMergeLandingContractViolation(
      "origin returned an invalid branch head"
    );
  }
  return sha;
}

async function verifiedGitHubRemoteUrl(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedRepoSlug: string
): Promise<string> {
  const { stdout } = await deps.git(
    cwd,
    ["remote", "get-url", "origin"],
    15_000,
    16 * 1024
  );
  const actualRepoSlug = parseGitHubSlug(stdout.trim());
  if (
    !actualRepoSlug ||
    actualRepoSlug.toLowerCase() !== expectedRepoSlug.toLowerCase()
  ) {
    throw new FleetMergeLandingContractViolation(
      "GitHub repository identity differs from the checkout's origin"
    );
  }
  return stdout.trim();
}

async function verifiedGitHubLandingRemoteUrl(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  expectedRepoSlug: string
): Promise<string> {
  try {
    return await verifiedGitHubRemoteUrl(deps, cwd, expectedRepoSlug);
  } catch (error) {
    if (error instanceof FleetMergeLandingContractViolation) throw error;
    throw retryableLandingError(
      "GitHub origin identity is temporarily unavailable",
      error
    );
  }
}

async function landingRemoteBranchHead(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  branch: string,
  remote = "origin"
): Promise<string | null> {
  try {
    return await remoteBranchHead(deps, cwd, branch, remote);
  } catch (error) {
    if (error instanceof FleetMergeLandingContractViolation) throw error;
    throw retryableLandingError(
      `remote branch ${branch} is temporarily unreadable`,
      error
    );
  }
}

/**
 * Advance one explicit remote branch only when it still has the reviewed base.
 * GitHub's PR merge mutation can bind the PR head but cannot compare-and-swap
 * the target ref. Git's receive-pack protocol can: the exact force-with-lease
 * value is the old OID expected by the server, while the refspec names both the
 * reviewed new OID and the approved destination. Callers must separately prove
 * that the new OID descends from the old one, so this remains a fast-forward;
 * the lease is used for atomicity, never to authorize history replacement.
 */
async function pushExactRemoteBranch(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  remote: string,
  branch: string,
  expectedOldSha: string,
  newSha: string
): Promise<void> {
  if (!validSha(expectedOldSha) || !validSha(newSha)) {
    throw new Error("remote branch compare-and-swap requires full Git SHAs");
  }
  const ref = `refs/heads/${branch}`;
  await deps.git(
    cwd,
    [
      "push",
      "--porcelain",
      `--force-with-lease=${ref}:${expectedOldSha}`,
      remote,
      `${newSha}:${ref}`,
    ],
    120_000
  );
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
    !target.repoSlug ||
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
  let githubRemote: string | null = null;
  if (operation.state === "failed") {
    githubRemote = await verifiedGitHubRemoteUrl(
      deps,
      target.repoPath,
      target.repoSlug
    ).catch(() => null);
    if (!githubRemote) return false;
    const remote = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch,
      githubRemote
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
    githubRemote ??= await verifiedGitHubRemoteUrl(
      deps,
      target.repoPath,
      target.repoSlug
    );
    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "GitHub landing preflight"
    );
    const remote = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch,
      githubRemote
    );
    if (remote && remote !== run.integration_head_sha) {
      throw new Error("remote integration branch exists at a different head");
    }
    if (!remote) {
      pushAttempted = true;
      await deps.git(
        run.integration_worktree,
        [
          "push",
          githubRemote,
          `${run.integration_head_sha}:refs/heads/${run.integration_branch}`,
        ],
        120_000
      );
    }
    const confirmed = await remoteBranchHead(
      deps,
      target.repoPath,
      run.integration_branch,
      githubRemote
    );
    if (confirmed !== run.integration_head_sha) {
      throw new Error("remote integration branch did not reach the exact head");
    }
    persistGitHubPush(deps, run, claimed, confirmed);
    return true;
  } catch (error) {
    if (githubRemote) {
      try {
        const confirmed = await remoteBranchHead(
          deps,
          target.repoPath,
          run.integration_branch,
          githubRemote
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
          leaveExternallyCompletedOperationRecoverable(
            deps,
            run,
            claimed,
            error
          );
          return false;
        }
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

async function readFleetPrForLanding(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  selector: string | number,
  repoSlug: string
): Promise<FleetPrStatus> {
  let result: GitResult;
  try {
    result = await deps.gh(cwd, buildFleetPrViewArgs(selector, repoSlug));
  } catch (error) {
    throw retryableLandingError(
      "GitHub PR status is temporarily unavailable",
      error,
      "waiting_ci"
    );
  }
  const pr = parseFleetPrStatus(result.stdout);
  if (!pr) {
    throw new FleetMergeLandingRetryable(
      "GitHub PR status response is unavailable or malformed",
      "waiting_ci"
    );
  }
  return pr;
}

async function readRequiredGitHubChecks(
  deps: FleetMergeRuntimeDeps,
  cwd: string,
  repoSlug: string,
  baseBranch: string
): Promise<FleetRequiredCheckSet> {
  const pages: string[] = [];
  for (let page = 1; page <= FLEET_REQUIRED_RULES_MAX_PAGES; page++) {
    let result: GitResult;
    try {
      result = await deps.gh(
        cwd,
        buildFleetRequiredCheckRulesArgs(repoSlug, baseBranch, page)
      );
    } catch (error) {
      throw retryableLandingError(
        "GitHub required-check rules are temporarily unavailable",
        error,
        "waiting_ci"
      );
    }
    if (
      Buffer.byteLength(result.stdout, "utf8") >
      FLEET_REQUIRED_RULES_MAX_PAGE_BYTES
    ) {
      throw new FleetMergeLandingRetryable(
        "GitHub required-check rules exceeded the bounded response size; automatic landing is disabled",
        "waiting_ci"
      );
    }
    pages.push(result.stdout);
    let itemCount: number;
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length > FLEET_REQUIRED_RULES_PAGE_SIZE
      ) {
        throw new Error("malformed GitHub rules page");
      }
      itemCount = parsed.length;
    } catch {
      throw new FleetMergeLandingRetryable(
        "GitHub returned malformed required-check rule pagination; automatic landing is disabled",
        "waiting_ci"
      );
    }
    if (itemCount < FLEET_REQUIRED_RULES_PAGE_SIZE) break;
    if (page === FLEET_REQUIRED_RULES_MAX_PAGES) {
      throw new FleetMergeLandingRetryable(
        "GitHub required-check rule pagination exceeded the bounded page limit; automatic landing is disabled",
        "waiting_ci"
      );
    }
  }
  const required = parseFleetRequiredCheckRulePages(pages);
  if (!required) {
    throw new FleetMergeLandingRetryable(
      "GitHub returned unsupported or malformed active branch rules; automatic landing is disabled",
      "waiting_ci"
    );
  }
  if (required.checks.length === 0) {
    throw new FleetMergeLandingRetryable(
      "GitHub returned no trustworthy required-check context set; automatic landing is disabled",
      "waiting_ci"
    );
  }
  if (required.checks.some((check) => check.integrationId !== null)) {
    throw new FleetMergeLandingRetryable(
      "GitHub required checks are app-bound, but the PR rollup does not prove app identity; automatic landing is disabled",
      "waiting_ci"
    );
  }
  return required;
}

function fleetPrTargetError(
  pr: FleetPrStatus,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo,
  requirePinnedBaseSha: boolean
): string | null {
  if (pr.baseRefName !== target.baseBranch) {
    return `GitHub PR target branch changed after Fleet bound it: expected ${target.baseBranch}, received ${pr.baseRefName ?? "unknown"}`;
  }
  if (requirePinnedBaseSha && pr.baseSha !== run.integration_base_sha) {
    return "GitHub PR base changed after Fleet bound it";
  }
  return null;
}

function assertExactFleetPrTarget(
  pr: FleetPrStatus,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo,
  requirePinnedBaseSha: boolean
): void {
  const error = fleetPrTargetError(pr, run, target, requirePinnedBaseSha);
  if (error) throw new Error(error);
}

function isExactFleetPrTarget(
  pr: FleetPrStatus,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo,
  requirePinnedBaseSha: boolean
): boolean {
  return fleetPrTargetError(pr, run, target, requirePinnedBaseSha) === null;
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
      !existing ||
      !isExactFleetPrTarget(
        existing,
        run,
        target,
        existing.state !== "MERGED"
      ) ||
      existing.headSha !== run.integration_head_sha ||
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
    assertExactFleetPrTarget(pr, run, target, pr.state !== "MERGED");
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
      recovered &&
      isExactFleetPrTarget(
        recovered,
        run,
        target,
        recovered.state !== "MERGED"
      ) &&
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

function recordGitHubPrWait(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  operation: FleetMergeOperationRow,
  pr: FleetPrStatus,
  required: FleetRequiredCheckSet
): boolean {
  const expectedContexts = required.checks.map((check) => check.context);
  const missing = expectedContexts.filter(
    (context) => !Object.hasOwn(pr.checkContexts, context)
  );
  const requiredStates = expectedContexts
    .map((context) => pr.checkContexts[context])
    .filter((state): state is "passing" | "pending" | "failing" => !!state);
  if (requiredStates.includes("failing")) {
    throw new FleetMergeLandingContractViolation(
      "A required GitHub check is failing"
    );
  }
  if (
    pr.mergeable === "MERGEABLE" &&
    pr.checks === "passing" &&
    missing.length === 0 &&
    requiredStates.every((state) => state === "passing")
  ) {
    return false;
  }
  if (pr.checks === "failing") {
    throw new FleetMergeLandingContractViolation("GitHub checks are failing");
  }
  const error = missing.length
    ? `GitHub has not registered ${missing.length} required check${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 8).join(", ")}`
    : pr.checks === "none"
      ? "GitHub has not reported any checks; waiting to avoid the check-registration race"
      : "GitHub mergeability or checks are pending";
  finishOperation(deps, operation, { state: "waiting", error });
  const now = deps.now().toISOString();
  deps.db
    .prepare(
      `UPDATE fleet_runs SET integration_state = 'waiting_ci',
       integration_error = ?, integration_updated_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(error, now, now, run.id);
  return true;
}

async function finalizeGitHub(
  deps: FleetMergeRuntimeDeps,
  run: FleetMergeRunRow,
  target: FleetMergeTargetInfo
): Promise<boolean> {
  if (
    !target.repoSlug ||
    !run.integration_pr_number ||
    !run.integration_worktree ||
    !validSha(run.integration_base_sha) ||
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
  let githubRemote: string | null = null;
  if (operation.state === "failed") {
    githubRemote = await verifiedGitHubRemoteUrl(
      deps,
      target.repoPath,
      target.repoSlug
    ).catch(() => null);
    if (!githubRemote) return false;
    const landedHead = await remoteBranchHead(
      deps,
      target.repoPath,
      target.baseBranch,
      githubRemote
    ).catch(() => null);
    if (landedHead !== run.integration_head_sha) return false;
    operation =
      reopenFailedOperationForExactRecovery(deps, operation) ?? operation;
    if (operation.state === "failed") return false;
  }
  const claimed = claimOperation(deps, operation.id);
  if (!claimed) return false;
  let landingAttempted = false;
  let exactPr: FleetPrStatus | null = null;
  try {
    githubRemote ??= await verifiedGitHubLandingRemoteUrl(
      deps,
      target.repoPath,
      target.repoSlug
    );
    let pr = await readFleetPrForLanding(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    assertExactFleetPrTarget(pr, run, target, pr.state !== "MERGED");
    if (pr.headSha !== run.integration_head_sha) {
      throw new Error("GitHub PR head changed after final verification");
    }
    exactPr = pr;
    if (pr.state === "MERGED") {
      const landedHead = await landingRemoteBranchHead(
        deps,
        target.repoPath,
        target.baseBranch,
        githubRemote
      );
      if (landedHead !== run.integration_head_sha) {
        throw new Error(
          "GitHub target branch does not equal the verified integration head; the merged PR cannot be certified"
        );
      }
      completeRun(deps, run, claimed, run.integration_head_sha, {
        number: pr.number,
        url: pr.url,
        headSha: pr.headSha,
      });
      return true;
    }
    if (pr.state !== "OPEN") {
      throw new Error(`GitHub PR is not open (state ${pr.state ?? "unknown"})`);
    }
    const requiredChecks = await readRequiredGitHubChecks(
      deps,
      target.repoPath,
      target.repoSlug,
      target.baseBranch
    );
    if (recordGitHubPrWait(deps, run, claimed, pr, requiredChecks)) {
      return false;
    }

    // Re-read the PR for operator-facing audit context immediately before the
    // external action. The action itself does not derive its destination from
    // mutable PR metadata: it advances the configured target ref with an exact
    // old-OID lease below.
    pr = await readFleetPrForLanding(
      deps,
      target.repoPath,
      run.integration_pr_number,
      target.repoSlug
    );
    assertExactFleetPrTarget(pr, run, target, pr.state !== "MERGED");
    if (pr.headSha !== run.integration_head_sha) {
      throw new Error("GitHub PR head changed immediately before merge");
    }
    const finalRequiredChecks = await readRequiredGitHubChecks(
      deps,
      target.repoPath,
      target.repoSlug,
      target.baseBranch
    );
    if (
      JSON.stringify(finalRequiredChecks.checks) !==
      JSON.stringify(requiredChecks.checks)
    ) {
      throw new FleetMergeLandingRetryable(
        "GitHub required-check context set changed before landing",
        "waiting_ci"
      );
    }
    if (recordGitHubPrWait(deps, run, claimed, pr, finalRequiredChecks)) {
      return false;
    }
    exactPr = pr;
    if (pr.state === "MERGED") {
      const landedHead = await landingRemoteBranchHead(
        deps,
        target.repoPath,
        target.baseBranch,
        githubRemote
      );
      if (landedHead !== run.integration_head_sha) {
        throw new Error(
          "GitHub target branch does not equal the verified integration head; the merged PR cannot be certified"
        );
      }
      completeRun(deps, run, claimed, run.integration_head_sha, {
        number: pr.number,
        url: pr.url,
        headSha: pr.headSha,
      });
      return true;
    }
    if (pr.state !== "OPEN") {
      throw new Error(`GitHub PR is not open (state ${pr.state ?? "unknown"})`);
    }
    if (recordGitHubPrWait(deps, run, claimed, pr, finalRequiredChecks)) {
      return false;
    }

    await assertExactIsolatedHead(
      deps,
      run.integration_worktree,
      run.integration_head_sha,
      "GitHub target landing preflight"
    );
    if (
      !(await isAncestor(
        deps,
        run.integration_worktree,
        run.integration_base_sha,
        run.integration_head_sha
      ))
    ) {
      throw new Error(
        "verified integration head is not descended from its base"
      );
    }
    const remoteBase = await landingRemoteBranchHead(
      deps,
      target.repoPath,
      target.baseBranch,
      githubRemote
    );
    if (remoteBase !== run.integration_base_sha) {
      throw new Error(
        "GitHub target base changed before the exact-ref compare-and-swap"
      );
    }
    deps.db
      .prepare(
        `UPDATE fleet_runs SET integration_state = 'merging',
         integration_updated_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(deps.now().toISOString(), deps.now().toISOString(), run.id);
    landingAttempted = true;
    await pushExactRemoteBranch(
      deps,
      run.integration_worktree,
      githubRemote,
      target.baseBranch,
      run.integration_base_sha,
      run.integration_head_sha
    );
    const landedHead = await landingRemoteBranchHead(
      deps,
      target.repoPath,
      target.baseBranch,
      githubRemote
    );
    if (landedHead !== run.integration_head_sha) {
      throw new Error(
        "GitHub target ref did not reach the exact verified integration head"
      );
    }
    completeRun(deps, run, claimed, run.integration_head_sha, {
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
    });
    return true;
  } catch (error) {
    let observedTargetHead: string | null | undefined;
    if (!githubRemote) {
      observedTargetHead = undefined;
    } else {
      try {
        observedTargetHead = await remoteBranchHead(
          deps,
          target.repoPath,
          target.baseBranch,
          githubRemote
        );
      } catch {
        observedTargetHead = undefined;
      }
    }
    if (observedTargetHead === run.integration_head_sha) {
      try {
        completeRun(
          deps,
          run,
          claimed,
          run.integration_head_sha,
          exactPr
            ? {
                number: exactPr.number,
                url: exactPr.url,
                headSha: run.integration_head_sha,
              }
            : null
        );
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
    if (landingAttempted && observedTargetHead === undefined) {
      leaveExternallyCompletedOperationRecoverable(deps, run, claimed, error);
      return false;
    }
    if (
      (!landingAttempted && error instanceof FleetMergeLandingRetryable) ||
      (landingAttempted && observedTargetHead === run.integration_base_sha)
    ) {
      leaveLandingOperationRetryable(
        deps,
        run,
        claimed,
        error,
        error instanceof FleetMergeLandingRetryable
          ? error.integrationState
          : "merging"
      );
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
    target: input.target ?? null,
    targetRef: input.targetRef ?? null,
    requiredTargetSha: input.requiredTargetSha ?? null,
    integrationHeadSha: input.integrationHeadSha ?? null,
    instructions: input.instructions ?? null,
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
    target: null,
    targetRef: null,
    requiredTargetSha: null,
    integrationHeadSha: null,
    instructions: null,
  };
}

function inspectFailedLandingRecovery(
  db: Database.Database,
  runId: string
): FleetFinalVerificationRetryStatus {
  const exact = exactApprovedFleetExecution(db, runId);
  const run = exact?.run;
  if (
    !run ||
    run.merge_requested_at === null ||
    !run.merge_requested_by ||
    (run.merge_target !== "local" && run.merge_target !== "github_pr")
  ) {
    return unavailableFinalVerificationRetry();
  }
  const target = run.merge_target;
  const operationType = target === "local" ? "local_finalize" : "github_merge";
  const operation = db
    .prepare(
      `SELECT * FROM fleet_merge_operations
       WHERE fleet_run_id = ? AND operation_type = ? AND state = 'failed'
       ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(runId, operationType) as FleetMergeOperationRow | undefined;
  if (!operation) return unavailableFinalVerificationRetry();

  const tasks = queries.listFleetTasksForRun(db).all(runId) as FleetTaskRow[];
  const resolvedTarget = resolveFleetMergeTarget(db, run, tasks);
  const blocked = (reason: string) =>
    unavailableFinalVerificationRetry({
      action: "retry_landing",
      state: "blocked",
      reason,
      operationId: operation.id,
      attemptCount: operation.attempt_count,
      target,
      targetRef: resolvedTarget
        ? `refs/heads/${resolvedTarget.baseBranch}`
        : null,
      requiredTargetSha: run.integration_base_sha,
      integrationHeadSha: run.integration_head_sha,
    });

  if (
    ["completed", "failed", "canceled"].includes(run.status) ||
    (run.desired_state ?? "running") !== "running" ||
    !["running", "reviewing", "merging"].includes(run.status)
  ) {
    return blocked(`Fleet run cannot retry landing from ${run.status}`);
  }
  if (run.recovery_required === 1) {
    return blocked(
      "Fleet startup recovery must finish before retrying landing"
    );
  }
  if (run.integration_state !== "awaiting_operator") {
    return blocked("Landing is not waiting for an operator recovery action");
  }
  if (
    !validSha(run.automation_base_sha) ||
    run.integration_base_sha !== run.automation_base_sha ||
    !validSha(run.integration_head_sha) ||
    !resolvedTarget ||
    (target === "github_pr" && !resolvedTarget.repoSlug)
  ) {
    return blocked(
      "The exact landing repository, base, or head is unavailable"
    );
  }
  if (
    operation.task_id !== null ||
    operation.target !== target ||
    operation.expected_base_sha !== run.integration_head_sha ||
    operation.expected_task_head_sha !== null ||
    operation.result_head_sha !== null ||
    operation.lease_owner !== null ||
    operation.lease_expires_at !== null
  ) {
    return blocked("The failed landing operation is not retry-safe");
  }
  const reservedResources = db
    .prepare(
      `SELECT 1 FROM fleet_runtime_leases
       WHERE owner_type = 'merge_operation' AND owner_id = ?
         AND status = 'reserved' LIMIT 1`
    )
    .get(operation.id);
  if (reservedResources) {
    return blocked("Landing resource cleanup is still pending");
  }

  const targetRef = `refs/heads/${resolvedTarget.baseBranch}`;
  const displayTarget =
    target === "github_pr" && resolvedTarget.repoSlug
      ? `${resolvedTarget.repoSlug}:${targetRef}`
      : targetRef;
  return {
    action: "retry_landing",
    state: "available",
    available: true,
    reason: null,
    operationId: operation.id,
    attemptCount: operation.attempt_count,
    maxAttempts: FLEET_FINAL_VERIFICATION_MAX_ATTEMPTS,
    preconditions: {
      planHash: run.plan_hash!,
      executionHash: exact.executionHash,
      baseSha: run.automation_base_sha,
      integrationHeadSha: run.integration_head_sha,
    },
    target,
    targetRef: displayTarget,
    requiredTargetSha: run.integration_base_sha,
    integrationHeadSha: run.integration_head_sha,
    instructions:
      target === "local"
        ? "Remediate the displayed local checkout or ref error, then retry. Stoa will re-read the exact target ref and every landing gate; it will proceed only if the ref still equals the bound base or already equals the exact integration head."
        : "Remediate the displayed PR, required-check, or branch error, then retry. Stoa will re-read GitHub, the exact remote target ref, and every landing gate; it will proceed only if the ref still equals the bound base or already equals the exact integration head.",
  };
}

export function getFleetMergeStatus(
  runId: string,
  db: Database.Database = getDb()
): FleetMergeStatus | null {
  const status = readFleetMergeStatus(runId, db);
  if (!status) return null;
  const finalVerificationRetry = inspectManualFinalVerificationRetry(db, runId);
  return {
    ...status,
    retry:
      finalVerificationRetry.action !== null
        ? finalVerificationRetry
        : inspectFailedLandingRecovery(db, runId),
  };
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

interface FleetMergeRequestPreconditions {
  planHash: string;
  executionHash?: string;
  baseSha: string | null;
  integrationHeadSha: string | null;
}

interface FleetManualLandingPreconditions {
  planHash: string;
  executionHash: string;
  baseSha: string;
  integrationHeadSha: string;
}

interface FleetLandingRecoveryPreconditions extends FleetManualLandingPreconditions {
  operationId: string;
}

function consumeManualMergeIntent(
  deps: FleetMergeRuntimeDeps,
  runId: string,
  target: FleetMergeTarget,
  actor: string,
  expected: FleetManualLandingPreconditions
): { authorized: true } | { error: string; status?: number } {
  return transaction(deps.db, () => {
    const exact = exactApprovedFleetExecution(deps.db, runId);
    if (!exact) {
      return {
        error: "The approved plan or execution contract changed",
        status: 409,
      };
    }
    const current = exact.run;
    if (
      current.merge_requested_at !== null ||
      current.merge_request_kind !== "manual" ||
      current.merge_target !== target ||
      !current.merge_requested_by ||
      (current.desired_state ?? "running") !== "running" ||
      !["running", "reviewing", "merging"].includes(current.status) ||
      current.recovery_required === 1 ||
      current.integration_state !== "ready_to_finalize" ||
      !validSha(current.automation_base_sha) ||
      current.integration_base_sha !== current.automation_base_sha ||
      !validSha(current.integration_head_sha)
    ) {
      return {
        error: "Manual landing is not ready for explicit authorization",
        status: 409,
      };
    }
    if (
      current.plan_hash !== expected.planHash ||
      exact.executionHash !== expected.executionHash ||
      current.automation_base_sha !== expected.baseSha ||
      current.integration_base_sha !== expected.baseSha ||
      current.integration_head_sha !== expected.integrationHeadSha
    ) {
      return {
        error: "Fleet landing authorization preconditions changed",
        status: 409,
      };
    }
    const readiness = inspectFleetMergeReadiness(deps.db, runId);
    if (!readiness?.canFinalize || !readiness.allTasksIntegrated) {
      return { error: "Exact-head merge readiness changed", status: 409 };
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
    if (!verified) {
      return {
        error: "Exact current final-verification evidence is required",
        status: 409,
      };
    }
    const now = deps.now().toISOString();
    const safeActor = actor.trim().slice(0, 80) || "operator";
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET merge_requested_at = ?,
         merge_requested_by = ?, integration_error = NULL,
         integration_updated_at = ?, updated_at = ?
         WHERE id = ? AND merge_requested_at IS NULL
           AND merge_request_kind = 'manual' AND merge_target = ?
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
        safeActor,
        now,
        now,
        current.id,
        current.merge_target,
        current.plan_hash,
        current.plan_hash,
        current.automation_base_sha,
        current.automation_base_sha,
        current.integration_head_sha
      );
    if (changed.changes !== 1) {
      return {
        error: "Fleet landing authorization preconditions changed",
        status: 409,
      };
    }
    createEvent(
      deps.db,
      current.id,
      "manual_merge_landing_authorized",
      {
        target: current.merge_target,
        actor: safeActor,
        planHash: current.plan_hash,
        executionHash: exact.executionHash,
        baseSha: current.automation_base_sha,
        integrationHeadSha: current.integration_head_sha,
      },
      { controlPlane: true }
    );
    return { authorized: true };
  });
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

/**
 * Consume a previously staged manual merge intent only after a second,
 * operator-authenticated action bound to the exact verified integration head.
 * Internal staging never calls this function.
 */
export async function authorizeFleetManualLanding(
  runId: string,
  target: FleetMergeTarget,
  actor: string,
  expected: FleetManualLandingPreconditions,
  overrides: Partial<FleetMergeRuntimeDeps> = {}
): Promise<
  { readiness: FleetMergeReadiness } | { error: string; status?: number }
> {
  const deps = runtimeDeps(overrides);
  const recoveryBlocked = fleetLaunchBlockedResult(deps.db, runId);
  if (recoveryBlocked) return recoveryBlocked;
  if (target !== "local" && target !== "github_pr") {
    return { error: "landing target must be local or github_pr", status: 400 };
  }
  if (
    !validSha(expected.baseSha) ||
    !validSha(expected.integrationHeadSha) ||
    !/^[0-9a-f]{64}$/i.test(expected.planHash) ||
    !/^[0-9a-f]{64}$/i.test(expected.executionHash)
  ) {
    return {
      error: "Exact landing authorization preconditions are required",
      status: 400,
    };
  }

  const current = queries.getFleetRun(deps.db).get(runId) as
    FleetMergeRunRow | undefined;
  if (!current) return { error: "Fleet run not found", status: 404 };
  if (current.merge_requested_at !== null) {
    if (
      current.merge_request_kind !== "manual" ||
      current.merge_target !== target ||
      !mergeRequestPreconditionsMatch(deps.db, current, expected)
    ) {
      return {
        error: "Fleet landing authorization preconditions changed",
        status: 409,
      };
    }
    const readiness = inspectFleetMergeReadiness(deps.db, runId);
    return readiness
      ? { readiness }
      : { error: "Fleet run not found", status: 404 };
  }

  const authorized = consumeManualMergeIntent(
    deps,
    runId,
    target,
    actor,
    expected
  );
  if ("error" in authorized) return authorized;
  const readiness = inspectFleetMergeReadiness(deps.db, runId);
  return readiness
    ? { readiness }
    : { error: "Fleet run not found", status: 404 };
}

/**
 * Reopen a failed, already-authorized landing without minting or replaying
 * landing authority. The external target is read authoritatively first. Only
 * the bound base (safe to retry) or exact integration head (safe to recover)
 * can pass; an unreadable or third SHA remains locked for operator inspection.
 */
export async function retryFailedFleetLanding(
  runId: string,
  target: FleetMergeTarget,
  actor: string,
  expected: FleetLandingRecoveryPreconditions,
  overrides: Partial<FleetMergeRuntimeDeps> = {}
): Promise<
  | { reopened: true; observedTargetSha: string }
  | { error: string; status?: number }
> {
  const deps = runtimeDeps(overrides);
  const recoveryBlocked = fleetLaunchBlockedResult(deps.db, runId);
  if (recoveryBlocked) return recoveryBlocked;
  if (
    (target !== "local" && target !== "github_pr") ||
    !expected.operationId ||
    expected.operationId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(expected.operationId) ||
    !validSha(expected.baseSha) ||
    !validSha(expected.integrationHeadSha) ||
    !/^[0-9a-f]{64}$/i.test(expected.planHash) ||
    !/^[0-9a-f]{64}$/i.test(expected.executionHash)
  ) {
    return {
      error: "Exact failed-landing recovery preconditions are required",
      status: 400,
    };
  }
  const recovery = inspectFailedLandingRecovery(deps.db, runId);
  const recoveryPreconditions = recovery.preconditions;
  if (
    !recovery.available ||
    recovery.action !== "retry_landing" ||
    recovery.operationId !== expected.operationId ||
    recovery.target !== target ||
    !recoveryPreconditions ||
    recoveryPreconditions.planHash !== expected.planHash ||
    recoveryPreconditions.executionHash !== expected.executionHash ||
    recoveryPreconditions.baseSha !== expected.baseSha ||
    recoveryPreconditions.integrationHeadSha !== expected.integrationHeadSha
  ) {
    return {
      error: recovery.reason ?? "Failed landing recovery preconditions changed",
      status: 409,
    };
  }

  const run = queries.getFleetRun(deps.db).get(runId) as FleetMergeRunRow;
  const tasks = queries
    .listFleetTasksForRun(deps.db)
    .all(runId) as FleetTaskRow[];
  const resolvedTarget = resolveFleetMergeTarget(deps.db, run, tasks);
  if (!resolvedTarget || (target === "github_pr" && !resolvedTarget.repoSlug)) {
    return { error: "Fleet landing target is unavailable", status: 409 };
  }

  let observedTargetSha: string;
  try {
    if (target === "local") {
      observedTargetSha = await localLandingTargetHead(
        deps,
        resolvedTarget.repoPath,
        `refs/heads/${resolvedTarget.baseBranch}`
      );
    } else {
      const githubRemote = await verifiedGitHubLandingRemoteUrl(
        deps,
        resolvedTarget.repoPath,
        resolvedTarget.repoSlug!
      );
      const observed = await landingRemoteBranchHead(
        deps,
        resolvedTarget.repoPath,
        resolvedTarget.baseBranch,
        githubRemote
      );
      if (!observed) {
        return {
          error:
            "GitHub target ref is missing; landing recovery remains locked",
          status: 409,
        };
      }
      observedTargetSha = observed;
    }
  } catch (error) {
    return {
      error: `Authoritative target-ref proof failed: ${boundedError(error)}`,
      status: 503,
    };
  }
  if (
    observedTargetSha !== expected.baseSha &&
    observedTargetSha !== expected.integrationHeadSha
  ) {
    return {
      error: `Target ref is ${observedTargetSha}, not the required base ${expected.baseSha} or exact integration head ${expected.integrationHeadSha}; landing recovery remains locked`,
      status: 409,
    };
  }

  try {
    transaction(deps.db, () => {
      const current = inspectFailedLandingRecovery(deps.db, runId);
      const currentPreconditions = current.preconditions;
      if (
        !current.available ||
        current.action !== "retry_landing" ||
        current.operationId !== expected.operationId ||
        current.target !== target ||
        !currentPreconditions ||
        currentPreconditions.planHash !== expected.planHash ||
        currentPreconditions.executionHash !== expected.executionHash ||
        currentPreconditions.baseSha !== expected.baseSha ||
        currentPreconditions.integrationHeadSha !== expected.integrationHeadSha
      ) {
        throw new Error("Failed landing recovery preconditions changed");
      }
      const now = deps.now().toISOString();
      const reopened = deps.db
        .prepare(
          `UPDATE fleet_merge_operations
           SET state = 'waiting', error = 'operator requested exact-bound landing recovery',
               completed_at = NULL, updated_at = ?
           WHERE id = ? AND fleet_run_id = ? AND state = 'failed'
             AND expected_base_sha = ? AND expected_task_head_sha IS NULL
             AND result_head_sha IS NULL AND lease_owner IS NULL
             AND lease_expires_at IS NULL`
        )
        .run(now, expected.operationId, runId, expected.integrationHeadSha);
      if (reopened.changes !== 1) {
        throw new Error("Failed landing operation changed");
      }
      const runChanged = deps.db
        .prepare(
          `UPDATE fleet_runs
           SET integration_state = 'merging', integration_error = NULL,
               integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND merge_requested_at IS NOT NULL
             AND merge_target = ? AND integration_state = 'awaiting_operator'
             AND status IN ('running','reviewing','merging')
             AND desired_state = 'running' AND recovery_required = 0
             AND plan_hash = ? AND approved_plan_hash = ?
             AND automation_base_sha = ? AND integration_base_sha = ?
             AND integration_head_sha = ?`
        )
        .run(
          now,
          now,
          runId,
          target,
          expected.planHash,
          expected.planHash,
          expected.baseSha,
          expected.baseSha,
          expected.integrationHeadSha
        );
      if (runChanged.changes !== 1) {
        throw new Error("Failed landing run changed");
      }
      createEvent(
        deps.db,
        runId,
        "fleet_landing_retry_scheduled",
        {
          recovery: "operator_exact_bound",
          actor: actor.trim().slice(0, 80) || "operator",
          operationId: expected.operationId,
          target,
          targetRef: current.targetRef,
          observedTargetSha,
          requiredBaseSha: expected.baseSha,
          integrationHeadSha: expected.integrationHeadSha,
        },
        { controlPlane: true }
      );
    });
  } catch (error) {
    return { error: boundedError(error), status: 409 };
  }
  return { reopened: true, observedTargetSha };
}

/**
 * Terminally settle an exact failed landing after the authoritative target has
 * diverged from both SHAs Stoa was allowed to land. This is intentionally not
 * a Git recovery operation: it only reads the target and records the terminal
 * decision. The failed operation and integration workspace remain as evidence.
 */
export async function abandonDivergedFleetLanding(
  runId: string,
  target: FleetMergeTarget,
  actor: string,
  expected: FleetLandingRecoveryPreconditions,
  overrides: Partial<FleetMergeRuntimeDeps> = {}
): Promise<
  | { abandoned: true; observedTargetSha: string }
  | { error: string; status?: number }
> {
  const deps = runtimeDeps(overrides);
  const recoveryBlocked = fleetLaunchBlockedResult(deps.db, runId);
  if (recoveryBlocked) return recoveryBlocked;
  if (
    (target !== "local" && target !== "github_pr") ||
    !expected.operationId ||
    expected.operationId.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(expected.operationId) ||
    !validSha(expected.baseSha) ||
    !validSha(expected.integrationHeadSha) ||
    !/^[0-9a-f]{64}$/i.test(expected.planHash) ||
    !/^[0-9a-f]{64}$/i.test(expected.executionHash)
  ) {
    return {
      error: "Exact failed-landing recovery preconditions are required",
      status: 400,
    };
  }

  const recovery = inspectFailedLandingRecovery(deps.db, runId);
  const recoveryPreconditions = recovery.preconditions;
  if (
    !recovery.available ||
    recovery.action !== "retry_landing" ||
    recovery.operationId !== expected.operationId ||
    recovery.target !== target ||
    !recoveryPreconditions ||
    recoveryPreconditions.planHash !== expected.planHash ||
    recoveryPreconditions.executionHash !== expected.executionHash ||
    recoveryPreconditions.baseSha !== expected.baseSha ||
    recoveryPreconditions.integrationHeadSha !== expected.integrationHeadSha
  ) {
    return {
      error: recovery.reason ?? "Failed landing recovery preconditions changed",
      status: 409,
    };
  }

  const liveMergeAuthorization = deps.db
    .prepare(
      `SELECT 1 FROM fleet_action_authorizations
       WHERE fleet_run_id = ? AND action = 'merge' AND status = 'authorized'
       LIMIT 1`
    )
    .get(runId);
  const liveMergeOperation = deps.db
    .prepare(
      `SELECT 1 FROM fleet_merge_operations
       WHERE fleet_run_id = ? AND id <> ?
         AND state IN ('pending','running','waiting') LIMIT 1`
    )
    .get(runId, expected.operationId);
  if (liveMergeAuthorization || liveMergeOperation) {
    return {
      error: "A live Fleet landing action still exists",
      status: 409,
    };
  }

  const run = queries.getFleetRun(deps.db).get(runId) as FleetMergeRunRow;
  const tasks = queries
    .listFleetTasksForRun(deps.db)
    .all(runId) as FleetTaskRow[];
  const resolvedTarget = resolveFleetMergeTarget(deps.db, run, tasks);
  if (!resolvedTarget || (target === "github_pr" && !resolvedTarget.repoSlug)) {
    return { error: "Fleet landing target is unavailable", status: 409 };
  }

  let observedTargetSha: string;
  try {
    if (target === "local") {
      observedTargetSha = await localLandingTargetHead(
        deps,
        resolvedTarget.repoPath,
        `refs/heads/${resolvedTarget.baseBranch}`
      );
    } else {
      const githubRemote = await verifiedGitHubLandingRemoteUrl(
        deps,
        resolvedTarget.repoPath,
        resolvedTarget.repoSlug!
      );
      const observed = await landingRemoteBranchHead(
        deps,
        resolvedTarget.repoPath,
        resolvedTarget.baseBranch,
        githubRemote
      );
      if (!observed) {
        return {
          error:
            "GitHub target ref is missing; terminal landing recovery remains locked",
          status: 409,
        };
      }
      observedTargetSha = observed;
    }
  } catch (error) {
    return {
      error: `Authoritative target-ref proof failed: ${boundedError(error)}`,
      status: 503,
    };
  }
  if (
    !validSha(observedTargetSha) ||
    observedTargetSha === expected.baseSha ||
    observedTargetSha === expected.integrationHeadSha
  ) {
    return {
      error: `Target ref is ${observedTargetSha}; terminal abandonment requires a valid third SHA distinct from the bound base and exact integration head`,
      status: 409,
    };
  }

  try {
    transaction(deps.db, () => {
      const current = inspectFailedLandingRecovery(deps.db, runId);
      const currentPreconditions = current.preconditions;
      if (
        !current.available ||
        current.action !== "retry_landing" ||
        current.operationId !== expected.operationId ||
        current.target !== target ||
        !currentPreconditions ||
        currentPreconditions.planHash !== expected.planHash ||
        currentPreconditions.executionHash !== expected.executionHash ||
        currentPreconditions.baseSha !== expected.baseSha ||
        currentPreconditions.integrationHeadSha !== expected.integrationHeadSha
      ) {
        throw new Error("Failed landing recovery preconditions changed");
      }
      const conflictingActivity = deps.db
        .prepare(
          `SELECT 1
           WHERE EXISTS (
             SELECT 1 FROM fleet_action_authorizations
             WHERE fleet_run_id = ? AND action = 'merge'
               AND status = 'authorized'
           ) OR EXISTS (
             SELECT 1 FROM fleet_merge_operations
             WHERE fleet_run_id = ? AND id <> ?
               AND state IN ('pending','running','waiting')
           ) OR EXISTS (
             SELECT 1 FROM fleet_runtime_leases
             WHERE owner_type = 'merge_operation' AND owner_id = ?
               AND status = 'reserved'
           )`
        )
        .get(runId, runId, expected.operationId, expected.operationId);
      if (conflictingActivity) {
        throw new Error(
          "A live Fleet landing lease, action, or resource exists"
        );
      }

      const now = deps.now();
      const nowIso = now.toISOString();
      const terminalError =
        `Landing abandoned after authoritative target divergence: observed ${observedTargetSha}; ` +
        `bound base ${expected.baseSha}; exact integration head ${expected.integrationHeadSha}`;
      const runChanged = deps.db
        .prepare(
          `UPDATE fleet_runs
           SET status = 'failed', integration_state = 'failed',
               integration_error = ?, ended_at = COALESCE(ended_at, ?),
               integration_updated_at = ?, updated_at = ?
           WHERE id = ? AND merge_requested_at IS NOT NULL
             AND merge_target = ? AND integration_state = 'awaiting_operator'
             AND status IN ('running','reviewing','merging')
             AND desired_state = 'running' AND recovery_required = 0
             AND plan_hash = ? AND approved_plan_hash = ?
             AND automation_base_sha = ? AND integration_base_sha = ?
             AND integration_head_sha = ?
             AND EXISTS (
               SELECT 1 FROM fleet_merge_operations operation
               WHERE operation.id = ? AND operation.fleet_run_id = fleet_runs.id
                 AND operation.state = 'failed'
                 AND operation.target = ?
                 AND operation.expected_base_sha = ?
                 AND operation.expected_task_head_sha IS NULL
                 AND operation.result_head_sha IS NULL
                 AND operation.lease_owner IS NULL
                 AND operation.lease_expires_at IS NULL
             )`
        )
        .run(
          terminalError,
          nowIso,
          nowIso,
          nowIso,
          runId,
          target,
          expected.planHash,
          expected.planHash,
          expected.baseSha,
          expected.baseSha,
          expected.integrationHeadSha,
          expected.operationId,
          target,
          expected.integrationHeadSha
        );
      if (runChanged.changes !== 1) {
        throw new Error("Failed landing run changed");
      }
      releaseIntegrationWorkspaceResources(deps, runId, now);
      createEvent(
        deps.db,
        runId,
        "fleet_landing_abandoned",
        {
          recovery: "operator_exact_bound_terminal",
          actor: actor.trim().slice(0, 80) || "operator",
          operationId: expected.operationId,
          target,
          targetRef: current.targetRef,
          observedTargetSha,
          requiredBaseSha: expected.baseSha,
          integrationHeadSha: expected.integrationHeadSha,
          outcome: "failed",
          worktreePreserved: true,
        },
        { controlPlane: true }
      );
    });
  } catch (error) {
    return { error: boundedError(error), status: 409 };
  }
  return { abandoned: true, observedTargetSha };
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
    const integrationRef = `refs/heads/${expected.branch}`;
    await assertDirectGitRef(deps, target.repoPath, integrationRef);
    const branchResult = await deps.git(
      target.repoPath,
      ["for-each-ref", "--format=%(objectname)", "--count=2", integrationRef],
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
      // Revalidate immediately before deletion, then delete only if the direct
      // ref still names the exact inspected head. --no-deref and the old-OID
      // compare-and-swap keep a symbolic or concurrently moved ref intact.
      await assertDirectGitRef(deps, target.repoPath, integrationRef);
      await deps.git(
        target.repoPath,
        ["update-ref", "--no-deref", "-d", integrationRef, branchHead],
        30_000,
        4096
      );
      const remaining = await deps.git(
        target.repoPath,
        ["for-each-ref", "--format=%(objectname)", "--count=1", integrationRef],
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
      if (error instanceof FleetMergeRecoveryInProgress) return;
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
      if (run.merge_request_kind !== "manual") {
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
  const claimCandidates = (): FleetMergeRunRow[] => {
    let nextCursor = prepareFleetFairnessCursor(deps.db, "mergePoll");
    const selected = deps.db
      .prepare(
        `SELECT * FROM fleet_runs
         WHERE (
           (merge_requested_at IS NULL
             AND merge_request_kind IS NULL
             AND status NOT IN ('completed','failed','canceled')
             AND desired_state = 'running' AND recovery_required = 0
             AND automation_policy_hash IS NOT NULL) OR
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
         ORDER BY merge_poll_cursor, id LIMIT ?`
      )
      .all(FLEET_MERGE_LIMIT) as FleetMergeRunRow[];
    const advance = deps.db.prepare(
      `UPDATE fleet_runs SET merge_poll_cursor = ? WHERE id = ?`
    );
    return selected.filter(
      (run) => advance.run(++nextCursor, run.id).changes === 1
    );
  };
  const claimedCandidates = onlyRunId
    ? ([queries.getFleetRun(deps.db).get(onlyRunId)].filter(
        Boolean
      ) as FleetMergeRunRow[])
    : transaction(deps.db, claimCandidates);
  const candidates = new Map<string, FleetMergeRunRow>();
  for (const run of claimedCandidates) {
    const isAutomaticCandidate =
      run.merge_requested_at === null &&
      run.merge_request_kind === null &&
      !["completed", "failed", "canceled"].includes(run.status) &&
      run.automation_policy_hash !== null;
    if (isAutomaticCandidate && !launchBlocked) {
      const eligible = autoMergeEligible(deps.db, run.id);
      if (eligible) candidates.set(run.id, eligible.run);
    } else if (
      !launchBlocked ||
      ["completed", "failed", "canceled"].includes(run.status)
    ) {
      candidates.set(run.id, run);
    }
  }
  const persistenceFailures: unknown[] = [];
  for (const run of candidates.values()) {
    try {
      await reconcileOneMerge(deps, run);
    } catch (error) {
      try {
        const now = deps.now().toISOString();
        setRunError(deps.db, run.id, "awaiting_operator", error, now);
        const alreadyRecorded = deps.db
          .prepare(
            `SELECT 1 FROM fleet_events WHERE fleet_run_id = ?
             AND event_type = 'integration_reconcile_failed' LIMIT 1`
          )
          .get(run.id);
        if (!alreadyRecorded) {
          createEvent(
            deps.db,
            run.id,
            "integration_reconcile_failed",
            { error: boundedError(error) },
            { controlPlane: true }
          );
        }
      } catch (persistenceError) {
        persistenceFailures.push(persistenceError);
      }
    }
  }
  if (persistenceFailures.length > 0) {
    const first = persistenceFailures[0];
    throw first instanceof Error
      ? first
      : new Error("failed to persist a Fleet integration error");
  }
}

export const __fleetMergeTesting = {
  fleetMergeLeaseDuration,
  runtimeDeps,
  ensureOperation,
  claimOperation,
  finishOperation,
  assertExactIsolatedHead,
  sanitizeExactVerificationHead,
  integrateTask,
  runFinalVerification,
  consumeAutomaticMergeAuthorization,
  finalizeLocal,
  ensureGitHubPush,
  ensureGitHubPr,
  finalizeGitHub,
};
