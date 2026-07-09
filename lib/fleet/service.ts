import { randomUUID } from "crypto";
import { getDb, queries } from "@/lib/db";
import type { DispatchRepo } from "@/lib/dispatch/types";
import type { Project } from "@/lib/db/types";
import {
  composeFleetRunDetail,
  normalizeFleetRunDraft,
  toFleetRunDto,
} from "./engine";
import type {
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
  const events = queries
    .listFleetEventsForRun(db)
    .all(id, 50) as FleetEventRow[];
  return composeFleetRunDetail({ run, tasks, workers, events });
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
