import { randomBytes, randomUUID } from "crypto";
import { mkdir, unlink } from "fs/promises";
import { dirname, join } from "path";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { generateBranchName, runGit } from "@/lib/git";
import { spawnWorker, WorkerSpawnError } from "@/lib/orchestration";
import { stoaHomeDir } from "@/lib/platform";
import {
  backendKeyForSession,
  PROVIDER_IDS,
  type ProviderId,
} from "@/lib/providers/registry";
import type { ApprovalMode } from "@/lib/sandbox/types";
import { getSessionBackend } from "@/lib/session-backend";
import { deleteWorktree } from "@/lib/worktrees";
import { parseFleetAutomationPolicy } from "./automation-policy";
import { readBoundedRegularFile } from "./artifacts";
import { decideFleetAuxiliaryLaunchRetry } from "./auxiliary-retry";
import {
  allocateFleetAuxiliaryProvider,
  detectInstalledFleetAgentProviders,
  type FleetAgentProviderId,
} from "./auxiliary-provider";
import { collectFleetGitState } from "./git-state";
import { fleetProviderRetryIsDue } from "./backoff";
import { hashFleetAutomationPolicy } from "./hash";
import {
  FLEET_PLAN_REVIEW_LENSES,
  fleetPlanReviewerApprovalMode,
  type FleetPlanReviewFinding,
} from "./plan-review";
import { redactAndCapFleetText } from "./redaction";
import { insertFleetArtifact } from "./durable-write";
import { clearFleetProviderCooldown } from "./resource-runtime";
import { fleetStrongConfinementAvailable } from "./confinement";
import { stopFleetSession } from "./stop";
import {
  activateFleetPaidSession,
  finishFleetPaidSession,
  reserveFleetPaidSession,
} from "./session-admission";
import { assertFleetLaunchReady } from "./recovery-gate";
import { isFleetUnattendedProvider } from "./provider-eligibility";
import {
  reconcileFleetTaskFixSettlements,
  reconcileFleetTaskFixRow,
  recordFleetTaskFixFailure,
  recoverSpawningFleetTaskFix,
} from "./task-fix-runtime";
import {
  buildFleetTaskFixPrompt,
  buildFleetTaskReviewPrompt,
  FLEET_TASK_REVIEW_FINDING_BODY_MAX_CHARS as FINDING_BODY_MAX_CHARS,
  FLEET_TASK_REVIEW_FINDING_MAX_COUNT as FINDING_MAX_COUNT,
  FLEET_TASK_REVIEW_FINDING_TITLE_MAX_CHARS as FINDING_TITLE_MAX_CHARS,
  FLEET_TASK_REVIEW_RESULT_MAX_BYTES as RESULT_MAX_BYTES,
  hashFleetTaskRuntimeNonce,
  hashFleetVerificationEvidence,
  parseFleetTaskFixResult,
  parseFleetTaskReviewFindings,
  parseFleetTaskReviewResult,
  parseFleetTaskStringArray as parseStringArray,
  type TaskFixContract,
  type TaskReviewCandidate,
  type TaskReviewContract,
} from "./task-review-contract";
import type {
  FleetAutomationPolicy,
  FleetPlanReviewLens,
  FleetRunRow,
  FleetTaskFixRow,
  FleetTaskReviewRow,
  FleetVerificationRow,
} from "./types";

export {
  buildFleetTaskFixPrompt,
  buildFleetTaskReviewPrompt,
  hashFleetVerificationEvidence,
  parseFleetTaskFixResult,
  parseFleetTaskReviewResult,
} from "./task-review-contract";
export type {
  FleetTaskFixExpectedResult,
  FleetTaskFixParseResult,
  FleetTaskReviewExpectedResult,
  FleetTaskReviewParseResult,
} from "./task-review-contract";

const REVIEW_TIMEOUT_MS = 20 * 60 * 1_000;
const SPAWN_RECOVERY_GRACE_MS = 90 * 1_000;
const TASK_REVIEW_UNATTENDED_PROVIDER_ERROR =
  "persisted task reviewer provider cannot run unattended";
const CANDIDATE_LIMIT = 16;
const ACTIVE_LIMIT = 64;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SAFE_PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACTIVE_FLEET_RUN_STATUSES = new Set(["running", "reviewing", "merging"]);

interface ReviewSpawnResult {
  id: string;
  worktree_path: string | null;
  branch_name: string | null;
}

interface FixSpawnResult {
  id: string;
}

export interface FleetTaskReviewDeps {
  db: Database.Database;
  now: () => Date;
  randomId: () => string;
  randomNonce: () => string;
  installedProviders: () => FleetAgentProviderId[];
  prepareResultPath: (input: {
    kind: "reviews" | "fixes";
    runId: string;
    taskId: string;
    attempt: number;
    requestId: string;
  }) => Promise<string>;
  readResult: typeof readBoundedRegularFile;
  removeResult: (path: string) => Promise<boolean>;
  sessionExists: (db: Database.Database, sessionId: string) => Promise<boolean>;
  stopSession: (
    sessionId: string,
    finalStatus?: "completed" | "failed"
  ) => Promise<boolean>;
  removeWorktree: (
    worktreePath: string,
    projectPath: string,
    deleteBranch?: boolean
  ) => Promise<void>;
  git: typeof runGit;
  collectGitState: typeof collectFleetGitState;
  spawnReview: (input: {
    contract: TaskReviewContract;
    lens: FleetPlanReviewLens;
    prompt: string;
    persistedPrompt: string;
    resultPath: string;
    branchFeature: string;
    approvalMode: ApprovalMode;
    provider: FleetAgentProviderId;
    model: string | null;
  }) => Promise<ReviewSpawnResult>;
  spawnFix: (input: {
    contract: TaskFixContract;
    row: FleetTaskFixRow;
    prompt: string;
    persistedPrompt: string;
    approvalMode: ApprovalMode;
    provider: FleetAgentProviderId;
    model: string | null;
  }) => Promise<FixSpawnResult>;
}

export interface ReconcileFleetTaskReviewOptions {
  maxTasks?: number;
  /** Restrict an operator-triggered pass to one exact Fleet run. */
  runId?: string;
  /** Restrict an operator-triggered pass to one exact task in runId. */
  taskId?: string;
}

function safePathComponent(value: string, label: string): string {
  if (!SAFE_PATH_COMPONENT.test(value) || value === "." || value === "..") {
    throw new Error(`${label} is not safe for a Fleet-owned result path`);
  }
  return value;
}

async function defaultPrepareResultPath(input: {
  kind: "reviews" | "fixes";
  runId: string;
  taskId: string;
  attempt: number;
  requestId: string;
}): Promise<string> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new Error("Fleet task review attempt must be positive");
  }
  const directory = join(
    stoaHomeDir(),
    "fleet-task-runtime",
    safePathComponent(input.runId, "runId"),
    safePathComponent(input.taskId, "taskId"),
    String(input.attempt),
    input.kind
  );
  await mkdir(directory, { recursive: true });
  return join(
    directory,
    `${safePathComponent(input.requestId, "requestId")}.json`
  );
}

async function defaultRemoveResult(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function provider(value: string): FleetAgentProviderId {
  if (!PROVIDER_IDS.includes(value as ProviderId) || value === "shell") {
    throw new Error(`unsupported Fleet task reviewer provider: ${value}`);
  }
  return value as FleetAgentProviderId;
}

function approvalMode(policy: FleetAutomationPolicy): ApprovalMode {
  const sandboxEnabled = process.env.STOA_SANDBOX === "1";
  return fleetPlanReviewerApprovalMode(policy, {
    sandboxEnabled,
    confinementAvailable: fleetStrongConfinementAvailable(),
  });
}

async function defaultSessionExists(
  db: Database.Database,
  sessionId: string
): Promise<boolean> {
  const session = queries.getSession(db).get(sessionId) as Session | undefined;
  if (!session) return false;
  try {
    return await getSessionBackend().exists(backendKeyForSession(session));
  } catch {
    return false;
  }
}

function dependencies(
  overrides: Partial<FleetTaskReviewDeps>
): FleetTaskReviewDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    randomId: overrides.randomId ?? randomUUID,
    randomNonce:
      overrides.randomNonce ?? (() => randomBytes(32).toString("hex")),
    installedProviders:
      overrides.installedProviders ?? detectInstalledFleetAgentProviders,
    prepareResultPath: overrides.prepareResultPath ?? defaultPrepareResultPath,
    readResult: overrides.readResult ?? readBoundedRegularFile,
    removeResult: overrides.removeResult ?? defaultRemoveResult,
    sessionExists: overrides.sessionExists ?? defaultSessionExists,
    stopSession: overrides.stopSession ?? stopFleetSession,
    removeWorktree: overrides.removeWorktree ?? deleteWorktree,
    git: overrides.git ?? runGit,
    collectGitState: overrides.collectGitState ?? collectFleetGitState,
    spawnReview:
      overrides.spawnReview ??
      (async ({
        contract,
        prompt,
        persistedPrompt,
        resultPath,
        branchFeature,
        approvalMode: mode,
        provider: reviewProvider,
        model,
      }) =>
        spawnWorker({
          conductorSessionId: contract.candidate.conductor_session_id ?? null,
          task: persistedPrompt,
          deliveryTask: prompt,
          workingDirectory: contract.candidate.project_path!,
          branchName: branchFeature,
          baseBranch: contract.candidate.task_head_sha!,
          useWorktree: true,
          requireWorktree: true,
          requireTaskDelivery: true,
          skipSetup: true,
          readOnlyWorktree: true,
          fleetWritableRoots: [dirname(resultPath)],
          requireStrongIsolation: true,
          approvalMode: mode,
          agentType: reviewProvider,
          model: model ?? undefined,
        })),
    spawnFix:
      overrides.spawnFix ??
      (async ({
        contract,
        row,
        prompt,
        persistedPrompt,
        approvalMode: mode,
        provider: fixerProvider,
        model,
      }) => {
        const session = await spawnWorker({
          conductorSessionId: contract.candidate.conductor_session_id ?? null,
          task: persistedPrompt,
          deliveryTask: prompt,
          workingDirectory: row.worktree_path!,
          useWorktree: false,
          requireTaskDelivery: true,
          fleetWritableRoots: [dirname(row.result_path!)],
          requireStrongIsolation: true,
          approvalMode: mode,
          agentType: fixerProvider,
          model: model ?? undefined,
        });
        queries
          .updateSessionWorktree(getDb())
          .run(
            row.worktree_path,
            row.branch_name,
            contract.candidate.task_base_branch ?? "main",
            null,
            session.id
          );
        return { id: session.id };
      }),
  };
}

function transaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) {
    const savepoint = "fleet_task_review_nested";
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = callback();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
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
  payload: unknown,
  createdAt?: string
): void {
  queries
    .createFleetEvent(db)
    .run(runId, type, "fleet-task-review", JSON.stringify(payload), {
      createdAt,
    });
}

function sessionOwnedByAnotherFleetAccount(
  db: Database.Database,
  input: {
    runId: string;
    ownerId: string;
    sessionId: string;
  }
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM fleet_cost_accounts
         WHERE session_id = ?
           AND NOT (
             fleet_run_id = ? AND owner_type = 'task_review' AND owner_id = ?
           )
         LIMIT 1`
      )
      .get(input.sessionId, input.runId, input.ownerId)
  );
}

function taskReviewSessionWasActivated(
  db: Database.Database,
  row: FleetTaskReviewRow
): boolean {
  const account = db
    .prepare(
      `SELECT session_id FROM fleet_cost_accounts
       WHERE fleet_run_id = ? AND owner_type = 'task_review' AND owner_id = ?`
    )
    .get(row.fleet_run_id, row.request_id) as
    { session_id: string | null } | undefined;
  return Boolean(account?.session_id);
}

function taskReviewProviderError(
  row: FleetTaskReviewRow,
  session?: Session
): string | null {
  const recoveredProvider = session?.agent_type?.trim() ?? "";
  const persistedProvider = row.provider?.trim() || recoveredProvider;
  if (
    !isFleetUnattendedProvider(persistedProvider) ||
    (session &&
      (!isFleetUnattendedProvider(recoveredProvider) ||
        recoveredProvider !== persistedProvider))
  ) {
    return TASK_REVIEW_UNATTENDED_PROVIDER_ERROR;
  }
  return null;
}

function rejectIneligibleTaskReviewSession(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow,
  session?: Session
): FleetTaskReviewRow {
  const message = taskReviewProviderError(row, session);
  if (!message) return row;
  const sessionId = session?.id ?? row.reviewer_session_id;
  const foreignSessionOwner = Boolean(
    sessionId &&
    sessionOwnedByAnotherFleetAccount(deps.db, {
      runId: row.fleet_run_id,
      ownerId: row.request_id,
      sessionId,
    })
  );
  if (session && !foreignSessionOwner) {
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET reviewer_session_id = ?, reviewer_worktree_path = ?,
             reviewer_branch_name = ?, updated_at = ?
         WHERE id = ? AND state = ? AND request_id = ?`
      )
      .run(
        session.id,
        session.worktree_path,
        session.branch_name ?? row.reviewer_branch_name,
        deps.now().toISOString(),
        row.id,
        row.state,
        row.request_id
      );
  }
  const latest = (deps.db
    .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
    .get(row.id) ?? row) as FleetTaskReviewRow;
  queueReviewResult(deps, latest, {
    verdict: "changes_requested",
    findings: [failureFinding(message)],
    bytes: null,
    error: message,
    preserveExternalState: foreignSessionOwner,
  });
  return (deps.db
    .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
    .get(row.id) ?? latest) as FleetTaskReviewRow;
}

function redactedText(value: string, maxChars: number): string {
  return redactAndCapFleetText(value, maxChars * 4).text.slice(0, maxChars);
}

function sanitizedFinding(
  finding: FleetPlanReviewFinding
): FleetPlanReviewFinding {
  return {
    severity: finding.severity,
    title: redactedText(finding.title, FINDING_TITLE_MAX_CHARS),
    body: redactedText(finding.body, FINDING_BODY_MAX_CHARS),
  };
}

function verificationFromCandidate(
  candidate: TaskReviewCandidate
): FleetVerificationRow {
  return {
    id: candidate.verification_id!,
    fleet_run_id: candidate.verification_run_id!,
    task_id: candidate.verification_task_id!,
    worker_id: candidate.verification_worker_id,
    attempt: candidate.verification_attempt!,
    base_sha: candidate.verification_base_sha!,
    head_sha: candidate.verification_head_sha!,
    spec_hash: candidate.verification_spec_hash!,
    command: candidate.verification_command!,
    status: "pass",
    run_count: candidate.verification_run_count!,
    lease_owner: null,
    lease_expires_at: null,
    output_artifact_id: candidate.verification_output_artifact_id,
    output_hash: candidate.verification_output_hash,
    error: null,
    created_at: candidate.verification_created_at!,
    updated_at: candidate.verification_completed_at!,
    started_at: candidate.verification_started_at,
    completed_at: candidate.verification_completed_at,
  };
}

function candidateError(
  candidate: TaskReviewCandidate
): { code: string; message: string } | TaskReviewContract {
  const baseSha = candidate.task_base_sha?.toLowerCase() ?? "";
  const headSha = candidate.task_head_sha?.toLowerCase() ?? "";
  if (
    !Number.isSafeInteger(candidate.current_attempt) ||
    candidate.current_attempt < 1 ||
    !FULL_SHA.test(baseSha) ||
    !FULL_SHA.test(headSha)
  ) {
    return {
      code: "task_review_identity_invalid",
      message:
        "task review requires a positive attempt and exact base/head SHAs",
    };
  }
  if (
    !ACTIVE_FLEET_RUN_STATUSES.has(candidate.run_status) ||
    candidate.desired_state !== "running"
  ) {
    return {
      code: "task_review_run_not_active",
      message: "task review requires an actively running Fleet run",
    };
  }
  // `manual` governs plan approval and unattended automation. Executable task
  // code still requires the same four exact-head review lanes because there is
  // no weaker manual-evidence path into the merge gate.
  if (
    !candidate.project_path ||
    !candidate.task_worktree_path ||
    !candidate.task_branch_name
  ) {
    return {
      code: "task_review_worktree_invalid",
      message:
        "task review requires the owned task project, worktree, and branch",
    };
  }
  const policyResult = parseFleetAutomationPolicy(
    candidate.automation_policy_json
  );
  if (
    !policyResult.valid ||
    !candidate.automation_policy_hash ||
    hashFleetAutomationPolicy(policyResult.policy) !==
      candidate.automation_policy_hash
  ) {
    return {
      code: "task_review_policy_invalid",
      message: "the persisted Fleet automation policy hash is invalid",
    };
  }
  if (
    !candidate.approved_plan_hash ||
    candidate.approved_task_hash !== candidate.approved_plan_hash
  ) {
    return {
      code: "task_review_approval_invalid",
      message: "the task is no longer bound to its approved plan",
    };
  }
  if (
    candidate.task_verification_status !== "pass" ||
    candidate.task_verified_head_sha?.toLowerCase() !== headSha ||
    candidate.task_verification_id !== candidate.verification_id ||
    candidate.task_verification_spec_hash !==
      candidate.verification_spec_hash ||
    candidate.task_verification_artifact_id !==
      candidate.verification_output_artifact_id ||
    candidate.verification_status !== "pass" ||
    candidate.verification_run_id !== candidate.fleet_run_id ||
    candidate.verification_task_id !== candidate.task_id ||
    candidate.verification_attempt !== candidate.current_attempt ||
    candidate.verification_base_sha?.toLowerCase() !== baseSha ||
    candidate.verification_head_sha?.toLowerCase() !== headSha ||
    !candidate.verification_id ||
    !candidate.verification_spec_hash ||
    !candidate.verification_command ||
    !candidate.verification_output_artifact_id ||
    !candidate.verification_output_hash ||
    !SHA256.test(candidate.verification_output_hash) ||
    !candidate.verification_started_at ||
    !candidate.verification_completed_at
  ) {
    return {
      code: "task_review_verification_stale",
      message:
        "task review requires immutable passing verification for the exact task HEAD",
    };
  }
  if (
    candidate.artifact_content_hash !== candidate.verification_output_hash ||
    candidate.artifact_run_id !== candidate.fleet_run_id ||
    candidate.artifact_task_id !== candidate.task_id ||
    candidate.artifact_worker_id !== candidate.verification_worker_id ||
    candidate.artifact_attempt !== candidate.current_attempt ||
    candidate.artifact_base_sha?.toLowerCase() !== baseSha ||
    candidate.artifact_head_sha?.toLowerCase() !== headSha
  ) {
    return {
      code: "task_review_verification_artifact_stale",
      message:
        "the verification result artifact does not match the exact task evidence",
    };
  }
  if (
    !candidate.worker_id ||
    candidate.worker_id !== candidate.verification_worker_id ||
    candidate.worker_attempt !== candidate.current_attempt ||
    candidate.worker_base_sha?.toLowerCase() !== baseSha ||
    candidate.worker_head_sha?.toLowerCase() !== headSha ||
    candidate.worker_worktree_path !== candidate.task_worktree_path ||
    candidate.worker_branch_name !== candidate.task_branch_name ||
    candidate.worker_report_state !== "accepted" ||
    candidate.worker_report_status !== "succeeded"
  ) {
    return {
      code: "task_review_worker_evidence_stale",
      message:
        "the accepted worker evidence does not match the exact verified task HEAD",
    };
  }
  let reviewerProvider: FleetAgentProviderId;
  try {
    reviewerProvider = provider(candidate.run_provider);
  } catch (error) {
    return {
      code: "task_review_provider_invalid",
      message:
        error instanceof Error ? error.message : "review provider is invalid",
    };
  }
  const verification = verificationFromCandidate(candidate);
  return {
    candidate,
    policy: policyResult.policy,
    policyHash: candidate.automation_policy_hash,
    verification,
    verificationEvidenceHash: hashFleetVerificationEvidence(verification),
    provider: reviewerProvider,
  };
}

