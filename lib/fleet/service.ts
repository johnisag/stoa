import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import {
  getDefaultBranch,
  isGitRepo,
  resolveGitCommit,
} from "@/lib/git-status";
import { PROVIDER_IDS, type ProviderId } from "@/lib/providers/registry";
import { resolveExactModelForAgent } from "@/lib/model-catalog";
import {
  composeFleetRunDetail,
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
  normalizeFleetRunDraft,
  toFleetRunDto,
} from "./engine";
import {
  hashParsedFleetPlanTasks,
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  validateFleetTaskRowsForApproval,
} from "./hash";
import { fleetAutomationPolicyJson } from "./automation-policy";
import {
  FLEET_PLAN_TASK_DESCRIPTION_MAX,
  FLEET_PLAN_TASK_TITLE_MAX,
  FLEET_PLAN_TEXT_MAX,
  parseFleetPlanText,
  type ParsedFleetPlanTask,
} from "./plan";
import { normalizeFleetClaims, UNKNOWN_FLEET_CLAIM } from "./conflicts";
import {
  isFleetSchedulerReady,
  reconcileFleetRun,
  reconcileFleetWorkerReport,
} from "./scheduler";
import { fleetLaunchBlockedResult } from "./recovery-gate";
import { stopFleetSession } from "./stop";
import {
  finalizeFleetWorkerCost,
  releaseFleetCostOwnerReservation,
  settleFleetCostOwner,
  type FleetCostOwnerType,
} from "./cost-runtime";
import { releaseFleetRuntimeResources } from "./resource-runtime";
import {
  FLEET_INTERRUPT_MAX_WORKERS,
  decideFleetResume,
  parseFleetCancelRequest,
  parseFleetPauseRequest,
  startFleetWorkerInterrupt,
} from "./interrupt-policy";
import { redactAndCapFleetText } from "./redaction";
import type { FleetDestructiveConfirmation } from "./lifecycle";
import type {
  FleetArtifactRow,
  FleetArtifactSeverity,
  FleetEventRow,
  FleetRunDetailDto,
  FleetRunDto,
  FleetRunRow,
  FleetTaskRow,
  FleetWorkerRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetAutomationAction,
  FleetVerificationRow,
} from "./types";

interface FleetRunListRow extends FleetRunRow {
  task_count: number;
  worker_count: number;
  attention_count: number;
  awaiting_manual_merge: number;
}

const FLEET_RUN_LIST_LIMIT = 100;
const FLEET_ARTIFACT_LIST_LIMIT = 100;
const FLEET_ACTOR_MAX = 80;
const FLEET_ARTIFACT_TITLE_MAX = 160;
const FLEET_ARTIFACT_BODY_MAX = 8000;
const FLEET_PLAN_ACCEPTANCE_CRITERIA_MAX = 2_000;
const FLEET_PLAN_RISK_NOTES_MAX = 8;
const FLEET_PLAN_RISK_TEXT_MAX = 500;
const FLEET_PLAN_RISK_MITIGATION_MAX = 1_000;
const FULL_GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const FLEET_AUXILIARY_COST_OWNER_TYPES = new Set<
  Exclude<FleetCostOwnerType, "worker">
>(["planner", "plan_review", "task_review", "fixer", "supervisor"]);

type FleetAuxiliaryCostOwnerType = Exclude<FleetCostOwnerType, "worker">;

interface FleetAuxiliaryInterruptAccountRow {
  id: string;
  fleet_run_id: string;
  session_id: string | null;
  owner_type: string;
  owner_id: string;
  terminal_at: string | null;
  reservation_released_at: string | null;
  interrupt_requested_at: string | null;
  interrupt_deadline_at: string | null;
  interrupt_notice_state: string;
  interrupt_stop_state: string;
  interrupt_cause: string | null;
  active_account_owners?: number;
  active_worker_owners?: number;
}

function isFleetAuxiliaryCostOwnerType(
  value: string
): value is FleetAuxiliaryCostOwnerType {
  return FLEET_AUXILIARY_COST_OWNER_TYPES.has(
    value as FleetAuxiliaryCostOwnerType
  );
}

function auxiliaryInterruptSnapshot(
  runId: string,
  account: FleetAuxiliaryInterruptAccountRow
) {
  return {
    runId,
    workerId: `aux-${account.id}`,
    sessionId: account.session_id,
    workerStatus:
      account.terminal_at && account.reservation_released_at
        ? "cleanup_complete"
        : "running",
    interruptRequestedAt: account.interrupt_requested_at,
    interruptDeadlineAt: account.interrupt_deadline_at,
    noticeState: account.interrupt_notice_state,
    stopState: account.interrupt_stop_state,
  };
}

function validateFleetClaimRowsForApproval(
  tasks: FleetTaskRow[],
  claims: FleetTaskClaimRow[]
): { error: string } | { ok: true } {
  const expected = tasks.flatMap((task) => {
    const normalized = normalizeFleetClaims(
      (() => {
        try {
          const parsed = JSON.parse(task.file_claims_json);
          return Array.isArray(parsed)
            ? parsed.filter(
                (value): value is string => typeof value === "string"
              )
            : [];
        } catch {
          return [];
        }
      })()
    );
    const effective = ["milestone", "review", "explore"].includes(
      task.task_type
    )
      ? []
      : normalized.length > 0
        ? normalized
        : [UNKNOWN_FLEET_CLAIM];
    return effective.map((path) =>
      JSON.stringify({
        taskId: task.id,
        path,
        claimType: path === UNKNOWN_FLEET_CLAIM ? "unknown" : "exclusive",
        confidence: path === UNKNOWN_FLEET_CLAIM ? 0 : 1,
      })
    );
  });
  const actual = claims.map((claim) =>
    JSON.stringify({
      taskId: claim.task_id,
      path: claim.path,
      claimType: claim.claim_type,
      confidence: claim.confidence,
    })
  );
  expected.sort();
  actual.sort();
  return expected.length === actual.length &&
    expected.every((value, index) => value === actual[index])
    ? { ok: true }
    : { error: "plan graph claims do not match the reviewed task claims" };
}

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cappedText(value: unknown, max: number): string {
  // Preserve the existing character cap while ensuring credential-shaped text
  // is removed from the complete value before any truncation is applied.
  return redactAndCapFleetText(textValue(value), max * 4)
    .text.trim()
    .slice(0, max);
}

function containsCredentialShapedText(
  value: string | null | undefined
): boolean {
  if (!value) return false;
  return redactAndCapFleetText(value, Buffer.byteLength(value, "utf8"))
    .redacted;
}

function sanitizeFleetPlanReplacement(
  replacement: FleetPlanReplacement
): FleetPlanReplacement | { error: string; status: number } {
  const tasks: ParsedFleetPlanTask[] = [];
  for (const [index, task] of replacement.tasks.entries()) {
    const credentialFields: Array<[string, string | null | undefined]> = [
      ["verification command", task.verifyCommand],
      ["working directory", task.workingDirectory],
      ["base branch", task.baseBranch],
      ["agent type", task.agentType],
      ["model", task.model],
      ...task.fileClaims.map(
        (claim) => ["file claim", claim] as [string, string | null]
      ),
    ];
    const unsafe = credentialFields.find(([, value]) =>
      containsCredentialShapedText(value)
    );
    if (unsafe) {
      return {
        error: `plan task ${index + 1} ${unsafe[0]} contains credential-shaped text`,
        status: 400,
      };
    }
    tasks.push({
      ...task,
      title: cappedText(task.title, FLEET_PLAN_TASK_TITLE_MAX),
      description: task.description
        ? cappedText(task.description, FLEET_PLAN_TASK_DESCRIPTION_MAX) || null
        : null,
      acceptanceCriteria: task.acceptanceCriteria
        ? cappedText(
            task.acceptanceCriteria,
            FLEET_PLAN_ACCEPTANCE_CRITERIA_MAX
          ) || null
        : null,
      riskNotes: (task.riskNotes ?? [])
        .slice(0, FLEET_PLAN_RISK_NOTES_MAX)
        .map((note) => ({
          severity:
            note.severity === "low" || note.severity === "high"
              ? note.severity
              : ("medium" as const),
          risk: cappedText(note.risk, FLEET_PLAN_RISK_TEXT_MAX),
          mitigation: cappedText(
            note.mitigation,
            FLEET_PLAN_RISK_MITIGATION_MAX
          ),
        }))
        .filter((note) => note.risk && note.mitigation),
    });
  }
  return {
    ...replacement,
    tasks,
    planText: cappedText(replacement.planText, FLEET_PLAN_TEXT_MAX),
  };
}

function fleetProvider(value: string | null | undefined): ProviderId | null {
  const provider = value?.trim() ?? "";
  return PROVIDER_IDS.includes(provider as ProviderId) && provider !== "shell"
    ? (provider as ProviderId)
    : null;
}

function exactPersistedModelError(
  provider: ProviderId,
  model: string | null | undefined
): string | null {
  const resolved = resolveExactModelForAgent(provider, model);
  if (!resolved.ok) return resolved.error;
  const persisted = model?.trim() || null;
  return resolved.model === persisted
    ? null
    : "the provider-owned default was not persisted explicitly";
}

