import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import { runGit } from "@/lib/git";
import { getDefaultBranch } from "@/lib/git-status";
import { parseFleetAutomationPolicy } from "./automation-policy";
import { fleetStrongConfinementAvailable } from "./confinement";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "./hash";
import { classifySensitiveFleetPath } from "./git-state";
import { fleetProviderRetryIsDue } from "./backoff";
import { startFleetPlanner } from "./planner";
import {
  FLEET_PLAN_REVIEW_LENSES,
  reconcileFleetPlanReviews,
} from "./plan-review";
import { redactAndCapFleetText } from "./redaction";
import {
  approveFleetRunPlan,
  type FleetAutomationApprovalGuard,
} from "./service";
import { isFleetSchedulerReady, reconcileFleetRun } from "./scheduler";
import type {
  FleetApprovalState,
  FleetAutomationAction,
  FleetAutomationPolicy,
  FleetDesiredState,
  FleetPlanReviewLens,
  FleetPlannerState,
  FleetReviewEvidenceRow,
  FleetRunRow,
  FleetRunStatus,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "./types";

export { FLEET_PLAN_REVIEW_LENSES } from "./plan-review";

export type FleetAutomationDecision =
  | { action: "planning" }
  | { action: "plan_approval" }
  | { action: "start" }
  | { action: "fix" }
  | { action: "merge" }
  | { action: "wait"; reason: string };

interface CommonDecisionInput {
  policy: FleetAutomationPolicy;
  policyHashMatches: boolean;
  authorized: boolean;
  desiredState: FleetDesiredState;
  status: FleetRunStatus;
  approvalState: FleetApprovalState;
}

export function evaluateAutomaticPlanning(
  input: CommonDecisionInput & {
    planHash: string | null;
    plannerState: FleetPlannerState;
    baseSha: string | null;
    confinementAvailable: boolean;
    retryNotBefore?: string | null;
    now?: Date;
  }
): FleetAutomationDecision {
  if (!input.policy.automaticPlanning)
    return { action: "wait", reason: "automatic planning is disabled" };
  if (!input.policyHashMatches)
    return { action: "wait", reason: "automation policy hash changed" };
  if (!input.authorized)
    return { action: "wait", reason: "planning is not authorized" };
  if (!input.baseSha)
    return { action: "wait", reason: "base commit is not bound" };
  if (!input.policy.allowUnconfinedAgents && !input.confinementAvailable) {
    return {
      action: "wait",
      reason: "automatic planning requires confinement or explicit consent",
    };
  }
  if (!["planned", "running"].includes(input.desiredState))
    return { action: "wait", reason: "run does not desire a plan" };
  if (input.status !== "draft")
    return { action: "wait", reason: "run is no longer a draft" };
  if (!["draft", "needs_approval"].includes(input.approvalState))
    return { action: "wait", reason: "run is not available for planning" };
  if (input.planHash)
    return { action: "wait", reason: "a plan already exists" };
  if (input.plannerState !== "idle")
    return { action: "wait", reason: "planner is not idle" };
  if (!fleetProviderRetryIsDue(input.retryNotBefore, input.now ?? new Date())) {
    return { action: "wait", reason: "planner launch retry is deferred" };
  }
  return { action: "planning" };
}

export function isSensitiveFleetPath(value: string): boolean {
  return classifySensitiveFleetPath(value) !== null;
}

export function evaluateAutomaticApproval(
  input: CommonDecisionInput & {
    reviewPolicy: FleetRunRow["review_policy"];
    planHash: string | null;
    executionHash: string | null;
    baseSha: string | null;
    currentBaseSha: string | null;
    plannerState: FleetPlannerState;
    graphHashMatches: boolean;
    blockerCount: number;
    unverifiedWriteTaskCount?: number;
    claimPaths: string[];
    reviews: FleetReviewEvidenceRow[];
  }
): FleetAutomationDecision {
  if (!input.policy.automaticPlanApproval)
    return { action: "wait", reason: "automatic plan approval is disabled" };
  if (!input.policyHashMatches)
    return { action: "wait", reason: "automation policy hash changed" };
  if (!input.authorized)
    return { action: "wait", reason: "plan approval is not authorized" };
  if (!["planned", "running"].includes(input.desiredState))
    return { action: "wait", reason: "run does not desire an approved plan" };
  if (input.status !== "draft" || input.approvalState !== "needs_approval") {
    return { action: "wait", reason: "run is not awaiting plan approval" };
  }
  if (!input.planHash || !input.executionHash)
    return { action: "wait", reason: "execution contract is incomplete" };
  if (!input.baseSha || input.currentBaseSha !== input.baseSha) {
    return { action: "wait", reason: "base commit changed" };
  }
  if (!["idle", "ready"].includes(input.plannerState)) {
    return { action: "wait", reason: "planner cleanup is incomplete" };
  }
  if (!input.graphHashMatches)
    return { action: "wait", reason: "plan graph hash changed" };
  if (input.blockerCount > 0)
    return { action: "wait", reason: "plan has blocker findings" };
  if ((input.unverifiedWriteTaskCount ?? 0) > 0) {
    return {
      action: "wait",
      reason: "write tasks require a verification command",
    };
  }
  if (input.reviewPolicy === "manual") {
    return { action: "wait", reason: "review policy requires manual approval" };
  }
  if (input.claimPaths.includes("*")) {
    return { action: "wait", reason: "plan has unknown file claims" };
  }
  if (
    !input.policy.allowSensitivePaths &&
    input.claimPaths.some(isSensitiveFleetPath)
  ) {
    return { action: "wait", reason: "plan touches sensitive paths" };
  }

  const cleanByLens = new Map<FleetPlanReviewLens, string>();
  for (const review of input.reviews) {
    if (
      review.subject_hash !== input.planHash ||
      review.execution_hash !== input.executionHash ||
      review.base_sha !== input.baseSha ||
      review.verdict !== "clean" ||
      !review.reviewer_session_id
    ) {
      continue;
    }
    cleanByLens.set(review.lens, review.reviewer_session_id);
  }
  if (
    !FLEET_PLAN_REVIEW_LENSES.every((lens) => cleanByLens.has(lens)) ||
    new Set(cleanByLens.values()).size !== FLEET_PLAN_REVIEW_LENSES.length
  ) {
    return {
      action: "wait",
      reason: "four independent clean plan critics are required",
    };
  }
  return { action: "plan_approval" };
}

export function evaluateAutomaticStart(
  input: CommonDecisionInput & {
    planHash: string | null;
    approvedPlanHash: string | null;
    approvedExecutionHash: string | null;
    currentExecutionHash: string | null;
    baseSha: string | null;
    currentBaseSha: string | null;
    recoveryRequired: boolean;
    schedulerReady: boolean;
    confinementAvailable: boolean;
  }
): FleetAutomationDecision {
  if (!input.policy.automaticStart)
    return { action: "wait", reason: "automatic start is disabled" };
  if (!input.policyHashMatches)
    return { action: "wait", reason: "automation policy hash changed" };
  if (!input.authorized)
    return { action: "wait", reason: "start is not authorized" };
  if (input.desiredState !== "running")
    return { action: "wait", reason: "run does not desire execution" };
  if (input.status !== "planned" || input.approvalState !== "approved") {
    return { action: "wait", reason: "run does not have an approved plan" };
  }
  if (
    !input.planHash ||
    input.approvedPlanHash !== input.planHash ||
    !input.approvedExecutionHash ||
    input.currentExecutionHash !== input.approvedExecutionHash
  ) {
    return { action: "wait", reason: "approved execution hash changed" };
  }
  if (!input.baseSha || input.currentBaseSha !== input.baseSha) {
    return { action: "wait", reason: "base commit changed" };
  }
  if (input.recoveryRequired)
    return { action: "wait", reason: "scheduler recovery is required" };
  if (!input.schedulerReady)
    return { action: "wait", reason: "scheduler recovery is not ready" };
  if (!input.policy.allowUnconfinedAgents && !input.confinementAvailable) {
    return {
      action: "wait",
      reason: "automatic start requires confinement or explicit consent",
    };
  }
  return { action: "start" };
}

export function evaluateAutomaticFix(
  policy: FleetAutomationPolicy,
  completedRounds: number
): FleetAutomationDecision {
  if (!policy.automaticFixes)
    return { action: "wait", reason: "automatic fixes are disabled" };
  if (completedRounds >= policy.maxAutomaticFixRounds) {
    return { action: "wait", reason: "automatic fix round limit reached" };
  }
  return { action: "fix" };
}

export function evaluateAutomaticMerge(
  policy: FleetAutomationPolicy
): FleetAutomationDecision {
  if (!policy.automaticMerge)
    return { action: "wait", reason: "automatic merge is disabled" };
  if (!policy.automaticStart) {
    return {
      action: "wait",
      reason: "automatic start is not enabled",
    };
  }
  return { action: "merge" };
}

interface ExecutionPreview {
  executionHash: string;
  graphHashMatches: boolean;
  claimPaths: string[];
  workingDirectory: string;
  tasks: FleetTaskRow[];
  dependencies: FleetTaskDependencyRow[];
  claims: FleetTaskClaimRow[];
}

interface FleetAutomationDeps {
  db: Database.Database;
  now: () => Date;
  startPlanner: typeof startFleetPlanner;
  reconcilePlanReviews: typeof reconcileFleetPlanReviews;
  approvePlan: typeof approveFleetRunPlan;
  reconcileRun: typeof reconcileFleetRun;
  schedulerReady: () => boolean;
  confinementAvailable: () => boolean;
  resolveBaseSha: (db: Database.Database, run: FleetRunRow) => Promise<string>;
}

const automationLocks = new Set<string>();

function automationDeps(
  overrides: Partial<FleetAutomationDeps>
): FleetAutomationDeps {
  return {
    db: overrides.db ?? getDb(),
    now: overrides.now ?? (() => new Date()),
    startPlanner: overrides.startPlanner ?? startFleetPlanner,
    reconcilePlanReviews:
      overrides.reconcilePlanReviews ?? reconcileFleetPlanReviews,
    approvePlan: overrides.approvePlan ?? approveFleetRunPlan,
    reconcileRun: overrides.reconcileRun ?? reconcileFleetRun,
    schedulerReady: overrides.schedulerReady ?? isFleetSchedulerReady,
    confinementAvailable:
      overrides.confinementAvailable ?? fleetStrongConfinementAvailable,
    resolveBaseSha: overrides.resolveBaseSha ?? resolveFleetBaseSha,
  };
}

function plannerState(run: FleetRunRow): FleetPlannerState {
  try {
    const settings = JSON.parse(run.settings_json) as {
      planner?: { state?: unknown };
    };
    const state = settings.planner?.state;
    return [
      "idle",
      "starting",
      "running",
      "finalizing",
      "cleanup_pending",
      "ready",
      "failed",
    ].includes(String(state))
      ? (state as FleetPlannerState)
      : "idle";
  } catch {
    return "idle";
  }
}

function plannerRetryNotBefore(run: FleetRunRow): string | null {
  try {
    const settings = JSON.parse(run.settings_json) as {
      planner?: { retryNotBefore?: unknown };
    };
    return typeof settings.planner?.retryNotBefore === "string"
      ? settings.planner.retryNotBefore
      : null;
  } catch {
    return null;
  }
}

function approvedExecutionHash(run: FleetRunRow): string | null {
  try {
    const value = (JSON.parse(run.settings_json) as Record<string, unknown>)[
      "approvedExecutionHash"
    ];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

function planText(run: FleetRunRow): string | null {
  try {
    const value = (JSON.parse(run.settings_json) as Record<string, unknown>)[
      "planText"
    ];
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

function desiredState(run: FleetRunRow): FleetDesiredState {
  return ["draft", "planned", "running", "paused", "canceled"].includes(
    String(run.desired_state)
  )
    ? (run.desired_state as FleetDesiredState)
    : "draft";
}

function actionStatus(
  db: Database.Database,
  runId: string,
  action: FleetAutomationAction,
  policyHash: string
): string | null {
  const row = db
    .prepare(
      `SELECT status FROM fleet_action_authorizations
       WHERE fleet_run_id = ? AND action = ? AND policy_hash = ?`
    )
    .get(runId, action, policyHash) as { status: string } | undefined;
  return row?.status ?? null;
}

function runTarget(
  db: Database.Database,
  run: FleetRunRow
): { workingDirectory: string; baseBranch: string } | null {
  if (run.repo_id) {
    const repo = queries.getDispatchRepo(db).get(run.repo_id) as
      DispatchRepo | undefined;
    return repo?.repo_path
      ? {
          workingDirectory: repo.repo_path,
          baseBranch: repo.base_branch ?? "main",
        }
      : null;
  }
  if (run.project_id) {
    const project = queries.getProject(db).get(run.project_id) as
      Project | undefined;
    return project?.working_directory
      ? {
          workingDirectory: project.working_directory,
          baseBranch: getDefaultBranch(project.working_directory),
        }
      : null;
  }
  return null;
}

async function resolveFleetBaseSha(
  db: Database.Database,
  run: FleetRunRow
): Promise<string> {
  const target = runTarget(db, run);
  if (!target) throw new Error("automation requires a repository or project");
  const result = await runGit(
    target.workingDirectory,
    ["rev-parse", `${target.baseBranch}^{commit}`],
    5000
  );
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new Error("failed to resolve the Fleet base commit");
  }
  return sha;
}

function executionPreview(
  db: Database.Database,
  run: FleetRunRow
): ExecutionPreview | null {
  if (!run.plan_hash) return null;
  const target = runTarget(db, run);
  if (!target) return null;
  const tasks = queries.listFleetTasksForRun(db).all(run.id) as FleetTaskRow[];
  if (tasks.length === 0) return null;
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskDependencyRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(run.id) as FleetTaskClaimRow[];
  const executionTasks = tasks.map((task) => ({
    ...task,
    working_directory: task.working_directory ?? target.workingDirectory,
    base_branch: task.base_branch ?? target.baseBranch,
  }));
  return {
    executionHash: hashFleetExecutionContract({
      run,
      tasks: executionTasks,
      claims,
      dependencies,
    }),
    graphHashMatches: hashFleetTaskRows(tasks, dependencies) === run.plan_hash,
    claimPaths: claims.map((claim) => claim.path),
    workingDirectory: target.workingDirectory,
    tasks: executionTasks,
    dependencies,
    claims,
  };
}

function recordAutomationFailure(
  db: Database.Database,
  run: FleetRunRow,
  action: FleetAutomationAction,
  error: unknown,
  now: string
): void {
  const message = redactAndCapFleetText(
    error instanceof Error ? error.message : String(error),
    500
  ).text;
  const ownsTransaction = !db.inTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db
      .prepare(
        `UPDATE fleet_runs SET automation_last_error = ?, updated_at = ? WHERE id = ?`
      )
      .run(message, now, run.id);
    if (changed.changes !== 1) {
      if (ownsTransaction) db.exec("COMMIT");
      return;
    }
    if (run.automation_policy_hash) {
      db.prepare(
        `UPDATE fleet_action_authorizations
         SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
         WHERE fleet_run_id = ? AND action = ? AND policy_hash = ?
           AND status = 'authorized'`
      ).run(message, now, run.id, action, run.automation_policy_hash);
    }
    queries
      .createFleetEvent(db)
      .run(
        run.id,
        "automation_action_failed",
        "fleet-automation",
        JSON.stringify({ action, error: message })
      );
    if (ownsTransaction) db.exec("COMMIT");
  } catch (failure) {
    if (ownsTransaction && db.inTransaction) db.exec("ROLLBACK");
    throw failure;
  }
}

/** Persist a policy wait once so API-created/recovered runs never stall silently. */
function recordAutomationWait(
  db: Database.Database,
  run: FleetRunRow,
  action: FleetAutomationAction,
  reason: string,
  now: string
): void {
  const ownsTransaction = !db.inTransaction;
  if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const changed = db
      .prepare(
        `UPDATE fleet_runs SET automation_last_error = ?, updated_at = ?
         WHERE id = ? AND COALESCE(automation_last_error, '') <> ?`
      )
      .run(reason, now, run.id, reason);
    if (changed.changes === 1) {
      queries
        .createFleetEvent(db)
        .run(
          run.id,
          "automation_waiting",
          "fleet-automation",
          JSON.stringify({ action, reason })
        );
    }
    if (ownsTransaction) db.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function clearAutomationFailure(
  db: Database.Database,
  runId: string,
  now: string
): void {
  db.prepare(
    `UPDATE fleet_runs SET automation_last_error = NULL, updated_at = ? WHERE id = ?`
  ).run(now, runId);
}

async function bindAndReadBaseSha(
  deps: FleetAutomationDeps,
  run: FleetRunRow
): Promise<{ stored: string; current: string }> {
  const current = await deps.resolveBaseSha(deps.db, run);
  if (run.automation_base_sha) {
    return { stored: run.automation_base_sha, current };
  }
  const now = deps.now().toISOString();
  let bound = false;
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const changed = deps.db
      .prepare(
        `UPDATE fleet_runs SET automation_base_sha = ?, updated_at = ?
         WHERE id = ? AND automation_base_sha IS NULL
           AND automation_policy_hash = ?`
      )
      .run(current, now, run.id, run.automation_policy_hash);
    if (changed.changes === 1) {
      queries
        .createFleetEvent(deps.db)
        .run(
          run.id,
          "automation_base_bound",
          "fleet-automation",
          JSON.stringify({ baseSha: current })
        );
      bound = true;
    }
    deps.db.exec("COMMIT");
  } catch (error) {
    deps.db.exec("ROLLBACK");
    throw error;
  }
  if (bound) {
    return { stored: current, current };
  }
  const refreshed = queries.getFleetRun(deps.db).get(run.id) as
    FleetRunRow | undefined;
  if (!refreshed?.automation_base_sha) {
    throw new Error("automation base commit binding changed");
  }
  return { stored: refreshed.automation_base_sha, current };
}

function markPlanningConsumed(
  db: Database.Database,
  run: FleetRunRow,
  baseSha: string,
  now: string
): void {
  if (!run.automation_policy_hash) return;
  db.prepare(
    `UPDATE fleet_action_authorizations
     SET status = 'consumed', base_sha = ?, consumed_by = 'fleet-automation',
         consumed_at = COALESCE(consumed_at, ?), attempt_count = attempt_count + 1,
         last_error = NULL, updated_at = ?
     WHERE fleet_run_id = ? AND action = 'planning' AND policy_hash = ?
       AND status = 'authorized'`
  ).run(baseSha, now, now, run.id, run.automation_policy_hash);
}

function compareAndSetAutomaticStart(
  deps: FleetAutomationDeps,
  runId: string,
  policy: FleetAutomationPolicy,
  policyHash: string,
  baseSha: string,
  currentBaseSha: string
): boolean {
  const db = deps.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = queries.getFleetRun(db).get(runId) as FleetRunRow | undefined;
    if (!run) {
      db.exec("COMMIT");
      return false;
    }
    const preview = executionPreview(db, run);
    const decision = evaluateAutomaticStart({
      policy,
      policyHashMatches: run.automation_policy_hash === policyHash,
      authorized:
        actionStatus(db, run.id, "start", policyHash) === "authorized",
      desiredState: desiredState(run),
      status: run.status,
      approvalState: run.approval_state,
      planHash: run.plan_hash,
      approvedPlanHash: run.approved_plan_hash,
      approvedExecutionHash: approvedExecutionHash(run),
      currentExecutionHash: preview?.executionHash ?? null,
      baseSha,
      currentBaseSha,
      recoveryRequired: run.recovery_required === 1,
      schedulerReady: deps.schedulerReady(),
      confinementAvailable: deps.confinementAvailable(),
    });
    if (decision.action !== "start") {
      db.exec("COMMIT");
      return false;
    }
    const now = deps.now().toISOString();
    const changed = db
      .prepare(
        `UPDATE fleet_runs
         SET status = 'running', started_at = COALESCE(started_at, ?),
             automation_last_error = NULL, updated_at = ?
         WHERE id = ? AND status = 'planned' AND desired_state = 'running'
           AND approval_state = 'approved'
           AND approved_plan_hash = plan_hash
           AND automation_policy_hash = ?
           AND automation_base_sha = ?
           AND recovery_required = 0`
      )
      .run(now, now, run.id, policyHash, baseSha);
    if (changed.changes !== 1) {
      db.exec("COMMIT");
      return false;
    }
    const authorization = db
      .prepare(
        `UPDATE fleet_action_authorizations
         SET status = 'consumed', plan_hash = ?, execution_hash = ?,
             base_sha = ?, consumed_by = 'fleet-automation', consumed_at = ?,
             attempt_count = attempt_count + 1, last_error = NULL,
             updated_at = ?
         WHERE fleet_run_id = ? AND action = 'start' AND policy_hash = ?
           AND status = 'authorized'`
      )
      .run(
        run.plan_hash,
        preview?.executionHash ?? null,
        baseSha,
        now,
        now,
        run.id,
        policyHash
      );
    if (authorization.changes !== 1) {
      throw new Error("automatic start authorization changed");
    }
    queries.createFleetEvent(db).run(
      run.id,
      "run_auto_started",
      "fleet-automation",
      JSON.stringify({
        planHash: run.plan_hash,
        executionHash: preview?.executionHash ?? null,
        policyHash,
        baseSha,
      })
    );
    db.exec("COMMIT");
    return true;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function reconcileOneFleetAutomation(
  deps: FleetAutomationDeps,
  initialRun: FleetRunRow
): Promise<void> {
  if (automationLocks.has(initialRun.id)) return;
  automationLocks.add(initialRun.id);
  try {
    let run = queries.getFleetRun(deps.db).get(initialRun.id) as
      FleetRunRow | undefined;
    if (!run || !run.automation_policy_hash) return;
    const policyHash = run.automation_policy_hash;
    const parsed = parseFleetAutomationPolicy(run.automation_policy_json);
    const policyHashMatches =
      parsed.valid && hashFleetAutomationPolicy(parsed.policy) === policyHash;
    if (!policyHashMatches) {
      recordAutomationFailure(
        deps.db,
        run,
        "planning",
        new Error("automation policy hash changed"),
        deps.now().toISOString()
      );
      return;
    }

    let base: { stored: string; current: string };
    try {
      base = await bindAndReadBaseSha(deps, run);
    } catch (error) {
      recordAutomationFailure(
        deps.db,
        run,
        "planning",
        error,
        deps.now().toISOString()
      );
      return;
    }
    if (base.stored !== base.current) {
      recordAutomationFailure(
        deps.db,
        run,
        run.approval_state === "approved" ? "start" : "plan_approval",
        new Error("base commit changed"),
        deps.now().toISOString()
      );
      return;
    }

    run = queries.getFleetRun(deps.db).get(run.id) as FleetRunRow;
    const currentPlannerState = plannerState(run);
    if (
      [
        "starting",
        "running",
        "finalizing",
        "cleanup_pending",
        "ready",
      ].includes(currentPlannerState) ||
      run.plan_hash
    ) {
      markPlanningConsumed(deps.db, run, base.stored, deps.now().toISOString());
    }
    const planning = evaluateAutomaticPlanning({
      policy: parsed.policy,
      policyHashMatches,
      authorized:
        actionStatus(deps.db, run.id, "planning", policyHash) === "authorized",
      desiredState: desiredState(run),
      status: run.status,
      approvalState: run.approval_state,
      planHash: run.plan_hash,
      plannerState: currentPlannerState,
      baseSha: base.stored,
      confinementAvailable: deps.confinementAvailable(),
      retryNotBefore: plannerRetryNotBefore(run),
      now: deps.now(),
    });
    if (
      planning.action === "wait" &&
      planning.reason ===
        "automatic planning requires confinement or explicit consent"
    ) {
      recordAutomationWait(
        deps.db,
        run,
        "planning",
        planning.reason,
        deps.now().toISOString()
      );
      return;
    }
    if (planning.action === "planning") {
      const result = await deps.startPlanner(
        run.id,
        { taskCap: parsed.policy.plannerTaskCap },
        "fleet-automation"
      );
      if ("error" in result) {
        recordAutomationFailure(
          deps.db,
          run,
          "planning",
          new Error(result.error),
          deps.now().toISOString()
        );
        return;
      }
      markPlanningConsumed(deps.db, run, base.stored, deps.now().toISOString());
      clearAutomationFailure(deps.db, run.id, deps.now().toISOString());
      return;
    }

    run = queries.getFleetRun(deps.db).get(run.id) as FleetRunRow;
    if (
      parsed.policy.automaticPlanApproval &&
      run.status === "draft" &&
      run.approval_state === "needs_approval"
    ) {
      const preview = executionPreview(deps.db, run);
      let reviews = preview
        ? (queries
            .listFleetReviewsForContract(deps.db)
            .all(
              run.id,
              run.plan_hash,
              policyHash,
              preview.executionHash,
              base.stored
            ) as FleetReviewEvidenceRow[])
        : [];
      let blockers = run.plan_hash
        ? (queries
            .countFleetBlockerArtifactsForPlan(deps.db)
            .get(run.id, run.plan_hash) as { n: number })
        : { n: 0 };
      const reviewEligibility = evaluateAutomaticApproval({
        policy: parsed.policy,
        policyHashMatches,
        authorized:
          actionStatus(deps.db, run.id, "plan_approval", policyHash) ===
          "authorized",
        desiredState: desiredState(run),
        status: run.status,
        approvalState: run.approval_state,
        reviewPolicy: run.review_policy,
        planHash: run.plan_hash,
        executionHash: preview?.executionHash ?? null,
        baseSha: base.stored,
        currentBaseSha: base.current,
        plannerState: plannerState(run),
        graphHashMatches: preview?.graphHashMatches ?? false,
        blockerCount: 0,
        unverifiedWriteTaskCount:
          preview?.tasks.filter(
            (task) =>
              !["milestone", "review", "explore"].includes(task.task_type) &&
              !task.verify_command?.trim()
          ).length ?? 0,
        claimPaths: preview?.claimPaths ?? ["*"],
        reviews,
      });
      const activeReviews =
        preview && run.plan_hash
          ? (deps.db
              .prepare(
                `SELECT COUNT(*) AS n FROM fleet_reviews
                 WHERE fleet_run_id = ? AND subject_type = 'plan'
                   AND subject_hash = ? AND policy_hash = ?
                   AND execution_hash = ? AND base_sha = ?
                   AND state IN ('pending', 'spawning', 'running', 'cleanup_pending')`
              )
              .get(
                run.id,
                run.plan_hash,
                policyHash,
                preview.executionHash,
                base.stored
              ) as { n: number })
          : { n: 0 };
      const auxiliaryLaunchAllowed =
        parsed.policy.allowUnconfinedAgents || deps.confinementAvailable();
      if (
        preview &&
        run.plan_hash &&
        !auxiliaryLaunchAllowed &&
        reviews.length < FLEET_PLAN_REVIEW_LENSES.length &&
        reviewEligibility.action === "wait" &&
        reviewEligibility.reason ===
          "four independent clean plan critics are required"
      ) {
        recordAutomationWait(
          deps.db,
          run,
          "plan_approval",
          "automatic plan review requires confinement or explicit consent",
          deps.now().toISOString()
        );
        return;
      }
      if (
        preview &&
        run.plan_hash &&
        auxiliaryLaunchAllowed &&
        reviewEligibility.action === "wait" &&
        reviewEligibility.reason ===
          "four independent clean plan critics are required" &&
        (blockers.n === 0 || activeReviews.n > 0)
      ) {
        await deps.reconcilePlanReviews({
          run,
          policy: parsed.policy,
          planHash: run.plan_hash,
          policyHash,
          executionHash: preview.executionHash,
          baseSha: base.stored,
          workingDirectory: preview.workingDirectory,
          planText: planText(run),
          tasks: preview.tasks,
          dependencies: preview.dependencies,
          claims: preview.claims,
        });
        reviews = queries
          .listFleetReviewsForContract(deps.db)
          .all(
            run.id,
            run.plan_hash,
            policyHash,
            preview.executionHash,
            base.stored
          ) as FleetReviewEvidenceRow[];
        blockers = queries
          .countFleetBlockerArtifactsForPlan(deps.db)
          .get(run.id, run.plan_hash) as { n: number };
      }
      const approval = evaluateAutomaticApproval({
        policy: parsed.policy,
        policyHashMatches,
        authorized:
          actionStatus(deps.db, run.id, "plan_approval", policyHash) ===
          "authorized",
        desiredState: desiredState(run),
        status: run.status,
        approvalState: run.approval_state,
        reviewPolicy: run.review_policy,
        planHash: run.plan_hash,
        executionHash: preview?.executionHash ?? null,
        baseSha: base.stored,
        currentBaseSha: base.current,
        plannerState: plannerState(run),
        graphHashMatches: preview?.graphHashMatches ?? false,
        blockerCount: blockers.n,
        unverifiedWriteTaskCount:
          preview?.tasks.filter(
            (task) =>
              !["milestone", "review", "explore"].includes(task.task_type) &&
              !task.verify_command?.trim()
          ).length ?? 0,
        claimPaths: preview?.claimPaths ?? ["*"],
        reviews,
      });
      if (approval.action === "plan_approval" && run.plan_hash && preview) {
        const guard: FleetAutomationApprovalGuard = {
          policyHash,
          baseSha: base.stored,
          executionHash: preview.executionHash,
        };
        const result = deps.approvePlan(
          run.id,
          { expectedPlanHash: run.plan_hash },
          "fleet-automation",
          guard
        );
        if ("error" in result) {
          recordAutomationFailure(
            deps.db,
            run,
            "plan_approval",
            new Error(result.error),
            deps.now().toISOString()
          );
          return;
        }
        clearAutomationFailure(deps.db, run.id, deps.now().toISOString());
      }
    }

    run = queries.getFleetRun(deps.db).get(run.id) as FleetRunRow;
    if (
      parsed.policy.automaticStart &&
      run.status === "planned" &&
      run.approval_state === "approved"
    ) {
      const preview = executionPreview(deps.db, run);
      const start = evaluateAutomaticStart({
        policy: parsed.policy,
        policyHashMatches,
        authorized:
          actionStatus(deps.db, run.id, "start", policyHash) === "authorized",
        desiredState: desiredState(run),
        status: run.status,
        approvalState: run.approval_state,
        planHash: run.plan_hash,
        approvedPlanHash: run.approved_plan_hash,
        approvedExecutionHash: approvedExecutionHash(run),
        currentExecutionHash: preview?.executionHash ?? null,
        baseSha: base.stored,
        currentBaseSha: base.current,
        recoveryRequired: run.recovery_required === 1,
        schedulerReady: deps.schedulerReady(),
        confinementAvailable: deps.confinementAvailable(),
      });
      if (
        start.action === "wait" &&
        start.reason ===
          "automatic start requires confinement or explicit consent"
      ) {
        recordAutomationWait(
          deps.db,
          run,
          "start",
          start.reason,
          deps.now().toISOString()
        );
        return;
      }
      if (
        start.action === "start" &&
        compareAndSetAutomaticStart(
          deps,
          run.id,
          parsed.policy,
          policyHash,
          base.stored,
          base.current
        )
      ) {
        await deps.reconcileRun(run.id);
      }
    }
  } finally {
    automationLocks.delete(initialRun.id);
  }
}

export async function reconcileFleetAutomation(
  limit = 40,
  overrides: Partial<FleetAutomationDeps> = {}
): Promise<void> {
  const deps = automationDeps(overrides);
  const runs = queries
    .listFleetAutomationCandidates(deps.db)
    .all(Math.max(1, Math.min(100, Math.trunc(limit)))) as FleetRunRow[];
  for (const run of runs) {
    try {
      await reconcileOneFleetAutomation(deps, run);
    } catch (error) {
      recordAutomationFailure(
        deps.db,
        run,
        run.approval_state === "approved" ? "start" : "planning",
        error,
        deps.now().toISOString()
      );
    }
  }
}
