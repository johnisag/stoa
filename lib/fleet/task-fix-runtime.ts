import { detectSandboxTool } from "@/lib/sandbox/detect";
import type { ApprovalMode } from "@/lib/sandbox/types";
import type Database from "better-sqlite3";
import { queries, type Session } from "@/lib/db";
import { WorkerSpawnError } from "@/lib/orchestration";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import { parseFleetAutomationPolicy } from "./automation-policy";
import type { FleetArtifactReadResult } from "./artifacts";
import {
  collectFleetGitState,
  compareFleetPathClaims,
  type FleetGitState,
} from "./git-state";
import { hashFleetAutomationPolicy } from "./hash";
import {
  fleetPlanReviewerApprovalMode,
  type FleetPlanReviewFinding,
} from "./plan-review";
import { boundedFleetArtifactJson } from "./report-runtime";
import {
  buildFleetTaskFixPrompt,
  FLEET_TASK_REVIEW_RESULT_MAX_BYTES,
  hashFleetTaskRuntimeNonce,
  parseFleetTaskFixResult,
  parseFleetTaskReviewFindings,
  parseFleetTaskStringArray,
  type TaskFixCandidate,
  type TaskFixContract,
} from "./task-review-contract";
import type { FleetTaskFixRow } from "./types";

const FIX_TIMEOUT_MS = 30 * 60 * 1_000;
export const FLEET_TASK_FIX_SPAWN_RECOVERY_GRACE_MS = 90 * 1_000;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

interface FixSpawnResult {
  id: string;
}