/** Bind every task to the exact provider/model tuple that it will launch. */
function bindFleetPlanModels(
  replacement: FleetPlanReplacement,
  run: FleetRunRow
): FleetPlanReplacement | { error: string; status: number } {
  const runProvider = fleetProvider(run.provider);
  if (!runProvider) {
    return { error: "run has an unsupported provider", status: 409 };
  }
  const runModelError = exactPersistedModelError(runProvider, run.model);
  if (runModelError) {
    return {
      error: `run model contract is invalid: ${runModelError}`,
      status: 409,
    };
  }

  const tasks: ParsedFleetPlanTask[] = [];
  for (const [index, task] of replacement.tasks.entries()) {
    if ((task.agentType?.trim().length ?? 0) > FLEET_PROVIDER_MAX) {
      return {
        error: `plan task ${index + 1} provider is too long`,
        status: 400,
      };
    }
    const provider = fleetProvider(task.agentType ?? runProvider);
    if (!provider) {
      return {
        error: `plan task ${index + 1} has an unsupported provider`,
        status: 400,
      };
    }
    const explicitModel = task.model?.trim() || null;
    if (explicitModel && explicitModel.length > FLEET_MODEL_MAX) {
      return {
        error: `plan task ${index + 1} model is too long`,
        status: 400,
      };
    }
    const candidate =
      explicitModel ?? (provider === runProvider ? run.model : null);
    const resolved = resolveExactModelForAgent(provider, candidate);
    if (!resolved.ok) {
      return {
        error: `plan task ${index + 1} ${resolved.error}`,
        status: 400,
      };
    }
    tasks.push({
      ...task,
      agentType: provider,
      model: resolved.model,
    });
  }
  return { ...replacement, tasks };
}

function validateFleetModelContractsForApproval(
  run: FleetRunRow,
  tasks: FleetTaskRow[]
): { ok: true } | { error: string; status: number } {
  const runProvider = fleetProvider(run.provider);
  if (!runProvider) {
    return {
      error: "select a supported agent provider before approval",
      status: 409,
    };
  }
  const runModelError = exactPersistedModelError(runProvider, run.model);
  if (runModelError) {
    return {
      error: `run model contract is invalid: ${runModelError}`,
      status: 409,
    };
  }
  for (const task of tasks) {
    const provider = task.agent_type ? fleetProvider(task.agent_type) : null;
    if (!provider) {
      return {
        error: `task ${task.id} is missing an exact supported provider`,
        status: 409,
      };
    }
    const modelError = exactPersistedModelError(provider, task.model);
    if (modelError) {
      return {
        error: `task ${task.id} model contract is invalid: ${modelError}`,
        status: 409,
      };
    }
  }
  return { ok: true };
}

function actorValue(value: unknown, fallback: string): string {
  return cappedText(value, FLEET_ACTOR_MAX) || fallback;
}

function severityValue(value: unknown): FleetArtifactSeverity {
  return value === "info" || value === "warning" || value === "blocker"
    ? value
    : "warning";
}

function canReplacePlan(run: FleetRunRow): boolean {
  return (
    run.status === "draft" &&
    (run.approval_state === "draft" || run.approval_state === "needs_approval")
  );
}

function canApprovePlan(run: FleetRunRow): boolean {
  return run.status === "draft" && run.approval_state === "needs_approval";
}

function settingsJson(
  row: FleetRunRow,
  updates: Record<string, unknown>
): string {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.settings_json);
    if (parsed && typeof parsed === "object") {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  return JSON.stringify({
    ...current,
    ...updates,
    canSpawnWorkers: updates.canSpawnWorkers === true,
  });
}

