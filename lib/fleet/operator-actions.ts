import { createHash } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries, type Session } from "@/lib/db";
import { sendToWorker } from "@/lib/orchestration";
import { canReserveFleetBudget } from "./admission";
import { parseFleetAutomationPolicy } from "./automation-policy";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "./hash";
import { approvedExecutionHash } from "./merge-readiness";
import { stopFleetSession } from "./stop";
import { reconcileFleetTaskReviews } from "./task-review";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "./types";
import { reconcileFleetVerifications } from "./verification";

const REQUEST_ID_MAX = 128;
const ACTOR_MAX = 80;
const MESSAGE_MAX = 4_000;
const PLAN_HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ACTIVE_WORKER_STATES = [
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "cleanup_pending",
] as const;
const RETRYABLE_TASK_STATES = [
  "failed",
  "blocked",
  "needs_inspection",
  "needs_followup",
] as const;

export interface FleetOperatorDeps {
  db: Database.Database;
  now: () => Date;
  sendMessage: (sessionId: string, message: string) => Promise<boolean>;
  stopSession: (sessionId: string) => Promise<boolean>;
  reconcileVerification: (options: {
    runId: string;
    taskId: string;
    maxPerTick: number;
  }) => Promise<number>;
  reconcileReview: (options: {
    runId: string;
    taskId: string;
    maxTasks: number;
  }) => Promise<number>;
}

export type FleetOperatorActionResult =
  | {
      ok: true;
      action: string;
      idempotent: boolean;
      processed?: number;
      queued?: boolean;
    }
  | { error: string; status: number };

interface TaskActionInput {
  requestId: string;
  expectedPlanHash: string;
  expectedAttempt: number;
  expectedHeadSha: string | null;
}

interface WorkerActionInput {
  requestId: string;
  expectedAttempt: number;
  expectedSessionId: string;
}

interface ReplayRow {
  event_type: string;
  payload: string | null;
}

interface ReplayState {
  eventTypes: Set<string>;
  fingerprint: string;
}

function dependencies(
  overrides: Partial<FleetOperatorDeps> = {}
): FleetOperatorDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    sendMessage: overrides.sendMessage ?? sendToWorker,
    stopSession:
      overrides.stopSession ??
      ((sessionId) => stopFleetSession(sessionId, "failed")),
    reconcileVerification:
      overrides.reconcileVerification ??
      ((options) => reconcileFleetVerifications({}, options)),
    reconcileReview:
      overrides.reconcileReview ??
      ((options) => reconcileFleetTaskReviews({}, options)),
  };
}

function transaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) return callback();
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

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function identifier(value: unknown, max = REQUEST_ID_MAX): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate &&
    candidate.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : null;
}

function actorValue(value: string): string {
  return identifier(value, ACTOR_MAX) ?? "operator";
}

function positiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function parseTaskInput(
  input: unknown,
  options: { nullableHead: boolean }
): TaskActionInput | { error: string; status: number } {
  const body = objectValue(input);
  const requestId = identifier(body.requestId);
  if (!requestId) return { error: "requestId is required", status: 400 };
  if (
    typeof body.expectedPlanHash !== "string" ||
    !PLAN_HASH.test(body.expectedPlanHash)
  ) {
    return {
      error: "expectedPlanHash must be an exact SHA-256 hash",
      status: 400,
    };
  }
  const expectedAttempt = positiveInteger(body.expectedAttempt);
  if (!expectedAttempt) {
    return { error: "expectedAttempt must be a positive integer", status: 400 };
  }
  const expectedHeadSha = body.expectedHeadSha;
  if (!(
    (options.nullableHead && expectedHeadSha === null) ||
    (typeof expectedHeadSha === "string" && GIT_SHA.test(expectedHeadSha))
  )) {
    return {
      error: options.nullableHead
        ? "expectedHeadSha must be an exact Git SHA or null"
        : "expectedHeadSha must be an exact Git SHA",
      status: 400,
    };
  }
  return {
    requestId,
    expectedPlanHash: body.expectedPlanHash,
    expectedAttempt,
    expectedHeadSha: expectedHeadSha as string | null,
  };
}

