import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { runGit } from "@/lib/git";
import { runInBackground } from "@/lib/async-operations";
import {
  parseVerifySteps,
  runVerify,
  VERIFY_TIMEOUT_MS,
  type VerifyResult,
  type VerifyStatus,
} from "@/lib/verification/runner";
import { boundedFleetArtifactJson } from "./report-runtime";
import type {
  FleetTaskStatus,
  FleetVerificationRow,
  FleetVerificationStatus,
} from "./types";

const FLEET_VERIFICATION_SPEC_VERSION = 1;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FLEET_VERIFICATION_ERROR_MAX = 1_000;
const FLEET_VERIFICATION_COMMAND_MAX = 4_000;
const FLEET_VERIFICATION_CANDIDATE_LIMIT = 32;
export const FLEET_VERIFICATION_MAX_PER_TICK = 8;
export const FLEET_VERIFICATION_MAX_CONCURRENT = (() => {
  const raw = Number(process.env.STOA_FLEET_VERIFY_MAX_CONCURRENT ?? 2);
  return Number.isSafeInteger(raw) && raw > 0 ? Math.min(raw, 8) : 2;
})();
export const FLEET_VERIFICATION_LEASE_MS = Math.min(
  Math.max(VERIFY_TIMEOUT_MS + 60_000, 2 * 60_000),
  24 * 60 * 60 * 1000
);

const verificationOwner = randomUUID();
const verificationInFlight = new Set<string>();

export interface FleetVerificationCandidate {
  task_id: string;
  fleet_run_id: string;
  current_attempt: number;
  verify_command: string | null;
  task_base_sha: string | null;
  task_head_sha: string | null;
  task_worktree_path: string | null;
  actual_file_claims_json: string | null;
  report_artifact_id: string | null;
  approved_task_hash: string | null;
  approved_plan_hash: string | null;
  worker_id: string | null;
  worker_attempt: number | null;
  worker_base_sha: string | null;
  worker_head_sha: string | null;
  worker_worktree_path: string | null;
  report_state: string | null;
  report_status: string | null;
}

export interface FleetVerificationSpec {
  specHash: string;
  command: string;
  steps: string[][];
}

export type FleetVerificationSpecResult =
  | { ok: true; spec: FleetVerificationSpec }
  | { ok: false; specHash: string; error: string; command: string };

export interface FleetVerificationDeps {
  db: Database.Database;
  now: () => Date;
  run: (cwd: string, command: string) => Promise<VerifyResult>;
  readHead: (cwd: string) => Promise<string>;
  readStatus: (cwd: string) => Promise<string>;
  launch: (task: () => Promise<void>, name: string) => void;
}

export interface ReconcileFleetVerificationOptions {
  maxPerTick?: number;
  maxConcurrent?: number;
  owner?: string;
  /** Restrict an operator-triggered pass to one exact Fleet run. */
  runId?: string;
  /** Restrict an operator-triggered pass to one exact task in runId. */
  taskId?: string;
}

function deps(
  overrides: Partial<FleetVerificationDeps>
): FleetVerificationDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    run: overrides.run ?? runVerify,
    readHead: overrides.readHead ?? readFleetVerificationHead,
    readStatus: overrides.readStatus ?? readFleetVerificationStatus,
    launch:
      overrides.launch ??
      ((task, name) => {
        runInBackground(task, name);
      }),
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

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cappedPositiveInteger(
  value: number | undefined,
  fallback: number,
  ceiling: number
): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), ceiling)
    : fallback;
}

export function parseFleetVerificationSpec(
  value: string | null | undefined
): FleetVerificationSpecResult {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command) {
    return {
      ok: false,
      command,
      specHash: stableHash({
        version: FLEET_VERIFICATION_SPEC_VERSION,
        invalid: "missing_command",
      }),
      error: "a verification command is required for a write task",
    };
  }
  if (command.length > FLEET_VERIFICATION_COMMAND_MAX) {
    return {
      ok: false,
      command,
      specHash: stableHash({
        version: FLEET_VERIFICATION_SPEC_VERSION,
        invalid: "command_too_long",
      }),
      error: "the verification command exceeds its safety limit",
    };
  }
  const parsed = parseVerifySteps(command);
  if (!("steps" in parsed)) {
    return {
      ok: false,
      command,
      specHash: stableHash({
        version: FLEET_VERIFICATION_SPEC_VERSION,
        invalid: parsed.error,
        command,
      }),
      error: parsed.error,
    };
  }
  const specHash = stableHash({
    version: FLEET_VERIFICATION_SPEC_VERSION,
    steps: parsed.steps,
  });
  return {
    ok: true,
    spec: { specHash, command, steps: parsed.steps.map((step) => [...step]) },
  };
}

