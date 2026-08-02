import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import { normalizeFleetClaims } from "./conflicts";
import { compareFleetPathClaims, findSensitiveFleetPaths } from "./git-state";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "./hash";
import { approvedExecutionHash } from "./merge-readiness";
import { fleetLaunchBlockedResult } from "./recovery-gate";
import { parseFleetAutomationPolicy } from "./automation-policy";
import {
  estimateFleetPlanReservation,
  type FleetPlanReservationSession,
  type FleetReservationHistorySample,
} from "./budgets";
import type { FleetApprovalCostEstimateDto } from "./approval-control-types";
import type {
  FleetApprovalState,
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
  FleetTaskStatus,
} from "./types";

const HASH = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REQUEST_ID_MAX = 128;
const ACTOR_MAX = 80;
const TIMESTAMP_MAX = 64;
const CLAIM_MAX = 500;
const CLAIM_PATH_MAX = 240;
const CONCURRENCY_MAX = 40;
const BUDGET_MAX_USD = 1_000_000_000;
const BUDGET_MAX_TOKENS = 1_000_000_000_000;
const ACTIVE_WORKER_STATES = [
  "leasing",
  "spawning",
  "running",
  "waiting_for_operator",
  "cleanup_pending",
] as const;
const NOT_STARTED_TASK_STATES = ["ready", "blocked"] as const;
const CLAIM_QUARANTINE_CODES = [
  "claim_drift",
  "sensitive_path_requires_review",
] as const;

export interface FleetApprovalControlDeps {
  db: Database.Database;
  now: () => Date;
}

export type FleetApprovalControlResult =
  | {
      ok: true;
      action: string;
      idempotent: boolean;
      planHash: string;
      executionHash: string;
    }
  | { error: string; status: number };

export interface FleetApprovalControlPreview {
  runId: string;
  estimate: FleetApprovalCostEstimateDto;
  bindings: {
    approvedPlanHash: string | null;
    currentPlanHash: string;
    approvedExecutionHash: string | null;
    currentExecutionHash: string;
    storedPolicyHash: string | null;
    currentPolicyHash: string | null;
    baseSha: string | null;
    runUpdatedAt: string;
  };
  approvedVsCurrent: {
    planChanged: boolean;
    executionChanged: boolean;
    policyChanged: boolean;
  };
  run: {
    status: string;
    maxConcurrency: number;
    budgetUsd: number | null;
    budgetTokens: number | null;
    reservedBudgetUsd: number;
    spentBudgetUsd: number;
    reservedBudgetTokens: number;
    spentBudgetTokens: number;
    budgetStopMode: string;
    budgetHardLimitAt: string | null;
    budgetInterruptDeadlineAt: string | null;
    pauseReason: string | null;
  };
  tasks: Array<{
    id: string;
    status: FleetTaskStatus;
    approvalState: FleetApprovalState;
    attempt: number;
    baseSha: string | null;
    headSha: string | null;
    updatedAt: string;
    notYetStarted: boolean;
    hasActiveWorker: boolean;
    manualLaunchApprovalRequired: boolean;
    approvedTaskHash: string | null;
    plannedClaims: string[];
    actualClaims: string[];
    actualClaimsHash: string;
    addedActualClaims: string[];
    sensitivePaths: ReturnType<typeof findSensitiveFleetPaths>;
    quarantinedForClaimApproval: boolean;
    skipClosure: {
      taskIds: string[];
      hash: string;
      eligible: boolean;
      blockers: string[];
    };
  }>;
  recentApprovals: Array<{
    eventType: string;
    actor: string;
    createdAt: string;
    detail: unknown;
  }>;
}

interface RunBindingInput {
  requestId: string;
  expectedPlanHash: string;
  expectedExecutionHash: string;
  expectedPolicyHash: string;
  expectedBaseSha: string | null;
  expectedRunUpdatedAt: string;
}

interface TaskBindingInput extends RunBindingInput {
  expectedTaskStatus: FleetTaskStatus;
  expectedTaskApprovalState: FleetApprovalState;
  expectedAttempt: number;
  expectedTaskBaseSha: string | null;
  expectedHeadSha: string | null;
  expectedTaskUpdatedAt: string;
}

interface ExactRunContext {
  run: FleetRunRow;
  tasks: FleetTaskRow[];
  claims: FleetTaskClaimRow[];
  dependencies: FleetTaskDependencyRow[];
  settings: Record<string, unknown>;
  executionHash: string;
}

interface ReplayRow {
  payload: string | null;
}

function requestIdHash(requestId: string): string {
  return createHash("sha256").update(requestId, "utf8").digest("hex");
}