function listReviewCandidates(
  db: Database.Database,
  limit: number
): TaskReviewCandidate[] {
  return db
    .prepare(
      `SELECT
         t.id AS task_id, t.fleet_run_id, t.title, t.description, t.task_type,
         t.current_attempt, t.file_claims_json, t.actual_file_claims_json,
         t.acceptance_criteria, t.verify_command,
         t.agent_type AS task_agent_type, t.model AS task_model,
         t.working_directory AS project_path,
         t.worktree_path AS task_worktree_path,
         t.branch_name AS task_branch_name, t.base_branch AS task_base_branch,
         t.base_sha AS task_base_sha, t.head_sha AS task_head_sha,
         t.report_artifact_id AS task_report_artifact_id,
         t.verification_id AS task_verification_id,
         t.verification_status AS task_verification_status,
         t.verification_spec_hash AS task_verification_spec_hash,
         t.verified_head_sha AS task_verified_head_sha,
         t.verification_artifact_id AS task_verification_artifact_id,
         t.fix_rounds AS task_fix_rounds, t.approved_task_hash,
         r.status AS run_status, r.desired_state, r.provider AS run_provider,
         r.model AS run_model, r.review_policy, r.approved_plan_hash,
         r.automation_policy_json, r.automation_policy_hash,
         r.conductor_session_id,
         v.id AS verification_id, v.fleet_run_id AS verification_run_id,
         v.task_id AS verification_task_id,
         v.worker_id AS verification_worker_id,
         v.attempt AS verification_attempt, v.base_sha AS verification_base_sha,
         v.head_sha AS verification_head_sha,
         v.spec_hash AS verification_spec_hash,
         v.command AS verification_command, v.status AS verification_status,
         v.run_count AS verification_run_count,
         v.output_artifact_id AS verification_output_artifact_id,
         v.output_hash AS verification_output_hash,
         v.started_at AS verification_started_at,
         v.completed_at AS verification_completed_at,
         v.created_at AS verification_created_at,
         a.content_hash AS artifact_content_hash,
         a.fleet_run_id AS artifact_run_id, a.task_id AS artifact_task_id,
         a.worker_id AS artifact_worker_id, a.attempt AS artifact_attempt,
         a.base_sha AS artifact_base_sha, a.head_sha AS artifact_head_sha,
         w.id AS worker_id, w.attempt AS worker_attempt,
         w.base_sha AS worker_base_sha, w.head_sha AS worker_head_sha,
         w.worktree_path AS worker_worktree_path,
         w.branch_name AS worker_branch_name,
         w.report_state AS worker_report_state,
         w.report_status AS worker_report_status
       FROM fleet_tasks t
       JOIN fleet_runs r ON r.id = t.fleet_run_id
       LEFT JOIN fleet_verifications v ON v.id = t.verification_id
       LEFT JOIN fleet_artifacts a ON a.id = v.output_artifact_id
       LEFT JOIN fleet_workers w ON w.id = v.worker_id
       WHERE t.status = 'reviewing'
         AND r.status IN ('running','reviewing','merging')
         AND r.desired_state = 'running'
         AND r.recovery_required = 0
       ORDER BY t.updated_at ASC, t.sort_order ASC, t.id ASC
       LIMIT ?`
    )
    .all(limit) as TaskReviewCandidate[];
}

function failureFinding(message: string): FleetPlanReviewFinding {
  return {
    severity: "blocker",
    title: "Code review could not establish clean evidence",
    body: redactedText(message, FINDING_BODY_MAX_CHARS),
  };
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
  const title = redactAndCapFleetText(input.title, 240);
  const body = redactAndCapFleetText(input.body, 64 * 1024);
  insertFleetArtifact(
    db,
    {
      id: input.id,
      runId: input.runId,
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      attempt: input.attempt,
      planHash: input.planHash,
      baseSha: input.baseSha,
      headSha: input.headSha,
      metadataJson: JSON.stringify(input.metadata),
      artifactType: input.artifactType,
      title: title.text,
      body: body.text,
      severity: input.severity,
      actor: input.actor,
      createdAt: input.nowIso,
    },
    { orIgnore: true }
  );
}

function writeTaskBlocker(
  deps: FleetTaskReviewDeps,
  candidate: TaskReviewCandidate,
  code: string,
  message: string
): boolean {
  const nowIso = deps.now().toISOString();
  const safeMessage = redactedText(message, 1_000);
  return transaction(deps.db, () => {
    const changed = deps.db
      .prepare(
        `UPDATE fleet_tasks
         SET status = 'needs_inspection', failure_code = ?, fix_error = ?,
             review_status = 'changes_requested', review_head_sha = head_sha,
             review_completed_at = ?, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'reviewing'
           AND current_attempt = ?
           AND EXISTS (
             SELECT 1 FROM fleet_runs r
             WHERE r.id = fleet_tasks.fleet_run_id
               AND r.status IN ('running','reviewing','merging')
               AND r.desired_state = 'running'
           )`
      )
      .run(
        code,
        safeMessage,
        nowIso,
        nowIso,
        candidate.task_id,
        candidate.fleet_run_id,
        candidate.current_attempt
      );
    if (changed.changes !== 1) return false;
    artifact(deps.db, {
      id: deps.randomId(),
      runId: candidate.fleet_run_id,
      taskId: candidate.task_id,
      attempt: candidate.current_attempt,
      planHash: candidate.approved_plan_hash,
      baseSha: candidate.task_base_sha ?? "",
      headSha: candidate.task_head_sha ?? "",
      artifactType: "task_review_precondition",
      title: "Task code review requires operator inspection",
      body: safeMessage,
      metadata: {
        code,
        attempt: candidate.current_attempt,
        headSha: candidate.task_head_sha,
        verificationId: candidate.task_verification_id,
      },
      severity: "blocker",
      actor: "fleet-task-review",
      nowIso,
    });
    event(deps.db, candidate.fleet_run_id, "task_review_precondition_failed", {
      taskId: candidate.task_id,
      attempt: candidate.current_attempt,
      headSha: candidate.task_head_sha,
      code,
    });
    return true;
  });
}

function ensureReviewSlots(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract
): void {
  const candidate = contract.candidate;
  const nowIso = deps.now().toISOString();
  const statement = deps.db.prepare(
    `INSERT OR IGNORE INTO fleet_task_reviews
     (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
      verification_id, verification_spec_hash, verification_evidence_hash,
      policy_hash, lens, reviewer_session_id, verdict, state, project_path,
      findings_json, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'changes_requested',
       'pending', ?, '[]', ?, ?)`
  );
  transaction(deps.db, () => {
    for (const lens of FLEET_PLAN_REVIEW_LENSES) {
      const inserted = statement.run(
        deps.randomId(),
        candidate.fleet_run_id,
        candidate.task_id,
        candidate.verification_worker_id,
        candidate.current_attempt,
        candidate.task_base_sha,
        candidate.task_head_sha,
        contract.verification.id,
        contract.verification.spec_hash,
        contract.verificationEvidenceHash,
        contract.policyHash,
        lens,
        candidate.project_path,
        nowIso,
        nowIso
      );
      if (inserted.changes === 1) {
        event(deps.db, candidate.fleet_run_id, "task_review_queued", {
          taskId: candidate.task_id,
          attempt: candidate.current_attempt,
          headSha: candidate.task_head_sha,
          verificationId: contract.verification.id,
          verificationEvidenceHash: contract.verificationEvidenceHash,
          policyHash: contract.policyHash,
          lens,
        });
      }
    }
  });
}

