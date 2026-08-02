import { resolve } from "path";
import type Database from "better-sqlite3";
import { getDb, queries } from "../db";
import type { Project } from "../db/types";
import type { DispatchRepo, IssueDispatch } from "../dispatch/types";
import { getDefaultBranch } from "../git-status";
import { expandHome, isWindows } from "../platform";
import { isValidProviderId } from "../providers/registry";
import type { CreateFleetRunInput, FleetRunDetailDto } from "./types";
import {
  adaptFleetSource,
  type FleetSourceDraftPlanInput,
  type FleetSourceProvider,
} from "./sources";
import { allocateFleetSourcePlan, fleetSourceDraftToPlan } from "./source-plan";
import { redactAndCapFleetText } from "./redaction";
import {
  detectInstalledFleetAgentProviders,
  type FleetAgentProviderId,
} from "./auxiliary-provider";
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

export interface FleetSourceServiceDeps {
  detectInstalledProviders: () => FleetAgentProviderId[];
  defaultBranch: (workingDirectory: string) => string;
}

function sourceServiceDeps(
  overrides: Partial<FleetSourceServiceDeps>
): FleetSourceServiceDeps {
  return {
    detectInstalledProviders:
      overrides.detectInstalledProviders ?? detectInstalledFleetAgentProviders,
    defaultBranch: overrides.defaultBranch ?? getDefaultBranch,
  };
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

function sanitizedLineageName(value: string | null): string | null {
  if (!value) return null;
  return (
    redactAndCapFleetText(value, 160 * 4)
      .text.trim()
      .slice(0, 160) || null
  );
}

function containsCredentialShapedText(
  value: string | null | undefined
): boolean {
  if (!value) return false;
  return redactAndCapFleetText(value, Buffer.byteLength(value, "utf8"))
    .redacted;
}

const SOURCE_PROSE_KEYS = new Set([
  "body",
  "description",
  "exitCriteria",
  "goal",
  "issue_title",
  "issue_url",
  "name",
  "sourceName",
  "spec",
  "task",
  "task_body",
  "text",
  "title",
]);

/**
 * Redact source prose before an adapter applies character limits. Otherwise a
 * credential that straddles an adapter's boundary can be truncated into a
 * fragment that no longer matches the redaction rules and then be persisted.
 * Identity, path, branch, claim, model, and command fields remain byte-for-byte
 * intact here so their dedicated validation can reject unsafe values.
 */
function sanitizeSourceProse(
  value: unknown,
  key: string | null = null
): unknown {
  if (typeof value === "string") {
    if (!key || !SOURCE_PROSE_KEYS.has(key)) return value;
    return redactAndCapFleetText(value, Buffer.byteLength(value, "utf8")).text;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSourceProse(entry, key));
  }
  const record = plainRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([childKey, childValue]) => [
      childKey,
      sanitizeSourceProse(childValue, childKey),
    ])
  );
}

interface ResolvedSourceTarget {
  repoId: string | null;
  projectId: string | null;
  workingDirectory: string;
  baseBranch: string;
  provider: FleetSourceProvider | null;
  model: string | null;
  label: string;
}

function sourceProvider(value: unknown): FleetSourceProvider | null {
  const provider = optionalString(value)?.toLowerCase() ?? null;
  return provider && isValidProviderId(provider) && provider !== "shell"
    ? provider
    : null;
}

function optionProvider(value: unknown): FleetSourceProvider | null {
  const provider = optionalString(value);
  if (!provider) return null;
  const normalized = sourceProvider(provider);
  if (!normalized) {
    throw new FleetSourceCreateError(
      "options provider must be a supported agent provider"
    );
  }
  return normalized;
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
  options: FleetSourceCreateOptions,
  defaultBranch: (workingDirectory: string) => string
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
      provider: sourceProvider(repo.agent_type),
      model: optionalString(repo.default_model),
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
    baseBranch: defaultBranch(project.working_directory),
    provider: sourceProvider(project.agent_type),
    model: optionalString(project.default_model),
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
  actor = "operator",
  overrides: Partial<FleetSourceServiceDeps> = {}
): { run: FleetRunDetailDto } | { error: string; status?: number } {
  const runtime = sourceServiceDeps(overrides);
  const safeActor =
    redactAndCapFleetText(actor, 80 * 4)
      .text.trim()
      .slice(0, 80) || "operator";
  const payload = plainRecord(input) as FleetSourceCreatePayload | null;
  if (!payload || !("source" in payload)) {
    return { error: "source is required", status: 400 };
  }
  if (payload.options != null && !plainRecord(payload.options)) {
    return { error: "options must be an object", status: 400 };
  }

  const adapted = adaptFleetSource(sanitizeSourceProse(payload.source));
  if (!adapted.ok) {
    return {
      error: adapted.errors.map((issue) => issue.message).join("; "),
      status: 400,
    };
  }

  const unsafeLineageIdentity = [
    adapted.draft.provenance.sourceId,
    ...adapted.draft.tasks.flatMap((task) => [
      task.id,
      task.sourceRef,
      task.sourceIssueId ?? null,
    ]),
  ].some(containsCredentialShapedText);
  if (unsafeLineageIdentity) {
    return {
      error: "source lineage identity contains credential-shaped text",
      status: 400,
    };
  }
  const sourceName = sanitizedLineageName(adapted.draft.provenance.sourceName);

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
    const target = resolveSourceTarget(
      db,
      adapted.draft,
      options,
      runtime.defaultBranch
    );
    const requestedProvider = optionProvider(options.provider);
    const requestedModel = optionalString(options.model);
    const sourceDefault = adapted.draft.tasks.find((task) => task.provider);
    const preferences: Array<{
      provider: FleetSourceProvider;
      model: string | null;
    }> = [];
    if (requestedProvider) {
      preferences.push({
        provider: requestedProvider,
        model:
          requestedModel ??
          (sourceDefault?.provider === requestedProvider
            ? sourceDefault.model
            : target.provider === requestedProvider
              ? target.model
              : null),
      });
    }
    if (sourceDefault?.provider) {
      preferences.push({
        provider: sourceDefault.provider,
        model: requestedProvider
          ? sourceDefault.model
          : (requestedModel ?? sourceDefault.model),
      });
    }
    if (target.provider) {
      preferences.push({
        provider: target.provider,
        model:
          !requestedProvider && !sourceDefault
            ? (requestedModel ?? target.model)
            : target.model,
      });
    }
    const installedProviders = runtime.detectInstalledProviders();
    const installed = new Set(installedProviders);
    const preference =
      preferences.find((candidate) => installed.has(candidate.provider)) ??
      preferences[0] ??
      null;
    let allocated;
    try {
      allocated = allocateFleetSourcePlan(executable, {
        availableProviders: installedProviders,
        preferredProvider: preference?.provider ?? null,
        preferredModel: preference?.model ?? null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "no installed agent provider is available"
      ) {
        throw new FleetSourceCreateError(error.message, 409);
      }
      throw new FleetSourceCreateError(
        error instanceof Error ? error.message : "source model is invalid",
        400
      );
    }
    const boundExecutable = {
      ...allocated.plan,
      tasks: allocated.plan.tasks.map((task) => ({
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
      provider: allocated.provider,
      model: allocated.model,
    };

    return db.transaction(() => {
      const created = createDraftFleetRun(createInput, safeActor);
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
          sourceName,
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
        actor: safeActor,
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
        safeActor,
        JSON.stringify({
          kind: adapted.draft.provenance.kind,
          sourceId: adapted.draft.provenance.sourceId,
          sourceName,
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