export function fleetVerificationAttemptId(input: {
  taskId: string;
  attempt: number;
  headSha: string;
  specHash: string;
}): string {
  return `fleet-verify-${stableHash(input)}`;
}

export async function readFleetVerificationHead(cwd: string): Promise<string> {
  const { stdout } = await runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
    15_000,
    4 * 1024
  );
  const head = stdout.trim().toLowerCase();
  if (!FULL_GIT_SHA.test(head)) {
    throw new Error("Git returned an invalid verification HEAD");
  }
  return head;
}

export async function readFleetVerificationStatus(
  cwd: string
): Promise<string> {
  const { stdout } = await runGit(
    cwd,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    15_000,
    4 * 1024 * 1024
  );
  return stdout;
}

function exactCandidateError(
  candidate: FleetVerificationCandidate
): { code: string; message: string } | null {
  if (
    !Number.isSafeInteger(candidate.current_attempt) ||
    candidate.current_attempt < 1 ||
    candidate.worker_attempt !== candidate.current_attempt
  ) {
    return {
      code: "verification_attempt_mismatch",
      message: "the accepted worker attempt does not match the task attempt",
    };
  }
  if (
    candidate.report_state !== "accepted" ||
    candidate.report_status !== "succeeded" ||
    !candidate.report_artifact_id
  ) {
    return {
      code: "verification_report_required",
      message: "verification requires an accepted successful worker report",
    };
  }
  const taskBase = candidate.task_base_sha?.toLowerCase() ?? "";
  const taskHead = candidate.task_head_sha?.toLowerCase() ?? "";
  if (!FULL_GIT_SHA.test(taskBase) || !FULL_GIT_SHA.test(taskHead)) {
    return {
      code: "verification_sha_required",
      message: "verification requires exact persisted base and head SHAs",
    };
  }
  if (
    candidate.worker_base_sha?.toLowerCase() !== taskBase ||
    candidate.worker_head_sha?.toLowerCase() !== taskHead
  ) {
    return {
      code: "verification_sha_mismatch",
      message: "worker and task verification SHAs do not match",
    };
  }
  if (
    !candidate.task_worktree_path ||
    candidate.worker_worktree_path !== candidate.task_worktree_path
  ) {
    return {
      code: "verification_worktree_mismatch",
      message: "worker and task verification worktrees do not match",
    };
  }
  if (
    !candidate.approved_plan_hash ||
    candidate.approved_task_hash !== candidate.approved_plan_hash
  ) {
    return {
      code: "verification_approval_mismatch",
      message: "the task is no longer bound to its approved plan",
    };
  }
  try {
    const actualClaims = JSON.parse(candidate.actual_file_claims_json ?? "[]");
    if (!Array.isArray(actualClaims) || actualClaims.length === 0) {
      return {
        code: "verification_write_claims_required",
        message: "a write verification requires authoritative changed paths",
      };
    }
  } catch {
    return {
      code: "verification_write_claims_invalid",
      message: "authoritative changed paths are malformed",
    };
  }
  return null;
}