function deps(
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
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

function boundedIdentifier(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  return candidate &&
    candidate.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : null;
}

function actorValue(value: string): string {
  return boundedIdentifier(value, ACTOR_MAX) ?? "operator";
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseStoredStringArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) &&
      parsed.every((entry): entry is string => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseExactHash(value: unknown, label: string) {
  return typeof value === "string" && HASH.test(value)
    ? value
    : ({
        error: `${label} must be an exact SHA-256 hash`,
        status: 400,
      } as const);
}

function parseNullableGitSha(value: unknown, label: string) {
  return value === null ||
    (typeof value === "string" && GIT_SHA.test(value.toLowerCase()))
    ? (value as string | null)
    : ({
        error: `${label} must be an exact Git SHA or null`,
        status: 400,
      } as const);
}

function parseRunBinding(
  input: unknown
): RunBindingInput | { error: string; status: number } {
  const body = objectValue(input);
  const requestId = boundedIdentifier(body.requestId, REQUEST_ID_MAX);
  if (!requestId) return { error: "requestId is required", status: 400 };
  const expectedPlanHash = parseExactHash(
    body.expectedPlanHash,
    "expectedPlanHash"
  );
  if (typeof expectedPlanHash !== "string") return expectedPlanHash;
  const expectedExecutionHash = parseExactHash(
    body.expectedExecutionHash,
    "expectedExecutionHash"
  );
  if (typeof expectedExecutionHash !== "string") return expectedExecutionHash;
  const expectedPolicyHash = parseExactHash(
    body.expectedPolicyHash,
    "expectedPolicyHash"
  );
  if (typeof expectedPolicyHash !== "string") return expectedPolicyHash;
  const expectedBaseSha = parseNullableGitSha(
    body.expectedBaseSha,
    "expectedBaseSha"
  );
  if (typeof expectedBaseSha !== "string" && expectedBaseSha !== null) {
    return expectedBaseSha;
  }
  const expectedRunUpdatedAt = boundedIdentifier(
    body.expectedRunUpdatedAt,
    TIMESTAMP_MAX
  );
  if (!expectedRunUpdatedAt) {
    return { error: "expectedRunUpdatedAt is required", status: 400 };
  }
  return {
    requestId,
    expectedPlanHash,
    expectedExecutionHash,
    expectedPolicyHash,
    expectedBaseSha,
    expectedRunUpdatedAt,
  };
}

function taskStatus(value: unknown): FleetTaskStatus | null {
  const statuses: FleetTaskStatus[] = [
    "draft",
    "planned",
    "ready",
    "blocked",
    "leasing",
    "spawning",
    "running",
    "waiting_for_operator",
    "needs_followup",
    "needs_inspection",
    "verifying",
    "reviewing",
    "fixing",
    "ready_to_merge",
    "merging",
    "merged",
    "failed",
    "canceled",
    "skipped",
    "completed",
  ];
  return statuses.includes(value as FleetTaskStatus)
    ? (value as FleetTaskStatus)
    : null;
}

function approvalState(value: unknown): FleetApprovalState | null {
  return ["draft", "needs_approval", "approved", "blocked"].includes(
    String(value)
  )
    ? (value as FleetApprovalState)
    : null;
}

function parseTaskBinding(
  input: unknown
): TaskBindingInput | { error: string; status: number } {
  const run = parseRunBinding(input);
  if ("error" in run) return run;
  const body = objectValue(input);
  const expectedTaskStatus = taskStatus(body.expectedTaskStatus);
  const expectedTaskApprovalState = approvalState(
    body.expectedTaskApprovalState
  );
  const expectedAttempt = Number(body.expectedAttempt);
  const expectedTaskBaseSha = parseNullableGitSha(
    body.expectedTaskBaseSha,
    "expectedTaskBaseSha"
  );
  const expectedHeadSha = parseNullableGitSha(
    body.expectedHeadSha,
    "expectedHeadSha"
  );
  const expectedTaskUpdatedAt = boundedIdentifier(
    body.expectedTaskUpdatedAt,
    TIMESTAMP_MAX
  );
  if (!expectedTaskStatus) {
    return { error: "expectedTaskStatus is invalid", status: 400 };
  }
  if (!expectedTaskApprovalState) {
    return { error: "expectedTaskApprovalState is invalid", status: 400 };
  }
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 0) {
    return {
      error: "expectedAttempt must be a non-negative integer",
      status: 400,
    };
  }
  if (typeof expectedTaskBaseSha !== "string" && expectedTaskBaseSha !== null) {
    return expectedTaskBaseSha;
  }
  if (typeof expectedHeadSha !== "string" && expectedHeadSha !== null) {
    return expectedHeadSha;
  }
  if (!expectedTaskUpdatedAt) {
    return { error: "expectedTaskUpdatedAt is required", status: 400 };
  }
  return {
    ...run,
    expectedTaskStatus,
    expectedTaskApprovalState,
    expectedAttempt,
    expectedTaskBaseSha,
    expectedHeadSha,
    expectedTaskUpdatedAt,
  };
}

function exactRunContext(
  db: Database.Database,
  runId: string,
  input: RunBindingInput
): ExactRunContext | { error: string; status: number } {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "canceled" ||
    run.merge_requested_at != null
  ) {
    return {
      error: "Fleet run is terminal or external landing is already authorized",
      status: 409,
    };
  }
  if (
    run.approval_state !== "approved" ||
    !run.plan_hash ||
    run.approved_plan_hash !== run.plan_hash ||
    run.plan_hash !== input.expectedPlanHash
  ) {
    return { error: "the approved plan binding changed", status: 409 };
  }
  if (run.updated_at !== input.expectedRunUpdatedAt) {
    return { error: "Fleet run changed", status: 409 };
  }
  if ((run.automation_base_sha ?? null) !== input.expectedBaseSha) {
    return { error: "Fleet run base commit changed", status: 409 };
  }
  const parsedPolicy = parseFleetAutomationPolicy(run.automation_policy_json);
  if (!parsedPolicy.valid) {
    return { error: "Fleet automation policy is invalid", status: 409 };
  }
  const policyHash = hashFleetAutomationPolicy(parsedPolicy.policy);
  if (
    run.automation_policy_hash !== policyHash ||
    policyHash !== input.expectedPolicyHash
  ) {
    return { error: "Fleet automation policy changed", status: 409 };
  }
  const settings = parseJsonObject(run.settings_json);
  if (!settings)
    return { error: "Fleet run settings are invalid", status: 409 };
  const tasks = queries.listFleetTasksForRun(db).all(runId) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(runId) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(runId) as FleetTaskDependencyRow[];
  if (hashFleetTaskRows(tasks, dependencies) !== run.plan_hash) {
    return { error: "the approved plan graph changed", status: 409 };
  }
  const executionHash = hashFleetExecutionContract({
    run,
    tasks,
    claims,
    dependencies,
  });
  if (
    approvedExecutionHash(run) !== executionHash ||
    executionHash !== input.expectedExecutionHash
  ) {
    return { error: "the approved execution contract changed", status: 409 };
  }
  return { run, tasks, claims, dependencies, settings, executionHash };
}

function exactTask(
  db: Database.Database,
  runId: string,
  taskId: string,
  input: TaskBindingInput
): FleetTaskRow | { error: string; status: number } {
  const task = queries.getFleetTaskForRun(db).get(runId, taskId) as
    FleetTaskRow | undefined;
  if (!task) return { error: "Fleet task not found", status: 404 };
  if (
    task.status !== input.expectedTaskStatus ||
    task.approval_state !== input.expectedTaskApprovalState ||
    (task.current_attempt ?? 0) !== input.expectedAttempt ||
    (task.base_sha ?? null) !== input.expectedTaskBaseSha ||
    (task.head_sha ?? null) !== input.expectedHeadSha ||
    task.updated_at !== input.expectedTaskUpdatedAt
  ) {
    return { error: "Fleet task changed", status: 409 };
  }
  if (task.approved_task_hash !== input.expectedPlanHash) {
    return { error: "Fleet task approval binding changed", status: 409 };
  }
  return task;
}

function activeWorkerCount(
  db: Database.Database,
  runId: string,
  taskId: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM fleet_workers
       WHERE fleet_run_id = ? AND task_id = ?
         AND status IN (${ACTIVE_WORKER_STATES.map(() => "?").join(",")})`
    )
    .get(runId, taskId, ...ACTIVE_WORKER_STATES) as { n: number };
  return row.n;
}

function workerCount(
  db: Database.Database,
  runId: string,
  taskId: string
): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers
         WHERE fleet_run_id = ? AND task_id = ?`
      )
      .get(runId, taskId) as { n: number }
  ).n;
}

interface FleetSkipClosure {
  entries: Array<{ task: FleetTaskRow; workerCount: number }>;
  taskIds: string[];
  hash: string;
  eligible: boolean;
  blockers: string[];
}

function fleetSkipClosure(
  db: Database.Database,
  runId: string,
  targetTaskId: string,
  tasks: FleetTaskRow[],
  dependencies: FleetTaskDependencyRow[]
): FleetSkipClosure {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const dependents = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (dependency.dependency_type !== "blocks") continue;
    const current = dependents.get(dependency.depends_on_task_id) ?? [];
    current.push(dependency.task_id);
    dependents.set(dependency.depends_on_task_id, current);
  }
  const seen = new Set<string>();
  const queue = [targetTaskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependent of (dependents.get(current) ?? []).sort()) {
      queue.push(dependent);
    }
  }
  const entries = [...seen]
    .flatMap((id) => {
      const task = taskById.get(id);
      return task ? [{ task, workerCount: workerCount(db, runId, id) }] : [];
    })
    .sort(
      (left, right) =>
        left.task.sort_order - right.task.sort_order ||
        left.task.id.localeCompare(right.task.id)
    );
  const blockers: string[] = [];
  for (const entry of entries) {
    const task = entry.task;
    const untouched =
      (task.current_attempt ?? 0) === 0 &&
      task.head_sha == null &&
      entry.workerCount === 0;
    const mutable =
      untouched &&
      (NOT_STARTED_TASK_STATES as readonly string[]).includes(task.status);
    const inert =
      task.status === "skipped" ||
      (task.status === "completed" &&
        task.task_type === "milestone" &&
        untouched);
    if (!mutable && !inert) {
      blockers.push(
        `${task.id}: downstream task is not untouched and skip-eligible`
      );
    }
  }
  const canonical = entries.map((entry) => ({
    id: entry.task.id,
    status: entry.task.status,
    approvalState: entry.task.approval_state ?? "draft",
    attempt: entry.task.current_attempt ?? 0,
    baseSha: entry.task.base_sha ?? null,
    headSha: entry.task.head_sha ?? null,
    updatedAt: entry.task.updated_at,
    workerCount: entry.workerCount,
  }));
  return {
    entries,
    taskIds: entries.map((entry) => entry.task.id),
    hash: stableHash(canonical),
    eligible: blockers.length === 0,
    blockers,
  };
}