function immediateTransaction<T>(db: Database.Database, callback: () => T): T {
  if (db.inTransaction) {
    const savepoint = "fleet_service_nested";
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

export function listFleetRuns(): FleetRunDto[] {
  const rows = queries
    .listFleetRuns(getDb())
    .all(FLEET_RUN_LIST_LIMIT) as FleetRunListRow[];
  return rows.map((row) =>
    toFleetRunDto(row, {
      taskCount: row.task_count,
      workerCount: row.worker_count,
      attentionCount:
        row.attention_count + (row.awaiting_manual_merge === 1 ? 1 : 0),
      awaitingManualMerge: row.awaiting_manual_merge === 1,
    })
  );
}

function fleetRunDetailFromDb(
  db: Database.Database,
  id: string
): FleetRunDetailDto | null {
  const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
  if (!run) return null;
  const tasks = queries.listFleetTasksForRun(db).all(id) as FleetTaskRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(id) as FleetTaskDependencyRow[];
  const workers = queries
    .listFleetWorkersForRun(db)
    .all(id) as FleetWorkerRow[];
  const artifacts = queries
    .listFleetArtifactsForRun(db)
    .all(id, FLEET_ARTIFACT_LIST_LIMIT) as FleetArtifactRow[];
  const verifications = queries
    .listFleetVerificationsForRun(db)
    .all(id) as FleetVerificationRow[];
  const events = queries
    .listFleetEventsForRun(db)
    .all(id, 50) as FleetEventRow[];
  return composeFleetRunDetail({
    run,
    tasks,
    dependencies,
    workers,
    artifacts,
    verifications,
    events,
  });
}

export function getFleetRunDetail(id: string): FleetRunDetailDto | null {
  return fleetRunDetailFromDb(getDb(), id);
}

export function createDraftFleetRun(
  input: unknown,
  actor = "operator",
  runIdOverride?: string
): { run: FleetRunDetailDto } | { error: string } {
  const rawDraft = payloadObject(input);
  if (containsCredentialShapedText(textValue(rawDraft.model))) {
    return { error: "model must not contain credential-shaped text" };
  }
  const normalized = normalizeFleetRunDraft({
    ...rawDraft,
    name: cappedText(rawDraft.name, FLEET_RUN_NAME_MAX),
    goal: cappedText(rawDraft.goal, FLEET_RUN_GOAL_MAX),
  });
  if ("error" in normalized) return normalized;
  if (containsCredentialShapedText(normalized.draft.model)) {
    return { error: "model must not contain credential-shaped text" };
  }
  const draft = {
    ...normalized.draft,
    name: cappedText(normalized.draft.name, FLEET_RUN_NAME_MAX),
    goal: cappedText(normalized.draft.goal, FLEET_RUN_GOAL_MAX),
  };
  const db = getDb();

  if (draft.repoId) {
    const repo = queries.getDispatchRepo(db).get(draft.repoId) as
      DispatchRepo | undefined;
    if (!repo) return { error: "unknown repoId" };
  }

  if (draft.projectId) {
    const project = queries.getProject(db).get(draft.projectId) as
      Project | undefined;
    if (!project) return { error: "unknown projectId" };
  }

  const runId = runIdOverride ?? randomUUID();
  const rootTaskId = randomUUID();
  const grantedBy = actorValue(actor, "operator");
  const grantedAt = new Date().toISOString();
  const policyJson = fleetAutomationPolicyJson(draft.automationPolicy);
  const policyHash = hashFleetAutomationPolicy(draft.automationPolicy);
  const settingsJson = JSON.stringify({
    phase: "draft",
    canSpawnWorkers: false,
  });
  const eventPayload = JSON.stringify({
    name: draft.name,
    repoId: draft.repoId,
    projectId: draft.projectId,
    maxConcurrency: draft.maxConcurrency,
    budgetUsd: draft.budgetUsd,
    budgetTokens: draft.budgetTokens,
    budgetStopMode: draft.budgetStopMode,
    budgetWarningThreshold: draft.budgetWarningThreshold,
    providerCaps: draft.providerCaps,
    defaultMaxAttempts: draft.defaultMaxAttempts,
    reviewPolicy: draft.reviewPolicy,
    desiredState: draft.desiredState,
    automationPolicyVersion: draft.automationPolicy.version,
    automationPolicyHash: policyHash,
  });

  const authorizedActions: FleetAutomationAction[] = [];
  if (draft.automationPolicy.automaticPlanning)
    authorizedActions.push("planning");
  if (draft.automationPolicy.automaticPlanApproval)
    authorizedActions.push("plan_approval");
  if (draft.automationPolicy.automaticStart) authorizedActions.push("start");
  if (draft.automationPolicy.automaticFixes) authorizedActions.push("fix");
  if (draft.automationPolicy.automaticMerge) authorizedActions.push("merge");

  db.transaction(() => {
    queries
      .createFleetRun(db)
      .run(
        runId,
        draft.name,
        draft.goal,
        draft.repoId,
        draft.projectId,
        draft.budgetUsd,
        draft.provider,
        draft.model,
        draft.maxConcurrency,
        draft.reviewPolicy,
        settingsJson
      );
    db.prepare(
      `UPDATE fleet_runs SET budget_tokens = ?, budget_stop_mode = ?,
       budget_warning_threshold = ?, provider_caps_json = ?,
       resource_limits_json = ?, default_max_attempts = ? WHERE id = ?`
    ).run(
      draft.budgetTokens,
      draft.budgetStopMode,
      draft.budgetWarningThreshold,
      JSON.stringify(draft.providerCaps),
      JSON.stringify(draft.resourceLimits),
      draft.defaultMaxAttempts,
      runId
    );
    const intent = queries
      .setFleetRunAutomationIntent(db)
      .run(
        draft.desiredState,
        draft.automationPolicy.version,
        policyJson,
        policyHash,
        grantedBy,
        grantedAt,
        grantedAt,
        runId
      );
    if (intent.changes !== 1) {
      throw new Error("failed to persist fleet automation intent");
    }
    for (const action of authorizedActions) {
      queries
        .createFleetActionAuthorization(db)
        .run(
          randomUUID(),
          runId,
          action,
          policyHash,
          grantedBy,
          grantedAt,
          grantedAt
        );
    }
    queries
      .createFleetTask(db)
      .run(
        rootTaskId,
        runId,
        null,
        "Draft scope",
        draft.goal,
        "draft",
        "scope",
        0,
        "[]"
      );
    queries
      .createFleetEvent(db)
      .run(runId, "draft_created", grantedBy, eventPayload);
  })();

  const detail = getFleetRunDetail(runId);
  if (!detail) return { error: "failed to read created run" };
  return { run: detail };
}

interface FleetPlanReplacement {
  tasks: ParsedFleetPlanTask[];
  planText: string;
  dependencies?: number[][];
  expectedPlannerRequestId?: string;
  plannerProvider?: string;
  source?: "operator" | "planner";
}

function replaceFleetRunPlan(
  id: string,
  replacement: FleetPlanReplacement,
  actor: string
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const sanitized = sanitizeFleetPlanReplacement(replacement);
  if ("error" in sanitized) return sanitized;
  let parsed = sanitized;
  const db = getDb();
  const taskIds = parsed.tasks.map(() => randomUUID());

  const updated = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (!canReplacePlan(run)) {
      return {
        error: "cannot replace a plan for the current run state",
        status: 409,
      };
    }
    const boundModels = bindFleetPlanModels(parsed, run);
    if ("error" in boundModels) return boundModels;
    parsed = boundModels;
    const planHash = hashParsedFleetPlanTasks(
      parsed.tasks,
      parsed.dependencies ?? []
    );
    const eventPayload = JSON.stringify({
      taskCount: parsed.tasks.length,
      planHash,
      actor,
      source: parsed.source ?? "operator",
    });
    if (!parsed.expectedPlannerRequestId) {
      try {
        const currentSettings = payloadObject(JSON.parse(run.settings_json));
        const currentPlanner = payloadObject(currentSettings.planner);
        if (
          ["starting", "running", "finalizing", "cleanup_pending"].includes(
            String(currentPlanner.state)
          )
        ) {
          return {
            error: "cancel the active planner before ingesting a manual plan",
            status: 409,
          };
        }
      } catch {
        return { error: "run settings are invalid", status: 409 };
      }
    }
    if (parsed.expectedPlannerRequestId) {
      let settings: Record<string, unknown> = {};
      try {
        settings = payloadObject(JSON.parse(run.settings_json));
      } catch {
        return { error: "run settings are invalid", status: 409 };
      }
      const planner = payloadObject(settings.planner);
      if (
        planner.requestId !== parsed.expectedPlannerRequestId ||
        planner.state !== "finalizing"
      ) {
        return { error: "planner result was superseded", status: 409 };
      }
    }

    const workerCount = queries.countFleetWorkersForRun(db).get(id) as {
      n: number;
    };
    if (workerCount.n > 0) {
      return {
        error: "cannot replace a plan after workers exist",
        status: 409,
      };
    }

    const settings = settingsJson(run, {
      phase: "plan_review",
      planHash,
      planText: parsed.planText,
      taskCount: parsed.tasks.length,
      planner: parsed.expectedPlannerRequestId
        ? {
            ...payloadObject(
              payloadObject(JSON.parse(run.settings_json)).planner
            ),
            state: "cleanup_pending",
            finalState: "ready",
            requestId: parsed.expectedPlannerRequestId,
            provider: parsed.plannerProvider ?? null,
            completedAt: new Date().toISOString(),
          }
        : { state: "idle" },
    });
    const state = queries
      .updateFleetRunPlanState(db)
      .run(planHash, settings, id);
    if (state.changes !== 1) {
      return { error: "run state changed before plan ingestion", status: 409 };
    }
    queries.clearFleetArtifactTaskLinksForRun(db).run(id);
    queries.deleteFleetTaskDependenciesForRun(db).run(id);
    queries.deleteFleetTaskClaimsForRun(db).run(id);
    queries.deleteFleetTasksForRun(db).run(id);
    parsed.tasks.forEach((task, index) => {
      const taskId = taskIds[index];
      if (!taskId) throw new Error("missing generated task id");
      let parentTaskId: string | null = null;
      if (task.parentIndex != null) {
        parentTaskId = taskIds[task.parentIndex] ?? null;
        if (!parentTaskId) throw new Error("missing generated parent task id");
      }
      queries
        .createFleetTask(db)
        .run(
          taskId,
          id,
          parentTaskId,
          task.title,
          task.description,
          "draft",
          task.taskType,
          task.sortOrder,
          JSON.stringify(task.fileClaims)
        );
      db.prepare(
        `UPDATE fleet_tasks SET agent_type = ?, model = ?, acceptance_criteria = ?,
         risk_notes_json = ?, verify_command = ?, working_directory = ?,
         base_branch = ?, max_attempts = ?
         WHERE id = ? AND fleet_run_id = ?`
      ).run(
        task.agentType,
        task.model,
        task.acceptanceCriteria,
        JSON.stringify(task.riskNotes ?? []),
        task.verifyCommand,
        task.workingDirectory ?? null,
        task.baseBranch ?? null,
        run.default_max_attempts ?? 2,
        taskId,
        id
      );
      const dependencyIndexes = new Set(parsed.dependencies?.[index] ?? []);
      if (task.parentIndex != null) dependencyIndexes.add(task.parentIndex);
      for (const dependencyIndex of dependencyIndexes) {
        const dependsOnTaskId = taskIds[dependencyIndex];
        if (!dependsOnTaskId || dependsOnTaskId === taskId) {
          throw new Error("missing generated dependency task id");
        }
        queries
          .createFleetTaskDependency(db)
          .run(randomUUID(), id, taskId, dependsOnTaskId, "blocks");
      }
      const claims = normalizeFleetClaims(task.fileClaims);
      const effectiveClaims = ["milestone", "review", "explore"].includes(
        task.taskType
      )
        ? []
        : claims.length > 0
          ? claims
          : [UNKNOWN_FLEET_CLAIM];
      for (const claim of effectiveClaims) {
        queries
          .createFleetTaskClaim(db)
          .run(
            randomUUID(),
            id,
            taskId,
            claim,
            claim === UNKNOWN_FLEET_CLAIM ? "unknown" : "exclusive",
            claim === UNKNOWN_FLEET_CLAIM ? 0 : 1
          );
      }
    });
    queries.createFleetEvent(db).run(id, "plan_ingested", actor, eventPayload);
    return { ok: true };
  });
  if ("error" in updated) {
    return updated;
  }

  const detail = getFleetRunDetail(id);
  if (!detail) return { error: "failed to read updated run" };
  return { run: detail };
}

export function ingestFleetRunPlan(
  id: string,
  input: unknown
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const parsed = parseFleetPlanText(
    cappedText(payload.planText, FLEET_PLAN_TEXT_MAX)
  );
  if ("error" in parsed) return parsed;
  return replaceFleetRunPlan(
    id,
    { ...parsed, source: "operator" },
    actorValue(payload.actor, "operator")
  );
}

export function ingestGeneratedFleetRunPlan(
  id: string,
  input: FleetPlanReplacement & { actor?: string }
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  return replaceFleetRunPlan(id, input, actorValue(input.actor, "planner"));
}

export interface FleetAutomationApprovalGuard {
  policyHash: string;
  baseSha: string;
  executionHash: string;
}