function exactReviewRows(
  db: Database.Database,
  contract: TaskReviewContract
): FleetTaskReviewRow[] {
  const candidate = contract.candidate;
  return db
    .prepare(
      `SELECT * FROM fleet_task_reviews
       WHERE task_id = ? AND attempt = ? AND head_sha = ?
         AND verification_id = ? AND verification_evidence_hash = ?
         AND policy_hash = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(
      candidate.task_id,
      candidate.current_attempt,
      candidate.task_head_sha,
      contract.verification.id,
      contract.verificationEvidenceHash,
      contract.policyHash
    ) as FleetTaskReviewRow[];
}

function queueReviewResult(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow,
  result: {
    verdict: "clean" | "changes_requested";
    findings: FleetPlanReviewFinding[];
    bytes: number | null;
    error?: string;
    persistArtifacts?: boolean;
    launchFailureCount?: number;
    preserveExternalState?: boolean;
  }
): boolean {
  const nowIso = deps.now().toISOString();
  const safeError = result.error ? redactedText(result.error, 1_000) : null;
  const safeResultFindings = result.findings
    .slice(0, FINDING_MAX_COUNT)
    .map(sanitizedFinding);
  const findings =
    result.verdict === "changes_requested" &&
    !safeResultFindings.some((finding) => finding.severity === "blocker")
      ? [
          ...safeResultFindings.slice(0, FINDING_MAX_COUNT - 1),
          failureFinding(safeError ?? "review failed"),
        ]
      : safeResultFindings;
  return transaction(deps.db, () => {
    const changed = result.preserveExternalState
      ? deps.db
          .prepare(
            `UPDATE fleet_task_reviews
             SET state = ?, verdict = ?, result_verdict = ?, result_bytes = ?,
                 findings_json = ?, error = ?,
                 launch_failure_count = COALESCE(?, launch_failure_count),
                 retry_not_before = NULL,
                 completed_at = COALESCE(completed_at, ?), updated_at = ?
             WHERE id = ? AND state IN ('pending', 'spawning', 'running')`
          )
          .run(
            result.verdict,
            result.verdict,
            result.verdict,
            result.bytes,
            JSON.stringify(findings),
            safeError,
            result.launchFailureCount ?? null,
            nowIso,
            nowIso,
            row.id
          )
      : deps.db
          .prepare(
            `UPDATE fleet_task_reviews
             SET state = 'cleanup_pending', result_verdict = ?, result_bytes = ?,
                 findings_json = ?, error = ?,
                 launch_failure_count = COALESCE(?, launch_failure_count),
                 retry_not_before = NULL, updated_at = ?
             WHERE id = ? AND state IN ('pending', 'spawning', 'running')`
          )
          .run(
            result.verdict,
            result.bytes,
            JSON.stringify(findings),
            safeError,
            result.launchFailureCount ?? null,
            nowIso,
            row.id
          );
    if (changed.changes !== 1) return false;
    if (result.persistArtifacts !== false) {
      artifact(deps.db, {
        id: `${row.id}:result`,
        runId: row.fleet_run_id,
        taskId: row.task_id,
        attempt: row.attempt,
        planHash: null,
        baseSha: row.base_sha,
        headSha: row.head_sha,
        artifactType: "task_review_result",
        title: `[${row.lens}] Task code review result`,
        body: JSON.stringify({ verdict: result.verdict, findings }),
        metadata: {
          reviewId: row.id,
          lens: row.lens,
          verdict: result.verdict,
          verificationId: row.verification_id,
          verificationSpecHash: row.verification_spec_hash,
          verificationEvidenceHash: row.verification_evidence_hash,
          policyHash: row.policy_hash,
        },
        severity: result.verdict === "clean" ? "info" : "warning",
        actor: `fleet-task-review:${row.lens}`,
        nowIso,
      });
      findings.forEach((finding, index) => {
        artifact(deps.db, {
          id: `${row.id}:finding:${index}`,
          runId: row.fleet_run_id,
          taskId: row.task_id,
          attempt: row.attempt,
          planHash: null,
          baseSha: row.base_sha,
          headSha: row.head_sha,
          artifactType: "task_review_finding",
          title: `[${row.lens}] ${finding.title}`,
          body: finding.body,
          metadata: {
            reviewId: row.id,
            lens: row.lens,
            verificationId: row.verification_id,
            verificationEvidenceHash: row.verification_evidence_hash,
            policyHash: row.policy_hash,
          },
          severity: finding.severity,
          actor: `fleet-task-review:${row.lens}`,
          nowIso,
        });
      });
    }
    event(deps.db, row.fleet_run_id, "task_review_result_received", {
      reviewId: row.id,
      taskId: row.task_id,
      attempt: row.attempt,
      headSha: row.head_sha,
      lens: row.lens,
      verdict: result.verdict,
      verificationId: row.verification_id,
      verificationEvidenceHash: row.verification_evidence_hash,
      policyHash: row.policy_hash,
    });
    if (result.preserveExternalState) {
      finishFleetPaidSession(deps.db, {
        runId: row.fleet_run_id,
        ownerType: "task_review",
        ownerId: row.request_id,
        sessionCreated: false,
        now: deps.now(),
      });
      event(deps.db, row.fleet_run_id, "task_review_completed", {
        reviewId: row.id,
        taskId: row.task_id,
        lens: row.lens,
        reviewerSessionId: row.reviewer_session_id || null,
        verdict: result.verdict,
        preservedExternalState: true,
      });
    }
    return true;
  });
}

function queueReviewLaunchRetry(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow,
  input: { failureCount: number; retryNotBefore: string; error: string }
): boolean {
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const changed = deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET state = 'cleanup_pending', result_verdict = NULL,
             result_bytes = NULL, findings_json = '[]', error = ?,
             launch_failure_count = ?, retry_not_before = ?, updated_at = ?
         WHERE id = ? AND state = 'spawning'`
      )
      .run(
        redactedText(input.error, 1_000),
        input.failureCount,
        input.retryNotBefore,
        nowIso,
        row.id
      );
    if (changed.changes !== 1) return false;
    event(deps.db, row.fleet_run_id, "task_review_retry_scheduled", {
      reviewId: row.id,
      taskId: row.task_id,
      lens: row.lens,
      failureCount: input.failureCount,
      retryNotBefore: input.retryNotBefore,
    });
    return true;
  });
}

async function reviewWorkspaceError(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow
): Promise<string | null> {
  if (!row.reviewer_worktree_path || !row.reviewer_branch_name) {
    return "reviewer worktree identity is incomplete";
  }
  try {
    const state = await deps.collectGitState({
      cwd: row.reviewer_worktree_path,
      baseSha: row.head_sha,
      expectedHeadSha: row.head_sha,
      limits: { maxGitOutputBytes: 2 * 1024 * 1024, maxPaths: 200 },
    });
    if (state.currentBranch !== row.reviewer_branch_name) {
      return "reviewer branch identity changed";
    }
    if (
      state.committedChanges.length > 0 ||
      state.stagedChanges.length > 0 ||
      state.unstagedChanges.length > 0 ||
      state.untrackedPaths.length > 0
    ) {
      return "read-only reviewer mutated its checkout";
    }
    return null;
  } catch {
    return "reviewer exact HEAD and zero-mutation state could not be verified";
  }
}

function ownedReviewBranch(row: FleetTaskReviewRow): boolean {
  const prefix = generateBranchName(`fleet-tr-${row.fleet_run_id.slice(0, 8)}`);
  return Boolean(
    row.reviewer_branch_name &&
    row.reviewer_branch_name.startsWith(`${prefix}-`) &&
    row.result_path &&
    dirname(row.result_path).includes("fleet-task-runtime")
  );
}

