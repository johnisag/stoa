import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

vi.mock("@/lib/git-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-status")>();
  return {
    ...actual,
    getDefaultBranch: () => "main",
    isGitRepo: () => true,
    resolveGitCommit: () => "a".repeat(40),
  };
});

import { queries } from "@/lib/db";
import {
  FLEET_PLAN_REVIEW_LENSES,
  evaluateAutomaticApproval,
  evaluateAutomaticMerge,
  evaluateAutomaticStart,
  reconcileFleetAutomation,
} from "@/lib/fleet/automation";
import { DEFAULT_FLEET_AUTOMATION_POLICY } from "@/lib/fleet/automation-policy";
import { hashFleetExecutionContract } from "@/lib/fleet/hash";
import {
  createDraftFleetRun,
  ingestFleetRunPlan,
  ingestGeneratedFleetRunPlan,
} from "@/lib/fleet/service";
import type {
  FleetAutomationPolicy,
  FleetReviewEvidenceRow,
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const BASE_SHA = "a".repeat(40);
const PLAN_HASH = "b".repeat(64);
const EXECUTION_HASH = "c".repeat(64);
const POLICY_HASH = "d".repeat(64);

function db() {
  return state.db as InstanceType<typeof Database>;
}

function policy(
  overrides: Partial<FleetAutomationPolicy> = {}
): FleetAutomationPolicy {
  return { ...DEFAULT_FLEET_AUTOMATION_POLICY, ...overrides };
}

function cleanReviews(): FleetReviewEvidenceRow[] {
  return FLEET_PLAN_REVIEW_LENSES.map((lens, index) => ({
    id: `review-${index}`,
    fleet_run_id: "run-1",
    subject_type: "plan",
    subject_hash: PLAN_HASH,
    policy_hash: POLICY_HASH,
    execution_hash: EXECUTION_HASH,
    base_sha: BASE_SHA,
    lens,
    reviewer_session_id: `critic-${index}`,
    verdict: "clean",
    created_at: "2026-08-01T00:00:00.000Z",
  }));
}

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  state.db = memory;
});

