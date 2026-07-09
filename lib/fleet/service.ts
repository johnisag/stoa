import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import {
  composeFleetRunDetail,
  normalizeFleetRunDraft,
  toFleetRunDto,
} from "./engine";
import {
  hashParsedFleetPlanTasks,
  validateFleetTaskRowsForApproval,
} from "./hash";
import { parseFleetPlanText } from "./plan";
import type {
  FleetArtifactRow,
  FleetArtifactSeverity,
  FleetEventRow,
  FleetRunDetailDto,
  FleetRunDto,
  FleetRunRow,
  FleetTaskRow,
  FleetWorkerRow,
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
    canSpawnWorkers: false,
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
  const workers = queries
    .listFleetWorkersForRun(db)
    .all(id) as FleetWorkerRow[];
  const artifacts = queries
    .listFleetArtifactsForRun(db)
    .all(id, FLEET_ARTIFACT_LIST_LIMIT) as FleetArtifactRow[];
  const events = queries
    .listFleetEventsForRun(db)
    .all(id, 50) as FleetEventRow[];
  return composeFleetRunDetail({ run, tasks, workers, artifacts, events });
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

export function ingestFleetRunPlan(
  id: string,
  input: unknown
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = payloadObject(input);
  const parsed = parseFleetPlanText(payload.planText);
  if ("error" in parsed) return parsed;

  const db = getDb();
  const actor = actorValue(payload.actor, "operator");
  const taskIds = parsed.tasks.map(() => randomUUID());
  const planHash = hashParsedFleetPlanTasks(parsed.tasks);
  const eventPayload = JSON.stringify({
    taskCount: parsed.tasks.length,
    planHash,
    actor,
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
    });
    const state = queries
      .updateFleetRunPlanState(db)
      .run(planHash, settings, id);
    if (state.changes !== 1) {
      return { error: "run state changed before plan ingestion", status: 409 };
    }
    queries.clearFleetArtifactTaskLinksForRun(db).run(id);
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
    if (run.plan_hash !== expectedPlanHash) {
      return { error: "plan hash changed", status: 409 };
    }

    const tasks = queries.listFleetTasksForRun(db).all(id) as FleetTaskRow[];
    if (tasks.length === 0) return { error: "plan has no tasks", status: 400 };
    const validation = validateFleetTaskRowsForApproval(tasks);
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

    const approvedAt = new Date().toISOString();
    const settings = settingsJson(run, {
      phase: "approved_plan",
      approvedPlanHash: run.plan_hash,
      approvedBy,
      approvedAt,
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