async function cleanupReview(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow
): Promise<boolean> {
  const foreignSessionOwner = Boolean(
    row.reviewer_session_id &&
    sessionOwnedByAnotherFleetAccount(deps.db, {
      runId: row.fleet_run_id,
      ownerId: row.request_id,
      sessionId: row.reviewer_session_id,
    })
  );
  if (row.reviewer_session_id && !foreignSessionOwner) {
    const stopped = await deps
      .stopSession(
        row.reviewer_session_id,
        row.result_verdict === "clean" ? "completed" : "failed"
      )
      .catch(() => false);
    if (!stopped) return false;
  }
  if (
    !foreignSessionOwner &&
    (row.reviewer_worktree_path || row.reviewer_branch_name) &&
    !ownedReviewBranch(row)
  ) {
    return false;
  }
  if (!foreignSessionOwner && row.reviewer_worktree_path && row.project_path) {
    try {
      await deps.removeWorktree(
        row.reviewer_worktree_path,
        row.project_path,
        true
      );
    } catch {
      return false;
    }
  } else if (
    !foreignSessionOwner &&
    row.reviewer_branch_name &&
    row.project_path
  ) {
    try {
      await deps.git(
        row.project_path,
        ["branch", "-D", row.reviewer_branch_name],
        10_000
      );
    } catch {
      try {
        await deps.git(
          row.project_path,
          [
            "show-ref",
            "--verify",
            "--quiet",
            `refs/heads/${row.reviewer_branch_name}`,
          ],
          5_000
        );
        return false;
      } catch (error) {
        const code = (error as { code?: string | number }).code;
        if (code !== 1 && code !== "1") return false;
      }
    }
  }
  if (row.result_path && !(await deps.removeResult(row.result_path))) {
    return false;
  }
  const verdict = row.result_verdict ?? "changes_requested";
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    finishFleetPaidSession(deps.db, {
      runId: row.fleet_run_id,
      ownerType: "task_review",
      ownerId: row.request_id,
      sessionCreated:
        !foreignSessionOwner &&
        Boolean(row.reviewer_session_id) &&
        (row.error !== TASK_REVIEW_UNATTENDED_PROVIDER_ERROR ||
          taskReviewSessionWasActivated(deps.db, row)),
      now: deps.now(),
    });
    if (row.retry_not_before) {
      const changed = deps.db
        .prepare(
          `UPDATE fleet_task_reviews
           SET state = 'pending', provider = NULL, model = NULL,
               reviewer_session_id = '', request_id = '', nonce_hash = '',
               result_path = '', result_verdict = NULL, result_bytes = NULL,
               project_path = NULL, reviewer_worktree_path = NULL,
               reviewer_branch_name = '', findings_json = '[]',
               started_at = NULL, deadline_at = NULL, completed_at = NULL,
               updated_at = ?
           WHERE id = ? AND state = 'cleanup_pending'
             AND retry_not_before = ?`
        )
        .run(nowIso, row.id, row.retry_not_before);
      if (changed.changes === 1) {
        event(deps.db, row.fleet_run_id, "task_review_retry_ready", {
          reviewId: row.id,
          taskId: row.task_id,
          lens: row.lens,
          failureCount: row.launch_failure_count,
          retryNotBefore: row.retry_not_before,
        });
      }
      return changed.changes === 1;
    }
    const changed = deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET state = ?, verdict = ?, completed_at = COALESCE(completed_at, ?),
             updated_at = ?
         WHERE id = ? AND state = 'cleanup_pending'`
      )
      .run(verdict, verdict, nowIso, nowIso, row.id);
    if (changed.changes === 1) {
      event(deps.db, row.fleet_run_id, "task_review_completed", {
        reviewId: row.id,
        taskId: row.task_id,
        attempt: row.attempt,
        headSha: row.head_sha,
        lens: row.lens,
        reviewerSessionId: row.reviewer_session_id || null,
        verdict,
        verificationEvidenceHash: row.verification_evidence_hash,
        policyHash: row.policy_hash,
      });
    }
    return changed.changes === 1;
  });
}

async function recoverSpawningReview(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow
): Promise<FleetTaskReviewRow> {
  if (!row.reviewer_branch_name || !row.result_path) return row;
  const session = deps.db
    .prepare(
      `SELECT * FROM sessions
       WHERE branch_name = ? AND instr(worker_task, ?) > 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(row.reviewer_branch_name, row.result_path) as Session | undefined;
  if (session?.worktree_path) {
    const rejected = rejectIneligibleTaskReviewSession(deps, row, session);
    if (rejected.state !== "spawning") return rejected;
    let selectedProvider: FleetAgentProviderId;
    let selectedModel = row.model;
    try {
      const recoveredProvider = provider(session.agent_type ?? "");
      selectedProvider = provider(row.provider ?? recoveredProvider);
      if (selectedProvider !== recoveredProvider) {
        throw new Error("recovered provider does not match persisted binding");
      }
      if (!row.provider) {
        selectedModel = session.model?.trim() || null;
        deps.db
          .prepare(
            `UPDATE fleet_task_reviews SET provider = ?, model = ?, updated_at = ?
             WHERE id = ? AND state = 'spawning' AND request_id = ?
               AND provider IS NULL`
          )
          .run(
            selectedProvider,
            selectedModel,
            deps.now().toISOString(),
            row.id,
            row.request_id
          );
      }
    } catch {
      queueReviewResult(deps, row, {
        verdict: "changes_requested",
        findings: [
          failureFinding("persisted task reviewer provider is invalid"),
        ],
        bytes: null,
        error: "persisted task reviewer provider is invalid",
      });
      return (deps.db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
        .get(row.id) ?? row) as FleetTaskReviewRow;
    }
    const activated = activateFleetPaidSession(deps.db, {
      runId: row.fleet_run_id,
      ownerType: "task_review",
      ownerId: row.request_id,
      taskId: row.task_id,
      session,
      provider: selectedProvider,
      model: selectedModel,
      now: deps.now(),
    });
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET state = ?, reviewer_session_id = ?,
             reviewer_worktree_path = ?, reviewer_branch_name = ?,
             launch_failure_count = ?, retry_not_before = ?, updated_at = ?
         WHERE id = ? AND state = 'spawning' AND request_id = ?`
      )
      .run(
        activated ? "running" : "spawning",
        session.id,
        session.worktree_path,
        session.branch_name ?? row.reviewer_branch_name,
        activated ? 0 : row.launch_failure_count,
        activated ? null : row.retry_not_before,
        deps.now().toISOString(),
        row.id,
        row.request_id
      );
    if (!activated) {
      const latest = deps.db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
        .get(row.id) as FleetTaskReviewRow;
      const foreignSessionOwner = sessionOwnedByAnotherFleetAccount(deps.db, {
        runId: row.fleet_run_id,
        ownerId: row.request_id,
        sessionId: session.id,
      });
      const message = foreignSessionOwner
        ? "recovered task reviewer session is owned by another Fleet account"
        : "recovered task reviewer admission is no longer valid";
      queueReviewResult(deps, latest, {
        verdict: "changes_requested",
        findings: [failureFinding(message)],
        bytes: null,
        error: message,
        preserveExternalState: foreignSessionOwner,
      });
    } else {
      clearFleetProviderCooldown(deps.db, selectedProvider);
    }
  } else if (row.project_path) {
    try {
      const worktrees = (
        await deps.git(
          row.project_path,
          ["worktree", "list", "--porcelain"],
          10_000
        )
      ).stdout;
      for (const block of worktrees.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/);
        if (!lines.includes(`branch refs/heads/${row.reviewer_branch_name}`)) {
          continue;
        }
        const worktree = lines.find((line) => line.startsWith("worktree "));
        if (!worktree) continue;
        deps.db
          .prepare(
            `UPDATE fleet_task_reviews
             SET reviewer_worktree_path = ?, updated_at = ?
             WHERE id = ? AND state = 'spawning' AND request_id = ?`
          )
          .run(
            worktree.slice("worktree ".length),
            deps.now().toISOString(),
            row.id,
            row.request_id
          );
        break;
      }
    } catch {
      // Partial launch remains fail-closed until grace expiry and cleanup.
    }
  }
  return (deps.db
    .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
    .get(row.id) ?? row) as FleetTaskReviewRow;
}

async function startReview(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract,
  row: FleetTaskReviewRow
): Promise<void> {
  if (!fleetProviderRetryIsDue(row.retry_not_before, deps.now())) return;
  const launchApprovalMode = approvalMode(contract.policy);
  if (launchApprovalMode === "prompt") {
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews SET error = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND reviewer_session_id = ''`
      )
      .run(
        "task reviewer requires explicit unconfined-agent authorization until strong Fleet isolation is available",
        deps.now().toISOString(),
        row.id
      );
    return;
  }
  const requestId = deps.randomId();
  const nonce = deps.randomNonce();
  const resultPath = await deps.prepareResultPath({
    kind: "reviews",
    runId: row.fleet_run_id,
    taskId: row.task_id,
    attempt: row.attempt,
    requestId,
  });
  const branchFeature = `fleet-tr-${row.fleet_run_id.slice(0, 8)}-${requestId.slice(0, 8)}-${row.lens}`;
  const branchName = generateBranchName(branchFeature);
  const started = deps.now();
  const deadline = new Date(started.getTime() + REVIEW_TIMEOUT_MS);
  const run = queries.getFleetRun(deps.db).get(row.fleet_run_id) as
    FleetRunRow | undefined;
  if (!run) return;
  let selection;
  try {
    selection = allocateFleetAuxiliaryProvider({
      availableProviders: deps.installedProviders(),
      preferredProvider: provider(contract.provider),
      preferredModel: contract.candidate.run_model,
    });
  } catch {
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews SET error = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND reviewer_session_id = ''`
      )
      .run(
        "task reviewer is waiting for an installed agent provider",
        started.toISOString(),
        row.id
      );
    return;
  }
  const launchClaim = transaction(deps.db, () => {
    const assigned = deps.db
      .prepare(
        `UPDATE fleet_task_reviews SET provider = ?, model = ?, updated_at = ?
         WHERE id = ? AND state = 'pending' AND reviewer_session_id = ''
           AND request_id = ''`
      )
      .run(selection.provider, selection.model, started.toISOString(), row.id);
    if (assigned.changes !== 1) {
      return { admitted: true as const, claimed: false as const };
    }
    const admission = reserveFleetPaidSession(deps.db, {
      run,
      ownerType: "task_review",
      ownerId: requestId,
      taskId: row.task_id,
      taskType: "review",
      provider: selection.provider,
      model: selection.model,
      repositoryKey:
        run.repo_id ??
        run.project_id ??
        contract.candidate.project_path ??
        row.fleet_run_id,
      now: started,
      leaseExpiresAt: new Date(
        started.getTime() + SPAWN_RECOVERY_GRACE_MS
      ).toISOString(),
    });
    if (!admission.admitted) {
      return {
        admitted: false as const,
        reason: admission.reason,
        retryAt: admission.retryAt,
      };
    }
    const claimed = deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET state = 'spawning', request_id = ?, nonce_hash = ?, result_path = ?,
             project_path = ?, reviewer_branch_name = ?, started_at = ?,
             deadline_at = ?, retry_not_before = NULL, error = NULL,
             updated_at = ?
         WHERE id = ? AND state = 'pending' AND reviewer_session_id = ''
           AND request_id = '' AND provider = ? AND model IS ?`
      )
      .run(
        requestId,
        hashFleetTaskRuntimeNonce(nonce),
        resultPath,
        contract.candidate.project_path,
        branchName,
        started.toISOString(),
        deadline.toISOString(),
        started.toISOString(),
        row.id,
        selection.provider,
        selection.model
      );
    if (claimed.changes !== 1) {
      finishFleetPaidSession(deps.db, {
        runId: row.fleet_run_id,
        ownerType: "task_review",
        ownerId: requestId,
        sessionCreated: false,
        now: started,
      });
      return { admitted: true as const, claimed: false as const };
    }
    event(
      deps.db,
      row.fleet_run_id,
      "task_review_spawn_requested",
      {
        reviewId: row.id,
        taskId: row.task_id,
        requestId,
        lens: row.lens,
        headSha: row.head_sha,
        branchName,
        provider: selection.provider,
        model: selection.model,
      },
      started.toISOString()
    );
    return { admitted: true as const, claimed: true as const };
  });
  if (!launchClaim.admitted) {
    const message =
      launchClaim.reason === "budget"
        ? "task reviewer is waiting for budget capacity"
        : `task reviewer is waiting for runtime capacity${
            launchClaim.retryAt ? ` until ${launchClaim.retryAt}` : ""
          }`;
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews SET error = ?,
             retry_not_before = COALESCE(?, retry_not_before), updated_at = ?
         WHERE id = ? AND state = 'pending' AND reviewer_session_id = ''`
      )
      .run(
        redactedText(message, 1_000),
        launchClaim.retryAt,
        started.toISOString(),
        row.id
      );
    return;
  }
  if (!launchClaim.claimed) return;
  let spawned: ReviewSpawnResult | null = null;
  try {
    spawned = await deps.spawnReview({
      contract,
      lens: row.lens,
      prompt: buildFleetTaskReviewPrompt({
        contract,
        lens: row.lens,
        nonce,
        resultPath,
      }),
      persistedPrompt: buildFleetTaskReviewPrompt({
        contract,
        lens: row.lens,
        nonce: "[redacted ephemeral nonce]",
        resultPath,
      }),
      resultPath,
      branchFeature,
      approvalMode: launchApprovalMode,
      provider: selection.provider,
      model: selection.model,
    });
    const session = queries.getSession(deps.db).get(spawned.id) as
      Session | undefined;
    if (!spawned.worktree_path || !spawned.branch_name) {
      throw new Error("task reviewer started without an isolated worktree");
    }
    const launched = spawned;
    const duplicate = deps.db
      .prepare(
        `SELECT id FROM fleet_task_reviews
         WHERE task_id = ? AND attempt = ? AND head_sha = ?
           AND verification_id = ? AND verification_evidence_hash = ?
           AND policy_hash = ? AND reviewer_session_id = ? AND id <> ?
         LIMIT 1`
      )
      .get(
        row.task_id,
        row.attempt,
        row.head_sha,
        row.verification_id,
        row.verification_evidence_hash,
        row.policy_hash,
        launched.id,
        row.id
      );
    if (duplicate) {
      throw new Error("task reviewers must use four distinct sessions");
    }
    const updated = transaction(deps.db, () => {
      const nowIso = deps.now().toISOString();
      if (
        session &&
        !activateFleetPaidSession(deps.db, {
          runId: row.fleet_run_id,
          ownerType: "task_review",
          ownerId: requestId,
          taskId: row.task_id,
          session,
          provider: selection.provider,
          model: selection.model,
          now: deps.now(),
        })
      ) {
        throw new Error(
          "task reviewer session is already owned by another Fleet cost account"
        );
      }
      const changed = deps.db
        .prepare(
          `UPDATE fleet_task_reviews
           SET state = 'running', reviewer_session_id = ?,
               reviewer_worktree_path = ?, reviewer_branch_name = ?,
               launch_failure_count = 0, retry_not_before = NULL, updated_at = ?
           WHERE id = ? AND state = 'spawning' AND request_id = ?`
        )
        .run(
          launched.id,
          launched.worktree_path,
          launched.branch_name,
          nowIso,
          row.id,
          requestId
        );
      if (changed.changes === 1) {
        event(
          deps.db,
          row.fleet_run_id,
          "task_review_started",
          {
            reviewId: row.id,
            taskId: row.task_id,
            requestId,
            lens: row.lens,
            reviewerSessionId: launched.id,
            headSha: row.head_sha,
            branchName: launched.branch_name,
            provider: selection.provider,
            model: selection.model,
          },
          nowIso
        );
      }
      return changed;
    });
    if (updated.changes !== 1) {
      const foreignSessionOwner = sessionOwnedByAnotherFleetAccount(deps.db, {
        runId: row.fleet_run_id,
        ownerId: requestId,
        sessionId: launched.id,
      });
      if (!foreignSessionOwner) {
        await deps.stopSession(launched.id, "failed").catch(() => false);
        await deps
          .removeWorktree(
            launched.worktree_path!,
            contract.candidate.project_path!,
            true
          )
          .catch(() => undefined);
      }
      finishFleetPaidSession(deps.db, {
        runId: row.fleet_run_id,
        ownerType: "task_review",
        ownerId: requestId,
        sessionCreated: !foreignSessionOwner,
        now: deps.now(),
      });
      return;
    }
    clearFleetProviderCooldown(deps.db, selection.provider);
  } catch (error) {
    const sessionId =
      spawned?.id ??
      (error instanceof WorkerSpawnError ? error.sessionId : null) ??
      "";
    const worktreePath =
      spawned?.worktree_path ??
      (error instanceof WorkerSpawnError ? error.worktreePath : null);
    const foreignSessionOwner = Boolean(
      sessionId &&
      sessionOwnedByAnotherFleetAccount(deps.db, {
        runId: row.fleet_run_id,
        ownerId: requestId,
        sessionId,
      })
    );
    deps.db
      .prepare(
        `UPDATE fleet_task_reviews
         SET reviewer_session_id = ?, reviewer_worktree_path = ?, updated_at = ?
         WHERE id = ? AND state = 'spawning' AND request_id = ?`
      )
      .run(
        sessionId,
        worktreePath,
        deps.now().toISOString(),
        row.id,
        requestId
      );
    const recoveredSession = sessionId
      ? (queries.getSession(deps.db).get(sessionId) as Session | undefined)
      : undefined;
    const ambiguousExternalState =
      foreignSessionOwner || Boolean(sessionId && !recoveredSession);
    if (recoveredSession && !foreignSessionOwner) {
      activateFleetPaidSession(deps.db, {
        runId: row.fleet_run_id,
        ownerType: "task_review",
        ownerId: requestId,
        taskId: row.task_id,
        session: recoveredSession,
        provider: selection.provider,
        model: selection.model,
        now: deps.now(),
      });
    } else if (!sessionId && !worktreePath) {
      finishFleetPaidSession(deps.db, {
        runId: row.fleet_run_id,
        ownerType: "task_review",
        ownerId: requestId,
        sessionCreated: false,
        now: deps.now(),
      });
    }
    const latest = deps.db
      .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
      .get(row.id) as FleetTaskReviewRow;
    const message = redactedText(
      error instanceof Error ? error.message : "task reviewer failed to start",
      1_000
    );
    const retry = decideFleetAuxiliaryLaunchRetry(deps.db, {
      provider: selection.provider,
      previousFailureCount: latest.launch_failure_count,
      error,
      now: deps.now(),
      safeToRetry: spawned === null && !ambiguousExternalState,
    });
    if (retry.retry && retry.retryNotBefore) {
      queueReviewLaunchRetry(deps, latest, {
        failureCount: retry.failureCount,
        retryNotBefore: retry.retryNotBefore,
        error: message,
      });
    } else {
      queueReviewResult(deps, latest, {
        verdict: "changes_requested",
        findings: [failureFinding(message)],
        bytes: null,
        error: message,
        launchFailureCount: retry.failureCount,
        preserveExternalState: ambiguousExternalState,
      });
    }
  }
}

async function pollRunningReview(
  deps: FleetTaskReviewDeps,
  row: FleetTaskReviewRow
): Promise<void> {
  const deadline = Date.parse(row.deadline_at ?? "");
  const timedOut =
    !Number.isFinite(deadline) || deps.now().getTime() > deadline;
  if (
    !row.reviewer_worktree_path ||
    !row.reviewer_session_id ||
    !row.result_path
  ) {
    queueReviewResult(deps, row, {
      verdict: "changes_requested",
      findings: [failureFinding("task reviewer identity is incomplete")],
      bytes: null,
      error: "task reviewer identity is incomplete",
    });
    return;
  }
  const result = await deps.readResult(
    row.result_path,
    RESULT_MAX_BYTES,
    "Fleet task review result"
  );
  if (!result.ok) {
    const alive = await deps.sessionExists(deps.db, row.reviewer_session_id);
    if (result.missing && alive && !timedOut) return;
    const stopped = await deps
      .stopSession(row.reviewer_session_id, "failed")
      .catch(() => false);
    if (!stopped) return;
    const message = timedOut
      ? "task reviewer timed out before producing a valid result"
      : alive
        ? result.error
        : "task reviewer exited before producing a valid result";
    queueReviewResult(deps, row, {
      verdict: "changes_requested",
      findings: [failureFinding(message)],
      bytes: null,
      error: message,
    });
    return;
  }
  const parsed = parseFleetTaskReviewResult(result.text, {
    nonceHash: row.nonce_hash,
    runId: row.fleet_run_id,
    taskId: row.task_id,
    workerId: row.worker_id,
    attempt: row.attempt,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    verificationId: row.verification_id,
    verificationSpecHash: row.verification_spec_hash,
    verificationEvidenceHash: row.verification_evidence_hash,
    policyHash: row.policy_hash,
    lens: row.lens,
  });
  const stopped = await deps
    .stopSession(
      row.reviewer_session_id,
      parsed.ok && parsed.verdict === "clean" ? "completed" : "failed"
    )
    .catch(() => false);
  if (!stopped) return;
  if (!parsed.ok) {
    queueReviewResult(deps, row, {
      verdict: "changes_requested",
      findings: [failureFinding(parsed.error)],
      bytes: result.bytes,
      error: parsed.error,
    });
    return;
  }
  const workspaceError = await reviewWorkspaceError(deps, row);
  if (workspaceError) {
    queueReviewResult(deps, row, {
      verdict: "changes_requested",
      findings: [failureFinding(workspaceError)],
      bytes: result.bytes,
      error: workspaceError,
    });
    return;
  }
  const duplicate = deps.db
    .prepare(
      `SELECT id FROM fleet_task_reviews
       WHERE task_id = ? AND attempt = ? AND head_sha = ?
         AND verification_id = ? AND verification_evidence_hash = ?
         AND policy_hash = ? AND reviewer_session_id = ? AND id <> ?
       LIMIT 1`
    )
    .get(
      row.task_id,
      row.attempt,
      row.head_sha,
      row.verification_id,
      row.verification_evidence_hash,
      row.policy_hash,
      row.reviewer_session_id,
      row.id
    );
  if (duplicate) {
    queueReviewResult(deps, row, {
      verdict: "changes_requested",
      findings: [
        failureFinding("task reviewers did not use distinct sessions"),
      ],
      bytes: result.bytes,
      error: "task reviewers did not use distinct sessions",
    });
    return;
  }
  queueReviewResult(deps, row, {
    verdict: parsed.verdict,
    findings: parsed.findings,
    bytes: result.bytes,
  });
}

async function reconcileReviewRow(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract,
  initial: FleetTaskReviewRow
): Promise<void> {
  let row = initial;
  if (row.state === "pending") {
    await startReview(deps, contract, row);
    row = deps.db
      .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
      .get(row.id) as FleetTaskReviewRow;
    if (row.state === "running") return;
  }
  if (row.state === "spawning") {
    row = await recoverSpawningReview(deps, row);
    if (row.state === "spawning") {
      const started = Date.parse(row.started_at ?? "");
      if (
        Number.isFinite(started) &&
        deps.now().getTime() - started <= SPAWN_RECOVERY_GRACE_MS
      ) {
        return;
      }
      if (row.reviewer_session_id) {
        const stopped = await deps
          .stopSession(row.reviewer_session_id, "failed")
          .catch(() => false);
        if (!stopped) return;
      }
      queueReviewResult(deps, row, {
        verdict: "changes_requested",
        findings: [
          failureFinding("task reviewer launch could not be recovered"),
        ],
        bytes: null,
        error: "task reviewer launch could not be recovered",
      });
      row = deps.db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
        .get(row.id) as FleetTaskReviewRow;
    }
  }
  if (row.state === "running") {
    const session = row.reviewer_session_id
      ? (queries.getSession(deps.db).get(row.reviewer_session_id) as
          Session | undefined)
      : undefined;
    row = rejectIneligibleTaskReviewSession(deps, row, session);
  }
  if (row.state === "running") {
    await pollRunningReview(deps, row);
    row = deps.db
      .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
      .get(row.id) as FleetTaskReviewRow;
  }
  if (row.state === "cleanup_pending") await cleanupReview(deps, row);
}

function collectReviewFindings(
  rows: FleetTaskReviewRow[]
): FleetPlanReviewFinding[] {
  const findings: FleetPlanReviewFinding[] = [];
  for (const row of rows) {
    for (const finding of parseStoredFindings(row.findings_json)) {
      if (findings.length >= FINDING_MAX_COUNT) return findings;
      findings.push(finding);
    }
  }
  return findings;
}

function parseStoredFindings(value: string): FleetPlanReviewFinding[] {
  try {
    return parseFleetTaskReviewFindings(JSON.parse(value)) ?? [];
  } catch {
    return [];
  }
}

function automaticFixReason(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract
): string | null {
  const candidate = contract.candidate;
  if (!contract.policy.automaticFixes) return "automatic fixes are disabled";
  if (candidate.task_fix_rounds >= contract.policy.maxAutomaticFixRounds) {
    return "automatic fix round limit reached";
  }
  const authorization = deps.db
    .prepare(
      `SELECT status FROM fleet_action_authorizations
       WHERE fleet_run_id = ? AND action = 'fix' AND policy_hash = ?`
    )
    .get(candidate.fleet_run_id, contract.policyHash) as
    { status: string } | undefined;
  if (authorization?.status !== "authorized") {
    return "automatic fix action is not authorized for this policy";
  }
  if (
    !candidate.task_worktree_path ||
    !candidate.task_branch_name ||
    !candidate.project_path
  ) {
    return "the owned task worktree and branch are unavailable";
  }
  return null;
}

function markReviewNeedsInspection(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract,
  reason: string
): boolean {
  const candidate = contract.candidate;
  const nowIso = deps.now().toISOString();
  const safeReason = redactedText(reason, 1_000);
  const changed = deps.db
    .prepare(
      `UPDATE fleet_tasks
       SET status = 'needs_inspection', failure_code = 'task_review_changes_requested',
           review_status = 'changes_requested', review_head_sha = ?,
           review_verification_hash = ?, review_completed_at = ?,
           fix_error = ?, active_fix_id = NULL, fixer_session_id = NULL,
           updated_at = ?
       WHERE id = ? AND fleet_run_id = ? AND status = 'reviewing'
         AND current_attempt = ? AND head_sha = ? AND verification_id = ?
         AND verification_status = 'pass' AND verified_head_sha = ?
         AND EXISTS (
           SELECT 1 FROM fleet_runs r
           WHERE r.id = fleet_tasks.fleet_run_id
             AND r.status IN ('running','reviewing','merging')
             AND r.desired_state = 'running'
         )`
    )
    .run(
      candidate.task_head_sha,
      contract.verificationEvidenceHash,
      nowIso,
      safeReason,
      nowIso,
      candidate.task_id,
      candidate.fleet_run_id,
      candidate.current_attempt,
      candidate.task_head_sha,
      contract.verification.id,
      candidate.task_head_sha
    );
  if (changed.changes === 1) {
    event(deps.db, candidate.fleet_run_id, "task_review_needs_inspection", {
      taskId: candidate.task_id,
      attempt: candidate.current_attempt,
      headSha: candidate.task_head_sha,
      verificationEvidenceHash: contract.verificationEvidenceHash,
      policyHash: contract.policyHash,
      reason: safeReason,
    });
  }
  return changed.changes === 1;
}

function queueAutomaticFix(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract,
  rows: FleetTaskReviewRow[]
): boolean {
  const candidate = contract.candidate;
  const findings = collectReviewFindings(rows);
  const fixId = deps.randomId();
  const round = candidate.task_fix_rounds + 1;
  const nowIso = deps.now().toISOString();
  return transaction(deps.db, () => {
    const taskChanged = deps.db
      .prepare(
        `UPDATE fleet_tasks
         SET status = 'fixing', fix_rounds = fix_rounds + 1,
             active_fix_id = ?, fixer_session_id = NULL, fix_error = NULL,
             failure_code = 'task_review_changes_requested',
             review_status = 'changes_requested', review_head_sha = ?,
             review_verification_hash = ?, review_completed_at = ?, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'reviewing'
           AND current_attempt = ? AND head_sha = ? AND verification_id = ?
           AND verification_status = 'pass' AND verified_head_sha = ?
           AND fix_rounds = ?
           AND EXISTS (
             SELECT 1 FROM fleet_runs r
             WHERE r.id = fleet_tasks.fleet_run_id
               AND r.status IN ('running','reviewing','merging')
               AND r.desired_state = 'running'
           )`
      )
      .run(
        fixId,
        candidate.task_head_sha,
        contract.verificationEvidenceHash,
        nowIso,
        nowIso,
        candidate.task_id,
        candidate.fleet_run_id,
        candidate.current_attempt,
        candidate.task_head_sha,
        contract.verification.id,
        candidate.task_head_sha,
        candidate.task_fix_rounds
      );
    if (taskChanged.changes !== 1) return false;
    deps.db
      .prepare(
        `INSERT INTO fleet_task_fixes
         (id, fleet_run_id, task_id, worker_id, attempt, round, old_head_sha,
          policy_hash, verification_evidence_hash, state, project_path,
          worktree_path, branch_name, findings_json, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fixId,
        candidate.fleet_run_id,
        candidate.task_id,
        candidate.verification_worker_id,
        candidate.current_attempt,
        round,
        candidate.task_head_sha,
        contract.policyHash,
        contract.verificationEvidenceHash,
        candidate.project_path,
        candidate.task_worktree_path,
        candidate.task_branch_name,
        JSON.stringify(findings),
        nowIso,
        nowIso
      );
    const authorization = deps.db
      .prepare(
        `UPDATE fleet_action_authorizations
         SET attempt_count = attempt_count + 1, last_error = NULL, updated_at = ?
         WHERE fleet_run_id = ? AND action = 'fix' AND policy_hash = ?
           AND status = 'authorized'`
      )
      .run(nowIso, candidate.fleet_run_id, contract.policyHash);
    if (authorization.changes !== 1) {
      throw new Error("automatic fix authorization changed");
    }
    event(deps.db, candidate.fleet_run_id, "task_fix_queued", {
      fixId,
      taskId: candidate.task_id,
      attempt: candidate.current_attempt,
      round,
      oldHeadSha: candidate.task_head_sha,
      verificationEvidenceHash: contract.verificationEvidenceHash,
      policyHash: contract.policyHash,
    });
    return true;
  });
}

