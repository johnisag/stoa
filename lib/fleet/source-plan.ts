import type { ParsedFleetPlanTask } from "./plan";
import { FLEET_PLAN_TEXT_MAX } from "./plan";
import type {
  FleetSourceDraftPlanInput,
  FleetSourceDraftTask,
} from "./sources";

export interface FleetSourceExecutablePlan {
  tasks: ParsedFleetPlanTask[];
  dependencies: number[][];
  planText: string;
}

function sourceTaskType(task: FleetSourceDraftTask): string {
  // The scheduler's read-only contract is expressed by a canonical task type.
  // Keep the source's richer label in the rendered plan/sourceRef, but never
  // let a read-only import acquire an unknown write claim by accident.
  return task.claimMode === "read" ? "explore" : task.taskType;
}

function renderSourcePlan(draft: FleetSourceDraftPlanInput): string {
  const lines = [
    `# ${draft.name}`,
    "",
    draft.goal,
    "",
    `Imported from ${draft.provenance.kind}${draft.provenance.sourceId ? ` (${draft.provenance.sourceId})` : ""}.`,
    "",
    "## Tasks",
  ];
  for (const task of draft.tasks) {
    const claims = task.fileClaims
      .filter((claim) => claim.access === "write")
      .map((claim) => claim.path);
    lines.push(
      "",
      `${task.order + 1}. ${task.title}`,
      `   Source: ${task.sourceRef}`,
      `   Access: ${task.claimMode}`,
      ...(task.description
        ? [`   ${task.description.replace(/\s+/g, " ").slice(0, 600)}`]
        : []),
      ...(task.dependsOn.length
        ? [`   Depends on: ${task.dependsOn.join(", ")}`]
        : []),
      ...(claims.length ? [`   Files: ${claims.join(", ")}`] : []),
      ...(task.acceptanceCriteria
        ? [`   Acceptance: ${task.acceptanceCriteria}`]
        : []),
      ...(task.verifyCommand ? [`   Verify: ${task.verifyCommand}`] : []),
      ...(task.provider ? [`   Provider: ${task.provider}`] : [])
    );
  }
  return lines.join("\n").slice(0, FLEET_PLAN_TEXT_MAX);
}

/**
 * Convert a validated source adapter result into the existing durable Fleet
 * plan-ingestion contract. This is deliberately pure: callers can preview the
 * exact graph before creating any rows.
 */
export function fleetSourceDraftToPlan(
  draft: FleetSourceDraftPlanInput
): FleetSourceExecutablePlan {
  const indexById = new Map(
    draft.tasks.map((task, index) => [task.id, index] as const)
  );
  return {
    tasks: draft.tasks.map((task, index) => ({
      title: task.title,
      description: task.description,
      taskType: sourceTaskType(task),
      parentIndex: null,
      sortOrder: index,
      fileClaims:
        task.claimMode === "write"
          ? task.fileClaims
              .filter((claim) => claim.access === "write")
              .map((claim) => claim.path)
          : [],
      agentType: task.provider,
      model: task.model,
      acceptanceCriteria: task.acceptanceCriteria,
      verifyCommand: task.verifyCommand,
      workingDirectory: task.workingDirectory,
      baseBranch: task.baseBranch ?? draft.repository.baseBranch,
    })),
    dependencies: draft.tasks.map((task) =>
      task.dependsOn.map((dependency) => {
        const index = indexById.get(dependency);
        if (index == null) {
          // Source adapters guarantee this invariant. Throwing here prevents a
          // future adapter regression from silently dropping an edge.
          throw new Error(`Fleet source dependency is missing: ${dependency}`);
        }
        return index;
      })
    ),
    planText: renderSourcePlan(draft),
  };
}
