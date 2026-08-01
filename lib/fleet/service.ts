import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import { getDefaultBranch, isGitRepo } from "@/lib/git-status";
import { PROVIDER_IDS } from "@/lib/providers/registry";
import {
  composeFleetRunDetail,
  normalizeFleetRunDraft,
  toFleetRunDto,
} from "./engine";
import {
  hashParsedFleetPlanTasks,
  hashFleetExecutionContract,
  validateFleetTaskRowsForApproval,
} from "./hash";
import { parseFleetPlanText, type ParsedFleetPlanTask } from "./plan";
import { normalizeFleetClaims, UNKNOWN_FLEET_CLAIM } from "./conflicts";
import {
  isFleetSchedulerReady,
  reconcileFleetRun,
  recoverFleetRun,
} from "./scheduler";
import { stopFleetSession } from "./stop";
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
} from "./types";

interface FleetRunListRow extends FleetRunRow {
  task_count: number;
  worker_count: number;
}

const FLEET_RUN_LIST_LIMIT = 100;
const FLEET_ARTIFACT_LIST_LIMIT = 100;
const FLEET_ACTOR_MAX = 80;
const FLEET_ARTIFACT_TITLE_MAX = 160;
const FLEET_ARTIFACT_BODY_MAX = 8000;

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
  return textValue(value).trim().slice(0, max);
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
    })
  );
}

export function getFleetRunDetail(id: string): FleetRunDetailDto | null {
  const db = getDb();
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
  const events = queries
    .listFleetEventsForRun(db)
    .all(id, 50) as FleetEventRow[];
  return composeFleetRunDetail({
    run,
    tasks,
    dependencies,
    workers,
    artifacts,
    events,
  });
}

export function createDraftFleetRun(
  input: unknown
): { run: FleetRunDetailDto } | { error: string } {
  const normalized = normalizeFleetRunDraft(input);
  if ("error" in normalized) return normalized;
  const draft = normalized.draft;
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

  const runId = randomUUID();
  const rootTaskId = randomUUID();
  const settingsJson = JSON.stringify({
    phase: "draft",
    canSpawnWorkers: false,
  });
  const eventPayload = JSON.stringify({
    name: draft.name,
    repoId: draft.repoId,
    projectId: draft.projectId,
    maxConcurrency: draft.maxConcurrency,
    reviewPolicy: draft.reviewPolicy,
  });

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
      .run(runId, "draft_created", "operator", eventPayload);
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
  parsed: FleetPlanReplacement,
  actor: string
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const db = getDb();
  const taskIds = parsed.tasks.map(() => randomUUID());
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
         verify_command = ? WHERE id = ? AND fleet_run_id = ?`
      ).run(
        task.agentType,
        task.model,
        task.acceptanceCriteria,
        task.verifyCommand,
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
  const parsed = parseFleetPlanText(payload.planText);
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

export function approveFleetRunPlan(
  id: string,
  input: unknown
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const expectedPlanHash = cappedText(payload.expectedPlanHash, 128);
  if (!expectedPlanHash) return { error: "expectedPlanHash is required" };

  const db = getDb();
  const approvedBy = actorValue(payload.approvedBy, "operator");
  const result = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
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

    let defaultWorkingDirectory: string | null = null;
    let defaultBaseBranch = "main";
    if (run.repo_id) {
      const repo = queries.getDispatchRepo(db).get(run.repo_id) as
        DispatchRepo | undefined;
      defaultWorkingDirectory = repo?.repo_path ?? null;
      defaultBaseBranch = repo?.base_branch ?? "main";
    } else if (run.project_id) {
      const project = queries.getProject(db).get(run.project_id) as
        Project | undefined;
      defaultWorkingDirectory = project?.working_directory ?? null;
      if (defaultWorkingDirectory) {
        defaultBaseBranch = getDefaultBranch(defaultWorkingDirectory);
      }
    }
    if (!defaultWorkingDirectory) {
      return {
        error:
          "an executable fleet plan requires a repository or project working directory",
        status: 409,
      };
    }
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
      .run(approvedBy, approvedAt, settings, approvedAt, id, expectedPlanHash);
    if (approval.changes === 1) {
      queries.approveFleetTasksForRun(db).run(run.plan_hash, approvedAt, id);
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
  input: unknown
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const payload = payloadObject(input);
  if (!isFleetSchedulerReady()) {
    return { error: "fleet scheduler recovery is not ready", status: 503 };
  }
  const actor = actorValue(payload.actor, "operator");
  const conductorSessionId =
    cappedText(payload.conductorSessionId, 128) || null;
  const db = getDb();
  if (conductorSessionId) {
    const session = queries.getSession(db).get(conductorSessionId);
    if (!session) return { error: "unknown conductorSessionId", status: 400 };
  }
  const changed = immediateTransaction<
    { ok: true; needsRecovery: boolean } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (run.approval_state !== "approved")
      return { error: "approve the plan before resume", status: 409 };
    if (!["planned", "paused", "running"].includes(run.status)) {
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
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE fleet_runs SET status = 'running', conductor_session_id = ?, pause_mode = NULL, pause_reason = NULL,
      started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`
    ).run(conductorSessionId ?? run.conductor_session_id ?? null, now, now, id);
    queries
      .createFleetEvent(db)
      .run(id, "run_resumed", actor, JSON.stringify({ conductorSessionId }));
    return { ok: true, needsRecovery: run.recovery_required === 1 };
  });
  if ("error" in changed) return changed;
  if (changed.needsRecovery) {
    await recoverFleetRun(id);
    const recovered = queries.getFleetRun(db).get(id) as FleetRunRow;
    if (recovered.recovery_required === 1 || recovered.status !== "running") {
      return {
        error:
          "recovery still has an unresolved worker; inspect cleanup state or retry after the lease expires",
        status: 409,
      };
    }
  }
  await reconcileFleetRun(id);
  const detail = getFleetRunDetail(id);
  return detail ? { run: detail } : { error: "failed to read resumed run" };
}