function writePreconditionFailure(
  db: Database.Database,
  candidate: FleetVerificationCandidate,
  input: { code: string; message: string; nowIso: string }
): boolean {
  const artifactId = `fleet-verify-precondition-${stableHash({
    taskId: candidate.task_id,
    attempt: candidate.current_attempt,
    headSha: candidate.task_head_sha,
    code: input.code,
  })}`;
  const evidence = boundedFleetArtifactJson({
    schemaVersion: 1,
    type: "verification_precondition",
    taskId: candidate.task_id,
    attempt: candidate.current_attempt,
    baseSha: candidate.task_base_sha,
    headSha: candidate.task_head_sha,
    code: input.code,
    error: input.message,
  });
  return transaction(db, () => {
    const changed = db
      .prepare(
        `UPDATE fleet_tasks SET status = 'needs_inspection', failure_code = ?,
         verification_status = 'error', verification_artifact_id = ?,
         verification_completed_at = ?, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'verifying'`
      )
      .run(
        input.code,
        artifactId,
        input.nowIso,
        input.nowIso,
        candidate.task_id,
        candidate.fleet_run_id
      );
    if (changed.changes !== 1) return false;
    db.prepare(
      `INSERT OR IGNORE INTO fleet_artifacts
       (id, fleet_run_id, task_id, worker_id, attempt, plan_hash, base_sha,
        head_sha, content_hash, metadata_json, byte_count, artifact_type,
        title, body, severity, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'verification_precondition',
        'Verification precondition failed', ?, 'blocker', 'verifier', ?)`
    ).run(
      artifactId,
      candidate.fleet_run_id,
      candidate.task_id,
      candidate.worker_id,
      candidate.current_attempt,
      candidate.approved_plan_hash,
      candidate.task_base_sha,
      candidate.task_head_sha,
      evidence.contentHash,
      evidence.bytes,
      evidence.body,
      input.nowIso
    );
    queries.createFleetEvent(db).run(
      candidate.fleet_run_id,
      "verification_precondition_failed",
      "verifier",
      JSON.stringify({
        taskId: candidate.task_id,
        attempt: candidate.current_attempt,
        code: input.code,
      })
    );
    return true;
  });
}

function ensureVerificationAttempt(
  db: Database.Database,
  candidate: FleetVerificationCandidate,
  spec: FleetVerificationSpec | { specHash: string; command: string },
  nowIso: string
): FleetVerificationRow {
  const id = fleetVerificationAttemptId({
    taskId: candidate.task_id,
    attempt: candidate.current_attempt,
    headSha: candidate.task_head_sha!,
    specHash: spec.specHash,
  });
  queries
    .createFleetVerification(db)
    .run(
      id,
      candidate.fleet_run_id,
      candidate.task_id,
      candidate.worker_id,
      candidate.current_attempt,
      candidate.task_base_sha,
      candidate.task_head_sha,
      spec.specHash,
      spec.command,
      nowIso,
      nowIso
    );
  return queries
    .getFleetVerificationByIdentity(db)
    .get(
      candidate.task_id,
      candidate.current_attempt,
      candidate.task_head_sha,
      spec.specHash
    ) as FleetVerificationRow;
}

export function claimFleetVerificationAttempt(input: {
  db: Database.Database;
  verificationId: string;
  taskId: string;
  attempt: number;
  headSha: string;
  specHash: string;
  owner: string;
  now: Date;
  leaseMs?: number;
}): boolean {
  const nowIso = input.now.toISOString();
  const leaseMs = input.leaseMs ?? FLEET_VERIFICATION_LEASE_MS;
  const leaseExpiresAt = new Date(input.now.getTime() + leaseMs).toISOString();
  return transaction(input.db, () => {
    const claimed = input.db
      .prepare(
        `UPDATE fleet_verifications SET status = 'running', lease_owner = ?,
         lease_expires_at = ?, run_count = run_count + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?, error = NULL
         WHERE id = ? AND task_id = ? AND attempt = ? AND head_sha = ?
           AND spec_hash = ? AND (
             status = 'pending' OR
             (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
           )`
      )
      .run(
        input.owner,
        leaseExpiresAt,
        nowIso,
        nowIso,
        input.verificationId,
        input.taskId,
        input.attempt,
        input.headSha,
        input.specHash,
        nowIso
      );
    if (claimed.changes !== 1) return false;
    const taskClaimed = input.db
      .prepare(
        `UPDATE fleet_tasks SET verification_id = ?, verification_status = 'running',
         verification_spec_hash = ?, verified_head_sha = NULL,
         verification_started_at = COALESCE(verification_started_at, ?),
         verification_completed_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'verifying' AND current_attempt = ?
           AND head_sha = ?`
      )
      .run(
        input.verificationId,
        input.specHash,
        nowIso,
        nowIso,
        input.taskId,
        input.attempt,
        input.headSha
      );
    if (taskClaimed.changes !== 1) {
      throw new Error(
        "verification task changed while its attempt was claimed"
      );
    }
    return true;
  });
}

