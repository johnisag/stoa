import {
  FLEET_SUPERVISOR_RULES_VERSION,
  type FleetSupervisorAttentionItem,
  type FleetSupervisorRecommendation,
  type FleetSupervisorSnapshotState,
  type FleetSupervisorTaskSummary,
} from "./supervisor-types";

const OPERATOR_TASK_STATUSES = new Set([
  "waiting_for_operator",
  "needs_followup",
  "needs_inspection",
  "blocked",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recommendationId(
  kind: FleetSupervisorRecommendation["kind"],
  reasonCode: string,
  taskId: string | null
): string {
  return [
    `rules-v${FLEET_SUPERVISOR_RULES_VERSION}`,
    kind,
    reasonCode,
    taskId ?? "run",
  ].join(":");
}

function recommendation(
  priority: number,
  kind: FleetSupervisorRecommendation["kind"],
  reasonCode: string,
  taskId: string | null = null
): FleetSupervisorRecommendation {
  return {
    id: recommendationId(kind, reasonCode, taskId),
    priority,
    kind,
    reasonCode,
    taskId,
  };
}

function canRetry(task: FleetSupervisorTaskSummary): boolean {
  return (
    task.currentAttempt < task.maxAttempts &&
    !OPERATOR_TASK_STATUSES.has(task.status) &&
    task.integrationState !== "failed" &&
    task.providerState === "failed" &&
    task.failureCategory === "provider"
  );
}

/** Pure, deterministic advisory rules. No clock, I/O, or mutation. */
export function recommendFleetSupervisorActions(
  state: FleetSupervisorSnapshotState
): FleetSupervisorRecommendation[] {
  const recommendations: FleetSupervisorRecommendation[] = [];

  if (state.run.approvalState === "needs_approval") {
    if (
      state.gates.planReview.complete &&
      state.bindings.planHash != null &&
      state.bindings.policyHash != null &&
      state.bindings.executionHash != null &&
      state.bindings.baseSha != null &&
      state.bindings.contractComplete
    ) {
      recommendations.push(
        recommendation(10, "approval", "exact_plan_gates_ready")
      );
    } else {
      recommendations.push(
        recommendation(10, "inspect", "plan_gates_incomplete")
      );
    }
  }

  for (const task of state.tasks) {
    if (canRetry(task)) {
      recommendations.push(
        recommendation(20, "retry", "retryable_provider_failure", task.id)
      );
      continue;
    }
    if (
      OPERATOR_TASK_STATUSES.has(task.status) ||
      task.failureCategory === "verification" ||
      task.failureCategory === "review" ||
      task.integrationState === "failed"
    ) {
      recommendations.push(
        recommendation(30, "inspect", "task_requires_operator", task.id)
      );
    }
  }

  const criticalAttention = state.attention.some(
    (item) => item.severity === "critical"
  );
  if (
    ["running", "reviewing", "merging"].includes(state.run.status) &&
    criticalAttention
  ) {
    recommendations.push(
      recommendation(40, "pause", "critical_attention_while_running")
    );
  }

  if (
    state.merge.assessmentComplete &&
    (state.merge.readyTaskIds.length > 0 || state.merge.canFinalize)
  ) {
    recommendations.push(
      recommendation(
        50,
        "merge_readiness",
        state.merge.canFinalize
          ? "final_merge_gates_ready"
          : "task_merge_gates_ready"
      )
    );
  } else if (state.run.mergeRequested && state.merge.blockerCount > 0) {
    recommendations.push(recommendation(50, "inspect", "merge_gates_blocked"));
  }

  const unique = new Map<string, FleetSupervisorRecommendation>();
  for (const item of recommendations) unique.set(item.id, item);
  return [...unique.values()].sort(
    (left, right) =>
      left.priority - right.priority ||
      compareText(left.taskId ?? "", right.taskId ?? "") ||
      compareText(left.kind, right.kind) ||
      compareText(left.reasonCode, right.reasonCode)
  );
}

/** Exported so all transports render attention in the same stable order. */
export function compareFleetSupervisorAttention(
  left: FleetSupervisorAttentionItem,
  right: FleetSupervisorAttentionItem
): number {
  return (
    left.rank - right.rank ||
    compareText(left.taskId ?? "", right.taskId ?? "") ||
    compareText(left.workerId ?? "", right.workerId ?? "") ||
    compareText(left.code, right.code)
  );
}