function notStartedError(
  db: Database.Database,
  runId: string,
  task: FleetTaskRow
): string | null {
  if (
    (task.current_attempt ?? 0) !== 0 ||
    task.head_sha != null ||
    !(NOT_STARTED_TASK_STATES as readonly string[]).includes(task.status) ||
    workerCount(db, runId, task.id) !== 0
  ) {
    return "only a not-yet-started task with no worker history can be changed";
  }
  return null;
}

function replay(
  db: Database.Database,
  runId: string,
  requestId: string,
  action: string,
  expectedFingerprint: string
): "none" | "same" | "different" {
  const digest = requestIdHash(requestId);
  const rows = db
    .prepare(
      `SELECT payload FROM fleet_events
       WHERE fleet_run_id = ? AND event_type LIKE 'approval_control_%'
         AND json_valid(payload)
         AND (json_extract(payload, '$.requestIdHash') = ?
              OR json_extract(payload, '$.requestId') = ?)
         AND json_extract(payload, '$.action') = ?
       ORDER BY id ASC`
    )
    .all(runId, digest, requestId, action) as ReplayRow[];
  if (rows.length === 0) return "none";
  const fingerprints = new Set(
    rows.flatMap((row) => {
      const parsed = parseJsonObject(row.payload ?? "");
      return typeof parsed?.fingerprint === "string"
        ? [parsed.fingerprint]
        : [];
    })
  );
  return fingerprints.size === 1 && fingerprints.has(expectedFingerprint)
    ? "same"
    : "different";
}

function appendApprovalEvent(
  db: Database.Database,
  input: {
    runId: string;
    eventType: string;
    actor: string;
    action: string;
    requestId: string;
    fingerprint: string;
    at: string;
    detail: Record<string, unknown>;
  }
): void {
  queries.createFleetEvent(db).run(
    input.runId,
    input.eventType,
    input.actor,
    JSON.stringify({
      schemaVersion: 1,
      action: input.action,
      requestIdHash: requestIdHash(input.requestId),
      fingerprint: input.fingerprint,
      approvedAt: input.at,
      ...input.detail,
    })
  );
}

function updatedSettings(
  context: ExactRunContext,
  input: {
    planHash: string;
    executionHash: string;
    action: string;
    at: string;
    actor: string;
  }
): string {
  return JSON.stringify({
    ...context.settings,
    approvedPlanHash: input.planHash,
    approvedExecutionHash: input.executionHash,
    canSpawnWorkers: true,
    approvalControls: {
      version: 1,
      lastAction: input.action,
      lastApprovedAt: input.at,
      lastApprovedBy: input.actor,
      planHash: input.planHash,
      executionHash: input.executionHash,
    },
  });
}

function result(
  action: string,
  idempotent: boolean,
  planHash: string,
  executionHash: string
): FleetApprovalControlResult {
  return { ok: true, action, idempotent, planHash, executionHash };
}

function replayResult(
  db: Database.Database,
  runId: string,
  state: "none" | "same" | "different",
  action: string
): FleetApprovalControlResult | null {
  if (state === "different") {
    return {
      error: "requestId was already used with different inputs",
      status: 409,
    };
  }
  if (state !== "same") return null;
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  const executionHash = run ? approvedExecutionHash(run) : null;
  return run?.approved_plan_hash && executionHash
    ? result(action, true, run.approved_plan_hash, executionHash)
    : { error: "approved control replay state is unavailable", status: 409 };
}

function rebindChangedPlan(
  db: Database.Database,
  context: ExactRunContext,
  input: {
    action: string;
    actor: string;
    at: string;
    expectedRunUpdatedAt: string;
  }
):
  | { planHash: string; executionHash: string }
  | { error: string; status: number } {
  const tasks = queries
    .listFleetTasksForRun(db)
    .all(context.run.id) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(context.run.id) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(context.run.id) as FleetTaskDependencyRow[];
  const planHash = hashFleetTaskRows(tasks, dependencies);
  const reboundRun: FleetRunRow = {
    ...context.run,
    plan_hash: planHash,
    approved_plan_hash: planHash,
  };
  const executionHash = hashFleetExecutionContract({
    run: reboundRun,
    tasks,
    claims,
    dependencies,
  });
  const settingsJson = updatedSettings(context, {
    planHash,
    executionHash,
    action: input.action,
    at: input.at,
    actor: input.actor,
  });
  const changed = db
    .prepare(
      `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ?,
       settings_json = ?, approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ? AND updated_at = ? AND plan_hash = ?
         AND approved_plan_hash = ? AND approval_state = 'approved'`
    )
    .run(
      planHash,
      planHash,
      settingsJson,
      input.actor,
      input.at,
      input.at,
      context.run.id,
      input.expectedRunUpdatedAt,
      context.run.plan_hash,
      context.run.approved_plan_hash
    );
  if (changed.changes !== 1) {
    return { error: "Fleet run changed", status: 409 };
  }
  db.prepare(
    `UPDATE fleet_tasks SET approved_task_hash = ?
     WHERE fleet_run_id = ?`
  ).run(planHash, context.run.id);
  return { planHash, executionHash };
}

