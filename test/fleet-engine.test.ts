import { describe, expect, it } from "vitest";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
  buildFleetApprovalPreview,
  composeFleetRunDetail,
  normalizeFleetRunDraft,
} from "@/lib/fleet/engine";
import type {
  FleetEventRow,
  FleetRunRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const now = "2026-07-08T00:00:00.000Z";

function runRow(overrides: Partial<FleetRunRow> = {}): FleetRunRow {
  return {
    id: "run-1",
    name: "Ship the plan",
    goal: "Build a fleet manager",
    repo_id: null,
    project_id: null,
    status: "draft",
    budget_usd: null,
    provider: "claude",
    model: null,
    max_concurrency: 1,
    review_policy: "four_agent",
    approval_state: "draft",
    settings_json: "{}",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("normalizeFleetRunDraft", () => {
  it("trims required text, applies defaults, and clamps concurrency", () => {
    const res = normalizeFleetRunDraft({
      name: "  Tera Emperor  ",
      goal: "  execute every phase  ",
      repoId: "  repo-1  ",
      projectId: "  proj-1  ",
      budgetUsd: -5,
      provider: " codex ",
      model: " gpt-5.5 ",
      maxConcurrency: 99,
      reviewPolicy: "four_agent_plus_red_team",
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft).toMatchObject({
      name: "Tera Emperor",
      goal: "execute every phase",
      repoId: "repo-1",
      projectId: "proj-1",
      budgetUsd: 0,
      provider: "codex",
      model: "gpt-5.5",
      maxConcurrency: 40,
      reviewPolicy: "four_agent_plus_red_team",
    });
  });

  it("defaults optional fields and treats invalid numeric input as unset", () => {
    const res = normalizeFleetRunDraft({
      name: "Run",
      goal: "Goal",
      budgetUsd: Number.NaN,
      maxConcurrency: Number.POSITIVE_INFINITY,
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft.repoId).toBeNull();
    expect(res.draft.projectId).toBeNull();
    expect(res.draft.budgetUsd).toBeNull();
    expect(res.draft.provider).toBe("claude");
    expect(res.draft.model).toBeNull();
    expect(res.draft.maxConcurrency).toBe(1);
    expect(res.draft.reviewPolicy).toBe("four_agent");
  });

  it("normalizes malformed runtime payload fields defensively", () => {
    const res = normalizeFleetRunDraft({
      name: "Run",
      goal: "Goal",
      budgetUsd: "7.5" as never,
      maxConcurrency: "8" as never,
      repoId: 123 as never,
      provider: null,
      reviewPolicy: "evil" as never,
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft.budgetUsd).toBe(7.5);
    expect(res.draft.maxConcurrency).toBe(8);
    expect(res.draft.repoId).toBeNull();
    expect(res.draft.provider).toBe("claude");
    expect(res.draft.reviewPolicy).toBe("four_agent");
  });

  it("caps persisted labels, body fields, and model selectors", () => {
    const res = normalizeFleetRunDraft({
      name: "n".repeat(FLEET_RUN_NAME_MAX + 50),
      goal: "g".repeat(FLEET_RUN_GOAL_MAX + 50),
      provider: "p".repeat(FLEET_PROVIDER_MAX + 50),
      model: "m".repeat(FLEET_MODEL_MAX + 50),
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft.name).toHaveLength(FLEET_RUN_NAME_MAX);
    expect(res.draft.goal).toHaveLength(FLEET_RUN_GOAL_MAX);
    expect(res.draft.provider).toHaveLength(FLEET_PROVIDER_MAX);
    expect(res.draft.model).toHaveLength(FLEET_MODEL_MAX);
  });

  it("rejects blank name or goal", () => {
    expect(normalizeFleetRunDraft({ name: " ", goal: "x" })).toEqual({
      error: "name is required",
    });
    expect(normalizeFleetRunDraft({ name: "x", goal: " " })).toEqual({
      error: "goal is required",
    });
    expect(normalizeFleetRunDraft(null)).toEqual({
      error: "name is required",
    });
  });
});

describe("buildFleetApprovalPreview", () => {
  it("is a preview only and cannot approve executable work in phase 1", () => {
    const preview = buildFleetApprovalPreview();

    expect(preview.canApproveExecutableWork).toBe(false);
    expect(preview.requiredGates).toContain(
      "four-agent review with adversarial lane"
    );
    expect(preview.blockedActions).toEqual(
      expect.arrayContaining(["planner execution", "worker spawning"])
    );
  });
});

describe("composeFleetRunDetail", () => {
  it("converts DB rows into browser DTOs with counts and parsed payloads", () => {
    const tasks: FleetTaskRow[] = [
      {
        id: "task-1",
        fleet_run_id: "run-1",
        parent_task_id: null,
        title: "Scope",
        description: "Define scope",
        status: "draft",
        task_type: "scope",
        sort_order: 0,
        file_claims_json: JSON.stringify(["app/page.tsx", 123, "lib/fleet.ts"]),
        created_at: now,
        updated_at: now,
      },
    ];
    const events: FleetEventRow[] = [
      {
        id: 1,
        fleet_run_id: "run-1",
        event_type: "draft_created",
        actor: "operator",
        payload: JSON.stringify({ ok: true }),
        created_at: now,
      },
      {
        id: 2,
        fleet_run_id: "run-1",
        event_type: "bad_payload",
        actor: "system",
        payload: "{",
        created_at: now,
      },
    ];

    const detail = composeFleetRunDetail({
      run: runRow({ budget_usd: 12.5, max_concurrency: 8 }),
      tasks,
      workers: [],
      events,
    });

    expect(detail.run.taskCount).toBe(1);
    expect(detail.run.workerCount).toBe(0);
    expect(detail.run.budgetUsd).toBe(12.5);
    expect(detail.run.maxConcurrency).toBe(8);
    expect(detail.run.approvalPreview.canApproveExecutableWork).toBe(false);
    expect(detail.tasks[0].fileClaims).toEqual([
      "app/page.tsx",
      "lib/fleet.ts",
    ]);
    expect(detail.events[0].payload).toEqual({ ok: true });
    expect(detail.events[1].payload).toBeNull();
  });
});
