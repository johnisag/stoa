import { describe, expect, it } from "vitest";
import { hashFleetExecutionContract } from "@/lib/fleet/hash";
import type { FleetRunRow, FleetTaskRow } from "@/lib/fleet/types";

function run(): FleetRunRow {
  return {
    id: "run-1",
    name: "Fleet",
    goal: "Ship",
    repo_id: "repo-1",
    project_id: null,
    status: "planned",
    approval_state: "approved",
    provider: "codex",
    model: null,
    max_concurrency: 2,
    review_policy: "four_agent",
    budget_usd: null,
    reserved_budget_usd: 0,
    spent_budget_usd: 0,
    settings_json: "{}",
    plan_hash: "a".repeat(64),
    approved_plan_hash: "a".repeat(64),
    approved_by: "operator",
    approved_at: "2026-08-01T12:00:00.000Z",
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
    started_at: null,
    ended_at: null,
  };
}

function task(branchName: string | null, baseBranch = "main"): FleetTaskRow {
  return {
    id: "task-1",
    fleet_run_id: "run-1",
    parent_task_id: null,
    title: "Implement",
    description: "Implement the approved change",
    status: "ready",
    task_type: "task",
    sort_order: 0,
    file_claims_json: '["lib/fleet/hash.ts"]',
    priority: 0,
    agent_type: "codex",
    model: null,
    working_directory: "C:\\repo",
    base_branch: baseBranch,
    branch_name: branchName,
    max_attempts: 2,
    acceptance_criteria: "Tests pass",
    verify_command: "npm test",
    approval_state: "approved",
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
  };
}

describe("Fleet execution contract hashing", () => {
  it("ignores a runtime-assigned branch but still binds the planned base branch", () => {
    const input = {
      run: run(),
      claims: [],
      dependencies: [],
    };

    expect(hashFleetExecutionContract({ ...input, tasks: [task(null)] })).toBe(
      hashFleetExecutionContract({
        ...input,
        tasks: [task("fleet/run-1/task-1")],
      })
    );
    expect(
      hashFleetExecutionContract({ ...input, tasks: [task(null)] })
    ).not.toBe(
      hashFleetExecutionContract({ ...input, tasks: [task(null, "release")] })
    );
  });
});