export interface FleetTaskFixRuntimeDeps {
  db: Database.Database;
  now: () => Date;
  randomId: () => string;
  randomNonce: () => string;
  prepareResultPath: (input: {
    kind: "reviews" | "fixes";
    runId: string;
    taskId: string;
    attempt: number;
    requestId: string;
  }) => Promise<string>;
  readResult: (
    filePath: string,
    maxBytes: number,
    label?: string
  ) => Promise<FleetArtifactReadResult>;
  removeResult: (path: string) => Promise<boolean>;
  sessionExists: (db: Database.Database, sessionId: string) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<boolean>;
  git: (
    cwd: string,
    args: string[],
    timeout: number,
    maxBuffer?: number,
    env?: Record<string, string>
  ) => Promise<{ stdout: string; stderr: string }>;
  collectGitState: typeof collectFleetGitState;
  spawnFix: (input: {
    contract: TaskFixContract;
    row: FleetTaskFixRow;
    prompt: string;
    persistedPrompt: string;
    approvalMode: ApprovalMode;
  }) => Promise<FixSpawnResult>;
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

function event(
  db: Database.Database,
  runId: string,
  type: string,
  payload: unknown
): void {
  queries
    .createFleetEvent(db)
    .run(runId, type, "fleet-task-review", JSON.stringify(payload));
}

function artifact(
  db: Database.Database,
  input: {
    id: string;
    runId: string;
    taskId: string;
    workerId?: string | null;
    attempt: number;
    planHash: string | null;
    baseSha: string;
    headSha: string;
    artifactType: string;
    title: string;
    body: string;
    metadata: unknown;
    severity: "info" | "warning" | "blocker";
    actor: string;
    nowIso: string;
  }
): void {
  const bounded = boundedFleetArtifactJson({
    schemaVersion: 1,
    metadata: input.metadata,
    body: input.body,
  });
  db.prepare(
    `INSERT OR IGNORE INTO fleet_artifacts
     (id, fleet_run_id, task_id, worker_id, attempt, plan_hash, base_sha,
      head_sha, content_hash, metadata_json, byte_count, artifact_type,
      title, body, severity, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.runId,
    input.taskId,
    input.workerId ?? null,
    input.attempt,
    input.planHash,
    input.baseSha,
    input.headSha,
    bounded.contentHash,
    JSON.stringify(input.metadata),
    bounded.bytes,
    input.artifactType,
    input.title.slice(0, 240),
    input.body.slice(0, 64 * 1024),
    input.severity,
    input.actor,
    input.nowIso
  );
}

function provider(value: string): ProviderId {
  if (!PROVIDER_IDS.includes(value as ProviderId) || value === "shell") {
    throw new Error(`unsupported Fleet automatic fixer provider: ${value}`);
  }
  return value as ProviderId;
}

function approvalMode(policy: TaskFixContract["policy"]): ApprovalMode {
  const sandboxEnabled = process.env.STOA_SANDBOX === "1";
  return fleetPlanReviewerApprovalMode(policy, {
    sandboxEnabled,
    confinementAvailable: sandboxEnabled && detectSandboxTool() !== null,
  });
}

function parseStoredFindings(value: string): FleetPlanReviewFinding[] {
  try {
    return parseFleetTaskReviewFindings(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

function loadFixContract(
  deps: FleetTaskFixRuntimeDeps,
  row: FleetTaskFixRow
): { contract: TaskFixContract } | { error: string } {
  const candidate = deps.db
    .prepare(
      `SELECT
         t.id AS task_id, t.fleet_run_id, t.current_attempt,
         t.file_claims_json, t.actual_file_claims_json,
         t.agent_type AS task_agent_type, t.model AS task_model,
         t.working_directory AS project_path,
         t.worktree_path AS task_worktree_path,
         t.branch_name AS task_branch_name, t.base_branch AS task_base_branch,
         t.base_sha AS task_base_sha, t.head_sha AS task_head_sha,
         t.status AS task_status, t.active_fix_id,
         t.review_verification_hash, t.approved_task_hash,
         r.status AS run_status, r.desired_state, r.provider AS run_provider,
         r.model AS run_model, r.approved_plan_hash,
         r.automation_policy_json, r.automation_policy_hash,
         r.conductor_session_id
       FROM fleet_tasks t
       JOIN fleet_runs r ON r.id = t.fleet_run_id
       WHERE t.id = ? AND t.fleet_run_id = ?`
    )
    .get(row.task_id, row.fleet_run_id) as TaskFixCandidate | undefined;
  if (!candidate) return { error: "automatic fix task no longer exists" };
  if (
    candidate.task_status !== "fixing" ||
    candidate.active_fix_id !== row.id ||
    candidate.current_attempt !== row.attempt ||
    candidate.task_head_sha?.toLowerCase() !== row.old_head_sha.toLowerCase() ||
    candidate.review_verification_hash !== row.verification_evidence_hash
  ) {
    return { error: "automatic fix task identity was superseded" };
  }
  if (
    candidate.run_status !== "running" ||
    candidate.desired_state !== "running"
  ) {
    return { error: "automatic fix requires an actively running Fleet run" };
  }
  if (
    !candidate.task_base_sha ||
    !FULL_SHA.test(candidate.task_base_sha) ||
    !candidate.task_worktree_path ||
    candidate.task_worktree_path !== row.worktree_path ||
    !candidate.task_branch_name ||
    candidate.task_branch_name !== row.branch_name ||
    !candidate.project_path ||
    candidate.project_path !== row.project_path
  ) {
    return { error: "automatic fix owned worktree identity is invalid" };
  }
  if (
    !candidate.approved_plan_hash ||
    candidate.approved_task_hash !== candidate.approved_plan_hash
  ) {
    return {
      error: "automatic fix task is no longer bound to its approved plan",
    };
  }
  const parsed = parseFleetAutomationPolicy(candidate.automation_policy_json);
  if (
    !parsed.valid ||
    candidate.automation_policy_hash !== row.policy_hash ||
    hashFleetAutomationPolicy(parsed.policy) !== row.policy_hash ||
    !parsed.policy.automaticFixes ||
    row.round > parsed.policy.maxAutomaticFixRounds
  ) {
    return { error: "automatic fix policy binding is invalid or exhausted" };
  }
  const authorization = deps.db
    .prepare(
      `SELECT status FROM fleet_action_authorizations
       WHERE fleet_run_id = ? AND action = 'fix' AND policy_hash = ?`
    )
    .get(row.fleet_run_id, row.policy_hash) as { status: string } | undefined;
  if (authorization?.status !== "authorized") {
    return { error: "automatic fix authorization is no longer active" };
  }
  let fixerProvider: ProviderId;
  try {
    fixerProvider = provider(
      candidate.task_agent_type ?? candidate.run_provider
    );
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "automatic fix provider is invalid",
    };
  }
  return {
    contract: {
      candidate,
      policy: parsed.policy,
      policyHash: row.policy_hash,
      provider: fixerProvider,
    },
  };
}

function validateGitState(
  state: FleetGitState,
  input: {
    expectedBranch: string;
    plannedClaims: string[];
    allowSensitivePaths: boolean;
    requireChanges: boolean;
  }
): string | null {
  if (state.currentBranch !== input.expectedBranch) {
    return "automatic fixer branch identity changed";
  }
  if (
    state.stagedChanges.length > 0 ||
    state.unstagedChanges.length > 0 ||
    state.untrackedPaths.length > 0
  ) {
    return "automatic fixer left staged, unstaged, or untracked files";
  }
  if (input.requireChanges && state.committedChanges.length === 0) {
    return "automatic fixer produced no committed task changes";
  }
  const claims = compareFleetPathClaims(
    input.plannedClaims,
    state.allTouchedPaths
  );
  if (claims.hasDrift) {
    return `automatic fixer changed paths outside approved claims: ${
      claims.driftPaths.slice(0, 10).join(", ") || "invalid claim/path evidence"
    }`;
  }
  if (!input.allowSensitivePaths && state.sensitivePaths.length > 0) {
    return `automatic fixer touched sensitive paths without authorization: ${state.sensitivePaths
      .slice(0, 10)
      .map((item) => item.path)
      .join(", ")}`;
  }
  return null;
}

export function recordFleetTaskFixFailure(
  deps: FleetTaskFixRuntimeDeps,
  row: FleetTaskFixRow,
  message: string
): boolean {
  const nowIso = deps.now().toISOString();
  const boundedMessage = message.slice(0, 1_000);
  const changed = transaction(deps.db, () => {
    const fixChanged = deps.db
      .prepare(
        `UPDATE fleet_task_fixes
         SET state = 'failed', error = ?, completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ? AND state IN ('pending','spawning','running')`
      )
      .run(boundedMessage, nowIso, nowIso, row.id);
    if (fixChanged.changes !== 1) return false;
    deps.db
      .prepare(
        `UPDATE fleet_tasks
         SET status = 'needs_inspection', failure_code = 'automatic_fix_failed',
             active_fix_id = NULL, fixer_session_id = NULL, fix_error = ?,
             updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'fixing'
           AND active_fix_id = ? AND current_attempt = ? AND head_sha = ?`
      )
      .run(
        boundedMessage,
        nowIso,
        row.task_id,
        row.fleet_run_id,
        row.id,
        row.attempt,
        row.old_head_sha
      );
    artifact(deps.db, {
      id: `${row.id}:failure`,
      runId: row.fleet_run_id,
      taskId: row.task_id,
      attempt: row.attempt,
      planHash: null,
      baseSha: row.old_head_sha,
      headSha: row.old_head_sha,
      artifactType: "task_fix_failure",
      title: `Automatic fix round ${row.round} needs operator inspection`,
      body: boundedMessage,
      metadata: {
        fixId: row.id,
        round: row.round,
        oldHeadSha: row.old_head_sha,
        verificationEvidenceHash: row.verification_evidence_hash,
        policyHash: row.policy_hash,
      },
      severity: "blocker",
      actor: "fleet-task-fixer",
      nowIso,
    });
    event(deps.db, row.fleet_run_id, "task_fix_failed", {
      fixId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      round: row.round,
      oldHeadSha: row.old_head_sha,
      error: boundedMessage,
    });
    return true;
  });
  if (row.result_path) void deps.removeResult(row.result_path);
  return changed;
}

export async function recoverSpawningFleetTaskFix(
  deps: FleetTaskFixRuntimeDeps,
  row: FleetTaskFixRow
): Promise<FleetTaskFixRow> {
  if (!row.worktree_path || !row.result_path) return row;
  const session = deps.db
    .prepare(
      `SELECT * FROM sessions
       WHERE working_directory = ? AND instr(worker_task, ?) > 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(row.worktree_path, row.result_path) as Session | undefined;
  if (session) {
    transaction(deps.db, () => {
      const changed = deps.db
        .prepare(
          `UPDATE fleet_task_fixes
           SET state = 'running', fixer_session_id = ?, updated_at = ?
           WHERE id = ? AND state = 'spawning' AND request_id = ?`
        )
        .run(session.id, deps.now().toISOString(), row.id, row.request_id);
      if (changed.changes === 1) {
        deps.db
          .prepare(
            `UPDATE fleet_tasks SET fixer_session_id = ?, updated_at = ?
             WHERE id = ? AND status = 'fixing' AND active_fix_id = ?`
          )
          .run(session.id, deps.now().toISOString(), row.task_id, row.id);
      }
    });
  }
  return (deps.db
    .prepare(`SELECT * FROM fleet_task_fixes WHERE id = ?`)
    .get(row.id) ?? row) as FleetTaskFixRow;
}

async function startFix(
  deps: FleetTaskFixRuntimeDeps,
  contract: TaskFixContract,
  row: FleetTaskFixRow
): Promise<void> {
  const candidate = contract.candidate;
  let before: FleetGitState;
  try {
    before = await deps.collectGitState({
      cwd: row.worktree_path!,
      baseSha: candidate.task_base_sha!,
      expectedHeadSha: row.old_head_sha,
      limits: { maxGitOutputBytes: 2 * 1024 * 1024, maxPaths: 500 },
    });
  } catch {
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fix preflight could not verify the exact owned task HEAD"
    );
    return;
  }
  const preflightError = validateGitState(before, {
    expectedBranch: row.branch_name!,
    plannedClaims: parseFleetTaskStringArray(candidate.file_claims_json),
    allowSensitivePaths: contract.policy.allowSensitivePaths,
    requireChanges: true,
  });
  if (preflightError) {
    recordFleetTaskFixFailure(deps, row, preflightError);
    return;
  }
  const mode = approvalMode(contract.policy);
  if (mode === "prompt") {
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fix requires active confinement or explicit unconfined-agent authorization"
    );
    return;
  }
  const requestId = deps.randomId();
  const nonce = deps.randomNonce();
  const resultPath = await deps.prepareResultPath({
    kind: "fixes",
    runId: row.fleet_run_id,
    taskId: row.task_id,
    attempt: row.attempt,
    requestId,
  });
  const started = deps.now();
  const claimed = deps.db
    .prepare(
      `UPDATE fleet_task_fixes
       SET state = 'spawning', request_id = ?, nonce_hash = ?, result_path = ?,
           started_at = ?, deadline_at = ?, error = NULL, updated_at = ?
       WHERE id = ? AND state = 'pending' AND old_head_sha = ?`
    )
    .run(
      requestId,
      // The plaintext nonce is delivered once and never persisted.
      hashFleetTaskRuntimeNonce(nonce),
      resultPath,
      started.toISOString(),
      new Date(started.getTime() + FIX_TIMEOUT_MS).toISOString(),
      started.toISOString(),
      row.id,
      row.old_head_sha
    );
  if (claimed.changes !== 1) return;
  const findings = parseStoredFindings(row.findings_json);
  event(deps.db, row.fleet_run_id, "task_fix_spawn_requested", {
    fixId: row.id,
    taskId: row.task_id,
    attempt: row.attempt,
    round: row.round,
    requestId,
    oldHeadSha: row.old_head_sha,
  });
  let spawned: FixSpawnResult | null = null;
  try {
    spawned = await deps.spawnFix({
      contract,
      row: { ...row, result_path: resultPath },
      prompt: buildFleetTaskFixPrompt({
        contract,
        row,
        nonce,
        resultPath,
        findings,
      }),
      persistedPrompt: buildFleetTaskFixPrompt({
        contract,
        row,
        nonce: "[redacted ephemeral nonce]",
        resultPath,
        findings,
      }),
      approvalMode: mode,
    });
    const updated = transaction(deps.db, () => {
      const fixChanged = deps.db
        .prepare(
          `UPDATE fleet_task_fixes
           SET state = 'running', fixer_session_id = ?, updated_at = ?
           WHERE id = ? AND state = 'spawning' AND request_id = ?`
        )
        .run(spawned!.id, deps.now().toISOString(), row.id, requestId);
      if (fixChanged.changes !== 1) return false;
      const taskChanged = deps.db
        .prepare(
          `UPDATE fleet_tasks SET fixer_session_id = ?, updated_at = ?
           WHERE id = ? AND status = 'fixing' AND active_fix_id = ?
             AND current_attempt = ? AND head_sha = ?`
        )
        .run(
          spawned!.id,
          deps.now().toISOString(),
          row.task_id,
          row.id,
          row.attempt,
          row.old_head_sha
        );
      if (taskChanged.changes !== 1) {
        throw new Error("automatic fix task changed during spawn");
      }
      return true;
    });
    if (!updated) {
      await deps.stopSession(spawned.id, "failed").catch(() => false);
      return;
    }
    event(deps.db, row.fleet_run_id, "task_fix_started", {
      fixId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      round: row.round,
      fixerSessionId: spawned.id,
      oldHeadSha: row.old_head_sha,
    });
  } catch (error) {
    const sessionId =
      spawned?.id ??
      (error instanceof WorkerSpawnError ? error.sessionId : null) ??
      "";
    deps.db
      .prepare(
        `UPDATE fleet_task_fixes SET fixer_session_id = ?, updated_at = ?
         WHERE id = ? AND state = 'spawning' AND request_id = ?`
      )
      .run(sessionId, deps.now().toISOString(), row.id, requestId);
    if (sessionId) {
      const stopped = await deps
        .stopSession(sessionId, "failed")
        .catch(() => false);
      if (!stopped) return;
    }
    const latest = deps.db
      .prepare(`SELECT * FROM fleet_task_fixes WHERE id = ?`)
      .get(row.id) as FleetTaskFixRow;
    recordFleetTaskFixFailure(
      deps,
      latest,
      error instanceof Error ? error.message : "automatic fixer failed to start"
    );
  }
}