export function updateFleetRunConcurrency(
  runId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseRunBinding(input);
  if ("error" in binding) return binding;
  const body = objectValue(input);
  const maxConcurrency = Number(body.maxConcurrency);
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > CONCURRENCY_MAX
  ) {
    return {
      error: "maxConcurrency must be an integer from 1 to 40",
      status: 400,
    };
  }
  const runtime = deps(overrides);
  const action = "run_concurrency_approval";
  const fingerprint = stableHash({ action, runId, ...binding, maxConcurrency });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    if (context.run.max_concurrency === maxConcurrency) {
      return { error: "maxConcurrency is unchanged", status: 409 };
    }
    const at = runtime.now().toISOString();
    const reboundRun = { ...context.run, max_concurrency: maxConcurrency };
    const executionHash = hashFleetExecutionContract({
      run: reboundRun,
      tasks: context.tasks,
      claims: context.claims,
      dependencies: context.dependencies,
    });
    const settingsJson = updatedSettings(context, {
      planHash: context.run.plan_hash!,
      executionHash,
      action,
      at,
      actor: safeActor,
    });
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_runs SET max_concurrency = ?, settings_json = ?,
         approved_by = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND max_concurrency = ?`
      )
      .run(
        maxConcurrency,
        settingsJson,
        safeActor,
        at,
        at,
        runId,
        binding.expectedRunUpdatedAt,
        context.run.max_concurrency
      );
    if (changed.changes !== 1)
      return { error: "Fleet run changed", status: 409 };
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: "approval_control_concurrency_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        planHash: context.run.plan_hash,
        previousExecutionHash: context.executionHash,
        executionHash,
        previousMaxConcurrency: context.run.max_concurrency,
        maxConcurrency,
      },
    });
    return result(action, false, context.run.plan_hash!, executionHash);
  });
}

export function approveFleetRunBudgetChange(
  runId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseRunBinding(input);
  if ("error" in binding) return binding;
  const body = objectValue(input);
  const hasBudgetUsd = Object.prototype.hasOwnProperty.call(body, "budgetUsd");
  const hasBudgetTokens = Object.prototype.hasOwnProperty.call(
    body,
    "budgetTokens"
  );
  const budgetUsd = !hasBudgetUsd
    ? undefined
    : body.budgetUsd === null
      ? null
      : Number(body.budgetUsd);
  const budgetTokens = !hasBudgetTokens
    ? undefined
    : body.budgetTokens === null
      ? null
      : Number(body.budgetTokens);
  const overrideHardStop = body.overrideHardStop === true;
  const expectedPauseReason =
    body.expectedPauseReason === null
      ? null
      : boundedIdentifier(body.expectedPauseReason, 120);
  if (!hasBudgetUsd && !hasBudgetTokens) {
    return { error: "budgetUsd or budgetTokens is required", status: 400 };
  }
  if (
    budgetUsd !== undefined &&
    budgetUsd !== null &&
    (!Number.isFinite(budgetUsd) || budgetUsd < 0 || budgetUsd > BUDGET_MAX_USD)
  ) {
    return {
      error: "budgetUsd must be null or a finite value from 0 to 1000000000",
      status: 400,
    };
  }
  if (
    budgetTokens !== undefined &&
    budgetTokens !== null &&
    (!Number.isSafeInteger(budgetTokens) ||
      budgetTokens < 0 ||
      budgetTokens > BUDGET_MAX_TOKENS)
  ) {
    return {
      error: "budgetTokens must be null or an integer from 0 to 1000000000000",
      status: 400,
    };
  }
  if (body.expectedPauseReason !== null && !expectedPauseReason) {
    return { error: "expectedPauseReason is invalid", status: 400 };
  }
  const runtime = deps(overrides);
  const action = "run_budget_approval";
  const fingerprint = stableHash({
    action,
    runId,
    ...binding,
    budgetUsd,
    budgetTokens,
    overrideHardStop,
    expectedPauseReason,
  });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    const previousUsd = context.run.budget_usd;
    const previousTokens = context.run.budget_tokens ?? null;
    const nextUsd = budgetUsd === undefined ? previousUsd : budgetUsd;
    const nextTokens =
      budgetTokens === undefined ? previousTokens : budgetTokens;
    if (
      budgetUsd !== undefined &&
      (previousUsd === null || (budgetUsd !== null && budgetUsd <= previousUsd))
    ) {
      return {
        error:
          previousUsd === null
            ? "Fleet run already has an unlimited USD budget"
            : "budgetUsd must increase the approved budget",
        status: 409,
      };
    }
    if (
      budgetTokens !== undefined &&
      (previousTokens === null ||
        (budgetTokens !== null && budgetTokens <= previousTokens))
    ) {
      return {
        error:
          previousTokens === null
            ? "Fleet run already has an unlimited token budget"
            : "budgetTokens must increase the approved budget",
        status: 409,
      };
    }
    if ((context.run.pause_reason ?? null) !== expectedPauseReason) {
      return { error: "Fleet run pause reason changed", status: 409 };
    }
    if (context.run.pause_reason === "budget_exhausted" && !overrideHardStop) {
      return {
        error: "a budget-exhausted run requires an explicit hard-stop override",
        status: 409,
      };
    }
    if (overrideHardStop) {
      if (
        context.run.status !== "paused" ||
        context.run.pause_reason !== "budget_exhausted"
      ) {
        return {
          error: "only an exact budget-exhausted hard stop can be overridden",
          status: 409,
        };
      }
      const committed =
        (context.run.spent_budget_usd ?? 0) +
        (context.run.reserved_budget_usd ?? 0) +
        0.25;
      const committedTokens =
        (context.run.spent_budget_tokens ?? 0) +
        (context.run.reserved_budget_tokens ?? 0) +
        1;
      if (
        (nextUsd !== null && nextUsd < committed) ||
        (nextTokens !== null && nextTokens < committedTokens)
      ) {
        return {
          error:
            "the approved budget cannot provide headroom for another worker attempt",
          status: 409,
        };
      }
    }
    const at = runtime.now().toISOString();
    const reboundRun = {
      ...context.run,
      budget_usd: nextUsd,
      budget_tokens: nextTokens,
    };
    const executionHash = hashFleetExecutionContract({
      run: reboundRun,
      tasks: context.tasks,
      claims: context.claims,
      dependencies: context.dependencies,
    });
    const settingsJson = updatedSettings(context, {
      planHash: context.run.plan_hash!,
      executionHash,
      action,
      at,
      actor: safeActor,
    });
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_runs SET budget_usd = ?, budget_tokens = ?, settings_json = ?,
         pause_reason = CASE WHEN ? = 1 THEN NULL ELSE pause_reason END,
         budget_hard_limit_at = CASE WHEN ? = 1 THEN NULL ELSE budget_hard_limit_at END,
         budget_interrupt_deadline_at = CASE WHEN ? = 1 THEN NULL ELSE budget_interrupt_deadline_at END,
         approved_by = ?, approved_at = ?, updated_at = ?
         WHERE id = ? AND updated_at = ? AND budget_usd IS ?
           AND budget_tokens IS ?
           AND pause_reason IS ?`
      )
      .run(
        nextUsd,
        nextTokens,
        settingsJson,
        overrideHardStop ? 1 : 0,
        overrideHardStop ? 1 : 0,
        overrideHardStop ? 1 : 0,
        safeActor,
        at,
        at,
        runId,
        binding.expectedRunUpdatedAt,
        previousUsd,
        previousTokens,
        expectedPauseReason
      );
    if (changed.changes !== 1)
      return { error: "Fleet run changed", status: 409 };
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: "approval_control_budget_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        planHash: context.run.plan_hash,
        previousExecutionHash: context.executionHash,
        executionHash,
        previousBudgetUsd: previousUsd,
        budgetUsd: nextUsd,
        previousBudgetTokens: previousTokens,
        budgetTokens: nextTokens,
        hardStopOverrideApproved: overrideHardStop,
        previousPauseReason: expectedPauseReason,
      },
    });
    return result(action, false, context.run.plan_hash!, executionHash);
  });
}