function taskOutcome(status: FleetVerificationStatus): {
  taskStatus: FleetTaskStatus;
  failureCode: string | null;
} {
  if (status === "pass") {
    return { taskStatus: "reviewing", failureCode: null };
  }
  if (status === "fail") {
    return { taskStatus: "blocked", failureCode: "verification_failed" };
  }
  return { taskStatus: "needs_inspection", failureCode: "verification_error" };
}

function finalizeVerification(input: {
  db: Database.Database;
  candidate: FleetVerificationCandidate;
  row: FleetVerificationRow;
  owner: string;
  status: Extract<VerifyStatus, "pass" | "fail" | "error">;
  output: string;
  errorCode?: string;
  nowIso: string;
}): boolean {
  const outcome = taskOutcome(input.status);
  const failureCode = input.errorCode ?? outcome.failureCode;
  const artifactId = `${input.row.id}:result`;
  const evidence = boundedFleetArtifactJson({
    schemaVersion: 1,
    verificationId: input.row.id,
    taskId: input.candidate.task_id,
    workerId: input.candidate.worker_id,
    attempt: input.row.attempt,
    baseSha: input.row.base_sha,
    headSha: input.row.head_sha,
    specHash: input.row.spec_hash,
    status: input.status,
    output: input.output,
    errorCode: failureCode,
  });
  return transaction(input.db, () => {
    const finished = input.db
      .prepare(
        `UPDATE fleet_verifications SET status = ?, output_artifact_id = ?,
         output_hash = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_owner = ?
           AND task_id = ? AND attempt = ? AND head_sha = ? AND spec_hash = ?`
      )
      .run(
        input.status,
        artifactId,
        evidence.contentHash,
        input.status === "error"
          ? input.output.slice(-FLEET_VERIFICATION_ERROR_MAX)
          : null,
        input.nowIso,
        input.nowIso,
        input.row.id,
        input.owner,
        input.row.task_id,
        input.row.attempt,
        input.row.head_sha,
        input.row.spec_hash
      );
    if (finished.changes !== 1) return false;
    input.db
      .prepare(
        `INSERT OR IGNORE INTO fleet_artifacts
         (id, fleet_run_id, task_id, worker_id, attempt, plan_hash, base_sha,
          head_sha, content_hash, metadata_json, byte_count, artifact_type,
          title, body, severity, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verification_result',
          'Verification result', ?, ?, 'verifier', ?)`
      )
      .run(
        artifactId,
        input.row.fleet_run_id,
        input.row.task_id,
        input.row.worker_id,
        input.row.attempt,
        input.candidate.approved_plan_hash,
        input.row.base_sha,
        input.row.head_sha,
        evidence.contentHash,
        JSON.stringify({
          verificationId: input.row.id,
          status: input.status,
          specHash: input.row.spec_hash,
        }),
        evidence.bytes,
        evidence.body,
        input.status === "pass" ? "info" : "blocker",
        input.nowIso
      );
    const taskUpdated = input.db
      .prepare(
        `UPDATE fleet_tasks SET status = ?, failure_code = ?, verification_id = ?,
         verification_status = ?, verification_spec_hash = ?,
         verified_head_sha = CASE WHEN ? = 'pass' THEN ? ELSE NULL END,
         verification_artifact_id = ?, verification_completed_at = ?,
         updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'verifying'
           AND current_attempt = ? AND head_sha = ? AND verification_id = ?
           AND verification_spec_hash = ?`
      )
      .run(
        outcome.taskStatus,
        failureCode,
        input.row.id,
        input.status,
        input.row.spec_hash,
        input.status,
        input.row.head_sha,
        artifactId,
        input.nowIso,
        input.nowIso,
        input.row.task_id,
        input.row.fleet_run_id,
        input.row.attempt,
        input.row.head_sha,
        input.row.id,
        input.row.spec_hash
      );
    queries.createFleetEvent(input.db).run(
      input.row.fleet_run_id,
      taskUpdated.changes === 1
        ? "verification_completed"
        : "verification_result_stale",
      "verifier",
      JSON.stringify({
        verificationId: input.row.id,
        taskId: input.row.task_id,
        attempt: input.row.attempt,
        headSha: input.row.head_sha,
        status: input.status,
        failureCode,
      })
    );
    return taskUpdated.changes === 1;
  });
}