function fleetRunBaseTarget(
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

export function approveFleetRunPlan(
  id: string,
  input: unknown,
  actor = "operator",
  automationGuard?: FleetAutomationApprovalGuard
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const expectedPlanHash = cappedText(payload.expectedPlanHash, 128);
  if (!expectedPlanHash) return { error: "expectedPlanHash is required" };

  const db = getDb();
  const approvedBy = actorValue(actor, "operator");
  const result = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    const baseTarget = fleetRunBaseTarget(db, run);
    if (!baseTarget) {
      return {
        error:
          "an executable fleet plan requires a repository or project working directory",
        status: 409,
      };
    }
    const currentBaseSha = resolveGitCommit(
      baseTarget.workingDirectory,
      baseTarget.baseBranch
    );
    if (!currentBaseSha) {
      return { error: "failed to resolve the Fleet base commit", status: 409 };
    }
    if (
      run.automation_base_sha &&
      run.automation_base_sha.toLowerCase() !== currentBaseSha
    ) {
      return { error: "Fleet run base commit changed", status: 409 };
    }
    if (automationGuard) {
      if (
        approvedBy !== "fleet-automation" ||
        run.automation_policy_hash !== automationGuard.policyHash ||
        automationGuard.baseSha.toLowerCase() !== currentBaseSha
      ) {
        return {
          error: "automatic approval authorization changed",
          status: 409,
        };
      }
      const authorization = db
        .prepare(
          `SELECT status FROM fleet_action_authorizations
           WHERE fleet_run_id = ? AND action = 'plan_approval' AND policy_hash = ?`
        )
        .get(id, automationGuard.policyHash) as { status: string } | undefined;
      if (authorization?.status !== "authorized") {
        return {
          error: "automatic plan approval is not authorized",
          status: 409,
        };
      }
    }
    if (!canApprovePlan(run)) {
      return { error: "run is not awaiting plan approval", status: 409 };
    }
    if (!run.plan_hash) {
      return { error: "ingest a plan before approval", status: 400 };
    }
    if (
      !PROVIDER_IDS.includes(run.provider as (typeof PROVIDER_IDS)[number]) ||
      run.provider === "shell"
    ) {
      return {
        error: "select a supported agent provider before approval",
        status: 409,
      };
    }
    if (run.plan_hash !== expectedPlanHash) {
      return { error: "plan hash changed", status: 409 };
    }
    let plannerState = "idle";
    try {
      const settings = payloadObject(JSON.parse(run.settings_json));
      plannerState = String(payloadObject(settings.planner).state ?? "idle");
    } catch {
      return { error: "run settings are invalid", status: 409 };
    }
    if (
      ["starting", "running", "finalizing", "cleanup_pending"].includes(
        plannerState
      )
    ) {
      return {
        error: "planner finalization and cleanup must finish before approval",
        status: 409,
      };
    }

    const tasks = queries.listFleetTasksForRun(db).all(id) as FleetTaskRow[];
    if (tasks.length === 0) return { error: "plan has no tasks", status: 400 };
    const modelContracts = validateFleetModelContractsForApproval(run, tasks);
    if ("error" in modelContracts) return modelContracts;
    const dependencies = db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(id) as FleetTaskDependencyRow[];
    const validation = validateFleetTaskRowsForApproval(tasks, dependencies);
    if ("error" in validation) return { error: validation.error, status: 409 };
    if (validation.hash !== run.plan_hash) {
      return { error: "plan hash changed", status: 409 };
    }

    const blockers = queries
      .countFleetBlockerArtifactsForPlan(db)
      .get(id, run.plan_hash) as { n: number };
    if (blockers.n > 0) {
      return {
        error: "blocker findings must be addressed before approval",
        status: 409,
      };
    }

    const workerCount = queries.countFleetWorkersForRun(db).get(id) as {
      n: number;
    };
    if (workerCount.n > 0) {
      return {
        error: "cannot approve a plan after workers exist",
        status: 409,
      };
    }

    const defaultWorkingDirectory = baseTarget.workingDirectory;
    const defaultBaseBranch = baseTarget.baseBranch;
    if (!isGitRepo(defaultWorkingDirectory)) {
      return {
        error: "working directory must be an accessible Git repository",
        status: 409,
      };
    }
    db.prepare(
      `UPDATE fleet_tasks SET working_directory = COALESCE(working_directory, ?),
       base_branch = COALESCE(base_branch, ?) WHERE fleet_run_id = ?`
    ).run(defaultWorkingDirectory, defaultBaseBranch, id);
    const executionTasks = queries
      .listFleetTasksForRun(db)
      .all(id) as FleetTaskRow[];
    const executionDirectories = new Set<string>();
    for (const task of executionTasks) {
      const provider = task.agent_type ?? run.provider;
      if (
        !PROVIDER_IDS.includes(provider as (typeof PROVIDER_IDS)[number]) ||
        provider === "shell"
      ) {
        return {
          error: `task ${task.id} has an unsupported provider`,
          status: 409,
        };
      }
      if (!task.working_directory || !task.base_branch) {
        return {
          error: `task ${task.id} has an incomplete execution target`,
          status: 409,
        };
      }
      executionDirectories.add(task.working_directory);
    }
    for (const directory of executionDirectories) {
      if (!isGitRepo(directory)) {
        return {
          error: `task working directory is not an accessible Git repository: ${directory}`,
          status: 409,
        };
      }
    }

    const approvedAt = new Date().toISOString();
    const claims = db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(id) as FleetTaskClaimRow[];
    const claimValidation = validateFleetClaimRowsForApproval(
      executionTasks,
      claims
    );
    if ("error" in claimValidation) {
      return { error: claimValidation.error, status: 409 };
    }
    const approvedExecutionHash = hashFleetExecutionContract({
      run,
      tasks: executionTasks,
      claims,
      dependencies,
    });
    if (
      automationGuard &&
      approvedExecutionHash !== automationGuard.executionHash
    ) {
      return {
        error: "automatic approval execution hash changed",
        status: 409,
      };
    }
    const settings = settingsJson(run, {
      phase: "approved_plan",
      approvedPlanHash: run.plan_hash,
      approvedBy,
      approvedAt,
      canSpawnWorkers: true,
      approvedExecutionHash,
    });
    const eventPayload = JSON.stringify({
      planHash: run.plan_hash,
      approvedBy,
      approvedAt,
    });
    const approval = queries
      .approveFleetRunPlan(db)
      .run(
        currentBaseSha,
        approvedBy,
        approvedAt,
        settings,
        approvedAt,
        id,
        expectedPlanHash,
        currentBaseSha
      );
    if (approval.changes === 1) {
      queries.approveFleetTasksForRun(db).run(run.plan_hash, approvedAt, id);
      if (automationGuard) {
        const authorization = db
          .prepare(
            `UPDATE fleet_action_authorizations
             SET status = 'consumed', plan_hash = ?, execution_hash = ?,
                 base_sha = ?, consumed_by = ?, consumed_at = ?,
                 attempt_count = attempt_count + 1, last_error = NULL,
                 updated_at = ?
             WHERE fleet_run_id = ? AND action = 'plan_approval'
               AND policy_hash = ? AND status = 'authorized'`
          )
          .run(
            run.plan_hash,
            approvedExecutionHash,
            automationGuard.baseSha,
            approvedBy,
            approvedAt,
            approvedAt,
            id,
            automationGuard.policyHash
          );
        if (authorization.changes !== 1) {
          throw new Error("automatic plan approval authorization changed");
        }
      }
      queries
        .createFleetEvent(db)
        .run(id, "plan_approved", approvedBy, eventPayload);
      return { ok: true };
    }
    return { error: "run state changed before approval", status: 409 };
  });
  if ("error" in result) {
    return result;
  }

  const detail = getFleetRunDetail(id);
  if (!detail) return { error: "failed to read approved run" };
  return { run: detail };
}

export function attachFleetPlanCriticArtifact(
  id: string,
  input: unknown
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const title = cappedText(payload.title, FLEET_ARTIFACT_TITLE_MAX);
  const body = cappedText(payload.body, FLEET_ARTIFACT_BODY_MAX);
  if (!title) return { error: "title is required" };
  if (!body) return { error: "body is required" };

  const expectedPlanHash = cappedText(payload.expectedPlanHash, 128);
  if (!expectedPlanHash) return { error: "expectedPlanHash is required" };

  const db = getDb();
  const artifactId = randomUUID();
  const actor = actorValue(payload.actor, "critic");
  const severity = severityValue(payload.severity);
  const taskId = cappedText(payload.taskId, 128) || null;
  const eventPayload = JSON.stringify({
    artifactId,
    taskId,
    title,
    severity,
    actor,
  });

  const attached = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (!canApprovePlan(run)) {
      return { error: "run is not awaiting plan findings", status: 409 };
    }
    if (!run.plan_hash) {
      return { error: "ingest a plan before attaching findings", status: 400 };
    }
    if (run.plan_hash !== expectedPlanHash) {
      return { error: "plan hash changed", status: 409 };
    }

    if (taskId) {
      const task = queries.getFleetTaskForRun(db).get(id, taskId) as
        FleetTaskRow | undefined;
      if (!task) return { error: "unknown taskId", status: 400 };
    }

    queries
      .createFleetArtifact(db)
      .run(
        artifactId,
        id,
        taskId,
        run.plan_hash,
        "critic_finding",
        title,
        body,
        severity,
        actor
      );
    queries
      .createFleetEvent(db)
      .run(id, "critic_artifact_attached", actor, eventPayload);
    return { ok: true };
  });
  if ("error" in attached) {
    return attached;
  }

  const detail = getFleetRunDetail(id);
  if (!detail) return { error: "failed to read updated run" };
  return { run: detail };
}