function parseWorkerInput(
  input: unknown
): WorkerActionInput | { error: string; status: number } {
  const body = objectValue(input);
  const requestId = identifier(body.requestId);
  const expectedSessionId = identifier(body.expectedSessionId);
  const expectedAttempt = positiveInteger(body.expectedAttempt);
  if (!requestId) return { error: "requestId is required", status: 400 };
  if (!expectedSessionId) {
    return { error: "expectedSessionId is required", status: 400 };
  }
  if (!expectedAttempt) {
    return { error: "expectedAttempt must be a positive integer", status: 400 };
  }
  return { requestId, expectedSessionId, expectedAttempt };
}

function fingerprint(action: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, value }), "utf8")
    .digest("hex");
}

function replayState(
  db: Database.Database,
  runId: string,
  requestId: string,
  action: string
): ReplayState | null {
  const rows = db
    .prepare(
      `SELECT event_type, payload FROM fleet_events
       WHERE fleet_run_id = ? AND json_valid(payload)
         AND json_extract(payload, '$.requestId') = ?
         AND json_extract(payload, '$.action') = ?
       ORDER BY id ASC`
    )
    .all(runId, requestId, action) as ReplayRow[];
  if (rows.length === 0) return null;
  const fingerprints = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = objectValue(JSON.parse(row.payload ?? "{}"));
      if (typeof parsed.fingerprint === "string") {
        fingerprints.add(parsed.fingerprint);
      }
    } catch {
      // json_valid above makes this defensive only.
    }
  }
  return {
    eventTypes: new Set(rows.map((row) => row.event_type)),
    fingerprint: fingerprints.size === 1 ? [...fingerprints][0] : "",
  };
}

function appendEvent(
  db: Database.Database,
  input: {
    runId: string;
    eventType: string;
    actor: string;
    action: string;
    requestId: string;
    fingerprint: string;
    detail?: Record<string, unknown>;
  }
): void {
  queries.createFleetEvent(db).run(
    input.runId,
    input.eventType,
    input.actor,
    JSON.stringify({
      action: input.action,
      requestId: input.requestId,
      fingerprint: input.fingerprint,
      ...(input.detail ?? {}),
    })
  );
}

function replayError(
  replay: ReplayState | null,
  expectedFingerprint: string
): FleetOperatorActionResult | null {
  return replay && replay.fingerprint !== expectedFingerprint
    ? { error: "requestId was already used with different inputs", status: 409 }
    : null;
}

function getRunAndTask(
  db: Database.Database,
  runId: string,
  taskId: string
):
  { run: FleetRunRow; task: FleetTaskRow } | { error: string; status: number } {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  const task = queries.getFleetTaskForRun(db).get(runId, taskId) as
    FleetTaskRow | undefined;
  if (!task) return { error: "Fleet task not found", status: 404 };
  return { run, task };
}

function approvalError(
  db: Database.Database,
  run: FleetRunRow,
  task: FleetTaskRow,
  expectedPlanHash: string
): string | null {
  if (
    run.approval_state !== "approved" ||
    run.plan_hash !== expectedPlanHash ||
    run.approved_plan_hash !== expectedPlanHash ||
    task.approval_state !== "approved" ||
    task.approved_task_hash !== expectedPlanHash
  ) {
    return "the task is no longer bound to the expected approved plan";
  }
  const parsedPolicy = parseFleetAutomationPolicy(run.automation_policy_json);
  if (
    !parsedPolicy.valid ||
    !run.automation_policy_hash ||
    hashFleetAutomationPolicy(parsedPolicy.policy) !==
      run.automation_policy_hash
  ) {
    return "the Fleet automation policy is invalid or changed";
  }
  const tasks = queries.listFleetTasksForRun(db).all(run.id) as FleetTaskRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskDependencyRow[];
  if (hashFleetTaskRows(tasks, dependencies) !== expectedPlanHash) {
    return "the approved task graph changed";
  }
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskClaimRow[];
  const expectedExecution = approvedExecutionHash(run);
  if (
    !expectedExecution ||
    hashFleetExecutionContract({ run, tasks, claims, dependencies }) !==
      expectedExecution
  ) {
    return "the approved execution contract changed";
  }
  return null;
}

function exactTaskError(
  task: FleetTaskRow,
  input: TaskActionInput
): string | null {
  if (task.current_attempt !== input.expectedAttempt) {
    return "task attempt changed";
  }
  if (task.head_sha !== input.expectedHeadSha) return "task head changed";
  return null;
}