export function pauseFleetRun(
  id: string,
  input: unknown
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const actor = actorValue(payload.actor, "operator");
  const mode =
    payload.mode === "pause-and-interrupt" ? payload.mode : "pause-new";
  if (mode !== "pause-new") {
    return {
      error: "pause-and-interrupt is not available yet; use pause-new",
      status: 409,
    };
  }
  const db = getDb();
  const paused = immediateTransaction<boolean>(db, () => {
    const changed = db
      .prepare(
        `UPDATE fleet_runs SET status = 'paused', pause_mode = ?, pause_reason = 'operator_pause', updated_at = ? WHERE id = ? AND status = 'running'`
      )
      .run(mode, new Date().toISOString(), id);
    if (changed.changes !== 1) return false;
    queries
      .createFleetEvent(db)
      .run(id, "run_paused", actor, JSON.stringify({ mode }));
    return true;
  });
  if (!paused) {
    const run = queries.getFleetRun(db).get(id);
    return run
      ? { error: "run is not running", status: 409 }
      : { error: "Fleet run not found", status: 404 };
  }
  const detail = getFleetRunDetail(id);
  return detail ? { run: detail } : { error: "failed to read paused run" };
}

export async function cancelFleetRun(
  id: string,
  input: unknown
): Promise<{ run: FleetRunDetailDto } | { error: string; status?: number }> {
  const payload = payloadObject(input);
  const actor = actorValue(payload.actor, "operator");
  const mode =
    payload.mode === "cancel-and-clean-owned-worktrees"
      ? payload.mode
      : "cancel-preserve-worktrees";
  if (mode !== "cancel-preserve-worktrees") {
    return {
      error: "destructive fleet cleanup is not available yet",
      status: 409,
    };
  }
  const db = getDb();
  const now = new Date().toISOString();
  const changed = immediateTransaction<
    { ok: true } | { error: string; status?: number }
  >(db, () => {
    const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
    if (!run) return { error: "Fleet run not found", status: 404 };
    if (["completed", "failed", "canceled"].includes(run.status)) {
      return { error: "run is already terminal", status: 409 };
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
        error: "cancel the active planner and finish its cleanup first",
        status: 409,
      };
    }
    db.prepare(
      `UPDATE fleet_runs SET status = 'canceled', cancel_mode = ?, recovery_required = 0,
      spent_budget_usd = spent_budget_usd + reserved_budget_usd,
      reserved_budget_usd = 0, ended_at = ?, updated_at = ? WHERE id = ?`
    ).run(mode, now, now, id);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'canceled', lease_owner = NULL, lease_expires_at = NULL,
      ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE fleet_run_id = ? AND status NOT IN ('completed', 'merged', 'skipped', 'failed', 'canceled')`
    ).run(now, now, id);
    db.prepare(
      `UPDATE fleet_workers SET status = 'cleanup_pending', terminal_cause = 'operator_cancel_pending',
      lease_owner = NULL, lease_expires_at = NULL, ended_at = COALESCE(ended_at, ?)
      WHERE fleet_run_id = ? AND status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ).run(now, id);
    queries
      .createFleetEvent(db)
      .run(id, "run_canceled", actor, JSON.stringify({ mode }));
    return { ok: true };
  });
  if ("error" in changed) return changed;
  const sessions = db
    .prepare(
      `SELECT id AS worker_id, session_id FROM fleet_workers
       WHERE fleet_run_id = ? AND session_id IS NOT NULL AND status = 'cleanup_pending'`
    )
    .all(id) as { worker_id: string; session_id: string }[];
  const stopped = await Promise.all(
    sessions.map(async (session) => ({
      ...session,
      stopped: await stopFleetSession(session.session_id),
    }))
  );
  immediateTransaction(db, () => {
    for (const worker of stopped) {
      if (!worker.stopped) continue;
      db.prepare(
        `UPDATE fleet_workers SET status = 'cleanup_complete', terminal_cause = 'operator_cancel', ended_at = ?
         WHERE id = ? AND status = 'cleanup_pending'`
      ).run(now, worker.worker_id);
      db.prepare(
        `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
         WHERE worker_id = ? AND status = 'reserved'`
      ).run(now, worker.worker_id);
    }
    const pending = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_workers WHERE fleet_run_id = ? AND status = 'cleanup_pending'`
      )
      .get(id) as { n: number };
    if (pending.n > 0) {
      queries
        .createFleetEvent(db)
        .run(
          id,
          "cancel_cleanup_pending",
          "scheduler",
          JSON.stringify({ workerCount: pending.n })
        );
    }
  });
  const detail = getFleetRunDetail(id);
  return detail ? { run: detail } : { error: "failed to read canceled run" };
}

export async function tickFleetRun(
  id: string
): Promise<
  | { run: FleetRunDetailDto; launched: number }
  | { error: string; status?: number }
> {
  const db = getDb();
  if (!isFleetSchedulerReady()) {
    return { error: "fleet scheduler recovery is not ready", status: 503 };
  }
  const run = queries.getFleetRun(db).get(id) as FleetRunRow | undefined;
  if (!run) return { error: "Fleet run not found", status: 404 };
  if (run.status !== "running")
    return { error: "run is not running", status: 409 };
  if (run.recovery_required === 1) await recoverFleetRun(id);
  const refreshed = queries.getFleetRun(db).get(id) as FleetRunRow;
  if (refreshed.recovery_required === 1 || refreshed.status !== "running") {
    return { error: "run recovery requires operator attention", status: 409 };
  }
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
  const worker = db
    .prepare(`SELECT * FROM fleet_workers WHERE id = ? AND fleet_run_id = ?`)
    .get(workerId, runId) as FleetWorkerRow | undefined;
  if (!worker) return { error: "Fleet worker not found", status: 404 };
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
      db.prepare(
        `UPDATE fleet_runs SET reserved_budget_usd = MAX(0, reserved_budget_usd - ?),
       spent_budget_usd = spent_budget_usd + ?, updated_at = ? WHERE id = ?`
      ).run(
        worker.reservation_usd ?? 0,
        worker.reservation_usd ?? 0,
        now,
        runId
      );
      db.prepare(
        `UPDATE fleet_resource_leases SET status = 'released', released_at = ?
       WHERE worker_id = ? AND status = 'reserved'
           AND resource_type <> 'worktree'`
      ).run(now, workerId);
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