export async function resumeFleetRun(
  id: string,
  input: unknown,
  overrides: {
    db?: Database.Database;
    reconcileRun?: typeof reconcileFleetRun;
  } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const payload = payloadObject(input);
  const actor = actorValue(payload.actor, "operator");
  const conductorSessionId =
    cappedText(payload.conductorSessionId, 128) || null;
  const db = overrides.db ?? getDb();
  const recoveryBlocked = fleetLaunchBlockedResult(db, id);
  if (recoveryBlocked) return recoveryBlocked;
  if (conductorSessionId) {
    const session = queries.getSession(db).get(conductorSessionId);
    if (!session) return { error: "unknown conductorSessionId", status: 400 };
  }
  const changed = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.approval_state !== "approved")
      return { error: "approve the plan before resume", status: 409 };
    if (!FULL_GIT_SHA.test(run.automation_base_sha ?? "")) {
      return {
        error: "approved run has no exact base commit",
        status: 409,
      };
    }
    if (
      !["planned", "paused", "running", "reviewing", "merging"].includes(
        run.status
      )
    ) {
      return {
        error: "run cannot be resumed from its current state",
        status: 409,
      };
    }
    if (run.pause_reason === "budget_exhausted") {
      return {
        error: "budget is exhausted; create a new run",
        status: 409,
      };
    }
    const interruptWorkers = db
      .prepare(
        `SELECT * FROM fleet_workers WHERE fleet_run_id = ?
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(id, FLEET_INTERRUPT_MAX_WORKERS + 1) as FleetWorkerRow[];
    const interruptAuxiliaries = db
      .prepare(
        `SELECT id, fleet_run_id, session_id, owner_type, owner_id,
                terminal_at, reservation_released_at,
                interrupt_requested_at, interrupt_deadline_at,
                interrupt_notice_state, interrupt_stop_state, interrupt_cause
         FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type <> 'worker'
           AND (interrupt_requested_at IS NOT NULL
             OR interrupt_deadline_at IS NOT NULL
             OR interrupt_notice_state <> 'unattempted'
             OR interrupt_stop_state <> 'unattempted'
             OR interrupt_cause IS NOT NULL)
         ORDER BY created_at ASC, id ASC LIMIT ?`
      )
      .all(
        id,
        FLEET_INTERRUPT_MAX_WORKERS + 1
      ) as FleetAuxiliaryInterruptAccountRow[];
    const invalidAuxiliary = interruptAuxiliaries.find(
      (account) =>
        !isFleetAuxiliaryCostOwnerType(account.owner_type) ||
        account.interrupt_requested_at === null ||
        account.interrupt_deadline_at === null ||
        (account.interrupt_cause !== "operator_pause" &&
          account.interrupt_cause !== "budget_hard_limit")
    );
    if (invalidAuxiliary) {
      return {
        error: `cannot resume while interrupt cleanup is unresolved (aux-${invalidAuxiliary.id})`,
        status: 409,
      };
    }
    const resumeDecision = decideFleetResume([
      ...interruptWorkers.map((worker) => ({
        runId: id,
        workerId: worker.id,
        sessionId: worker.session_id,
        workerStatus: worker.status,
        interruptRequestedAt: worker.interrupt_requested_at ?? null,
        interruptDeadlineAt: worker.interrupt_deadline_at ?? null,
        noticeState: worker.interrupt_notice_state ?? "unattempted",
        stopState: worker.interrupt_stop_state ?? "unattempted",
      })),
      ...interruptAuxiliaries.map((account) =>
        auxiliaryInterruptSnapshot(id, account)
      ),
    ]);
    if (!resumeDecision.allowed) {
      const blockers = resumeDecision.blockingWorkerIds.slice(0, 8).join(", ");
      return {
        error: `cannot resume while interrupt cleanup is unresolved${
          blockers ? ` (${blockers})` : ""
        }`,
        status: 409,
      };
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE fleet_runs SET status = 'running', desired_state = 'running', conductor_session_id = ?, pause_mode = NULL, pause_reason = NULL,
      started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`
    ).run(conductorSessionId ?? run.conductor_session_id ?? null, now, now, id);
    queries
      .createFleetEvent(db)
      .run(id, "run_resumed", actor, JSON.stringify({ conductorSessionId }), {
        controlPlane: true,
      });
    return { ok: true };
  });
  if ("error" in changed) return changed;
  if (overrides.reconcileRun) {
    await overrides.reconcileRun(id);
  } else {
    await reconcileFleetRun(id, { db });
  }
  const detail = getFleetRunDetail(id);
  return detail ? { run: detail } : { error: "failed to read resumed run" };
}

export async function pauseFleetRun(
  id: string,
  input: unknown,
  overrides: {
    db?: Database.Database;
    now?: () => Date;
    schedulerReady?: () => boolean;
    reconcileRun?: typeof reconcileFleetRun;
  } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const parsed = parseFleetPauseRequest(input);
  if (!parsed.ok) return { error: parsed.error, status: 400 };
  const payload = payloadObject(input);
  const actor = actorValue(payload.actor, "operator");
  const { mode, graceMs } = parsed.value;
  const db = overrides.db ?? getDb();
  const paused = immediateTransaction<
    | {
        ok: true;
        interruptCount: number;
        workerInterruptCount: number;
        auxiliaryInterruptCount: number;
      }
    | { error: string; status?: number }
  >(db, () => {
    const now = overrides.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (!["running", "reviewing", "merging"].includes(run.status)) {
      return { error: "run is not active", status: 409 };
    }
    if (run.merge_requested_at != null) {
      return {
        error:
          "external landing is already authorized and cannot be paused safely",
        status: 409,
      };
    }
    const workers =
      mode === "pause-and-interrupt"
        ? (db
            .prepare(
              `SELECT * FROM fleet_workers
               WHERE fleet_run_id = ?
                 AND status IN ('running', 'waiting_for_operator')
               ORDER BY created_at ASC, id ASC LIMIT ?`
            )
            .all(id, FLEET_INTERRUPT_MAX_WORKERS + 1) as FleetWorkerRow[])
        : [];
    if (workers.length > FLEET_INTERRUPT_MAX_WORKERS) {
      return {
        error: "too many active workers to pause safely",
        status: 409,
      };
    }
    const auxiliaryAccounts =
      mode === "pause-and-interrupt"
        ? (db
            .prepare(
              `SELECT account.id, account.fleet_run_id, account.session_id,
                      account.owner_type, account.owner_id, account.terminal_at,
                      account.reservation_released_at,
                      account.interrupt_requested_at,
                      account.interrupt_deadline_at,
                      account.interrupt_notice_state,
                      account.interrupt_stop_state, account.interrupt_cause,
                      (SELECT COUNT(*) FROM fleet_cost_accounts bound
                       WHERE bound.session_id = account.session_id
                         AND bound.terminal_at IS NULL
                         AND bound.reservation_released_at IS NULL)
                        AS active_account_owners,
                      (SELECT COUNT(*) FROM fleet_workers bound_worker
                       WHERE bound_worker.session_id = account.session_id
                         AND bound_worker.status IN ('running', 'waiting_for_operator'))
                        AS active_worker_owners
               FROM fleet_cost_accounts account
               WHERE account.fleet_run_id = ? AND account.owner_type <> 'worker'
                 AND account.terminal_at IS NULL
                 AND account.reservation_released_at IS NULL
               ORDER BY account.created_at ASC, account.id ASC LIMIT ?`
            )
            .all(
              id,
              FLEET_INTERRUPT_MAX_WORKERS + 1
            ) as FleetAuxiliaryInterruptAccountRow[])
        : [];
    if (auxiliaryAccounts.length > FLEET_INTERRUPT_MAX_WORKERS) {
      return {
        error: "too many active auxiliary sessions to pause safely",
        status: 409,
      };
    }
    if (
      workers.length + auxiliaryAccounts.length >
      FLEET_INTERRUPT_MAX_WORKERS
    ) {
      return {
        error: "too many active Fleet sessions to pause safely",
        status: 409,
      };
    }
    const invalidAuxiliaryOwner = auxiliaryAccounts.find(
      (account) => !isFleetAuxiliaryCostOwnerType(account.owner_type)
    );
    if (invalidAuxiliaryOwner) {
      return {
        error: `auxiliary account ${invalidAuxiliaryOwner.id} has an invalid owner type`,
        status: 409,
      };
    }
    const ambiguousAuxiliaryOwner = auxiliaryAccounts.find(
      (account) =>
        !account.session_id ||
        account.active_account_owners !== 1 ||
        account.active_worker_owners !== 0
    );
    if (ambiguousAuxiliaryOwner) {
      return {
        error: `auxiliary account ${ambiguousAuxiliaryOwner.id} is not bound to exactly one active session owner`,
        status: 409,
      };
    }
    const interrupts =
      mode === "pause-and-interrupt"
        ? workers.map((worker) => ({
            worker,
            decision: startFleetWorkerInterrupt(
              {
                runId: id,
                workerId: worker.id,
                sessionId: worker.session_id,
                workerStatus: worker.status,
                interruptRequestedAt: worker.interrupt_requested_at ?? null,
                interruptDeadlineAt: worker.interrupt_deadline_at ?? null,
                noticeState: worker.interrupt_notice_state ?? "unattempted",
                stopState: worker.interrupt_stop_state ?? "unattempted",
              },
              now,
              graceMs ?? undefined
            ),
          }))
        : [];
    const auxiliaryInterrupts = auxiliaryAccounts.map((account) => ({
      account,
      decision: startFleetWorkerInterrupt(
        auxiliaryInterruptSnapshot(id, account),
        now,
        graceMs ?? undefined
      ),
    }));
    const invalid = interrupts.find(({ decision }) => !decision.ok);
    if (invalid && !invalid.decision.ok) {
      return {
        error: `worker ${invalid.worker.id} cannot be interrupted safely: ${invalid.decision.error}`,
        status: 409,
      };
    }
    const invalidAuxiliary = auxiliaryInterrupts.find(
      ({ decision }) => !decision.ok
    );
    if (invalidAuxiliary && !invalidAuxiliary.decision.ok) {
      return {
        error: `auxiliary account ${invalidAuxiliary.account.id} cannot be interrupted safely: ${invalidAuxiliary.decision.error}`,
        status: 409,
      };
    }
    const invalidExistingCause = interrupts.find(
      ({ worker, decision }) =>
        decision.ok &&
        decision.request !== null &&
        !decision.request.created &&
        worker.interrupt_cause !== "operator_pause" &&
        worker.interrupt_cause !== "budget_hard_limit"
    );
    if (invalidExistingCause) {
      return {
        error: `worker ${invalidExistingCause.worker.id} has an invalid existing interrupt cause`,
        status: 409,
      };
    }
    const invalidExistingAuxiliaryCause = auxiliaryInterrupts.find(
      ({ account, decision }) =>
        decision.ok &&
        decision.request !== null &&
        !decision.request.created &&
        account.interrupt_cause !== "operator_pause" &&
        account.interrupt_cause !== "budget_hard_limit"
    );
    if (invalidExistingAuxiliaryCause) {
      return {
        error: `auxiliary account ${invalidExistingAuxiliaryCause.account.id} has an invalid existing interrupt cause`,
        status: 409,
      };
    }
    const changed = db
      .prepare(
        `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused', pause_mode = ?, pause_reason = 'operator_pause', updated_at = ?
         WHERE id = ? AND status IN ('running', 'reviewing', 'merging')`
      )
      .run(mode, nowIso, id);
    if (changed.changes !== 1) {
      return { error: "run changed before pause", status: 409 };
    }
    for (const { worker, decision } of interrupts) {
      if (!decision.ok || !decision.request || !decision.request.created) {
        continue;
      }
      const workerChanged = db
        .prepare(
          `UPDATE fleet_workers SET interrupt_requested_at = ?,
           interrupt_deadline_at = ?, interrupt_notice_state = 'unattempted',
           interrupt_stop_state = 'unattempted', interrupt_cause = 'operator_pause'
           WHERE id = ? AND fleet_run_id = ? AND session_id = ?
             AND status IN ('running', 'waiting_for_operator')
             AND interrupt_requested_at IS NULL
             AND interrupt_deadline_at IS NULL`
        )
        .run(
          decision.request.requestedAt,
          decision.request.deadlineAt,
          worker.id,
          id,
          worker.session_id
        );
      if (workerChanged.changes !== 1) {
        throw new Error("worker changed before interrupt was persisted");
      }
    }
    for (const { account, decision } of auxiliaryInterrupts) {
      if (!decision.ok || !decision.request || !decision.request.created) {
        continue;
      }
      const accountChanged = db
        .prepare(
          `UPDATE fleet_cost_accounts
           SET interrupt_requested_at = ?, interrupt_deadline_at = ?,
               interrupt_notice_state = 'unattempted',
               interrupt_stop_state = 'unattempted',
               interrupt_cause = 'operator_pause', updated_at = ?
           WHERE id = ? AND fleet_run_id = ? AND owner_type = ? AND owner_id = ?
             AND session_id = ? AND terminal_at IS NULL
             AND reservation_released_at IS NULL
             AND interrupt_requested_at IS NULL
             AND interrupt_deadline_at IS NULL
             AND 1 = (
               SELECT COUNT(*) FROM fleet_cost_accounts bound
               WHERE bound.session_id = ? AND bound.terminal_at IS NULL
                 AND bound.reservation_released_at IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM fleet_workers bound_worker
               WHERE bound_worker.session_id = ?
                 AND bound_worker.status IN ('running', 'waiting_for_operator')
             )`
        )
        .run(
          decision.request.requestedAt,
          decision.request.deadlineAt,
          nowIso,
          account.id,
          id,
          account.owner_type,
          account.owner_id,
          account.session_id,
          account.session_id,
          account.session_id
        );
      if (accountChanged.changes !== 1) {
        throw new Error(
          "auxiliary account changed before interrupt was persisted"
        );
      }
    }
    const interruptCount = interrupts.length + auxiliaryInterrupts.length;
    queries.createFleetEvent(db).run(
      id,
      "run_paused",
      actor,
      JSON.stringify({
        mode,
        graceMs,
        interruptCount,
        workerInterruptCount: interrupts.length,
        auxiliaryInterruptCount: auxiliaryInterrupts.length,
      }),
      { controlPlane: true }
    );
    return {
      ok: true,
      interruptCount,
      workerInterruptCount: interrupts.length,
      auxiliaryInterruptCount: auxiliaryInterrupts.length,
    };
  });
  if ("error" in paused) return paused;
  if (
    mode === "pause-and-interrupt" &&
    paused.interruptCount > 0 &&
    (overrides.schedulerReady ?? isFleetSchedulerReady)()
  ) {
    // Best-effort immediate notice delivery. The durable pause remains valid if
    // a transient backend failure occurs; the global reconciler retries it.
    await (overrides.reconcileRun ?? reconcileFleetRun)(id).catch(
      () => undefined
    );
  }
  const detail = getFleetRunDetail(id);
  return detail ? { run: detail } : { error: "failed to read paused run" };
}