async function isDescendantCommit(
  deps: FleetTaskFixRuntimeDeps,
  worktreePath: string,
  oldHeadSha: string,
  newHeadSha: string
): Promise<boolean> {
  try {
    const mergeBase = (
      await deps.git(
        worktreePath,
        ["merge-base", oldHeadSha, newHeadSha],
        10_000,
        4 * 1024
      )
    ).stdout
      .trim()
      .toLowerCase();
    if (mergeBase !== oldHeadSha.toLowerCase()) return false;
    const count = (
      await deps.git(
        worktreePath,
        ["rev-list", "--count", `${oldHeadSha}..${newHeadSha}`],
        10_000,
        4 * 1024
      )
    ).stdout.trim();
    return /^(?:[1-9][0-9]*)$/.test(count);
  } catch {
    return false;
  }
}

function finalizeFix(
  deps: FleetTaskFixRuntimeDeps,
  contract: TaskFixContract,
  row: FleetTaskFixRow,
  input: {
    newHeadSha: string;
    summary: string;
    bytes: number;
    gitState: FleetGitState;
  }
): boolean {
  const candidate = contract.candidate;
  const nowIso = deps.now().toISOString();
  const workerId = deps.randomId();
  const reportArtifactId = `${row.id}:report`;
  const gitArtifactId = `${row.id}:git-state`;
  const resolutionArtifactId = `${row.id}:review-resolution`;
  const reviewRows = deps.db
    .prepare(
      `SELECT id, lens, verdict FROM fleet_task_reviews
       WHERE task_id = ? AND attempt = ? AND head_sha = ?
         AND verification_evidence_hash = ? AND policy_hash = ?
       ORDER BY lens ASC`
    )
    .all(
      row.task_id,
      row.attempt,
      row.old_head_sha,
      row.verification_evidence_hash,
      row.policy_hash
    ) as Array<{ id: string; lens: string; verdict: string }>;
  const actualClaims = input.gitState.allTouchedPaths;
  return transaction(deps.db, () => {
    deps.db
      .prepare(
        `INSERT INTO fleet_workers
         (id, fleet_run_id, task_id, session_id, status, provider, model,
          attempt, spawn_request_id, worktree_path, branch_name, base_sha,
          head_sha, report_path, report_nonce_hash, report_state, report_status,
          report_submitted_at, report_collected_at, report_bytes,
          actual_claims_json, diff_summary_json, terminal_cause, created_at,
          last_heartbeat_at, ended_at)
         VALUES (?, ?, ?, ?, 'cleanup_complete', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'accepted', 'succeeded', ?, ?, ?, ?, ?, 'automatic_fix', ?, ?, ?)`
      )
      .run(
        workerId,
        row.fleet_run_id,
        row.task_id,
        row.fixer_session_id,
        contract.provider,
        candidate.task_model ?? candidate.run_model,
        row.attempt,
        `fix:${row.id}`,
        row.worktree_path,
        row.branch_name,
        candidate.task_base_sha,
        input.newHeadSha,
        row.result_path,
        row.nonce_hash,
        nowIso,
        nowIso,
        input.bytes,
        JSON.stringify(actualClaims),
        JSON.stringify(input.gitState.summary),
        row.started_at ?? nowIso,
        nowIso,
        nowIso
      );
    const fixChanged = deps.db
      .prepare(
        `UPDATE fleet_task_fixes
         SET state = 'completed', worker_id = ?, new_head_sha = ?,
             result_bytes = ?, error = NULL, completed_at = ?, updated_at = ?
         WHERE id = ? AND state = 'running' AND old_head_sha = ?
           AND fixer_session_id = ?`
      )
      .run(
        workerId,
        input.newHeadSha,
        input.bytes,
        nowIso,
        nowIso,
        row.id,
        row.old_head_sha,
        row.fixer_session_id
      );
    if (fixChanged.changes !== 1) return false;
    artifact(deps.db, {
      id: reportArtifactId,
      runId: row.fleet_run_id,
      taskId: row.task_id,
      workerId,
      attempt: row.attempt,
      planHash: candidate.approved_plan_hash,
      baseSha: candidate.task_base_sha!,
      headSha: input.newHeadSha,
      artifactType: "automatic_fix_report",
      title: `Automatic fix round ${row.round} report`,
      body: input.summary,
      metadata: {
        fixId: row.id,
        round: row.round,
        oldHeadSha: row.old_head_sha,
        newHeadSha: input.newHeadSha,
        verificationEvidenceHash: row.verification_evidence_hash,
        policyHash: row.policy_hash,
      },
      severity: "info",
      actor: "fleet-task-fixer",
      nowIso,
    });
    artifact(deps.db, {
      id: gitArtifactId,
      runId: row.fleet_run_id,
      taskId: row.task_id,
      workerId,
      attempt: row.attempt,
      planHash: candidate.approved_plan_hash,
      baseSha: candidate.task_base_sha!,
      headSha: input.newHeadSha,
      artifactType: "fix_git_state",
      title: `Authoritative Git evidence for fix round ${row.round}`,
      body: JSON.stringify({
        summary: input.gitState.summary,
        committedChanges: input.gitState.committedChanges,
        sensitivePaths: input.gitState.sensitivePaths,
      }),
      metadata: {
        fixId: row.id,
        round: row.round,
        oldHeadSha: row.old_head_sha,
        newHeadSha: input.newHeadSha,
        branchName: input.gitState.currentBranch,
      },
      severity: "info",
      actor: "fleet-task-fixer",
      nowIso,
    });
    artifact(deps.db, {
      id: resolutionArtifactId,
      runId: row.fleet_run_id,
      taskId: row.task_id,
      workerId,
      attempt: row.attempt,
      planHash: candidate.approved_plan_hash,
      baseSha: candidate.task_base_sha!,
      headSha: input.newHeadSha,
      artifactType: "task_review_resolution",
      title: `Review findings superseded by fix round ${row.round}`,
      body: "Historical review findings remain immutable audit evidence and are superseded only for the new exact task HEAD.",
      metadata: {
        fixId: row.id,
        reviewIds: reviewRows.map((review) => review.id),
        oldHeadSha: row.old_head_sha,
        newHeadSha: input.newHeadSha,
        oldVerificationEvidenceHash: row.verification_evidence_hash,
        policyHash: row.policy_hash,
      },
      severity: "info",
      actor: "fleet-task-fixer",
      nowIso,
    });
    const taskChanged = deps.db
      .prepare(
        `UPDATE fleet_tasks
         SET status = 'verifying', head_sha = ?,
             actual_file_claims_json = ?, report_artifact_id = ?,
             diff_artifact_id = ?, verification_id = NULL,
             verification_status = NULL, verification_spec_hash = NULL,
             verified_head_sha = NULL, verification_artifact_id = NULL,
             verification_started_at = NULL, verification_completed_at = NULL,
             review_status = NULL, review_head_sha = NULL,
             review_verification_hash = NULL, review_completed_at = NULL,
             active_fix_id = NULL, fixer_session_id = NULL, fix_error = NULL,
             failure_code = NULL, ended_at = NULL, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'fixing'
           AND active_fix_id = ? AND current_attempt = ? AND head_sha = ?
           AND review_verification_hash = ?
           AND EXISTS (
             SELECT 1 FROM fleet_runs r
             WHERE r.id = fleet_tasks.fleet_run_id
               AND r.status = 'running' AND r.desired_state = 'running'
               AND r.automation_policy_hash = ?
           )`
      )
      .run(
        input.newHeadSha,
        JSON.stringify(actualClaims),
        reportArtifactId,
        gitArtifactId,
        nowIso,
        row.task_id,
        row.fleet_run_id,
        row.id,
        row.attempt,
        row.old_head_sha,
        row.verification_evidence_hash,
        row.policy_hash
      );
    if (taskChanged.changes !== 1) {
      throw new Error("automatic fix task changed before exact-head CAS");
    }
    event(deps.db, row.fleet_run_id, "task_review_resolved_by_fix", {
      fixId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      round: row.round,
      reviewIds: reviewRows.map((review) => review.id),
      oldHeadSha: row.old_head_sha,
      newHeadSha: input.newHeadSha,
      oldVerificationEvidenceHash: row.verification_evidence_hash,
      policyHash: row.policy_hash,
      historicalArtifactsImmutable: true,
    });
    event(deps.db, row.fleet_run_id, "task_fix_completed", {
      fixId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      round: row.round,
      oldHeadSha: row.old_head_sha,
      newHeadSha: input.newHeadSha,
      workerId,
    });
    return true;
  });
}