function applyTerminalAttempt(
  db: Database.Database,
  candidate: FleetVerificationCandidate,
  row: FleetVerificationRow,
  nowIso: string
): boolean {
  if (!["pass", "fail", "error"].includes(row.status)) return false;
  const outcome = taskOutcome(row.status);
  return (
    db
      .prepare(
        `UPDATE fleet_tasks SET status = ?, failure_code = ?, verification_id = ?,
         verification_status = ?, verification_spec_hash = ?,
         verified_head_sha = CASE WHEN ? = 'pass' THEN ? ELSE NULL END,
         verification_artifact_id = ?, verification_started_at = ?,
         verification_completed_at = ?, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'verifying'
           AND current_attempt = ? AND head_sha = ?`
      )
      .run(
        outcome.taskStatus,
        outcome.failureCode,
        row.id,
        row.status,
        row.spec_hash,
        row.status,
        row.head_sha,
        row.output_artifact_id,
        row.started_at,
        row.completed_at,
        nowIso,
        candidate.task_id,
        candidate.fleet_run_id,
        candidate.current_attempt,
        row.head_sha
      ).changes === 1
  );
}

async function executeVerification(
  runtime: FleetVerificationDeps,
  candidate: FleetVerificationCandidate,
  row: FleetVerificationRow,
  owner: string
): Promise<void> {
  let result: VerifyResult;
  try {
    const [beforeHead, beforeStatus] = await Promise.all([
      runtime.readHead(candidate.task_worktree_path!),
      runtime.readStatus(candidate.task_worktree_path!),
    ]);
    if (beforeHead !== row.head_sha) {
      result = {
        status: "error",
        output: `verification HEAD drifted before execution (expected ${row.head_sha}, found ${beforeHead})`,
      };
      finalizeVerification({
        db: runtime.db,
        candidate,
        row,
        owner,
        status: "error",
        output: result.output,
        errorCode: "verification_head_drift",
        nowIso: runtime.now().toISOString(),
      });
      return;
    }
    if (beforeStatus !== "") {
      result = {
        status: "error",
        output: "verification worktree was not clean before execution",
      };
      finalizeVerification({
        db: runtime.db,
        candidate,
        row,
        owner,
        status: "error",
        output: result.output,
        errorCode: "verification_worktree_dirty",
        nowIso: runtime.now().toISOString(),
      });
      return;
    }
    result = await runtime.run(candidate.task_worktree_path!, row.command);
    const [afterHead, afterStatus] = await Promise.all([
      runtime.readHead(candidate.task_worktree_path!),
      runtime.readStatus(candidate.task_worktree_path!),
    ]);
    if (afterHead !== row.head_sha) {
      result = {
        status: "error",
        output: `verification HEAD drifted during execution (expected ${row.head_sha}, found ${afterHead})`,
      };
      finalizeVerification({
        db: runtime.db,
        candidate,
        row,
        owner,
        status: "error",
        output: result.output,
        errorCode: "verification_head_drift",
        nowIso: runtime.now().toISOString(),
      });
      return;
    }
    if (afterStatus !== beforeStatus || afterStatus !== "") {
      result = {
        status: "error",
        output: "verification mutated the committed worktree",
      };
      finalizeVerification({
        db: runtime.db,
        candidate,
        row,
        owner,
        status: "error",
        output: result.output,
        errorCode: "verification_worktree_drift",
        nowIso: runtime.now().toISOString(),
      });
      return;
    }
  } catch (error) {
    result = {
      status: "error",
      output:
        error instanceof Error
          ? error.message.slice(-FLEET_VERIFICATION_ERROR_MAX)
          : "verification execution failed",
    };
  }
  finalizeVerification({
    db: runtime.db,
    candidate,
    row,
    owner,
    status: result.status === "running" ? "error" : result.status,
    output: result.output,
    nowIso: runtime.now().toISOString(),
  });
}