export async function cancelFleetRun(
  id: string,
  input: unknown,
  overrides: {
    db?: Database.Database;
    stopSession?: typeof stopFleetSession;
  } = {}
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const parsed = parseFleetCancelRequest(id, input);
  if (!parsed.ok) return { error: parsed.error, status: 400 };
  const payload = payloadObject(input);
  const actor = actorValue(payload.actor, "operator");
  const mode = parsed.value.mode;
  const db = overrides.db ?? getDb();
  const stopSession = overrides.stopSession ?? stopFleetSession;
  let destructiveAuthorization: FleetDestructiveConfirmation | null = null;
  let destructiveRevisionAtMutation:
    | ((
        db: Database.Database,
        runId: string,
        action: "cancel" | "cleanup"
      ) => string)
    | null = null;
  if (mode === "cancel-and-clean-owned-worktrees") {
    const current = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!current) return { error: "Fleet run not found", status: 404 };
    const settings = payloadObject(
      (() => {
        try {
          return JSON.parse(current.settings_json);
        } catch {
          return {};
        }
      })()
    );
    const stored = payloadObject(settings.destructiveCancellation);
    const storedDigest = textValue(stored.previewDigest);
    if (storedDigest) {
      if (
        current.status !== "canceled" ||
        current.cancel_mode !== "cancel-and-clean-owned-worktrees" ||
        storedDigest !== parsed.value.previewDigest
      ) {
        return {
          error: "destructive cancellation authorization changed",
          status: 409,
        };
      }
    } else {
      const lifecycle = await import("./lifecycle");
      const confirmed = await lifecycle.confirmFleetDestructiveAction(
        id,
        input,
        { db },
        "cancel"
      );
      if ("error" in confirmed) return confirmed;
      destructiveAuthorization = confirmed;
      destructiveRevisionAtMutation =
        lifecycle.fleetDestructiveDatabaseRevision;
    }
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const changed = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (["completed", "failed"].includes(run.status)) {
      return { error: "run is already terminal", status: 409 };
    }
    if (run.status !== "canceled" && run.merge_requested_at != null) {
      return {
        error:
          "external landing is already authorized and cannot be canceled safely",
        status: 409,
      };
    }
    if (run.status !== "canceled") {
      let plannerState = "idle";
      let settings: Record<string, unknown>;
      try {
        settings = payloadObject(JSON.parse(run.settings_json));
        plannerState = String(payloadObject(settings.planner).state ?? "idle");
      } catch {
        return { error: "run settings are invalid", status: 409 };
      }
      if (
        ["starting", "running", "finalizing", "cleanup_pending"].includes(
          plannerState
        )
      ) {
        return {
          error: "cancel the active planner and finish its cleanup first",
          status: 409,
        };
      }
      if (
        destructiveAuthorization &&
        destructiveRevisionAtMutation &&
        destructiveRevisionAtMutation(db, id, "cancel") !==
          destructiveAuthorization.preview.revision
      ) {
        return {
          error:
            "destructive targets changed; refresh and confirm the new preview",
          status: 409,
        };
      }
      if (destructiveAuthorization) {
        settings.destructiveCancellation = {
          schemaVersion: 1,
          previewDigest: destructiveAuthorization.preview.targetDigest,
          revision: destructiveAuthorization.preview.revision,
          targetSetDigest: destructiveAuthorization.targetSetDigest,
          sessionIds: destructiveAuthorization.sessionIds,
          cleanupTargets: destructiveAuthorization.cleanupTargets,
          integrationTarget: destructiveAuthorization.integrationTarget,
        };
      }
      db.prepare(
        `UPDATE fleet_runs SET status = 'canceled', desired_state = 'canceled',
         cancel_mode = ?, recovery_required = 0, settings_json = ?,
         ended_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(mode, JSON.stringify(settings), nowIso, nowIso, id);
      queries
        .createFleetEvent(db)
        .run(id, "run_canceled", actor, JSON.stringify({ mode }), {
          controlPlane: true,
        });
      if (destructiveAuthorization) {
        queries.createFleetEvent(db).run(
          id,
          "destructive_cancel_authorized",
          actor,
          JSON.stringify({
            previewDigest: destructiveAuthorization.preview.targetDigest,
            targetSetDigest: destructiveAuthorization.targetSetDigest,
            targetCount:
              destructiveAuthorization.cleanupTargets.length +
              (destructiveAuthorization.integrationTarget ? 2 : 0),
          }),
          { controlPlane: true }
        );
      }
    }
    db.prepare(
      `UPDATE fleet_tasks SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
       active_fix_id = NULL, fixer_session_id = NULL,
       ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE fleet_run_id = ?
         AND status NOT IN ('completed', 'merged', 'skipped', 'failed', 'canceled')`
    ).run(nowIso, nowIso, id);
    db.prepare(
      `UPDATE fleet_workers SET status = 'cleanup_pending', terminal_cause = 'operator_cancel_pending',
       lease_owner = NULL, lease_expires_at = NULL, ended_at = COALESCE(ended_at, ?)
       WHERE fleet_run_id = ?
         AND status IN ('leasing', 'spawning', 'running',
                        'waiting_for_operator', 'cleanup_pending')`
    ).run(nowIso, id);
    db.prepare(
      `UPDATE fleet_reviews SET state = 'cleanup_pending',
       result_verdict = COALESCE(result_verdict, 'changes_requested'),
       error = COALESCE(error, 'fleet run canceled by operator'), updated_at = ?
       WHERE fleet_run_id = ? AND subject_type = 'plan'
         AND state IN ('pending', 'spawning', 'running', 'cleanup_pending')`
    ).run(nowIso, id);
    db.prepare(
      `UPDATE fleet_task_reviews SET state = 'cleanup_pending',
       result_verdict = COALESCE(result_verdict, 'changes_requested'),
       error = COALESCE(error, 'fleet run canceled by operator'), updated_at = ?
       WHERE fleet_run_id = ?
         AND state IN ('pending', 'spawning', 'running', 'cleanup_pending')`
    ).run(nowIso, id);
    db.prepare(
      `UPDATE fleet_task_fixes SET state = 'cleanup_pending',
       error = COALESCE(error, 'fleet run canceled by operator'), updated_at = ?
       WHERE fleet_run_id = ?
         AND state IN ('pending', 'spawning', 'running', 'cleanup_pending')`
    ).run(nowIso, id);
    return { ok: true };
  });
  if ("error" in changed) return changed;

  const sessionIds = new Set<string>();
  const workerSessions = db
    .prepare(
      `SELECT session_id FROM fleet_workers
       WHERE fleet_run_id = ? AND session_id IS NOT NULL
         AND (status = 'cleanup_pending' OR cost_reconciled_at IS NULL)`
    )
    .all(id) as { session_id: string }[];
  workerSessions.forEach((row) => sessionIds.add(row.session_id));
  const ownerSessions = db
    .prepare(
      `SELECT session_id FROM fleet_cost_accounts
       WHERE fleet_run_id = ? AND terminal_at IS NULL AND session_id IS NOT NULL`
    )
    .all(id) as { session_id: string }[];
  ownerSessions.forEach((row) => sessionIds.add(row.session_id));
  for (const table of [
    ["fleet_reviews", "reviewer_session_id"],
    ["fleet_task_reviews", "reviewer_session_id"],
    ["fleet_task_fixes", "fixer_session_id"],
  ] as const) {
    const rows = db
      .prepare(
        `SELECT ${table[1]} AS session_id FROM ${table[0]}
         WHERE fleet_run_id = ? AND state = 'cleanup_pending'
           AND ${table[1]} IS NOT NULL AND ${table[1]} <> ''`
      )
      .all(id) as { session_id: string }[];
    rows.forEach((row) => sessionIds.add(row.session_id));
  }
  const stoppedSessions = new Map<string, boolean>();
  await Promise.all(
    [...sessionIds].map(async (sessionId) => {
      const stopped = await stopSession(sessionId, "failed").catch(() => false);
      stoppedSessions.set(sessionId, stopped);
    })
  );

  const completedAt = new Date();
  const completedAtIso = completedAt.toISOString();
  type NonWorkerCostOwner = Exclude<FleetCostOwnerType, "worker">;
  const pending = immediateTransaction(db, () => {
    const ownerAccount = (ownerType: string, ownerId: string) =>
      db
        .prepare(
          `SELECT session_id, session_key, terminal_at, reservation_released_at
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_type = ? AND owner_id = ?`
        )
        .get(id, ownerType, ownerId) as
        | {
            session_id: string | null;
            session_key: string;
            terminal_at: string | null;
            reservation_released_at: string | null;
          }
        | undefined;
    const finalizeOwner = (
      ownerType: NonWorkerCostOwner,
      ownerId: string,
      recordedSessionId: string | null
    ): boolean => {
      if (!ownerId) return !recordedSessionId;
      const account = ownerAccount(ownerType, ownerId);
      const sessions = new Set(
        [recordedSessionId, account?.session_id ?? null].filter(
          (value): value is string => Boolean(value)
        )
      );
      if ([...sessions].some((sessionId) => !stoppedSessions.get(sessionId))) {
        return false;
      }
      if (account && !account.terminal_at) {
        if (sessions.size > 0) {
          settleFleetCostOwner(db, {
            runId: id,
            ownerType,
            ownerId,
            now: completedAt,
          });
        } else if (account.session_key.startsWith("pending:")) {
          releaseFleetCostOwnerReservation(db, {
            runId: id,
            ownerType,
            ownerId,
            now: completedAt,
          });
        } else {
          return false;
        }
      }
      releaseFleetRuntimeResources(db, {
        ownerType,
        ownerId,
        now: completedAt,
        preserveResourceTypes: ["repo_worktree", "disk_bytes"],
      });
      return true;
    };

    const workers = db
      .prepare(
        `SELECT * FROM fleet_workers
         WHERE fleet_run_id = ?
           AND (status = 'cleanup_pending' OR cost_reconciled_at IS NULL)`
      )
      .all(id) as FleetWorkerRow[];
    for (const worker of workers) {
      const account = ownerAccount("worker", worker.id);
      const sessions = new Set(
        [worker.session_id, account?.session_id ?? null].filter(
          (value): value is string => Boolean(value)
        )
      );
      if ([...sessions].some((sessionId) => !stoppedSessions.get(sessionId))) {
        continue;
      }
      finalizeFleetWorkerCost(
        db,
        worker,
        completedAt,
        sessions.size > 0 || Boolean(worker.worktree_path)
      );
      if (worker.status === "cleanup_pending") {
        db.prepare(
          `UPDATE fleet_workers SET status = 'cleanup_complete',
           terminal_cause = 'operator_cancel', ended_at = COALESCE(ended_at, ?)
           WHERE id = ? AND status = 'cleanup_pending'`
        ).run(completedAtIso, worker.id);
      }
      db.prepare(
        `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
         WHERE worker_id = ? AND status = 'reserved'
           AND resource_type <> 'worktree'`
      ).run(completedAtIso, worker.id);
      releaseFleetRuntimeResources(db, {
        ownerType: "worker",
        ownerId: worker.id,
        now: completedAt,
        preserveResourceTypes: ["repo_worktree", "disk_bytes"],
      });
    }

    const planReviews = db
      .prepare(
        `SELECT id, request_id, reviewer_session_id FROM fleet_reviews
         WHERE fleet_run_id = ? AND subject_type = 'plan'
           AND state = 'cleanup_pending'`
      )
      .all(id) as Array<{
      id: string;
      request_id: string;
      reviewer_session_id: string;
    }>;
    for (const row of planReviews) {
      if (
        !finalizeOwner(
          "plan_review",
          row.request_id,
          row.reviewer_session_id || null
        )
      )
        continue;
      db.prepare(
        `UPDATE fleet_reviews SET state = 'changes_requested',
         verdict = 'changes_requested', result_verdict = 'changes_requested',
         completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`
      ).run(completedAtIso, completedAtIso, row.id);
    }

    const taskReviews = db
      .prepare(
        `SELECT id, request_id, reviewer_session_id FROM fleet_task_reviews
         WHERE fleet_run_id = ? AND state = 'cleanup_pending'`
      )
      .all(id) as Array<{
      id: string;
      request_id: string;
      reviewer_session_id: string;
    }>;
    for (const row of taskReviews) {
      if (
        !finalizeOwner(
          "task_review",
          row.request_id,
          row.reviewer_session_id || null
        )
      )
        continue;
      db.prepare(
        `UPDATE fleet_task_reviews SET state = 'changes_requested',
         verdict = 'changes_requested', result_verdict = 'changes_requested',
         completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`
      ).run(completedAtIso, completedAtIso, row.id);
    }

    const fixes = db
      .prepare(
        `SELECT id, request_id, fixer_session_id FROM fleet_task_fixes
         WHERE fleet_run_id = ? AND state = 'cleanup_pending'`
      )
      .all(id) as Array<{
      id: string;
      request_id: string;
      fixer_session_id: string;
    }>;
    for (const row of fixes) {
      if (!finalizeOwner("fixer", row.request_id, row.fixer_session_id || null))
        continue;
      db.prepare(
        `UPDATE fleet_task_fixes SET state = 'failed',
         completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ?`
      ).run(completedAtIso, completedAtIso, row.id);
    }

    const orphanAccounts = db
      .prepare(
        `SELECT owner_type, owner_id, session_id FROM fleet_cost_accounts
         WHERE fleet_run_id = ? AND owner_type <> 'worker' AND terminal_at IS NULL`
      )
      .all(id) as Array<{
      owner_type: NonWorkerCostOwner;
      owner_id: string;
      session_id: string | null;
    }>;
    for (const account of orphanAccounts) {
      if (
        ![
          "planner",
          "plan_review",
          "task_review",
          "fixer",
          "supervisor",
        ].includes(account.owner_type)
      ) {
        continue;
      }
      finalizeOwner(account.owner_type, account.owner_id, account.session_id);
    }

    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM fleet_workers
             WHERE fleet_run_id = ? AND status = 'cleanup_pending') +
           (SELECT COUNT(*) FROM fleet_reviews
             WHERE fleet_run_id = ? AND state = 'cleanup_pending') +
           (SELECT COUNT(*) FROM fleet_task_reviews
             WHERE fleet_run_id = ? AND state = 'cleanup_pending') +
           (SELECT COUNT(*) FROM fleet_task_fixes
             WHERE fleet_run_id = ? AND state = 'cleanup_pending') +
           (SELECT COUNT(*) FROM fleet_cost_accounts
             WHERE fleet_run_id = ? AND terminal_at IS NULL) AS n`
      )
      .get(id, id, id, id, id) as { n: number };
    const ledger = db
      .prepare(
        `SELECT reserved_budget_usd, reserved_budget_tokens
         FROM fleet_runs WHERE id = ?`
      )
      .get(id) as {
      reserved_budget_usd: number;
      reserved_budget_tokens: number;
    };
    const pendingCount =
      counts.n +
      (ledger.reserved_budget_usd > 1e-9 || ledger.reserved_budget_tokens > 0
        ? 1
        : 0);
    if (pendingCount > 0) {
      queries
        .createFleetEvent(db)
        .run(
          id,
          "cancel_cleanup_pending",
          "scheduler",
          JSON.stringify({ pendingCount }),
          { controlPlane: true }
        );
    }
    return pendingCount;
  });
  if (pending > 0) {
    return {
      error: "fleet cancellation cleanup remains pending",
      status: 409,
    };
  }
  const detail = fleetRunDetailFromDb(db, id);
  return detail ? { run: detail } : { error: "failed to read canceled run" };
}