function finalizeReviews(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract
): boolean {
  const rows = exactReviewRows(deps.db, contract);
  if (rows.length !== FLEET_PLAN_REVIEW_LENSES.length) return false;
  const byLens = new Map(rows.map((row) => [row.lens, row]));
  if (
    !FLEET_PLAN_REVIEW_LENSES.every((lens) => byLens.has(lens)) ||
    rows.some((row) => !["clean", "changes_requested"].includes(row.state)) ||
    new Set(rows.map((row) => row.reviewer_session_id)).size !== rows.length ||
    rows.some((row) => !row.reviewer_session_id)
  ) {
    return false;
  }
  const candidate = contract.candidate;
  if (rows.some((row) => row.verdict !== "clean")) {
    const reason = automaticFixReason(deps, contract);
    return reason
      ? markReviewNeedsInspection(deps, contract, reason)
      : queueAutomaticFix(deps, contract, rows);
  }
  const nowIso = deps.now().toISOString();
  const changed = deps.db
    .prepare(
      `UPDATE fleet_tasks
       SET status = 'ready_to_merge', failure_code = NULL,
           review_status = 'clean', review_head_sha = ?,
           review_verification_hash = ?, review_completed_at = ?,
           active_fix_id = NULL, fixer_session_id = NULL, fix_error = NULL,
           updated_at = ?
       WHERE id = ? AND fleet_run_id = ? AND status = 'reviewing'
         AND current_attempt = ? AND head_sha = ? AND verification_id = ?
         AND verification_status = 'pass' AND verified_head_sha = ?
         AND verification_spec_hash = ?
         AND EXISTS (
           SELECT 1 FROM fleet_runs r
           WHERE r.id = fleet_tasks.fleet_run_id
             AND r.status IN ('running','reviewing','merging')
             AND r.desired_state = 'running'
         )`
    )
    .run(
      candidate.task_head_sha,
      contract.verificationEvidenceHash,
      nowIso,
      nowIso,
      candidate.task_id,
      candidate.fleet_run_id,
      candidate.current_attempt,
      candidate.task_head_sha,
      contract.verification.id,
      candidate.task_head_sha,
      contract.verification.spec_hash
    );
  if (changed.changes === 1) {
    event(deps.db, candidate.fleet_run_id, "task_review_clean", {
      taskId: candidate.task_id,
      attempt: candidate.current_attempt,
      headSha: candidate.task_head_sha,
      verificationId: contract.verification.id,
      verificationEvidenceHash: contract.verificationEvidenceHash,
      policyHash: contract.policyHash,
      reviewerSessionIds: rows.map((row) => row.reviewer_session_id),
    });
  }
  return changed.changes === 1;
}

