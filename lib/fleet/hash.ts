import { createHash } from "crypto";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "./types";
import { canonicalFleetPlanTasks, type ParsedFleetPlanTask } from "./plan";

function parseFileClaims(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseFileClaimsStrict(
  value: string
): { claims: string[] } | { error: string } {
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((entry): entry is string => typeof entry === "string")
    ) {
      return { error: "plan graph has invalid file claims" };
    }
    return { claims: parsed };
  } catch {
    return { error: "plan graph has invalid file claims" };
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashParsedFleetPlanTasks(
  tasks: ParsedFleetPlanTask[],
  dependencies: number[][] = []
): string {
  return stableHash(
    canonicalFleetPlanTasks(tasks).map((task, index) => ({
      ...task,
      dependencies: [
        ...new Set([
          ...(dependencies[index] ?? []),
          ...(task.parentIndex == null ? [] : [task.parentIndex]),
        ]),
      ]
        .sort((a, b) => a - b)
        .map((dependencyIndex) => ({
          dependencyIndex,
          dependencyType: "blocks" as const,
        })),
    }))
  );
}

export function hashFleetTaskRows(
  rows: FleetTaskRow[],
  dependencies: FleetTaskDependencyRow[] = []
): string {
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  const indexById = new Map(ordered.map((task, index) => [task.id, index]));
  const canonical = ordered.map((task, index) => ({
    title: task.title,
    description: task.description ?? "",
    taskType: task.task_type,
    parentIndex:
      task.parent_task_id == null
        ? null
        : (indexById.get(task.parent_task_id) ?? null),
    sortOrder: index,
    fileClaims: parseFileClaims(task.file_claims_json).sort(),
    agentType: task.agent_type ?? null,
    model: task.model ?? null,
    acceptanceCriteria: task.acceptance_criteria ?? null,
    verifyCommand: task.verify_command ?? null,
    dependencies: dependencies
      .filter((dependency) => dependency.task_id === task.id)
      .flatMap((dependency) => {
        const dependencyIndex = indexById.get(dependency.depends_on_task_id);
        return dependencyIndex == null
          ? []
          : [{ dependencyIndex, dependencyType: dependency.dependency_type }];
      })
      .sort(
        (a, b) =>
          a.dependencyIndex - b.dependencyIndex ||
          a.dependencyType.localeCompare(b.dependencyType)
      ),
  }));
  return stableHash(canonical);
}

export function hashFleetExecutionContract(input: {
  run: FleetRunRow;
  tasks: FleetTaskRow[];
  claims: FleetTaskClaimRow[];
  dependencies: FleetTaskDependencyRow[];
}): string {
  const { run } = input;
  return stableHash({
    run: {
      repoId: run.repo_id,
      projectId: run.project_id,
      budgetUsd: run.budget_usd,
      provider: run.provider,
      model: run.model,
      maxConcurrency: run.max_concurrency,
      reviewPolicy: run.review_policy,
      planHash: run.plan_hash,
    },
    tasks: [...input.tasks]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((task) => ({
        id: task.id,
        parentTaskId: task.parent_task_id,
        title: task.title,
        description: task.description,
        taskType: task.task_type,
        sortOrder: task.sort_order,
        fileClaimsJson: task.file_claims_json,
        priority: task.priority ?? 0,
        agentType: task.agent_type ?? null,
        model: task.model ?? null,
        workingDirectory: task.working_directory ?? null,
        baseBranch: task.base_branch ?? null,
        branchName: task.branch_name ?? null,
        maxAttempts: task.max_attempts ?? 2,
        acceptanceCriteria: task.acceptance_criteria ?? null,
        verifyCommand: task.verify_command ?? null,
      })),
    claims: [...input.claims]
      .sort((a, b) =>
        `${a.task_id}:${a.path}`.localeCompare(`${b.task_id}:${b.path}`)
      )
      .map((claim) => ({
        taskId: claim.task_id,
        path: claim.path,
        claimType: claim.claim_type,
        confidence: claim.confidence,
      })),
    dependencies: [...input.dependencies]
      .sort((a, b) =>
        `${a.task_id}:${a.depends_on_task_id}:${a.dependency_type}`.localeCompare(
          `${b.task_id}:${b.depends_on_task_id}:${b.dependency_type}`
        )
      )
      .map((dependency) => ({
        taskId: dependency.task_id,
        dependsOnTaskId: dependency.depends_on_task_id,
        dependencyType: dependency.dependency_type,
      })),
  });
}

export function validateFleetTaskRowsForApproval(
  rows: FleetTaskRow[],
  dependencies: FleetTaskDependencyRow[] = []
): { hash: string } | { error: string } {
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order);
  const indexById = new Map(ordered.map((task, index) => [task.id, index]));
  const canonical = [];

  for (const [index, task] of ordered.entries()) {
    if (task.status !== "draft") {
      return { error: "plan graph has non-draft tasks" };
    }
    let parentIndex: number | null = null;
    if (task.parent_task_id != null) {
      const parent = indexById.get(task.parent_task_id);
      if (parent == null) return { error: "plan graph has invalid parents" };
      parentIndex = parent;
    }
    const claims = parseFileClaimsStrict(task.file_claims_json);
    if ("error" in claims) return claims;
    const dependencyIndexes: number[] = [];
    for (const dependency of dependencies.filter(
      (entry) => entry.task_id === task.id
    )) {
      if (dependency.dependency_type !== "blocks") {
        return { error: "plan graph has unsupported dependency semantics" };
      }
      const dependencyIndex = indexById.get(dependency.depends_on_task_id);
      if (dependencyIndex == null || dependencyIndex >= index) {
        return { error: "plan graph has invalid dependencies" };
      }
      dependencyIndexes.push(dependencyIndex);
    }

    canonical.push({
      title: task.title,
      description: task.description ?? "",
      taskType: task.task_type,
      parentIndex,
      sortOrder: index,
      fileClaims: claims.claims.sort(),
      agentType: task.agent_type ?? null,
      model: task.model ?? null,
      acceptanceCriteria: task.acceptance_criteria ?? null,
      verifyCommand: task.verify_command ?? null,
      dependencies: [...new Set(dependencyIndexes)]
        .sort((a, b) => a - b)
        .map((dependencyIndex) => ({
          dependencyIndex,
          dependencyType: "blocks" as const,
        })),
    });
  }

  return { hash: stableHash(canonical) };
}