async function pollRunningFix(
  deps: FleetTaskFixRuntimeDeps,
  contract: TaskFixContract,
  row: FleetTaskFixRow
): Promise<void> {
  const deadline = Date.parse(row.deadline_at ?? "");
  const timedOut =
    !Number.isFinite(deadline) || deps.now().getTime() > deadline;
  if (!row.fixer_session_id || !row.result_path || !row.worktree_path) {
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fixer identity is incomplete"
    );
    return;
  }
  const result = await deps.readResult(
    row.result_path,
    FLEET_TASK_REVIEW_RESULT_MAX_BYTES,
    "Fleet automatic fix result"
  );
  if (!result.ok) {
    const alive = await deps.sessionExists(deps.db, row.fixer_session_id);
    if (result.missing && alive && !timedOut) return;
    const stopped = await deps
      .stopSession(row.fixer_session_id, "failed")
      .catch(() => false);
    if (!stopped) return;
    recordFleetTaskFixFailure(
      deps,
      row,
      timedOut
        ? "automatic fixer timed out before producing a valid result"
        : alive
          ? result.error
          : "automatic fixer exited before producing a valid result"
    );
    return;
  }
  const parsed = parseFleetTaskFixResult(result.text, {
    nonceHash: row.nonce_hash,
    runId: row.fleet_run_id,
    taskId: row.task_id,
    attempt: row.attempt,
    round: row.round,
    oldHeadSha: row.old_head_sha,
    verificationEvidenceHash: row.verification_evidence_hash,
    policyHash: row.policy_hash,
  });
  const stopped = await deps
    .stopSession(row.fixer_session_id, parsed.ok ? "completed" : "failed")
    .catch(() => false);
  if (!stopped) return;
  if (!parsed.ok) {
    recordFleetTaskFixFailure(deps, row, parsed.error);
    return;
  }
  let state: FleetGitState;
  try {
    state = await deps.collectGitState({
      cwd: row.worktree_path,
      baseSha: contract.candidate.task_base_sha!,
      expectedHeadSha: parsed.newHeadSha,
      limits: { maxGitOutputBytes: 2 * 1024 * 1024, maxPaths: 500 },
    });
  } catch {
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fixer result did not match authoritative Git HEAD"
    );
    return;
  }
  if (
    !(await isDescendantCommit(
      deps,
      row.worktree_path,
      row.old_head_sha,
      parsed.newHeadSha
    ))
  ) {
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fixer must create a new committed descendant of the reviewed HEAD"
    );
    return;
  }
  const stateError = validateGitState(state, {
    expectedBranch: row.branch_name!,
    plannedClaims: parseFleetTaskStringArray(
      contract.candidate.file_claims_json
    ),
    allowSensitivePaths: contract.policy.allowSensitivePaths,
    requireChanges: true,
  });
  if (stateError) {
    recordFleetTaskFixFailure(deps, row, stateError);
    return;
  }
  if (
    finalizeFix(deps, contract, row, {
      newHeadSha: parsed.newHeadSha,
      summary: parsed.summary,
      bytes: result.bytes,
      gitState: state,
    })
  ) {
    await deps.removeResult(row.result_path);
  }
}