async function cleanupSupersededReviewsForTask(
  deps: FleetTaskReviewDeps,
  contract: TaskReviewContract
): Promise<void> {
  const candidate = contract.candidate;
  const rows = deps.db
    .prepare(
      `SELECT * FROM fleet_task_reviews
       WHERE task_id = ? AND state IN ('pending','spawning','running','cleanup_pending')
         AND NOT (
           attempt = ? AND head_sha = ? AND verification_id = ?
           AND verification_evidence_hash = ? AND policy_hash = ?
         )
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(
      candidate.task_id,
      candidate.current_attempt,
      candidate.task_head_sha,
      contract.verification.id,
      contract.verificationEvidenceHash,
      contract.policyHash,
      ACTIVE_LIMIT
    ) as FleetTaskReviewRow[];
  for (let row of rows) {
    if (row.state === "spawning") row = await recoverSpawningReview(deps, row);
    if (row.reviewer_session_id) {
      const stopped = await deps
        .stopSession(row.reviewer_session_id, "failed")
        .catch(() => false);
      if (!stopped) continue;
    }
    if (row.state !== "cleanup_pending") {
      queueReviewResult(deps, row, {
        verdict: "changes_requested",
        findings: [],
        bytes: null,
        error: "task review evidence was superseded",
        persistArtifacts: false,
      });
      row = deps.db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
        .get(row.id) as FleetTaskReviewRow;
    }
    if (row.state === "cleanup_pending") await cleanupReview(deps, row);
  }
}

async function cleanupOrphanedRuntimeRows(
  deps: FleetTaskReviewDeps
): Promise<void> {
  const reviews = deps.db
    .prepare(
      `SELECT tr.* FROM fleet_task_reviews tr
       LEFT JOIN fleet_tasks t ON t.id = tr.task_id
       LEFT JOIN fleet_runs r ON r.id = tr.fleet_run_id
       WHERE tr.state IN ('pending','spawning','running','cleanup_pending')
         AND (
           t.id IS NULL OR t.status <> 'reviewing' OR
           t.current_attempt <> tr.attempt OR t.head_sha <> tr.head_sha OR
           t.verification_id <> tr.verification_id OR
           r.id IS NULL OR r.status NOT IN ('running','reviewing','merging') OR
           r.desired_state <> 'running'
         )
       ORDER BY tr.updated_at ASC LIMIT ?`
    )
    .all(ACTIVE_LIMIT) as FleetTaskReviewRow[];
  for (let row of reviews) {
    if (row.state === "spawning") row = await recoverSpawningReview(deps, row);
    if (row.reviewer_session_id) {
      const stopped = await deps
        .stopSession(row.reviewer_session_id, "failed")
        .catch(() => false);
      if (!stopped) continue;
    }
    if (row.state !== "cleanup_pending") {
      queueReviewResult(deps, row, {
        verdict: "changes_requested",
        findings: [],
        bytes: null,
        error: "task review runtime was superseded",
        persistArtifacts: false,
      });
      row = deps.db
        .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
        .get(row.id) as FleetTaskReviewRow;
    }
    if (row.state === "cleanup_pending") await cleanupReview(deps, row);
  }

  const fixes = deps.db
    .prepare(
      `SELECT f.* FROM fleet_task_fixes f
       LEFT JOIN fleet_tasks t ON t.id = f.task_id
       LEFT JOIN fleet_runs r ON r.id = f.fleet_run_id
       WHERE f.state IN ('pending','spawning','running','cleanup_pending')
         AND (
           t.id IS NULL OR t.status <> 'fixing' OR t.active_fix_id <> f.id OR
           t.current_attempt <> f.attempt OR t.head_sha <> f.old_head_sha OR
           r.id IS NULL OR r.status NOT IN ('running','reviewing','merging') OR
           r.desired_state <> 'running'
         )
       ORDER BY f.updated_at ASC LIMIT ?`
    )
    .all(ACTIVE_LIMIT) as FleetTaskFixRow[];
  for (let row of fixes) {
    if (row.state === "spawning") {
      row = await recoverSpawningFleetTaskFix(deps, row);
    }
    if (row.fixer_session_id) {
      const stopped = await deps
        .stopSession(row.fixer_session_id, "failed")
        .catch(() => false);
      if (!stopped) continue;
    }
    recordFleetTaskFixFailure(
      deps,
      row,
      "automatic fix runtime was superseded"
    );
  }

  const terminalPaths = deps.db
    .prepare(
      `SELECT result_path FROM fleet_task_fixes
       WHERE state IN ('completed','failed') AND result_path <> ''
       ORDER BY completed_at DESC LIMIT ?`
    )
    .all(ACTIVE_LIMIT) as Array<{ result_path: string }>;
  for (const item of terminalPaths) await deps.removeResult(item.result_path);
}

const reconcileLock = new Set<string>();

/**
 * Advance exact-SHA four-lane task reviews and bounded automatic fix rounds.
 * Durable row-state CAS operations make repeated ticks and process restarts
 * idempotent; only cleaned, distinct, exact-evidence lanes can reach merge.
 */
export async function reconcileFleetTaskReviews(
  overrides: Partial<FleetTaskReviewDeps> = {},
  options: ReconcileFleetTaskReviewOptions = {}
): Promise<number> {
  const deps = dependencies(overrides);
  assertFleetLaunchReady(deps.db, options.runId);
  if (reconcileLock.has("global")) return 0;
  reconcileLock.add("global");
  let processed = 0;
  try {
    const scoped = Boolean(options.runId || options.taskId);
    if (!scoped) await cleanupOrphanedRuntimeRows(deps);
    reconcileFleetTaskFixSettlements(deps);

    const fixes = (
      deps.db
        .prepare(
          `SELECT fix.* FROM fleet_task_fixes fix
           JOIN fleet_runs run ON run.id = fix.fleet_run_id
           WHERE fix.state IN ('pending','spawning','running','cleanup_pending')
             AND (fix.state <> 'pending' OR (
               run.status IN ('running','reviewing','merging')
               AND run.desired_state = 'running'
               AND run.recovery_required = 0
             ))
           ORDER BY fix.updated_at ASC, fix.created_at ASC LIMIT ?`
        )
        .all(ACTIVE_LIMIT) as FleetTaskFixRow[]
    ).filter(
      (row) =>
        (!options.runId || row.fleet_run_id === options.runId) &&
        (!options.taskId || row.task_id === options.taskId)
    );
    for (const row of fixes) {
      await reconcileFleetTaskFixRow(deps, row);
      processed += 1;
    }

    const maxTasks = Math.min(
      Math.max(
        Number.isSafeInteger(options.maxTasks) ? Number(options.maxTasks) : 2,
        1
      ),
      CANDIDATE_LIMIT
    );
    const candidates = listReviewCandidates(deps.db, CANDIDATE_LIMIT).filter(
      (candidate) =>
        (!options.runId || candidate.fleet_run_id === options.runId) &&
        (!options.taskId || candidate.task_id === options.taskId)
    );
    for (const candidate of candidates.slice(0, maxTasks)) {
      const result = candidateError(candidate);
      if ("code" in result) {
        const active = deps.db
          .prepare(
            `SELECT * FROM fleet_task_reviews
             WHERE task_id = ? AND state IN ('pending','spawning','running','cleanup_pending')
             ORDER BY created_at ASC LIMIT ?`
          )
          .all(candidate.task_id, ACTIVE_LIMIT) as FleetTaskReviewRow[];
        for (let row of active) {
          if (row.state === "spawning") {
            row = await recoverSpawningReview(deps, row);
          }
          if (row.reviewer_session_id) {
            const stopped = await deps
              .stopSession(row.reviewer_session_id, "failed")
              .catch(() => false);
            if (!stopped) continue;
          }
          if (row.state !== "cleanup_pending") {
            queueReviewResult(deps, row, {
              verdict: "changes_requested",
              findings: [],
              bytes: null,
              error: result.message,
              persistArtifacts: false,
            });
            row = deps.db
              .prepare(`SELECT * FROM fleet_task_reviews WHERE id = ?`)
              .get(row.id) as FleetTaskReviewRow;
          }
          if (row.state === "cleanup_pending") await cleanupReview(deps, row);
        }
        writeTaskBlocker(deps, candidate, result.code, result.message);
        processed += 1;
        continue;
      }
      await cleanupSupersededReviewsForTask(deps, result);
      ensureReviewSlots(deps, result);
      const rows = exactReviewRows(deps.db, result);
      for (const lens of FLEET_PLAN_REVIEW_LENSES) {
        const row = rows.find((item) => item.lens === lens);
        if (row) await reconcileReviewRow(deps, result, row);
      }
      finalizeReviews(deps, result);
      processed += 1;
    }
    return processed;
  } finally {
    reconcileLock.delete("global");
  }
}
