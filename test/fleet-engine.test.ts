import { describe, expect, it } from "vitest";
import {
  FLEET_MODEL_MAX,
  FLEET_PROVIDER_MAX,
  FLEET_RUN_GOAL_MAX,
  FLEET_RUN_NAME_MAX,
  buildFleetApprovalPreview,
  composeFleetRunDetail,
  normalizeFleetRunDraft,
  toFleetTaskDto,
} from "@/lib/fleet/engine";
import type {
  FleetArtifactRow,
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
    plan_hash: null,
    approved_plan_hash: null,
    approved_by: null,
    approved_at: null,
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
      budgetTokens: 250000,
      budgetStopMode: "hard-stop",
      budgetWarningThreshold: 0.75,
      providerCaps: { codex: 8, hermes: 3 },
      resourceLimits: { verifier: 4, worktreesPerRepo: 20 },
      maxRetriesPerTask: 3,
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
      budgetTokens: 250000,
      budgetStopMode: "hard-stop",
      budgetWarningThreshold: 0.75,
      providerCaps: { codex: 8, hermes: 3 },
      defaultMaxAttempts: 4,
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
    expect(res.draft.budgetTokens).toBeNull();
    expect(res.draft.budgetStopMode).toBe("pause-new");
    expect(res.draft.budgetWarningThreshold).toBe(0.8);
    expect(res.draft.defaultMaxAttempts).toBe(2);
    expect(res.draft.provider).toBe("claude");
    expect(res.draft.model).toBe("sonnet");
    expect(res.draft.maxConcurrency).toBe(6);
    expect(res.draft.reviewPolicy).toBe("four_agent");
    expect(res.draft.desiredState).toBe("draft");
    expect(res.draft.automationPolicy).toMatchObject({
      version: 1,
      automaticPlanning: false,
      automaticPlanApproval: false,
      automaticStart: false,
      automaticMerge: false,
    });
  });

  it("normalizes a chained automatic intent and derives its desired state", () => {
    const res = normalizeFleetRunDraft({
      name: "Autonomous run",
      goal: "Plan, review, and execute",
      automationPolicy: {
        automaticPlanning: true,
        automaticPlanApproval: true,
        automaticStart: true,
        allowUnconfinedAgents: true,
        plannerTaskCap: 99,
      },
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft.desiredState).toBe("running");
    expect(res.draft.automationPolicy).toMatchObject({
      version: 1,
      automaticPlanning: true,
      automaticPlanApproval: true,
      automaticStart: true,
      allowUnconfinedAgents: true,
      plannerTaskCap: 40,
    });
  });

  it("rejects incomplete approval chains and unavailable automatic merge", () => {
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        automationPolicy: { automaticStart: true },
      })
    ).toEqual({ error: "automatic start requires automatic plan approval" });
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        reviewPolicy: "manual",
        automationPolicy: {
          automaticPlanning: true,
          automaticPlanApproval: true,
        },
      })
    ).toEqual({
      error: "automatic plan approval requires a four-agent review policy",
    });
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        automationPolicy: { automaticMerge: true },
      })
    ).toEqual({
      error: "automatic merge requires automatic start",
    });
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        automationPolicy: {
          automaticPlanning: true,
          automaticPlanApproval: true,
          automaticStart: true,
          automaticMerge: true,
        },
      })
    ).toMatchObject({ draft: { desiredState: "running" } });
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

  it("caps prose fields while rejecting oversized executable selectors", () => {
    const res = normalizeFleetRunDraft({
      name: "n".repeat(FLEET_RUN_NAME_MAX + 50),
      goal: "g".repeat(FLEET_RUN_GOAL_MAX + 50),
      provider: "claude",
      model: "sonnet",
    });

    expect(res).toHaveProperty("draft");
    if ("error" in res) return;
    expect(res.draft.name).toHaveLength(FLEET_RUN_NAME_MAX);
    expect(res.draft.goal).toHaveLength(FLEET_RUN_GOAL_MAX);
    expect(res.draft.provider).toBe("claude");
    expect(res.draft.model).toBe("sonnet");
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        provider: "p".repeat(FLEET_PROVIDER_MAX + 1),
      })
    ).toEqual({ error: "provider must be a supported Fleet agent" });
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        provider: "hermes",
        model: "m".repeat(FLEET_MODEL_MAX + 1),
      })
    ).toEqual({ error: `model must be at most ${FLEET_MODEL_MAX} characters` });
  });

  it("rejects unsafe and unsupported models and preserves dynamic defaults", () => {
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        provider: "codex",
        model: "gpt-4-unsupported",
      })
    ).toEqual({ error: "model is not supported by codex" });
    expect(
      normalizeFleetRunDraft({
        name: "Run",
        goal: "Goal",
        provider: "hermes",
        model: "openrouter/x;whoami",
      })
    ).toEqual({ error: "model is not a safe hermes model id" });
    expect(
      normalizeFleetRunDraft({ name: "Run", goal: "Goal", provider: "hermes" })
    ).toMatchObject({ draft: { model: "kimi-k3" } });
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
  it("is a preview only and cannot approve executable work in phase 2", () => {
    const preview = buildFleetApprovalPreview();

    expect(preview.canApproveExecutableWork).toBe(false);
    expect(preview.requiredGates).toContain(
      "four-agent review with adversarial lane"
    );
    expect(preview.blockedActions).toEqual(
      expect.arrayContaining(["worker spawning"])
    );
  });
});