export function skipFleetTaskWithApproval(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseTaskBinding(input);
  if ("error" in binding) return binding;
  const body = objectValue(input);
  const expectedSkipClosureHash = parseExactHash(
    body.expectedSkipClosureHash,
    "expectedSkipClosureHash"
  );
  if (typeof expectedSkipClosureHash !== "string") {
    return expectedSkipClosureHash;
  }
  const runtime = deps(overrides);
  const action = "task_skip_approval";
  const fingerprint = stableHash({
    action,
    runId,
    taskId,
    ...binding,
    expectedSkipClosureHash,
  });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    const task = exactTask(runtime.db, runId, taskId, binding);
    if ("error" in task) return task;
    const unsafe = notStartedError(runtime.db, runId, task);
    if (unsafe) return { error: unsafe, status: 409 };
    const closure = fleetSkipClosure(
      runtime.db,
      runId,
      taskId,
      context.tasks,
      context.dependencies
    );
    if (closure.hash !== expectedSkipClosureHash) {
      return { error: "Fleet skip closure changed", status: 409 };
    }
    if (!closure.eligible) {
      return {
        error: `Fleet skip closure is unsafe: ${closure.blockers.join("; ")}`,
        status: 409,
      };
    }
    const at = runtime.now().toISOString();
    const skipTask = runtime.db.prepare(
      `UPDATE fleet_tasks SET status = 'skipped', failure_code = ?,
       ended_at = ?, updated_at = ?
       WHERE id = ? AND fleet_run_id = ? AND status = ?
         AND approval_state = ? AND current_attempt = 0
         AND head_sha IS NULL AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1 FROM fleet_workers
           WHERE fleet_workers.fleet_run_id = fleet_tasks.fleet_run_id
             AND fleet_workers.task_id = fleet_tasks.id
         )`
    );
    const skippedTaskIds: string[] = [];
    for (const entry of closure.entries) {
      const closureTask = entry.task;
      if (
        closureTask.status === "skipped" ||
        (closureTask.status === "completed" &&
          closureTask.task_type === "milestone")
      ) {
        continue;
      }
      const changed = skipTask.run(
        closureTask.id === taskId
          ? "operator_skipped"
          : "operator_skip_dependency_propagated",
        at,
        at,
        closureTask.id,
        runId,
        closureTask.status,
        closureTask.approval_state,
        closureTask.updated_at
      );
      if (changed.changes !== 1) {
        throw new Error("Fleet skip closure changed during approval");
      }
      skippedTaskIds.push(closureTask.id);
    }
    const runChanged = runtime.db
      .prepare(
        `UPDATE fleet_runs SET updated_at = ? WHERE id = ? AND updated_at = ?`
      )
      .run(at, runId, binding.expectedRunUpdatedAt);
    if (runChanged.changes !== 1)
      throw new Error("Fleet run changed during task skip");
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: "approval_control_task_skip_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        taskId,
        planHash: context.run.plan_hash,
        executionHash: context.executionHash,
        previousStatus: task.status,
        status: "skipped",
        skipClosureHash: closure.hash,
        affectedTaskIds: closure.taskIds,
        skippedTaskIds,
      },
    });
    return result(action, false, context.run.plan_hash!, context.executionHash);
  });
}

export function setFleetTaskManualLaunchApproval(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseTaskBinding(input);
  if ("error" in binding) return binding;
  const body = objectValue(input);
  if (typeof body.required !== "boolean") {
    return { error: "required must be a boolean", status: 400 };
  }
  const required = body.required;
  const runtime = deps(overrides);
  if (!required) {
    const recoveryBlocked = fleetLaunchBlockedResult(runtime.db, runId);
    if (recoveryBlocked) return recoveryBlocked;
  }
  const action = required
    ? "task_manual_launch_requirement_approval"
    : "task_manual_launch_release_approval";
  const fingerprint = stableHash({
    action,
    runId,
    taskId,
    ...binding,
    required,
  });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    const task = exactTask(runtime.db, runId, taskId, binding);
    if ("error" in task) return task;
    const unsafe = notStartedError(runtime.db, runId, task);
    if (unsafe) return { error: unsafe, status: 409 };
    const expectedApproval = required ? "approved" : "blocked";
    if (task.approval_state !== expectedApproval) {
      return {
        error: required
          ? "task already requires approval or is not approved"
          : "task is not waiting for manual launch approval",
        status: 409,
      };
    }
    if (!required && task.failure_code !== "manual_launch_approval_required") {
      return { error: "task is blocked for a different reason", status: 409 };
    }
    const at = runtime.now().toISOString();
    const nextApproval = required ? "blocked" : "approved";
    const nextFailure = required ? "manual_launch_approval_required" : null;
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_tasks SET approval_state = ?, failure_code = ?, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = ?
           AND approval_state = ? AND current_attempt = 0
           AND head_sha IS NULL AND updated_at = ?`
      )
      .run(
        nextApproval,
        nextFailure,
        at,
        taskId,
        runId,
        binding.expectedTaskStatus,
        expectedApproval,
        binding.expectedTaskUpdatedAt
      );
    if (changed.changes !== 1)
      return { error: "Fleet task changed", status: 409 };
    const runChanged = runtime.db
      .prepare(
        `UPDATE fleet_runs SET updated_at = ? WHERE id = ? AND updated_at = ?`
      )
      .run(at, runId, binding.expectedRunUpdatedAt);
    if (runChanged.changes !== 1) {
      throw new Error("Fleet run changed during manual launch approval");
    }
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: required
        ? "approval_control_manual_launch_required"
        : "approval_control_manual_launch_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        taskId,
        planHash: context.run.plan_hash,
        executionHash: context.executionHash,
        previousApprovalState: task.approval_state,
        approvalState: nextApproval,
      },
    });
    return result(action, false, context.run.plan_hash!, context.executionHash);
  });
}

export function convertFleetTaskToReadOnly(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseTaskBinding(input);
  if ("error" in binding) return binding;
  const runtime = deps(overrides);
  const action = "task_read_only_conversion_approval";
  const fingerprint = stableHash({ action, runId, taskId, ...binding });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    const task = exactTask(runtime.db, runId, taskId, binding);
    if ("error" in task) return task;
    const unsafe = notStartedError(runtime.db, runId, task);
    if (unsafe) return { error: unsafe, status: 409 };
    const plannedClaims = context.claims.filter(
      (claim) => claim.task_id === taskId
    );
    if (plannedClaims.length === 0 && task.task_type === "explore") {
      return { error: "task is already read-only exploration", status: 409 };
    }
    const at = runtime.now().toISOString();
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_tasks SET task_type = 'explore', file_claims_json = '[]',
         verification_id = NULL, verification_status = NULL,
         verification_spec_hash = NULL, verified_head_sha = NULL,
         verification_artifact_id = NULL, verification_started_at = NULL,
         verification_completed_at = NULL, review_status = NULL,
         review_head_sha = NULL, review_verification_hash = NULL,
         review_completed_at = NULL, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = ?
           AND current_attempt = 0 AND head_sha IS NULL AND updated_at = ?`
      )
      .run(
        at,
        taskId,
        runId,
        binding.expectedTaskStatus,
        binding.expectedTaskUpdatedAt
      );
    if (changed.changes !== 1)
      return { error: "Fleet task changed", status: 409 };
    runtime.db
      .prepare(
        `DELETE FROM fleet_task_claims WHERE fleet_run_id = ? AND task_id = ?`
      )
      .run(runId, taskId);
    const rebound = rebindChangedPlan(runtime.db, context, {
      action,
      actor: safeActor,
      at,
      expectedRunUpdatedAt: binding.expectedRunUpdatedAt,
    });
    if ("error" in rebound) throw new Error(rebound.error);
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: "approval_control_read_only_conversion_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        taskId,
        previousPlanHash: context.run.plan_hash,
        planHash: rebound.planHash,
        previousExecutionHash: context.executionHash,
        executionHash: rebound.executionHash,
        previousTaskType: task.task_type,
        taskType: "explore",
        removedClaimCount: plannedClaims.length,
      },
    });
    return result(action, false, rebound.planHash, rebound.executionHash);
  });
}