beforeEach(() => {
  db().exec(`
    DELETE FROM fleet_reviews;
    DELETE FROM fleet_action_authorizations;
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  queries
    .createProject(db())
    .run(
      "fleet-auto-project",
      "Fleet auto",
      "C:\\repo",
      "claude",
      "sonnet",
      null,
      1
    );
  queries
    .createDispatchRepo(db())
    .run(
      "fleet-auto-repo",
      "C:\\repo",
      "owner/repo",
      "codex",
      10,
      4,
      null,
      "main",
      "review",
      1,
      1,
      0,
      0,
      1,
      "npm test",
      "fleet-auto-project"
    );
});

describe("Fleet automation decisions", () => {
  it("fails closed until four exact, independent clean critic records exist", () => {
    const base = {
      policy: policy({
        automaticPlanning: true,
        automaticPlanApproval: true,
      }),
      policyHashMatches: true,
      authorized: true,
      desiredState: "planned" as const,
      status: "draft" as const,
      approvalState: "needs_approval" as const,
      reviewPolicy: "four_agent" as const,
      planHash: PLAN_HASH,
      executionHash: EXECUTION_HASH,
      baseSha: BASE_SHA,
      currentBaseSha: BASE_SHA,
      plannerState: "ready" as const,
      graphHashMatches: true,
      blockerCount: 0,
      claimPaths: ["lib/fleet/automation.ts"],
    };

    expect(evaluateAutomaticApproval({ ...base, reviews: [] })).toEqual({
      action: "wait",
      reason: "four independent clean plan critics are required",
    });
    expect(
      evaluateAutomaticApproval({ ...base, reviews: cleanReviews() })
    ).toEqual({ action: "plan_approval" });
    expect(
      evaluateAutomaticApproval({
        ...base,
        reviews: cleanReviews().map((review) => ({
          ...review,
          reviewer_session_id: "same-session",
        })),
      })
    ).toMatchObject({ action: "wait" });
  });

  it("blocks unknown, sensitive, and base-drifted plans", () => {
    const base = {
      policy: policy({
        automaticPlanning: true,
        automaticPlanApproval: true,
      }),
      policyHashMatches: true,
      authorized: true,
      desiredState: "planned" as const,
      status: "draft" as const,
      approvalState: "needs_approval" as const,
      reviewPolicy: "four_agent" as const,
      planHash: PLAN_HASH,
      executionHash: EXECUTION_HASH,
      baseSha: BASE_SHA,
      currentBaseSha: BASE_SHA,
      plannerState: "ready" as const,
      graphHashMatches: true,
      blockerCount: 0,
      reviews: cleanReviews(),
    };
    expect(
      evaluateAutomaticApproval({ ...base, claimPaths: ["*"] })
    ).toMatchObject({ reason: "plan has unknown file claims" });
    expect(
      evaluateAutomaticApproval({
        ...base,
        claimPaths: [".github/workflows/release.yml"],
      })
    ).toMatchObject({ reason: "plan touches sensitive paths" });
    for (const claimPath of [
      "src/auth/session.ts",
      "package-lock.json",
      "db/migrations/001-add-user.sql",
      "db/schema/user.sql",
      "AGENTS.md",
      ".codex/skills/release/SKILL.md",
      ".agents/skills/review/SKILL.md",
      "package.json",
      "vite.config.ts",
      ".env.production",
    ]) {
      expect(
        evaluateAutomaticApproval({ ...base, claimPaths: [claimPath] }),
        claimPath
      ).toMatchObject({ reason: "plan touches sensitive paths" });
    }
    expect(
      evaluateAutomaticApproval({
        ...base,
        currentBaseSha: "e".repeat(40),
        claimPaths: ["lib/fleet.ts"],
      })
    ).toMatchObject({ reason: "base commit changed" });
    expect(
      evaluateAutomaticApproval({
        ...base,
        claimPaths: ["lib/fleet.ts"],
        unverifiedWriteTaskCount: 1,
      })
    ).toEqual({
      action: "wait",
      reason: "write tasks require a verification command",
    });
  });

  it("requires confinement or explicit consent before automatic start", () => {
    const base = {
      policy: policy({
        automaticPlanning: true,
        automaticPlanApproval: true,
        automaticStart: true,
      }),
      policyHashMatches: true,
      authorized: true,
      desiredState: "running" as const,
      status: "planned" as const,
      approvalState: "approved" as const,
      planHash: PLAN_HASH,
      approvedPlanHash: PLAN_HASH,
      approvedExecutionHash: EXECUTION_HASH,
      currentExecutionHash: EXECUTION_HASH,
      baseSha: BASE_SHA,
      currentBaseSha: BASE_SHA,
      recoveryRequired: false,
      schedulerReady: true,
      confinementAvailable: false,
    };
    expect(evaluateAutomaticStart(base)).toMatchObject({
      reason: "automatic start requires confinement or explicit consent",
    });
    expect(
      evaluateAutomaticStart({
        ...base,
        policy: { ...base.policy, allowUnconfinedAgents: true },
      })
    ).toEqual({ action: "start" });
  });

  it("requires automatic start but not automatic-fix authority before merge", () => {
    expect(evaluateAutomaticMerge(policy({ automaticMerge: true }))).toEqual({
      action: "wait",
      reason: "automatic start is not enabled",
    });
    expect(
      evaluateAutomaticMerge(
        policy({
          automaticMerge: true,
          automaticStart: true,
        })
      )
    ).toEqual({ action: "merge" });
  });
});

function createPlannedAutomationRun(automaticStart: boolean) {
  const created = createDraftFleetRun({
    name: "Automated Fleet",
    goal: "Plan, review, and safely start",
    repoId: "fleet-auto-repo",
    provider: "codex",
    automationPolicy: {
      automaticPlanning: true,
      automaticPlanApproval: true,
      automaticStart,
    },
  });
  if ("error" in created) throw new Error(created.error);
  const planned = ingestGeneratedFleetRunPlan(created.run.run.id, {
    planText: "1. Implement automation [files: lib/fleet/automation.ts]",
    tasks: [
      {
        title: "Implement automation",
        description: "Implement the exact approved behavior.",
        taskType: "implementation",
        parentIndex: null,
        sortOrder: 0,
        fileClaims: ["lib/fleet/automation.ts"],
        agentType: "codex",
        model: null,
        acceptanceCriteria: "Automation tests pass.",
        verifyCommand: "npm test",
      },
    ],
  });
  if ("error" in planned) throw new Error(planned.error);
  return planned.run.run.id;
}

function createPlanningAutomationRun(allowUnconfinedAgents = true) {
  const created = createDraftFleetRun({
    name: "Planning intent",
    goal: "Generate one durable plan",
    repoId: "fleet-auto-repo",
    provider: "codex",
    automationPolicy: {
      automaticPlanning: true,
      plannerTaskCap: 12,
      allowUnconfinedAgents,
    },
  });
  if ("error" in created) throw new Error(created.error);
  return created;
}

function insertExactCleanReviews(runId: string): string {
  const run = queries.getFleetRun(db()).get(runId) as FleetRunRow;
  const tasks = queries.listFleetTasksForRun(db()).all(runId) as FleetTaskRow[];
  const claims = db()
    .prepare("SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?")
    .all(runId) as FleetTaskClaimRow[];
  const dependencies = db()
    .prepare("SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?")
    .all(runId) as FleetTaskDependencyRow[];
  const executionHash = hashFleetExecutionContract({
    run,
    tasks: tasks.map((task) => ({
      ...task,
      working_directory: task.working_directory ?? "C:\\repo",
      base_branch: task.base_branch ?? "main",
    })),
    claims,
    dependencies,
  });
  const insert = db().prepare(`
    INSERT INTO fleet_reviews (
      id, fleet_run_id, subject_type, subject_hash, policy_hash,
      execution_hash, base_sha, lens, reviewer_session_id, verdict, state
    ) VALUES (?, ?, 'plan', ?, ?, ?, ?, ?, ?, 'clean', 'clean')
  `);
  for (const [index, lens] of FLEET_PLAN_REVIEW_LENSES.entries()) {
    insert.run(
      `${runId}-${lens}`,
      runId,
      run.plan_hash,
      run.automation_policy_hash,
      executionHash,
      run.automation_base_sha,
      lens,
      `critic-session-${index}`
    );
  }
  return executionHash;
}

describe("reconcileFleetAutomation", () => {
  it("does not launch an automatic planner without confinement or explicit consent", async () => {
    const created = createPlanningAutomationRun(false);
    const startPlanner = vi.fn(async () => ({ run: created.run }));

    await reconcileFleetAutomation(40, {
      db: db(),
      startPlanner,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => true,
      confinementAvailable: () => false,
    });
    await reconcileFleetAutomation(40, {
      db: db(),
      startPlanner,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => true,
      confinementAvailable: () => false,
    });

    expect(startPlanner).not.toHaveBeenCalled();
    expect(
      db()
        .prepare(
          "SELECT status FROM fleet_action_authorizations WHERE fleet_run_id = ? AND action = 'planning'"
        )
        .get(created.run.run.id)
    ).toEqual({ status: "authorized" });
    expect(
      db()
        .prepare("SELECT automation_last_error FROM fleet_runs WHERE id = ?")
        .get(created.run.run.id)
    ).toEqual({
      automation_last_error:
        "automatic planning requires confinement or explicit consent",
    });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'automation_waiting'`
        )
        .get(created.run.run.id)
    ).toEqual({ n: 1 });
  });

  it("does not spin an idle planner before its durable retry deadline", async () => {
    const created = createPlanningAutomationRun();
    const runId = created.run.run.id;
    const row = queries.getFleetRun(db()).get(runId) as FleetRunRow;
    const settings = JSON.parse(row.settings_json);
    settings.planner = {
      state: "idle",
      failureCount: 1,
      retryNotBefore: "2026-08-01T12:00:05.000Z",
    };
    db()
      .prepare(
        `UPDATE fleet_runs SET settings_json = ?, automation_base_sha = ? WHERE id = ?`
      )
      .run(JSON.stringify(settings), BASE_SHA, runId);
    const startPlanner = vi.fn(async () => ({ run: created.run }));
    const common = {
      db: db(),
      startPlanner,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => false,
      confinementAvailable: () => false,
    };

    await reconcileFleetAutomation(40, {
      ...common,
      now: () => new Date("2026-08-01T12:00:04.999Z"),
    });
    expect(startPlanner).not.toHaveBeenCalled();

    await reconcileFleetAutomation(40, {
      ...common,
      now: () => new Date("2026-08-01T12:00:05.000Z"),
    });
    expect(startPlanner).toHaveBeenCalledTimes(1);
  });

  it("consumes a durable planning grant once across repeated reconciles", async () => {
    const created = createPlanningAutomationRun();
    const startPlanner = vi.fn(async () => ({ run: created.run }));
    const overrides = {
      db: db(),
      startPlanner,
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => false,
      confinementAvailable: () => false,
    };

    await reconcileFleetAutomation(40, overrides);
    await reconcileFleetAutomation(40, overrides);

    expect(startPlanner).toHaveBeenCalledTimes(1);
    expect(startPlanner).toHaveBeenCalledWith(
      created.run.run.id,
      { taskCap: 12 },
      "fleet-automation"
    );
    expect(
      db()
        .prepare(
          "SELECT status, base_sha FROM fleet_action_authorizations WHERE fleet_run_id = ? AND action = 'planning'"
        )
        .get(created.run.run.id)
    ).toEqual({ status: "consumed", base_sha: BASE_SHA });
  });

  it("redacts automation failures consistently across state and audit evidence", async () => {
    const created = createPlanningAutomationRun();
    const runId = created.run.run.id;
    const secret = "automation-failure-canary";

    await reconcileFleetAutomation(40, {
      db: db(),
      startPlanner: vi.fn(async () => ({
        error: `password: "${secret}"`,
      })),
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => false,
      confinementAvailable: () => false,
    });

    const run = db()
      .prepare(`SELECT automation_last_error FROM fleet_runs WHERE id = ?`)
      .get(runId) as { automation_last_error: string };
    const authorization = db()
      .prepare(
        `SELECT attempt_count, last_error FROM fleet_action_authorizations
         WHERE fleet_run_id = ? AND action = 'planning'`
      )
      .get(runId) as { attempt_count: number; last_error: string };
    const audit = db()
      .prepare(
        `SELECT payload FROM fleet_events
         WHERE fleet_run_id = ? AND event_type = 'automation_action_failed'`
      )
      .get(runId) as { payload: string };
    const persisted = JSON.stringify({ run, authorization, audit });

    expect(persisted).not.toContain(secret);
    expect(run.automation_last_error).toContain("[REDACTED]");
    expect(authorization).toMatchObject({
      attempt_count: 1,
      last_error: run.automation_last_error,
    });
    expect(JSON.parse(audit.payload)).toMatchObject({
      action: "planning",
      error: run.automation_last_error,
    });
  });

  it("rolls back base binding when its required audit event is over quota", async () => {
    const created = createPlanningAutomationRun();
    const runId = created.run.run.id;
    db()
      .prepare(`UPDATE fleet_runs SET resource_limits_json = ? WHERE id = ?`)
      .run(JSON.stringify({ eventBytesTotal: 1 }), runId);
    const startPlanner = vi.fn(async () => ({ run: created.run }));

    await expect(
      reconcileFleetAutomation(40, {
        db: db(),
        startPlanner,
        resolveBaseSha: async () => BASE_SHA,
        schedulerReady: () => false,
        confinementAvailable: () => false,
      })
    ).rejects.toThrow(/event_bytes_total quota exceeded/);

    expect(startPlanner).not.toHaveBeenCalled();
    expect(
      db()
        .prepare(
          `SELECT automation_base_sha, automation_last_error
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ automation_base_sha: null, automation_last_error: null });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type IN
             ('automation_base_bound', 'automation_action_failed')`
        )
        .get(runId)
    ).toEqual({ n: 0 });
  });

  it("rolls back failure state when the failure audit event is over quota", async () => {
    const created = createPlanningAutomationRun();
    const runId = created.run.run.id;
    db()
      .prepare(
        `UPDATE fleet_runs
       SET automation_base_sha = ?, resource_limits_json = ?
       WHERE id = ?`
      )
      .run(BASE_SHA, JSON.stringify({ eventBytesTotal: 1 }), runId);

    await expect(
      reconcileFleetAutomation(40, {
        db: db(),
        startPlanner: vi.fn(async () => ({ error: "planner refused" })),
        resolveBaseSha: async () => BASE_SHA,
        schedulerReady: () => false,
        confinementAvailable: () => false,
      })
    ).rejects.toThrow(/event_bytes_total quota exceeded/);

    expect(
      db()
        .prepare(`SELECT automation_last_error FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ automation_last_error: null });
    expect(
      db()
        .prepare(
          `SELECT attempt_count, last_error FROM fleet_action_authorizations
           WHERE fleet_run_id = ? AND action = 'planning'`
        )
        .get(runId)
    ).toEqual({ attempt_count: 0, last_error: null });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'automation_action_failed'`
        )
        .get(runId)
    ).toEqual({ n: 0 });
  });

  it("auto-approves exact critic evidence and CAS-starts only when safe", async () => {
    const runId = createPlannedAutomationRun(true);
    const common = {
      db: db(),
      resolveBaseSha: async () => BASE_SHA,
      schedulerReady: () => false,
      confinementAvailable: () => false,
      reconcileRun: vi.fn(async () => 0),
      reconcilePlanReviews: vi.fn(async () => undefined),
    };

    await reconcileFleetAutomation(40, common);
    const executionHash = insertExactCleanReviews(runId);
    await reconcileFleetAutomation(40, common);
    expect(common.reconcilePlanReviews).not.toHaveBeenCalled();

    let run = queries.getFleetRun(db()).get(runId) as FleetRunRow;
    expect(run.status).toBe("planned");
    expect(run.approval_state).toBe("approved");
    expect(
      db()
        .prepare(
          "SELECT status, execution_hash FROM fleet_action_authorizations WHERE fleet_run_id = ? AND action = 'plan_approval'"
        )
        .get(runId)
    ).toEqual({ status: "consumed", execution_hash: executionHash });

    await reconcileFleetAutomation(40, {
      ...common,
      schedulerReady: () => true,
    });
    run = queries.getFleetRun(db()).get(runId) as FleetRunRow;
    expect(run.status).toBe("planned");

    const reconcileRun = vi.fn(async () => 0);
    await reconcileFleetAutomation(40, {
      ...common,
      schedulerReady: () => true,
      confinementAvailable: () => true,
      reconcileRun,
    });
    await reconcileFleetAutomation(40, {
      ...common,
      schedulerReady: () => true,
      confinementAvailable: () => true,
      reconcileRun,
    });

    run = queries.getFleetRun(db()).get(runId) as FleetRunRow;
    expect(run.status).toBe("running");
    expect(reconcileRun).toHaveBeenCalledTimes(1);
    expect(
      db()
        .prepare(
          "SELECT status, execution_hash FROM fleet_action_authorizations WHERE fleet_run_id = ? AND action = 'start'"
        )
        .get(runId)
    ).toEqual({ status: "consumed", execution_hash: executionHash });
  });
});