/**
 * Claim and launch a bounded number of exact-SHA Fleet verification attempts.
 * Slow commands run in the injected/background launcher, so the server tick is
 * never held for the duration of a build.
 */
export async function reconcileFleetVerifications(
  overrides: Partial<FleetVerificationDeps> = {},
  options: ReconcileFleetVerificationOptions = {}
): Promise<number> {
  const runtime = deps(overrides);
  const owner = options.owner ?? verificationOwner;
  const maxPerTick = cappedPositiveInteger(
    options.maxPerTick,
    FLEET_VERIFICATION_MAX_PER_TICK,
    32
  );
  const maxConcurrent = cappedPositiveInteger(
    options.maxConcurrent,
    FLEET_VERIFICATION_MAX_CONCURRENT,
    8
  );
  const candidates = (
    queries
      .listFleetVerificationCandidates(runtime.db)
      .all(FLEET_VERIFICATION_CANDIDATE_LIMIT) as FleetVerificationCandidate[]
  ).filter(
    (candidate) =>
      (!options.runId || candidate.fleet_run_id === options.runId) &&
      (!options.taskId || candidate.task_id === options.taskId)
  );
  let processed = 0;

  for (const candidate of candidates) {
    if (processed >= maxPerTick) break;
    const now = runtime.now();
    const nowIso = now.toISOString();
    const precondition = exactCandidateError(candidate);
    if (precondition) {
      if (
        writePreconditionFailure(runtime.db, candidate, {
          ...precondition,
          nowIso,
        })
      ) {
        processed += 1;
      }
      continue;
    }

    const parsed = parseFleetVerificationSpec(candidate.verify_command);
    const spec = parsed.ok
      ? parsed.spec
      : { specHash: parsed.specHash, command: parsed.command };
    const row = ensureVerificationAttempt(runtime.db, candidate, spec, nowIso);
    if (["pass", "fail", "error"].includes(row.status)) {
      if (applyTerminalAttempt(runtime.db, candidate, row, nowIso)) {
        processed += 1;
      }
      continue;
    }
    if (!parsed.ok) {
      if (
        claimFleetVerificationAttempt({
          db: runtime.db,
          verificationId: row.id,
          taskId: row.task_id,
          attempt: row.attempt,
          headSha: row.head_sha,
          specHash: row.spec_hash,
          owner,
          now,
        })
      ) {
        finalizeVerification({
          db: runtime.db,
          candidate,
          row: { ...row, status: "running", lease_owner: owner },
          owner,
          status: "error",
          output: parsed.error,
          errorCode: candidate.verify_command
            ? "verification_command_invalid"
            : "verification_command_required",
          nowIso,
        });
        processed += 1;
      }
      continue;
    }
    if (
      verificationInFlight.size >= maxConcurrent ||
      verificationInFlight.has(row.id)
    ) {
      continue;
    }
    const claimed = claimFleetVerificationAttempt({
      db: runtime.db,
      verificationId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      headSha: row.head_sha,
      specHash: row.spec_hash,
      owner,
      now,
    });
    if (!claimed) continue;

    verificationInFlight.add(row.id);
    const runningRow: FleetVerificationRow = {
      ...row,
      status: "running",
      lease_owner: owner,
      run_count: row.run_count + 1,
      started_at: row.started_at ?? nowIso,
      updated_at: nowIso,
    };
    try {
      runtime.launch(async () => {
        try {
          await executeVerification(runtime, candidate, runningRow, owner);
        } finally {
          verificationInFlight.delete(row.id);
        }
      }, `fleet-verify-${candidate.task_id}-${candidate.current_attempt}`);
      processed += 1;
    } catch (error) {
      verificationInFlight.delete(row.id);
      finalizeVerification({
        db: runtime.db,
        candidate,
        row: runningRow,
        owner,
        status: "error",
        output:
          error instanceof Error ? error.message : "verification launch failed",
        errorCode: "verification_launch_failed",
        nowIso: runtime.now().toISOString(),
      });
      processed += 1;
    }
  }
  return processed;
}

export function fleetVerificationInFlightCount(): number {
  return verificationInFlight.size;
}