function canonicalActualClaims(
  value: unknown
): { claims: string[]; hash: string } | { error: string; status: number } {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > CLAIM_MAX ||
    !value.every(
      (entry): entry is string =>
        typeof entry === "string" && entry.length <= CLAIM_PATH_MAX
    )
  ) {
    return {
      error: `approvedActualClaims must contain 1 to ${CLAIM_MAX} bounded paths`,
      status: 400,
    };
  }
  const compared = compareFleetPathClaims([], value);
  if (
    compared.invalidActualPaths.length > 0 ||
    compared.actualPaths.length !== value.length
  ) {
    return {
      error:
        "approvedActualClaims must be unique valid repository-relative paths",
      status: 400,
    };
  }
  const claims = [...compared.actualPaths].sort();
  return { claims, hash: stableHash(claims) };
}

export function approveFleetTaskClaimExpansion(
  runId: string,
  taskId: string,
  input: unknown,
  actor = "operator",
  overrides: Partial<FleetApprovalControlDeps> = {}
): FleetApprovalControlResult {
  const binding = parseTaskBinding(input);
  if ("error" in binding) return binding;
  const body = objectValue(input);
  const approved = canonicalActualClaims(body.approvedActualClaims);
  if ("error" in approved) return approved;
  const expectedActualClaimsHash = parseExactHash(
    body.expectedActualClaimsHash,
    "expectedActualClaimsHash"
  );
  if (typeof expectedActualClaimsHash !== "string")
    return expectedActualClaimsHash;
  if (approved.hash !== expectedActualClaimsHash) {
    return {
      error: "approvedActualClaims do not match their expected hash",
      status: 409,
    };
  }
  const approveSensitivePaths = body.approveSensitivePaths === true;
  const runtime = deps(overrides);
  const action = "task_claim_expansion_approval";
  const fingerprint = stableHash({
    action,
    runId,
    taskId,
    ...binding,
    actualClaimsHash: approved.hash,
    approveSensitivePaths,
  });
  const safeActor = actorValue(actor);
  return transaction(runtime.db, () => {
    const replayed = replayResult(
      runtime.db,
      runId,
      replay(runtime.db, runId, binding.requestId, action, fingerprint),
      action
    );
    if (replayed) return replayed;
    const context = exactRunContext(runtime.db, runId, binding);
    if ("error" in context) return context;
    const task = exactTask(runtime.db, runId, taskId, binding);
    if ("error" in task) return task;
    if (
      task.status !== "needs_inspection" ||
      !(CLAIM_QUARANTINE_CODES as readonly string[]).includes(
        task.failure_code ?? ""
      )
    ) {
      return {
        error: "task is not quarantined for claim approval",
        status: 409,
      };
    }
    if (
      binding.expectedAttempt < 1 ||
      !binding.expectedTaskBaseSha ||
      !binding.expectedHeadSha
    ) {
      return {
        error: "claim approval requires an exact attempted base and head",
        status: 409,
      };
    }
    if (activeWorkerCount(runtime.db, runId, taskId) !== 0) {
      return {
        error: "task still has an active or cleanup-pending worker",
        status: 409,
      };
    }
    const actual = canonicalActualClaims(
      parseStoredStringArray(task.actual_file_claims_json)
    );
    if ("error" in actual || actual.hash !== approved.hash) {
      return { error: "authoritative actual claims changed", status: 409 };
    }
    const acceptedWorker = runtime.db
      .prepare(
        `SELECT id FROM fleet_workers
         WHERE fleet_run_id = ? AND task_id = ? AND attempt = ?
           AND base_sha = ? AND head_sha = ? AND report_state = 'accepted'
           AND report_status = 'succeeded'
         ORDER BY report_collected_at DESC, created_at DESC LIMIT 1`
      )
      .get(
        runId,
        taskId,
        binding.expectedAttempt,
        binding.expectedTaskBaseSha,
        binding.expectedHeadSha
      );
    if (!acceptedWorker) {
      return {
        error: "exact accepted worker Git evidence is missing",
        status: 409,
      };
    }
    const sensitivePaths = findSensitiveFleetPaths(approved.claims);
    if (sensitivePaths.length > 0 && !approveSensitivePaths) {
      return {
        error: "sensitive paths require explicit approval",
        status: 409,
      };
    }
    const existingVerification = runtime.db
      .prepare(
        `SELECT 1 FROM fleet_verifications
         WHERE fleet_run_id = ? AND task_id = ? AND attempt = ? AND head_sha = ?
         LIMIT 1`
      )
      .get(runId, taskId, binding.expectedAttempt, binding.expectedHeadSha);
    if (existingVerification) {
      return {
        error:
          "a fresh descendant head is required because this head already has verification evidence",
        status: 409,
      };
    }
    const plannedClaims = context.claims
      .filter((claim) => claim.task_id === taskId)
      .map((claim) => claim.path);
    const expandedClaims = normalizeFleetClaims([
      ...plannedClaims,
      ...approved.claims,
    ]).sort();
    const at = runtime.now().toISOString();
    runtime.db
      .prepare(
        `DELETE FROM fleet_task_claims WHERE fleet_run_id = ? AND task_id = ?`
      )
      .run(runId, taskId);
    const insertClaim = runtime.db.prepare(
      `INSERT INTO fleet_task_claims
       (id, fleet_run_id, task_id, path, claim_type, confidence)
       VALUES (?, ?, ?, ?, 'exclusive', 1)`
    );
    for (const path of expandedClaims) {
      insertClaim.run(randomUUID(), runId, taskId, path);
    }
    const changed = runtime.db
      .prepare(
        `UPDATE fleet_tasks SET file_claims_json = ?, status = 'verifying',
         failure_code = NULL, ended_at = NULL,
         verification_id = NULL, verification_status = NULL,
         verification_spec_hash = NULL, verified_head_sha = NULL,
         verification_artifact_id = NULL, verification_started_at = NULL,
         verification_completed_at = NULL, review_status = NULL,
         review_head_sha = NULL, review_verification_hash = NULL,
         review_completed_at = NULL, active_fix_id = NULL,
         fixer_session_id = NULL, fix_error = NULL,
         integration_state = 'pending', integration_operation_id = NULL,
         integrated_head_sha = NULL, integrated_at = NULL, updated_at = ?
         WHERE id = ? AND fleet_run_id = ? AND status = 'needs_inspection'
           AND failure_code = ? AND current_attempt = ?
           AND base_sha = ? AND head_sha = ? AND updated_at = ?`
      )
      .run(
        JSON.stringify(expandedClaims),
        at,
        taskId,
        runId,
        task.failure_code,
        binding.expectedAttempt,
        binding.expectedTaskBaseSha,
        binding.expectedHeadSha,
        binding.expectedTaskUpdatedAt
      );
    if (changed.changes !== 1)
      throw new Error("Fleet task changed during claim approval");
    const rebound = rebindChangedPlan(runtime.db, context, {
      action,
      actor: safeActor,
      at,
      expectedRunUpdatedAt: binding.expectedRunUpdatedAt,
    });
    if ("error" in rebound) throw new Error(rebound.error);
    appendApprovalEvent(runtime.db, {
      runId,
      eventType: "approval_control_claim_expansion_approved",
      actor: safeActor,
      action,
      requestId: binding.requestId,
      fingerprint,
      at,
      detail: {
        taskId,
        attempt: binding.expectedAttempt,
        baseSha: binding.expectedTaskBaseSha,
        headSha: binding.expectedHeadSha,
        previousPlanHash: context.run.plan_hash,
        planHash: rebound.planHash,
        previousExecutionHash: context.executionHash,
        executionHash: rebound.executionHash,
        previousClaimsHash: stableHash([...plannedClaims].sort()),
        approvedActualClaimsHash: approved.hash,
        approvedActualClaimCount: approved.claims.length,
        sensitivePathCount: sensitivePaths.length,
        sensitivePathsApproved: sensitivePaths.length > 0,
        nextGate: "fresh_verification_then_four_exact_head_reviews",
      },
    });
    return result(action, false, rebound.planHash, rebound.executionHash);
  });
}