function workerBinding(
  db: Database.Database,
  runId: string,
  workerId: string,
  input: WorkerActionInput
):
  | { run: FleetRunRow; worker: FleetWorkerRow; session: Session }
  | { error: string; status: number } {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  const worker = db
    .prepare(`SELECT * FROM fleet_workers WHERE id = ? AND fleet_run_id = ?`)
    .get(workerId, runId) as FleetWorkerRow | undefined;
  if (!worker) return { error: "Fleet worker not found", status: 404 };
  if (
    worker.attempt !== input.expectedAttempt ||
    worker.session_id !== input.expectedSessionId
  ) {
    return { error: "Fleet worker binding changed", status: 409 };
  }
  if (!worker.session_id) {
    return { error: "Fleet worker has no authoritative session", status: 409 };
  }
  const session = queries.getSession(db).get(worker.session_id) as
    Session | undefined;
  if (!session) {
    return { error: "Fleet worker session is missing", status: 409 };
  }
  if (
    !worker.worktree_path ||
    !session.worktree_path ||
    worker.worktree_path !== session.worktree_path ||
    (worker.branch_name !== null &&
      session.branch_name !== null &&
      worker.branch_name !== session.branch_name)
  ) {
    return {
      error: "Fleet worker session binding is inconsistent",
      status: 409,
    };
  }
  return { run, worker, session };
}

