import { resolve } from "path";
import type Database from "better-sqlite3";
import { getDb, queries } from "../db";
import type { Project } from "../db/types";
import type { DispatchRepo, IssueDispatch } from "../dispatch/types";
import { expandHome, isWindows } from "../platform";
import type { CreateFleetRunInput, FleetRunDetailDto } from "./types";
import { adaptFleetSource, type FleetSourceDraftPlanInput } from "./sources";
import { fleetSourceDraftToPlan } from "./source-plan";
import {
  createDraftFleetRun,
  getFleetRunDetail,
  ingestGeneratedFleetRunPlan,
} from "./service";

type FleetSourceCreateOptions = Omit<CreateFleetRunInput, "name" | "goal">;

interface FleetSourceCreatePayload {
  source?: unknown;
  options?: FleetSourceCreateOptions;
}

class FleetSourceCreateError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "FleetSourceCreateError";
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface ResolvedSourceTarget {
  repoId: string | null;
  projectId: string | null;
  workingDirectory: string;
  baseBranch: string;
  label: string;
}

function comparablePath(value: string): string {
  const normalized = resolve(expandHome(value.trim()));
  return isWindows ? normalized.toLowerCase() : normalized;
}

function pathsMatch(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function validateTargetHints(
  draft: FleetSourceDraftPlanInput,
  target: ResolvedSourceTarget,
  repoSlug: string | null
): void {
  const sourcePath = draft.repository.workingDirectory;
  if (sourcePath && !pathsMatch(sourcePath, target.workingDirectory)) {
    throw new FleetSourceCreateError(
      `source workingDirectory does not match ${target.label}`
    );
  }
  if (
    draft.repository.baseBranch &&
    draft.repository.baseBranch !== target.baseBranch
  ) {
    throw new FleetSourceCreateError(
      `source baseBranch does not match ${target.label}`
    );
  }
  if (draft.repository.repoSlug) {
    if (!repoSlug || draft.repository.repoSlug !== repoSlug) {
      throw new FleetSourceCreateError(
        `source repoSlug does not match ${target.label}`
      );
    }
  }
  for (const task of draft.tasks) {
    if (
      task.workingDirectory &&
      !pathsMatch(task.workingDirectory, target.workingDirectory)
    ) {
      throw new FleetSourceCreateError(
        `source task ${task.id} workingDirectory does not match ${target.label}`
      );
    }
    if (task.baseBranch && task.baseBranch !== target.baseBranch) {
      throw new FleetSourceCreateError(
        `source task ${task.id} baseBranch does not match ${target.label}`
      );
    }
  }
}

function resolveSourceTarget(
  db: Database.Database,
  draft: FleetSourceDraftPlanInput,
  options: FleetSourceCreateOptions
): ResolvedSourceTarget {
  const optionRepoId = optionalString(options.repoId);
  const optionProjectId = optionalString(options.projectId);
  const sourceRepoId = draft.repository.repoId;
  const sourceProjectId = draft.repository.projectId;

  if (
    (optionRepoId && optionProjectId) ||
    (optionProjectId && sourceRepoId) ||
    (optionRepoId && sourceProjectId && !sourceRepoId)
  ) {
    throw new FleetSourceCreateError(
      "select either a repository or a project, not both"
    );
  }
  if (optionRepoId && sourceRepoId && optionRepoId !== sourceRepoId) {
    throw new FleetSourceCreateError(
      "options repoId does not match source repoId"
    );
  }
  if (
    optionProjectId &&
    sourceProjectId &&
    optionProjectId !== sourceProjectId
  ) {
    throw new FleetSourceCreateError(
      "options projectId does not match source projectId"
    );
  }

  const repoId = optionRepoId ?? sourceRepoId;
  const projectId = repoId ? null : (optionProjectId ?? sourceProjectId);
  if (!repoId && !projectId) {
    throw new FleetSourceCreateError(
      "a registered repository or project target is required"
    );
  }

  if (repoId) {
    const repo = queries.getDispatchRepo(db).get(repoId) as
      DispatchRepo | undefined;
    if (!repo) throw new FleetSourceCreateError("unknown repoId");
    if (sourceProjectId && repo.project_id !== sourceProjectId) {
      throw new FleetSourceCreateError(
        `source projectId does not match registered repository ${repoId}`
      );
    }
    const target: ResolvedSourceTarget = {
      repoId,
      projectId: null,
      workingDirectory: repo.repo_path,
      baseBranch: repo.base_branch,
      label: `registered repository ${repoId}`,
    };
    validateTargetHints(draft, target, repo.repo_slug);
    if (draft.provenance.kind === "dispatch_issue") {
      for (const task of draft.tasks) {
        const issueId = task.sourceIssueId;
        if (!issueId) {
          throw new FleetSourceCreateError(
            `source task ${task.id} is missing dispatch issue identity`
          );
        }
        const issue = queries.getDispatch(db).get(issueId) as
          IssueDispatch | undefined;
        if (!issue) {
          throw new FleetSourceCreateError(`unknown dispatch issue ${issueId}`);
        }
        if (issue.repo_id !== repoId) {
          throw new FleetSourceCreateError(
            `dispatch issue ${issueId} does not belong to registered repository ${repoId}`
          );
        }
        if (task.sourceIssueNumber !== issue.issue_number) {
          throw new FleetSourceCreateError(
            `dispatch issue ${issueId} no longer matches issue number ${String(task.sourceIssueNumber)}`
          );
        }
      }
    }
    return target;
  }

  if (
    draft.provenance.kind === "dispatch_issue" ||
    draft.provenance.kind === "dispatch_planner"
  ) {
    throw new FleetSourceCreateError(
      "Dispatch imports require a registered repository target"
    );
  }
  const project = queries.getProject(db).get(projectId!) as Project | undefined;
  if (!project) throw new FleetSourceCreateError("unknown projectId");
  const target: ResolvedSourceTarget = {
    repoId: null,
    projectId: project.id,
    workingDirectory: project.working_directory,
    baseBranch: "main",
    label: `registered project ${project.id}`,
  };
  validateTargetHints(draft, target, null);
  return target;
}

/**
 * Atomically import an existing Stoa planning surface into a durable Fleet run.
 * Adapter validation and plan conversion happen before the transaction; if
 * either row creation or plan ingestion fails, the new draft is rolled back.
 */
export function createFleetRunFromSource(
  input: unknown,
  actor = "operator"
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const payload = plainRecord(input) as FleetSourceCreatePayload | null;
  if (!payload || !("source" in payload)) {
    return { error: "source is required", status: 400 };
  }
  if (payload.options != null && !plainRecord(payload.options)) {
    return { error: "options must be an object", status: 400 };
  }

  const adapted = adaptFleetSource(payload.source);
  if (!adapted.ok) {
    return {
      error: adapted.errors.map((issue) => issue.message).join("; "),
      status: 400,
    };
  }

  let executable;
  try {
    executable = fleetSourceDraftToPlan(adapted.draft);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "source graph could not be converted",
      status: 400,
    };
  }

  const options = payload.options ?? {};
  try {
    const db = getDb();
    const target = resolveSourceTarget(db, adapted.draft, options);
    const boundExecutable = {
      ...executable,
      tasks: executable.tasks.map((task) => ({
        ...task,
        workingDirectory: target.workingDirectory,
        baseBranch: target.baseBranch,
      })),
    };
    const createInput: CreateFleetRunInput = {
      ...options,
      name: adapted.draft.name,
      goal: adapted.draft.goal,
      repoId: target.repoId,
      projectId: target.projectId,
      provider:
        optionalString(options.provider) ??
        adapted.draft.tasks.find((task) => task.provider)?.provider ??
        "claude",
      model:
        optionalString(options.model) ??
        adapted.draft.tasks.find((task) => task.model)?.model ??
        null,
    };

    return db.transaction(() => {
      const created = createDraftFleetRun(createInput, actor);
      if ("error" in created) throw new FleetSourceCreateError(created.error);
      const runId = created.run.run.id;
      const sourceUpdate = db
        .prepare(
          `UPDATE fleet_runs
           SET source_kind = ?, source_id = ?, source_name = ?
           WHERE id = ?`
        )
        .run(
          adapted.draft.provenance.kind,
          adapted.draft.provenance.sourceId,
          adapted.draft.provenance.sourceName,
          runId
        );
      if (sourceUpdate.changes !== 1) {
        throw new FleetSourceCreateError(
          "failed to persist fleet source lineage",
          500
        );
      }
      const ingested = ingestGeneratedFleetRunPlan(created.run.run.id, {
        ...boundExecutable,
        source: "operator",
        actor,
      });
      if ("error" in ingested) {
        throw new FleetSourceCreateError(
          ingested.error,
          ingested.status ?? 400
        );
      }
      const persistedTasks = queries.listFleetTasksForRun(db).all(runId) as {
        id: string;
      }[];
      if (persistedTasks.length !== adapted.draft.tasks.length) {
        throw new FleetSourceCreateError(
          "failed to align imported fleet source tasks",
          500
        );
      }
      const updateLineage = db.prepare(
        `UPDATE fleet_tasks
         SET source_ref = ?, source_step_id = ?, source_issue_id = ?,
             source_issue_number = ?
         WHERE id = ? AND fleet_run_id = ?`
      );
      for (let index = 0; index < persistedTasks.length; index += 1) {
        const row = persistedTasks[index];
        const sourceTask = adapted.draft.tasks[index];
        if (!row || !sourceTask) {
          throw new FleetSourceCreateError(
            "failed to align imported fleet source tasks",
            500
          );
        }
        const updated = updateLineage.run(
          sourceTask.sourceRef,
          sourceTask.id,
          sourceTask.sourceIssueId ?? null,
          sourceTask.sourceIssueNumber ?? null,
          row.id,
          runId
        );
        if (updated.changes !== 1) {
          throw new FleetSourceCreateError(
            "failed to persist fleet task source lineage",
            500
          );
        }
      }
      queries.createFleetEvent(db).run(
        runId,
        "source_imported",
        actor,
        JSON.stringify({
          kind: adapted.draft.provenance.kind,
          sourceId: adapted.draft.provenance.sourceId,
          sourceName: adapted.draft.provenance.sourceName,
          taskCount: adapted.draft.tasks.length,
          repoId: target.repoId,
          projectId: target.projectId,
        })
      );
      const detail = getFleetRunDetail(runId);
      if (!detail) {
        throw new FleetSourceCreateError(
          "failed to read imported fleet run",
          500
        );
      }
      return { run: detail };
    })();
  } catch (error) {
    if (error instanceof FleetSourceCreateError) {
      return { error: error.message, status: error.status };
    }
    throw error;
  }
}