const FOUR_REVIEW_LANES = [
  "correctness_security",
  "conventions_cross_platform",
  "simplicity_ux",
  "adversarial_red_team",
] as const;
const REVIEW_EXEMPT_TASK_TYPES = new Set([
  "explore",
  "review",
  "milestone",
  "planning",
]);
const TERMINAL_ESTIMATE_TASK_STATES = new Set([
  "completed",
  "merged",
  "skipped",
  "ready_to_merge",
]);

function fleetReservationHistory(
  db: Database.Database
): FleetReservationHistorySample[] {
  return db
    .prepare(
      `SELECT c.provider, c.model,
              CASE c.owner_type
                WHEN 'planner' THEN 'planning'
                WHEN 'plan_review' THEN 'review'
                WHEN 'task_review' THEN 'review'
                WHEN 'fixer' THEN 'fix'
                ELSE COALESCE(t.task_type, 'implementation')
              END AS task_type,
              c.observed_cost_usd AS actual_usd,
              CASE WHEN c.peak_input_tokens + c.peak_output_tokens +
                             c.peak_cache_read_tokens + c.peak_cache_write_tokens > 0
                   THEN c.peak_input_tokens + c.peak_output_tokens +
                        c.peak_cache_read_tokens + c.peak_cache_write_tokens
                   ELSE NULL END AS actual_tokens
       FROM fleet_cost_accounts c
       LEFT JOIN fleet_tasks t ON t.id = c.task_id
       WHERE c.terminal_at IS NOT NULL
       ORDER BY c.updated_at DESC
       LIMIT 256`
    )
    .all()
    .map((row) => {
      const sample = row as {
        provider: string;
        model: string | null;
        task_type: string;
        actual_usd: number | null;
        actual_tokens: number | null;
      };
      return {
        provider: sample.provider,
        model: sample.model,
        taskType: sample.task_type,
        actualUsd: sample.actual_usd,
        actualTokens: sample.actual_tokens,
      };
    });
}

function budgetComparison(
  budget: number | null,
  projected: number | null
): "within" | "exceeds" | "unlimited" | "unknown" {
  if (budget == null) return "unlimited";
  if (projected == null) return "unknown";
  return projected > budget ? "exceeds" : "within";
}

function fleetApprovalCostEstimate(input: {
  db: Database.Database;
  run: FleetRunRow;
  tasks: FleetTaskRow[];
  planHash: string;
  executionHash: string;
  policyHash: string | null;
}): FleetApprovalCostEstimateDto {
  const { db, run, tasks } = input;
  const parsedPolicy = parseFleetAutomationPolicy(run.automation_policy_json);
  const sessions: FleetPlanReservationSession[] = [];
  const exclusions = [
    "Additional attempts created by future plan changes are not estimable.",
  ];
  let workerAttempts = 0;
  let taskReviews = 0;
  let planReviews = 0;
  let planner = 0;

  const taskReviewRows = db
    .prepare(
      `SELECT task_id, attempt, head_sha, policy_hash, lens, state
       FROM fleet_task_reviews WHERE fleet_run_id = ?`
    )
    .all(run.id) as Array<{
    task_id: string;
    attempt: number;
    head_sha: string;
    policy_hash: string;
    lens: string;
    state: string;
  }>;

  for (const task of tasks) {
    if (TERMINAL_ESTIMATE_TASK_STATES.has(task.status)) continue;
    const attempts = Math.max(
      0,
      (task.max_attempts ?? run.default_max_attempts ?? 2) -
        (task.current_attempt ?? 0)
    );
    if (attempts > 0) {
      workerAttempts += attempts;
      sessions.push({
        provider: task.agent_type ?? run.provider,
        model:
          task.model ??
          (task.agent_type == null || task.agent_type === run.provider
            ? run.model
            : null),
        taskType: task.task_type || "implementation",
        count: attempts,
      });
    }

    if (REVIEW_EXEMPT_TASK_TYPES.has(task.task_type)) continue;
    const currentRows = taskReviewRows.filter(
      (row) =>
        row.task_id === task.id &&
        row.attempt === (task.current_attempt ?? 0) &&
        row.head_sha === (task.head_sha ?? "") &&
        row.policy_hash === (run.automation_policy_hash ?? "")
    );
    const remainingLanes = FOUR_REVIEW_LANES.filter((lens) => {
      const row = currentRows.find((candidate) => candidate.lens === lens);
      return !row || row.state === "pending";
    }).length;
    if (remainingLanes > 0) {
      taskReviews += remainingLanes;
      sessions.push({
        provider: run.provider,
        model: run.model,
        taskType: "review",
        count: remainingLanes,
      });
    }
  }

  const settings = parseJsonObject(run.settings_json) ?? {};
  const plannerSettings =
    settings.planner &&
    typeof settings.planner === "object" &&
    !Array.isArray(settings.planner)
      ? (settings.planner as Record<string, unknown>)
      : {};
  if (
    parsedPolicy.valid &&
    parsedPolicy.policy.automaticPlanning &&
    tasks.length === 0 &&
    !run.plan_hash &&
    String(plannerSettings.state ?? "idle") === "idle"
  ) {
    planner = 1;
    sessions.push({
      provider: run.provider,
      model: run.model,
      taskType: "planning",
      count: 1,
    });
  }

  if (
    parsedPolicy.valid &&
    parsedPolicy.policy.automaticPlanApproval &&
    run.review_policy !== "manual" &&
    run.approval_state !== "approved"
  ) {
    const reviewRows =
      input.policyHash && run.automation_base_sha
        ? (db
            .prepare(
              `SELECT lens, state FROM fleet_reviews
               WHERE fleet_run_id = ? AND subject_type = 'plan'
                 AND subject_hash = ? AND policy_hash = ?
                 AND execution_hash = ? AND base_sha = ?`
            )
            .all(
              run.id,
              input.planHash,
              input.policyHash,
              input.executionHash,
              run.automation_base_sha
            ) as Array<{ lens: string; state: string }>)
        : [];
    planReviews = FOUR_REVIEW_LANES.filter((lens) => {
      const row = reviewRows.find((candidate) => candidate.lens === lens);
      return !row || row.state === "pending";
    }).length;
    if (planReviews > 0) {
      sessions.push({
        provider: run.provider,
        model: run.model,
        taskType: "review",
        count: planReviews,
      });
    }
  }

  if (parsedPolicy.valid && parsedPolicy.policy.automaticFixes) {
    exclusions.push(
      "Automatic fixer sessions and repeated post-fix review cycles are excluded from this baseline estimate."
    );
  }
  if (!parsedPolicy.valid) {
    exclusions.push(
      "The automation policy is invalid, so auxiliary-session demand is unknown."
    );
  }

  const estimate = estimateFleetPlanReservation({
    sessions,
    history: fleetReservationHistory(db),
  });
  const projectedTotalUsd =
    estimate.usd == null
      ? null
      : (run.spent_budget_usd ?? 0) +
        (run.reserved_budget_usd ?? 0) +
        estimate.usd;
  const projectedTotalTokens =
    estimate.tokens == null
      ? null
      : (run.spent_budget_tokens ?? 0) +
        (run.reserved_budget_tokens ?? 0) +
        estimate.tokens;
  return {
    kind: "estimated_remaining",
    estimatedUsd: estimate.usd,
    estimatedTokens: estimate.tokens,
    confidence: estimate.confidence,
    capped: estimate.capped,
    sessionCounts: {
      workerAttempts,
      taskReviews,
      planReviews,
      planner,
      total: estimate.sessionCount,
    },
    projectedTotalUsd,
    projectedTotalTokens,
    budgetComparison: {
      usd: budgetComparison(run.budget_usd, projectedTotalUsd),
      tokens: budgetComparison(run.budget_tokens ?? null, projectedTotalTokens),
    },
    exclusions,
  };
}