/** Retry crash-safe cleanup for canceled runs without requiring another POST. */
export async function reconcileFleetCancellationCleanup(
  overrides: {
    db?: Database.Database;
    stopSession?: typeof stopFleetSession;
    maxRuns?: number;
  } = {}
): Promise<number> {
  const db = overrides.db ?? getDb();
  const maxRuns =
    Number.isSafeInteger(overrides.maxRuns) && Number(overrides.maxRuns) > 0
      ? Math.min(Number(overrides.maxRuns), 16)
      : 8;
  const runs = db
    .prepare(
      `SELECT id, cancel_mode, settings_json FROM fleet_runs r
       WHERE r.status = 'canceled' AND (
         r.reserved_budget_usd > 0.000000001 OR
         r.reserved_budget_tokens > 0 OR
         EXISTS (SELECT 1 FROM fleet_workers w
           WHERE w.fleet_run_id = r.id AND w.status = 'cleanup_pending') OR
         EXISTS (SELECT 1 FROM fleet_reviews v
           WHERE v.fleet_run_id = r.id AND v.state = 'cleanup_pending') OR
         EXISTS (SELECT 1 FROM fleet_task_reviews tr
           WHERE tr.fleet_run_id = r.id AND tr.state = 'cleanup_pending') OR
         EXISTS (SELECT 1 FROM fleet_task_fixes f
           WHERE f.fleet_run_id = r.id AND f.state = 'cleanup_pending') OR
         EXISTS (SELECT 1 FROM fleet_cost_accounts c
           WHERE c.fleet_run_id = r.id AND c.terminal_at IS NULL)
       )
       ORDER BY COALESCE(r.ended_at, r.updated_at), r.id LIMIT ?`
    )
    .all(maxRuns) as Array<{
    id: string;
    cancel_mode: string | null;
    settings_json: string;
  }>;
  let completed = 0;
  for (const run of runs) {
    const destructive = run.cancel_mode === "cancel-and-clean-owned-worktrees";
    let previewDigest = "";
    if (destructive) {
      try {
        previewDigest = textValue(
          payloadObject(
            payloadObject(JSON.parse(run.settings_json)).destructiveCancellation
          ).previewDigest
        );
      } catch {
        previewDigest = "";
      }
      if (!/^[0-9a-f]{64}$/.test(previewDigest)) continue;
    }
    const result = await cancelFleetRun(
      run.id,
      {
        mode: destructive
          ? "cancel-and-clean-owned-worktrees"
          : "cancel-preserve-worktrees",
        ...(destructive
          ? {
              confirm: true,
              confirmation: run.id,
              previewDigest,
            }
          : {}),
        actor: "cancel-recovery",
      },
      { db, stopSession: overrides.stopSession }
    );
    if (!("error" in result)) {
      completed += 1;
      continue;
    }
    if (result.status !== 409) {
      throw new Error(`Fleet cancellation recovery failed: ${result.error}`);
    }
  }
  return completed;
}