export async function reconcileFleetTaskFixRow(
  deps: FleetTaskFixRuntimeDeps,
  initial: FleetTaskFixRow
): Promise<void> {
  let row = initial;
  const loaded = loadFixContract(deps, row);
  if ("error" in loaded) {
    if (row.fixer_session_id) {
      const stopped = await deps
        .stopSession(row.fixer_session_id, "failed")
        .catch(() => false);
      if (!stopped) return;
    }
    recordFleetTaskFixFailure(deps, row, loaded.error);
    return;
  }
  if (row.state === "pending") {
    await startFix(deps, loaded.contract, row);
    row = deps.db
      .prepare(`SELECT * FROM fleet_task_fixes WHERE id = ?`)
      .get(row.id) as FleetTaskFixRow;
    if (row.state === "running") return;
  }
  if (row.state === "spawning") {
    row = await recoverSpawningFleetTaskFix(deps, row);
    if (row.state === "spawning") {
      const started = Date.parse(row.started_at ?? "");
      if (
        Number.isFinite(started) &&
        deps.now().getTime() - started <= FLEET_TASK_FIX_SPAWN_RECOVERY_GRACE_MS
      ) {
        return;
      }
      if (row.fixer_session_id) {
        const stopped = await deps
          .stopSession(row.fixer_session_id, "failed")
          .catch(() => false);
        if (!stopped) return;
      }
      recordFleetTaskFixFailure(
        deps,
        row,
        "automatic fixer launch could not be recovered"
      );
      return;
    }
  }
  if (row.state === "running") await pollRunningFix(deps, loaded.contract, row);
}