export function getFleetApprovalControlPreview(
  runId: string,
  db: Database.Database = getDb()
): FleetApprovalControlPreview | null {
  const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
  if (!run) return null;
  const tasks = queries.listFleetTasksForRun(db).all(runId) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(runId) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(runId) as FleetTaskDependencyRow[];
  const currentPlanHash = hashFleetTaskRows(tasks, dependencies);
  const currentExecutionHash = hashFleetExecutionContract({
    run,
    tasks,
    claims,
    dependencies,
  });
  const parsedPolicy = parseFleetAutomationPolicy(run.automation_policy_json);
  const currentPolicyHash = parsedPolicy.valid
    ? hashFleetAutomationPolicy(parsedPolicy.policy)
    : null;
  const activeRows = db
    .prepare(
      `SELECT task_id, COUNT(*) AS n FROM fleet_workers
       WHERE fleet_run_id = ?
         AND status IN (${ACTIVE_WORKER_STATES.map(() => "?").join(",")})
       GROUP BY task_id`
    )
    .all(runId, ...ACTIVE_WORKER_STATES) as Array<{
    task_id: string | null;
    n: number;
  }>;
  const historyRows = db
    .prepare(
      `SELECT event_type, actor, payload, created_at FROM fleet_events
       WHERE fleet_run_id = ? AND event_type LIKE 'approval_control_%'
       ORDER BY id DESC LIMIT 20`
    )
    .all(runId) as Array<{
    event_type: string;
    actor: string;
    payload: string | null;
    created_at: string;
  }>;
  const activeByTask = new Map(
    activeRows.flatMap((row) => (row.task_id ? [[row.task_id, row.n]] : []))
  );
  return {
    runId,
    estimate: fleetApprovalCostEstimate({
      db,
      run,
      tasks,
      planHash: currentPlanHash,
      executionHash: currentExecutionHash,
      policyHash: currentPolicyHash,
    }),
    bindings: {
      approvedPlanHash: run.approved_plan_hash,
      currentPlanHash,
      approvedExecutionHash: approvedExecutionHash(run),
      currentExecutionHash,
      storedPolicyHash: run.automation_policy_hash ?? null,
      currentPolicyHash,
      baseSha: run.automation_base_sha ?? null,
      runUpdatedAt: run.updated_at,
    },
    approvedVsCurrent: {
      planChanged: run.approved_plan_hash !== currentPlanHash,
      executionChanged: approvedExecutionHash(run) !== currentExecutionHash,
      policyChanged: (run.automation_policy_hash ?? null) !== currentPolicyHash,
    },
    run: {
      status: run.status,
      maxConcurrency: run.max_concurrency,
      budgetUsd: run.budget_usd,
      budgetTokens: run.budget_tokens ?? null,
      reservedBudgetUsd: run.reserved_budget_usd ?? 0,
      spentBudgetUsd: run.spent_budget_usd ?? 0,
      reservedBudgetTokens: run.reserved_budget_tokens ?? 0,
      spentBudgetTokens: run.spent_budget_tokens ?? 0,
      budgetStopMode: run.budget_stop_mode ?? "pause-new",
      budgetHardLimitAt: run.budget_hard_limit_at ?? null,
      budgetInterruptDeadlineAt: run.budget_interrupt_deadline_at ?? null,
      pauseReason: run.pause_reason ?? null,
    },
    tasks: tasks.map((task) => {
      const plannedClaims = claims
        .filter((claim) => claim.task_id === task.id)
        .map((claim) => claim.path)
        .sort();
      const actualClaims = parseStoredStringArray(
        task.actual_file_claims_json
      ).sort();
      const drift = compareFleetPathClaims(plannedClaims, actualClaims);
      const hasActiveWorker = (activeByTask.get(task.id) ?? 0) > 0;
      const skipClosure = fleetSkipClosure(
        db,
        runId,
        task.id,
        tasks,
        dependencies
      );
      return {
        id: task.id,
        status: task.status,
        approvalState: task.approval_state ?? "draft",
        attempt: task.current_attempt ?? 0,
        baseSha: task.base_sha ?? null,
        headSha: task.head_sha ?? null,
        updatedAt: task.updated_at,
        notYetStarted:
          (task.current_attempt ?? 0) === 0 &&
          task.head_sha == null &&
          (NOT_STARTED_TASK_STATES as readonly string[]).includes(
            task.status
          ) &&
          !hasActiveWorker,
        hasActiveWorker,
        manualLaunchApprovalRequired:
          task.approval_state === "blocked" &&
          task.failure_code === "manual_launch_approval_required",
        approvedTaskHash: task.approved_task_hash ?? null,
        plannedClaims,
        actualClaims,
        actualClaimsHash: stableHash(actualClaims),
        addedActualClaims: drift.driftPaths,
        sensitivePaths: drift.sensitivePaths,
        quarantinedForClaimApproval:
          task.status === "needs_inspection" &&
          (CLAIM_QUARANTINE_CODES as readonly string[]).includes(
            task.failure_code ?? ""
          ),
        skipClosure: {
          taskIds: skipClosure.taskIds,
          hash: skipClosure.hash,
          eligible: skipClosure.eligible,
          blockers: skipClosure.blockers,
        },
      };
    }),
    recentApprovals: historyRows.map((row) => ({
      eventType: row.event_type,
      actor: row.actor,
      createdAt: row.created_at,
      detail: row.payload ? parseJsonObject(row.payload) : null,
    })),
  };
}