export async function tickFleetRun(
  id: string
): Promise<
  | { run: FleetRunDetailDto; launched: number }
  | { error: string; status?: number }
> {
  const db = getDb();
  const recoveryBlocked = fleetLaunchBlockedResult(db, id);
  if (recoveryBlocked) return recoveryBlocked;
  const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  if (!["running", "reviewing", "merging"].includes(run.status))
    return { error: "run is not active", status: 409 };
  const launched = await reconcileFleetRun(id);
  const detail = getFleetRunDetail(id);
  return detail
    ? { run: detail, launched }
    : { error: "failed to read ticked run" };
}

export async function completeFleetWorker(
  runId: string,
  workerId: string,
  input: unknown
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const actor = actorValue(payloadObject(input).actor, "operator");
  const db = getDb();
  if (isFleetSchedulerReady()) {
    await reconcileFleetWorkerReport(runId, workerId);
  }
  const worker = db
    .prepare(`SELECT * FROM fleet_workers WHERE id = ? AND fleet_run_id = ?`)
    .get(workerId, runId) as FleetWorkerRow | undefined;
  if (!worker) return { error: "Fleet worker not found", status: 404 };
  if (
    !["running", "waiting_for_operator"].includes(worker.status) &&
    (worker.report_state === "accepted" || worker.report_state === "invalid")
  ) {
    const collected = getFleetRunDetail(runId);
    return collected
      ? { run: collected }
      : { error: "failed to read collected fleet report" };
  }
  if (!worker.session_id) {
    return { error: "worker has no linked session", status: 409 };
  }
  if (!["running", "waiting_for_operator"].includes(worker.status)) {
    return { error: "worker is not active", status: 409 };
  }

  const claimed = immediateTransaction<boolean>(db, () => {
    const update = db
      .prepare(
        `UPDATE fleet_workers SET status = 'cleanup_pending',
         terminal_cause = 'operator_completion_pending', ended_at = NULL
         WHERE id = ? AND fleet_run_id = ? AND status IN ('running', 'waiting_for_operator')`
      )
      .run(workerId, runId);
    if (update.changes !== 1) return false;
    queries
      .createFleetEvent(db)
      .run(
        runId,
        "worker_completion_requested",
        actor,
        JSON.stringify({ workerId, sessionId: worker.session_id })
      );
    return true;
  });
  if (!claimed) return { error: "worker state changed", status: 409 };

  let stopped = false;
  try {
    stopped = await stopFleetSession(worker.session_id, "completed");
  } catch {
    stopped = false;
  }
  const now = new Date().toISOString();
  const outcome = immediateTransaction<"completed" | "pending" | "changed">(
    db,
    () => {
      const current = db
        .prepare(`SELECT status FROM fleet_workers WHERE id = ?`)
        .get(workerId) as { status: string } | undefined;
      if (current?.status === "completed") return "completed";
      if (current?.status !== "cleanup_pending") return "changed";
      if (!stopped) {
        const update = db
          .prepare(
            `UPDATE fleet_workers SET terminal_cause = 'operator_completion_stop_failed'
             WHERE id = ? AND status = 'cleanup_pending'
               AND terminal_cause = 'operator_completion_pending'`
          )
          .run(workerId);
        if (update.changes === 1) {
          queries
            .createFleetEvent(db)
            .run(
              runId,
              "worker_completion_cleanup_pending",
              actor,
              JSON.stringify({ workerId, sessionId: worker.session_id })
            );
        }
        return "pending";
      }
      const update = db
        .prepare(
          `UPDATE fleet_workers SET status = 'completed', terminal_cause = 'operator_completed', ended_at = ?,
         lease_owner = NULL, lease_expires_at = NULL
           WHERE id = ? AND fleet_run_id = ? AND status = 'cleanup_pending'
             AND terminal_cause LIKE 'operator_completion%'`
        )
        .run(now, workerId, runId);
      if (update.changes !== 1) return "changed";
      db.prepare(
        `UPDATE fleet_tasks SET status = 'needs_inspection', failure_code = NULL, ended_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running', 'waiting_for_operator')`
      ).run(now, now, worker.task_id);
      finalizeFleetWorkerCost(db, worker, new Date(now), true);
      db.prepare(
        `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
       WHERE worker_id = ? AND status = 'reserved'
           AND resource_type <> 'worktree'`
      ).run(now, workerId);
      releaseFleetRuntimeResources(db, {
        ownerType: "worker",
        ownerId: workerId,
        now: new Date(now),
        preserveResourceTypes: ["repo_worktree", "disk_bytes"],
      });
      db.prepare(
        `UPDATE sessions SET worker_status = 'completed', updated_at = ? WHERE id = ?`
      ).run(now, worker.session_id);
      queries
        .createFleetEvent(db)
        .run(
          runId,
          "worker_completed_by_operator",
          actor,
          JSON.stringify({ workerId, sessionId: worker.session_id })
        );
      return "completed";
    }
  );
  if (outcome === "changed") {
    return { error: "worker state changed", status: 409 };
  }
  const detail = getFleetRunDetail(runId);
  if (!detail) return { error: "failed to read fleet run" };
  return outcome === "completed"
    ? { run: detail }
    : {
        error: "worker did not stop; cleanup remains pending",
        status: 409,
      };
}