export function retryFleetTask(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetOperatorDeps> = {}
): FleetOperatorActionResult {
  const parsed = parseTaskInput(input, { nullableHead: true });
  if ("error" in parsed) return parsed;
  const deps = dependencies(overrides);
  const action = "task_retry";
  const actionFingerprint = fingerprint(action, parsed);
  const safeActor = actorValue(actor);

  return transaction(deps.db, () => {
    const replay = replayState(deps.db, runId, parsed.requestId, action);
    const invalidReplay = replayError(replay, actionFingerprint);
    if (invalidReplay) return invalidReplay;
    if (replay?.eventTypes.has("task_retry_queued")) {
      return { ok: true, action, idempotent: true, queued: true };
    }
    const found = getRunAndTask(deps.db, runId, taskId);
    if ("error" in found) return found;
    const { run, task } = found;
    const approval = approvalError(deps.db, run, task, parsed.expectedPlanHash);
    if (approval) return { error: approval, status: 409 };
    const stale = exactTaskError(task, parsed);
    if (stale) return { error: stale, status: 409 };
    if (!["running", "paused"].includes(run.status)) {
      return { error: "Fleet run is not active or paused", status: 409 };
    }
    if (!(RETRYABLE_TASK_STATES as readonly string[]).includes(task.status)) {
      return { error: "Fleet task is not retryable", status: 409 };
    }
    if ((task.current_attempt ?? 0) >= (task.max_attempts ?? 2)) {
      return {
        error: "Fleet task has reached its maximum attempts",
        status: 409,
      };
    }
    if (
      !canReserveFleetBudget({
        budgetUsd: run.budget_usd,
        reservedBudgetUsd: run.reserved_budget_usd ?? 0,
        spentBudgetUsd: run.spent_budget_usd ?? 0,
      })
    ) {
      return {
        error: "Fleet budget cannot reserve another attempt",
        status: 409,
      };
    }
    const active = deps.db
      .prepare(
        `SELECT 1 FROM fleet_workers
         WHERE fleet_run_id = ? AND task_id = ?
           AND status IN (${ACTIVE_WORKER_STATES.map(() => "?").join(",")})
         LIMIT 1`
      )
      .get(runId, taskId, ...ACTIVE_WORKER_STATES);
    if (active) {
      return {
        error: "Fleet task still has an active or cleanup-pending worker",
        status: 409,
      };
    }

    const nowIso = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_tasks SET
           status = 'ready', failure_code = NULL, ended_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL, spawn_request_id = NULL,
           worktree_path = NULL, head_sha = NULL,
           actual_file_claims_json = '[]', report_artifact_id = NULL,
           diff_artifact_id = NULL, verification_id = NULL,
           verification_status = NULL, verification_spec_hash = NULL,
           verified_head_sha = NULL, verification_artifact_id = NULL,
           verification_started_at = NULL, verification_completed_at = NULL,
           review_status = NULL, review_head_sha = NULL,
           review_verification_hash = NULL, review_completed_at = NULL,
           active_fix_id = NULL, fixer_session_id = NULL, fix_error = NULL,
           integration_state = 'pending', integration_operation_id = NULL,
           integrated_head_sha = NULL, integrated_at = NULL,
           retry_not_before = NULL, provider_state = 'ready',
           provider_last_error = NULL, provider_backoff_event_at = NULL,
           updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = ?
           AND current_attempt = ? AND head_sha IS ?
           AND approved_task_hash = ?`
      )
      .run(
        nowIso,
        taskId,
        runId,
        task.status,
        parsed.expectedAttempt,
        parsed.expectedHeadSha,
        parsed.expectedPlanHash
      );
    if (changed.changes !== 1) {
      return { error: "Fleet task state changed", status: 409 };
    }
    appendEvent(deps.db, {
      runId,
      eventType: "task_retry_queued",
      actor: safeActor,
      action,
      requestId: parsed.requestId,
      fingerprint: actionFingerprint,
      detail: {
        taskId,
        attempt: parsed.expectedAttempt,
        previousStatus: task.status,
        previousHeadSha: parsed.expectedHeadSha,
        planHash: parsed.expectedPlanHash,
        preservedWorktree: task.worktree_path,
      },
    });
    return { ok: true, action, idempotent: false, queued: true };
  });
}

async function reconcileTaskAction(
  kind: "verification" | "review",
  runId: string,
  taskId: string,
  input: unknown,
  actor: string,
  overrides: Partial<FleetOperatorDeps>
): Promise<FleetOperatorActionResult> {
  const parsed = parseTaskInput(input, { nullableHead: false });
  if ("error" in parsed) return parsed;
  const body = objectValue(input);
  const expectedEvidenceHash =
    kind === "review" &&
    typeof body.expectedVerificationEvidenceHash === "string" &&
    PLAN_HASH.test(body.expectedVerificationEvidenceHash)
      ? body.expectedVerificationEvidenceHash
      : null;
  if (kind === "review" && !expectedEvidenceHash) {
    return {
      error: "expectedVerificationEvidenceHash must be an exact SHA-256 hash",
      status: 400,
    };
  }
  const deps = dependencies(overrides);
  const action = `${kind}_reconcile`;
  const fingerprintInput = {
    ...parsed,
    ...(kind === "review"
      ? { expectedVerificationEvidenceHash: expectedEvidenceHash }
      : {}),
  };
  const actionFingerprint = fingerprint(action, fingerprintInput);
  const safeActor = actorValue(actor);

  const prepared = transaction<
    FleetOperatorActionResult | { ok: true; dispatch: true }
  >(deps.db, () => {
    const replay = replayState(deps.db, runId, parsed.requestId, action);
    const invalidReplay = replayError(replay, actionFingerprint);
    if (invalidReplay) return invalidReplay;
    if (replay?.eventTypes.has(`${kind}_reconcile_dispatched`)) {
      return { ok: true, action, idempotent: true, processed: 0 };
    }
    const found = getRunAndTask(deps.db, runId, taskId);
    if ("error" in found) return found;
    const { run, task } = found;
    if (!["running", "paused"].includes(run.status)) {
      return { error: "Fleet run is not active or paused", status: 409 };
    }
    const approval = approvalError(deps.db, run, task, parsed.expectedPlanHash);
    if (approval) return { error: approval, status: 409 };
    const stale = exactTaskError(task, parsed);
    if (stale) return { error: stale, status: 409 };
    const expectedStatus = kind === "verification" ? "verifying" : "reviewing";
    if (task.status !== expectedStatus) {
      return {
        error: `Fleet task is not awaiting ${kind}`,
        status: 409,
      };
    }
    if (kind === "review") {
      const verification = task.verification_id
        ? (deps.db
            .prepare(
              `SELECT output_hash FROM fleet_verifications
                 WHERE id = ? AND fleet_run_id = ? AND task_id = ?
                   AND attempt = ? AND head_sha = ? AND status = 'pass'`
            )
            .get(
              task.verification_id,
              runId,
              taskId,
              parsed.expectedAttempt,
              parsed.expectedHeadSha
            ) as { output_hash: string | null } | undefined)
        : undefined;
      if (
        !verification?.output_hash ||
        verification.output_hash !== expectedEvidenceHash
      ) {
        return { error: "verification evidence changed", status: 409 };
      }
    }
    if (!replay) {
      appendEvent(deps.db, {
        runId,
        eventType: `${kind}_reconcile_requested`,
        actor: safeActor,
        action,
        requestId: parsed.requestId,
        fingerprint: actionFingerprint,
        detail: {
          taskId,
          attempt: parsed.expectedAttempt,
          headSha: parsed.expectedHeadSha,
          planHash: parsed.expectedPlanHash,
          ...(expectedEvidenceHash
            ? { verificationEvidenceHash: expectedEvidenceHash }
            : {}),
        },
      });
    }
    return { ok: true, dispatch: true };
  });
  if (!("dispatch" in prepared)) return prepared;

  try {
    const processed =
      kind === "verification"
        ? await deps.reconcileVerification({
            runId,
            taskId,
            maxPerTick: 1,
          })
        : await deps.reconcileReview({ runId, taskId, maxTasks: 1 });
    transaction(deps.db, () => {
      const replay = replayState(deps.db, runId, parsed.requestId, action);
      if (!replay?.eventTypes.has(`${kind}_reconcile_dispatched`)) {
        appendEvent(deps.db, {
          runId,
          eventType: `${kind}_reconcile_dispatched`,
          actor: safeActor,
          action,
          requestId: parsed.requestId,
          fingerprint: actionFingerprint,
          detail: { taskId, processed },
        });
      }
    });
    return { ok: true, action, idempotent: false, processed };
  } catch (error) {
    transaction(deps.db, () => {
      appendEvent(deps.db, {
        runId,
        eventType: `${kind}_reconcile_failed`,
        actor: safeActor,
        action,
        requestId: parsed.requestId,
        fingerprint: actionFingerprint,
        detail: {
          taskId,
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "reconcile failed",
        },
      });
    });
    return { error: `Fleet ${kind} reconciliation failed`, status: 500 };
  }
}

export function reconcileFleetTaskVerification(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetOperatorDeps> = {}
): Promise<FleetOperatorActionResult> {
  return reconcileTaskAction(
    "verification",
    runId,
    taskId,
    input,
    actor,
    overrides
  );
}

export function reconcileFleetTaskReview(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetOperatorDeps> = {}
): Promise<FleetOperatorActionResult> {
  return reconcileTaskAction("review", runId, taskId, input, actor, overrides);
}

export async function messageFleetWorker(
  runId: string,
  workerId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetOperatorDeps> = {}
): Promise<FleetOperatorActionResult> {
  const parsed = parseWorkerInput(input);
  if ("error" in parsed) return parsed;
  const body = objectValue(input);
  if (typeof body.message !== "string") {
    return { error: "message is required", status: 400 };
  }
  const message = body.message.trim();
  if (!message || message.length > MESSAGE_MAX || /\u0000/.test(message)) {
    return {
      error: `message must be 1-${MESSAGE_MAX} characters`,
      status: 400,
    };
  }
  const deps = dependencies(overrides);
  const action = "worker_message";
  const actionFingerprint = fingerprint(action, { ...parsed, message });
  const safeActor = actorValue(actor);
  const prepared = transaction<
    FleetOperatorActionResult | { ok: true; sessionId: string }
  >(deps.db, () => {
    const replay = replayState(deps.db, runId, parsed.requestId, action);
    const invalidReplay = replayError(replay, actionFingerprint);
    if (invalidReplay) return invalidReplay;
    if (replay?.eventTypes.has("worker_message_delivered")) {
      return { ok: true, action, idempotent: true };
    }
    if (replay?.eventTypes.has("worker_message_failed")) {
      return {
        error: "Fleet worker message delivery previously failed",
        status: 502,
      };
    }
    if (replay?.eventTypes.has("worker_message_requested")) {
      return {
        error:
          "Fleet worker message delivery outcome is unknown; inspect before using a new requestId",
        status: 409,
      };
    }
    const binding = workerBinding(deps.db, runId, workerId, parsed);
    if ("error" in binding) return binding;
    if (
      !(["running", "waiting_for_operator"] as string[]).includes(
        binding.worker.status
      )
    ) {
      return { error: "Fleet worker is not active", status: 409 };
    }
    appendEvent(deps.db, {
      runId,
      eventType: "worker_message_requested",
      actor: safeActor,
      action,
      requestId: parsed.requestId,
      fingerprint: actionFingerprint,
      detail: {
        workerId,
        sessionId: binding.session.id,
        attempt: binding.worker.attempt,
        messageHash: createHash("sha256").update(message, "utf8").digest("hex"),
        messageBytes: Buffer.byteLength(message, "utf8"),
      },
    });
    return { ok: true, sessionId: binding.session.id };
  });
  if (!("sessionId" in prepared)) return prepared;

  let sent = false;
  try {
    sent = await deps.sendMessage(prepared.sessionId, message);
  } catch {
    sent = false;
  }
  transaction(deps.db, () => {
    appendEvent(deps.db, {
      runId,
      eventType: sent ? "worker_message_delivered" : "worker_message_failed",
      actor: safeActor,
      action,
      requestId: parsed.requestId,
      fingerprint: actionFingerprint,
      detail: { workerId, sessionId: prepared.sessionId },
    });
  });
  return sent
    ? { ok: true, action, idempotent: false }
    : { error: "Fleet worker message delivery failed", status: 502 };
}

export async function killFleetWorker(
  runId: string,
  workerId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetOperatorDeps> = {}
): Promise<FleetOperatorActionResult> {
  const parsed = parseWorkerInput(input);
  if ("error" in parsed) return parsed;
  const body = objectValue(input);
  if (body.cleanupWorktree === true || body.preserveWorktree === false) {
    return {
      error:
        "Fleet worker kill preserves its worktree; use explicit Fleet cleanup later",
      status: 409,
    };
  }
  const deps = dependencies(overrides);
  const action = "worker_kill";
  const actionFingerprint = fingerprint(action, parsed);
  const safeActor = actorValue(actor);
  const prepared = transaction<
    FleetOperatorActionResult | { ok: true; sessionId: string }
  >(deps.db, () => {
    const replay = replayState(deps.db, runId, parsed.requestId, action);
    const invalidReplay = replayError(replay, actionFingerprint);
    if (invalidReplay) return invalidReplay;
    if (replay?.eventTypes.has("worker_kill_completed")) {
      return { ok: true, action, idempotent: true };
    }
    const binding = workerBinding(deps.db, runId, workerId, parsed);
    if ("error" in binding) return binding;
    if (replay?.eventTypes.has("worker_kill_requested")) {
      if (
        binding.worker.status !== "cleanup_pending" ||
        !binding.worker.terminal_cause?.startsWith(
          "session_failed_operator_kill"
        )
      ) {
        return { error: "Fleet worker kill state changed", status: 409 };
      }
      return { ok: true, sessionId: binding.session.id };
    }
    if (
      !(["running", "waiting_for_operator"] as string[]).includes(
        binding.worker.status
      )
    ) {
      return { error: "Fleet worker is not active", status: 409 };
    }
    const nowIso = deps.now().toISOString();
    const changed = deps.db
      .prepare(
        `UPDATE fleet_workers SET status = 'cleanup_pending',
           terminal_cause = 'session_failed_operator_kill_pending',
           lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND fleet_run_id = ? AND session_id = ? AND attempt = ?
             AND status IN ('running','waiting_for_operator')`
      )
      .run(workerId, runId, binding.session.id, parsed.expectedAttempt);
    if (changed.changes !== 1) {
      return { error: "Fleet worker state changed", status: 409 };
    }
    if (binding.worker.task_id) {
      deps.db
        .prepare(
          `UPDATE fleet_tasks SET status = 'needs_inspection',
             failure_code = 'operator_kill_requested', ended_at = ?, updated_at = ?
             WHERE id = ? AND fleet_run_id = ?
               AND status IN ('leasing','spawning','running','waiting_for_operator')`
        )
        .run(nowIso, nowIso, binding.worker.task_id, runId);
    }
    appendEvent(deps.db, {
      runId,
      eventType: "worker_kill_requested",
      actor: safeActor,
      action,
      requestId: parsed.requestId,
      fingerprint: actionFingerprint,
      detail: {
        workerId,
        sessionId: binding.session.id,
        taskId: binding.worker.task_id,
        attempt: binding.worker.attempt,
        preserveWorktree: true,
      },
    });
    return { ok: true, sessionId: binding.session.id };
  });
  if (!("sessionId" in prepared)) return prepared;

  let stopped = false;
  try {
    stopped = await deps.stopSession(prepared.sessionId);
  } catch {
    stopped = false;
  }
  const outcome = transaction<"completed" | "pending" | "changed">(
    deps.db,
    () => {
      const current = deps.db
        .prepare(
          `SELECT * FROM fleet_workers WHERE id = ? AND fleet_run_id = ?`
        )
        .get(workerId, runId) as FleetWorkerRow | undefined;
      if (!current || current.session_id !== prepared.sessionId)
        return "changed";
      const replay = replayState(deps.db, runId, parsed.requestId, action);
      if (replay?.eventTypes.has("worker_kill_completed")) return "completed";
      const nowIso = deps.now().toISOString();
      if (!stopped) {
        if (current.status !== "cleanup_pending") return "changed";
        deps.db
          .prepare(
            `UPDATE fleet_workers SET terminal_cause = 'session_failed_operator_kill_stop_failed'
             WHERE id = ? AND fleet_run_id = ? AND status = 'cleanup_pending'
               AND terminal_cause LIKE 'session_failed_operator_kill%'`
          )
          .run(workerId, runId);
        if (current.task_id) {
          deps.db
            .prepare(
              `UPDATE fleet_tasks SET status = 'needs_inspection',
               failure_code = 'operator_kill_stop_failed', ended_at = COALESCE(ended_at, ?),
               updated_at = ? WHERE id = ? AND fleet_run_id = ?`
            )
            .run(nowIso, nowIso, current.task_id, runId);
        }
        deps.db
          .prepare(
            `UPDATE fleet_runs SET recovery_required = 1, updated_at = ? WHERE id = ?`
          )
          .run(nowIso, runId);
        if (!replay?.eventTypes.has("worker_kill_cleanup_pending")) {
          appendEvent(deps.db, {
            runId,
            eventType: "worker_kill_cleanup_pending",
            actor: safeActor,
            action,
            requestId: parsed.requestId,
            fingerprint: actionFingerprint,
            detail: {
              workerId,
              sessionId: prepared.sessionId,
              taskId: current.task_id,
              preserveWorktree: true,
            },
          });
        }
        return "pending";
      }
      if (current.status === "cleanup_pending") {
        const changed = deps.db
          .prepare(
            `UPDATE fleet_workers SET status = 'failed', terminal_cause = 'operator_killed',
             ended_at = ?, lease_owner = NULL, lease_expires_at = NULL
             WHERE id = ? AND fleet_run_id = ? AND session_id = ?
               AND status = 'cleanup_pending'
               AND terminal_cause LIKE 'session_failed_operator_kill%'`
          )
          .run(nowIso, workerId, runId, prepared.sessionId);
        if (changed.changes !== 1) return "changed";
        deps.db
          .prepare(
            `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
             spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
          )
          .run(
            current.reservation_usd ?? 0,
            current.reservation_usd ?? 0,
            nowIso,
            runId
          );
        deps.db
          .prepare(
            `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
             WHERE worker_id = ? AND status = 'reserved'
               AND resource_type <> 'worktree'`
          )
          .run(nowIso, workerId);
        deps.db
          .prepare(
            `UPDATE sessions SET worker_status = 'failed', updated_at = ? WHERE id = ?`
          )
          .run(nowIso, prepared.sessionId);
      } else if (current.status !== "failed") {
        return "changed";
      }
      appendEvent(deps.db, {
        runId,
        eventType: "worker_kill_completed",
        actor: safeActor,
        action,
        requestId: parsed.requestId,
        fingerprint: actionFingerprint,
        detail: {
          workerId,
          sessionId: prepared.sessionId,
          taskId: current.task_id,
          preserveWorktree: true,
        },
      });
      return "completed";
    }
  );
  if (outcome === "completed") {
    return { ok: true, action, idempotent: false };
  }
  if (outcome === "pending") {
    return {
      error:
        "Fleet worker did not stop; cleanup remains pending and the task needs inspection",
      status: 409,
    };
  }
  return { error: "Fleet worker state changed during kill", status: 409 };
}