describe("composeFleetRunDetail", () => {
  it("strictly parses bounded structured task risk notes", () => {
    const row = {
      id: "task-risk",
      fleet_run_id: "run-1",
      parent_task_id: null,
      title: "Risky task",
      description: null,
      status: "draft",
      task_type: "implementation",
      sort_order: 0,
      file_claims_json: "[]",
      risk_notes_json: JSON.stringify([
        {
          severity: "high",
          risk: "A migration could lose historical rows",
          mitigation: "Back up and verify row counts before promotion",
        },
      ]),
      created_at: now,
      updated_at: now,
    } satisfies FleetTaskRow;

    expect(toFleetTaskDto(row).riskNotes).toEqual([
      {
        severity: "high",
        risk: "A migration could lose historical rows",
        mitigation: "Back up and verify row counts before promotion",
      },
    ]);
    for (const malformed of [
      "not-json",
      JSON.stringify({ severity: "high" }),
      JSON.stringify([
        {
          severity: "critical",
          risk: "Bad severity",
          mitigation: "Reject it",
        },
      ]),
      JSON.stringify([
        {
          severity: "low",
          risk: "r".repeat(501),
          mitigation: "Bound it",
        },
      ]),
      JSON.stringify(
        Array.from({ length: 9 }, () => ({
          severity: "low",
          risk: "Risk",
          mitigation: "Mitigation",
        }))
      ),
    ]) {
      expect(
        toFleetTaskDto({ ...row, risk_notes_json: malformed }).riskNotes
      ).toEqual([]);
    }
  });

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
        risk_notes_json: JSON.stringify([
          {
            severity: "medium",
            risk: "The plan may affect mobile layout",
            mitigation: "Verify the compact task card",
          },
        ]),
        integration_state: "merged",
        integration_operation_id: "merge-op-1",
        integrated_head_sha: "c".repeat(40),
        integrated_at: now,
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
    const artifacts: FleetArtifactRow[] = [
      {
        id: "artifact-1",
        fleet_run_id: "run-1",
        task_id: "task-1",
        plan_hash: "hash-a",
        artifact_type: "critic_finding",
        title: "Needs clearer boundary",
        body: "The implementation path is still too broad.",
        severity: "warning",
        actor: "critic",
        created_at: now,
      },
    ];

    const detail = composeFleetRunDetail({
      run: runRow({
        budget_usd: 12.5,
        max_concurrency: 8,
        plan_hash: "hash-a",
        approved_plan_hash: "hash-a",
        approved_by: "operator",
        approved_at: now,
        merge_requested_at: now,
        merge_requested_by: "fleet-automation",
        merge_request_kind: "automatic",
        merge_target: "github_pr",
        integration_state: "waiting_ci",
        integration_branch: "stoa/fleet/integration-run",
        integration_head_sha: "c".repeat(40),
        integration_pr_number: 42,
        integration_pr_url: "https://github.com/o/r/pull/42",
        integration_pr_head_sha: "c".repeat(40),
      }),
      tasks,
      workers: [],
      artifacts,
      events,
    });

    expect(detail.run.taskCount).toBe(1);
    expect(detail.run.workerCount).toBe(0);
    expect(detail.run.budgetUsd).toBe(12.5);
    expect(detail.run.maxConcurrency).toBe(8);
    expect(detail.run.planHash).toBe("hash-a");
    expect(detail.run.planText).toBeNull();
    expect(detail.run.approvedBy).toBe("operator");
    expect(detail.run).toMatchObject({
      mergeRequestKind: "automatic",
      mergeTarget: "github_pr",
      integrationState: "waiting_ci",
      integrationPrNumber: 42,
      integrationPrUrl: "https://github.com/o/r/pull/42",
      integrationPrHeadSha: "c".repeat(40),
    });
    expect(detail.run.approvalPreview.canApproveExecutableWork).toBe(false);
    expect(detail.tasks[0].fileClaims).toEqual([
      "app/page.tsx",
      "lib/fleet.ts",
    ]);
    expect(detail.tasks[0]).toMatchObject({
      integrationState: "merged",
      integrationOperationId: "merge-op-1",
      integratedHeadSha: "c".repeat(40),
      integratedAt: now,
      riskNotes: [
        {
          severity: "medium",
          risk: "The plan may affect mobile layout",
          mitigation: "Verify the compact task card",
        },
      ],
    });
    expect(detail.artifacts[0]).toMatchObject({
      title: "Needs clearer boundary",
      severity: "warning",
      taskId: "task-1",
      planHash: "hash-a",
    });
    expect(detail.events[0].payload).toEqual({ ok: true });
    expect(detail.events[1].payload).toBeNull();
  });
});
