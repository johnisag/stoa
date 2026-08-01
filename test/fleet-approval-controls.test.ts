import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import {
  approveFleetRunBudgetChange,
  approveFleetTaskClaimExpansion,
  convertFleetTaskToReadOnly,
  getFleetApprovalControlPreview,
  setFleetTaskManualLaunchApproval,
  skipFleetTaskWithApproval,
  updateFleetRunConcurrency,
  type FleetApprovalControlDeps,
  type FleetApprovalControlPreview,
} from "@/lib/fleet/approval-controls";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const RUN_ID = "run-approval-controls";
const TASK_ID = "task-approval-controls";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const NOW = new Date("2026-08-01T14:00:00.000Z");
const INITIAL_RUN_UPDATED_AT = "2026-08-01T12:00:00.000Z";
const INITIAL_TASK_UPDATED_AT = "2026-08-01T12:00:01.000Z";

let db: Database.Database;

function runtime(): Partial<FleetApprovalControlDeps> {
  return { db, now: () => NOW };
}

function rows() {
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as FleetRunRow;
  const tasks = db
    .prepare(
      `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
    )
    .all(RUN_ID) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskClaimRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskDependencyRow[];
  return { run, tasks, claims, dependencies };
}

function bindApprovedContract(): void {
  const before = rows();
  const planHash = hashFleetTaskRows(before.tasks, before.dependencies);
  db.prepare(
    `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ? WHERE id = ?`
  ).run(planHash, planHash, RUN_ID);
  db.prepare(
    `UPDATE fleet_tasks SET approved_task_hash = ? WHERE fleet_run_id = ?`
  ).run(planHash, RUN_ID);
  const current = rows();
  const executionHash = hashFleetExecutionContract(current);
  db.prepare(
    `UPDATE fleet_runs SET settings_json = ?, updated_at = ? WHERE id = ?`
  ).run(
    JSON.stringify({
      phase: "approved_plan",
      canSpawnWorkers: true,
      approvedPlanHash: planHash,
      approvedExecutionHash: executionHash,
    }),
    INITIAL_RUN_UPDATED_AT,
    RUN_ID
  );
}

function seedApprovedRun(
  input: {
    taskStatus?: string;
    taskApprovalState?: string;
    taskType?: string;
    taskClaims?: string[];
    currentAttempt?: number;
    taskBaseSha?: string | null;
    taskHeadSha?: string | null;
    actualClaims?: string[];
    failureCode?: string | null;
    budgetUsd?: number | null;
    budgetTokens?: number | null;
    spentBudgetUsd?: number;
    reservedBudgetUsd?: number;
    spentBudgetTokens?: number;
    reservedBudgetTokens?: number;
    budgetHardLimitAt?: string | null;
    budgetInterruptDeadlineAt?: string | null;
    runStatus?: string;
    pauseReason?: string | null;
  } = {}
): void {
  const policyJson = fleetAutomationPolicyJson(DEFAULT_FLEET_AUTOMATION_POLICY);
  const policyHash = hashFleetAutomationPolicy(DEFAULT_FLEET_AUTOMATION_POLICY);
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, desired_state, provider, review_policy,
      approval_state, automation_policy_json, automation_policy_hash,
      automation_base_sha, budget_usd, budget_tokens, spent_budget_usd,
      reserved_budget_usd, spent_budget_tokens, reserved_budget_tokens,
      budget_hard_limit_at, budget_interrupt_deadline_at,
      max_concurrency, pause_reason, settings_json, updated_at)
     VALUES (?, 'Approval controls', 'Safely control a live run', ?, 'running',
      'codex', 'four_agent', 'approved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      2, ?, '{}', ?)`
  ).run(
    RUN_ID,
    input.runStatus ?? "running",
    policyJson,
    policyHash,
    BASE_SHA,
    "budgetUsd" in input ? input.budgetUsd : 10,
    "budgetTokens" in input ? input.budgetTokens : null,
    input.spentBudgetUsd ?? 0,
    input.reservedBudgetUsd ?? 0,
    input.spentBudgetTokens ?? 0,
    input.reservedBudgetTokens ?? 0,
    input.budgetHardLimitAt ?? null,
    input.budgetInterruptDeadlineAt ?? null,
    input.pauseReason ?? null,
    INITIAL_RUN_UPDATED_AT
  );
  const taskClaims = input.taskClaims ?? ["src"];
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, current_attempt, base_sha, head_sha,
      actual_file_claims_json, approval_state, acceptance_criteria,
      verify_command, failure_code, updated_at)
     VALUES (?, ?, 'Implement safely', 'Bounded task', ?, ?, 0, ?, ?, ?, ?, ?, ?,
      'tests pass', 'npm test', ?, ?)`
  ).run(
    TASK_ID,
    RUN_ID,
    input.taskStatus ?? "ready",
    input.taskType ?? "implement",
    JSON.stringify(taskClaims),
    input.currentAttempt ?? 0,
    input.taskBaseSha ?? null,
    input.taskHeadSha ?? null,
    JSON.stringify(input.actualClaims ?? []),
    input.taskApprovalState ?? "approved",
    input.failureCode ?? null,
    INITIAL_TASK_UPDATED_AT
  );
  const insertClaim = db.prepare(
    `INSERT INTO fleet_task_claims
     (id, fleet_run_id, task_id, path, claim_type, confidence)
     VALUES (?, ?, ?, ?, 'exclusive', 1)`
  );
  for (const [index, claim] of taskClaims.entries()) {
    insertClaim.run(`claim-${index}`, RUN_ID, TASK_ID, claim);
  }
  bindApprovedContract();
}

function preview(): FleetApprovalControlPreview {
  return getFleetApprovalControlPreview(RUN_ID, db)!;
}

function runInput(requestId: string) {
  const state = preview();
  return {
    requestId,
    expectedPlanHash: state.bindings.approvedPlanHash,
    expectedExecutionHash: state.bindings.approvedExecutionHash,
    expectedPolicyHash: state.bindings.storedPolicyHash,
    expectedBaseSha: state.bindings.baseSha,
    expectedRunUpdatedAt: state.bindings.runUpdatedAt,
  };
}

function taskInput(requestId: string) {
  const state = preview();
  const task = state.tasks.find((entry) => entry.id === TASK_ID)!;
  return {
    ...runInput(requestId),
    expectedTaskStatus: task.status,
    expectedTaskApprovalState: task.approvalState,
    expectedAttempt: task.attempt,
    expectedTaskBaseSha: task.baseSha,
    expectedHeadSha: task.headSha,
    expectedTaskUpdatedAt: task.updatedAt,
  };
}

function skipInput(requestId: string) {
  const state = preview();
  const task = state.tasks.find((entry) => entry.id === TASK_ID)!;
  return {
    ...taskInput(requestId),
    expectedSkipClosureHash: task.skipClosure.hash,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe("Fleet run approval controls", () => {
  it("updates concurrency under exact hashes and replays one immutable approval", () => {
    seedApprovedRun();
    const requestId = `stoa_fleet_v1_${"b".repeat(43)}`;
    const input = { ...runInput(requestId), maxConcurrency: 5 };

    expect(
      updateFleetRunConcurrency(RUN_ID, input, "admin", runtime())
    ).toMatchObject({ ok: true, idempotent: false });
    expect(
      updateFleetRunConcurrency(RUN_ID, input, "admin", runtime())
    ).toMatchObject({ ok: true, idempotent: true });

    const state = preview();
    expect(state.run.maxConcurrency).toBe(5);
    expect(state.approvedVsCurrent).toEqual({
      planChanged: false,
      executionChanged: false,
      policyChanged: false,
    });
    expect(state.recentApprovals).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE event_type = 'approval_control_concurrency_approved'`
        )
        .get()
    ).toEqual({ n: 1 });
    const payload = db
      .prepare(
        `SELECT payload FROM fleet_events
         WHERE event_type = 'approval_control_concurrency_approved'`
      )
      .get() as { payload: string };
    expect(payload.payload).not.toContain(requestId);
    expect(JSON.parse(payload.payload).requestIdHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps exact-bound controls available during internal integration staging", () => {
    seedApprovedRun();
    db.prepare(
      `UPDATE fleet_runs SET status = 'merging', integration_state = 'integrating',
       integration_head_sha = ? WHERE id = ?`
    ).run(HEAD_SHA, RUN_ID);

    expect(
      updateFleetRunConcurrency(
        RUN_ID,
        { ...runInput("staging-concurrency"), maxConcurrency: 4 },
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true, idempotent: false });
    expect(
      db
        .prepare(
          `SELECT max_concurrency, merge_requested_at, integration_state
           FROM fleet_runs WHERE id = ?`
        )
        .get(RUN_ID)
    ).toEqual({
      max_concurrency: 4,
      merge_requested_at: null,
      integration_state: "integrating",
    });
  });

  it("freezes controls once external landing is authorized", () => {
    seedApprovedRun();
    const input = { ...runInput("landing-concurrency"), maxConcurrency: 4 };
    db.prepare(
      `UPDATE fleet_runs SET status = 'merging',
       merge_requested_at = ?, merge_requested_by = 'fleet-automation',
       merge_request_kind = 'automatic', merge_target = 'local',
       integration_state = 'ready_to_finalize' WHERE id = ?`
    ).run(NOW.toISOString(), RUN_ID);

    expect(
      updateFleetRunConcurrency(RUN_ID, input, "admin", runtime())
    ).toEqual({
      error: "Fleet run is terminal or external landing is already authorized",
      status: 409,
    });
  });

  it("raises the budget and explicitly releases only an exact budget hard stop", () => {
    seedApprovedRun({
      runStatus: "paused",
      pauseReason: "budget_exhausted",
      budgetUsd: 1,
      spentBudgetUsd: 1,
      budgetHardLimitAt: "2026-08-01T11:59:00.000Z",
      budgetInterruptDeadlineAt: "2026-08-01T12:01:00.000Z",
    });
    const input = {
      ...runInput("budget-1"),
      budgetUsd: 2,
      overrideHardStop: true,
      expectedPauseReason: "budget_exhausted",
    };

    expect(
      approveFleetRunBudgetChange(RUN_ID, input, "admin", runtime())
    ).toMatchObject({ ok: true, idempotent: false });
    expect(preview().run).toMatchObject({
      status: "paused",
      budgetUsd: 2,
      budgetHardLimitAt: null,
      budgetInterruptDeadlineAt: null,
      pauseReason: null,
    });
  });

  it("can increase the exact token cap without changing an unlimited USD cap", () => {
    seedApprovedRun({
      budgetUsd: null,
      budgetTokens: 100_000,
      spentBudgetTokens: 50_000,
    });
    expect(
      approveFleetRunBudgetChange(
        RUN_ID,
        {
          ...runInput("token-budget"),
          budgetTokens: 200_000,
          overrideHardStop: false,
          expectedPauseReason: null,
        },
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    expect(preview().run).toMatchObject({
      budgetUsd: null,
      budgetTokens: 200_000,
      spentBudgetTokens: 50_000,
    });
  });

  it("refuses stale run bindings and a hard-stop override that cannot fund a worker", () => {
    seedApprovedRun({
      runStatus: "paused",
      pauseReason: "budget_exhausted",
      budgetUsd: 1,
      spentBudgetUsd: 1,
    });
    const stale = runInput("stale-run");
    db.prepare(`UPDATE fleet_runs SET updated_at = 'changed' WHERE id = ?`).run(
      RUN_ID
    );
    expect(
      updateFleetRunConcurrency(
        RUN_ID,
        { ...stale, maxConcurrency: 3 },
        "admin",
        runtime()
      )
    ).toMatchObject({ status: 409, error: "Fleet run changed" });

    db.prepare(`UPDATE fleet_runs SET updated_at = ? WHERE id = ?`).run(
      INITIAL_RUN_UPDATED_AT,
      RUN_ID
    );
    expect(
      approveFleetRunBudgetChange(
        RUN_ID,
        {
          ...runInput("missing-override"),
          budgetUsd: 2,
          overrideHardStop: false,
          expectedPauseReason: "budget_exhausted",
        },
        "admin",
        runtime()
      )
    ).toMatchObject({
      status: 409,
      error: expect.stringContaining("explicit hard-stop override"),
    });
    expect(
      approveFleetRunBudgetChange(
        RUN_ID,
        {
          ...runInput("underfunded"),
          budgetUsd: 1.1,
          overrideHardStop: true,
          expectedPauseReason: "budget_exhausted",
        },
        "admin",
        runtime()
      )
    ).toMatchObject({
      status: 409,
      error: expect.stringContaining("cannot provide headroom"),
    });
  });
});

describe("Fleet not-yet-started task approval controls", () => {
  it("marks and then explicitly releases a manual launch gate", () => {
    seedApprovedRun();
    expect(
      setFleetTaskManualLaunchApproval(
        RUN_ID,
        TASK_ID,
        { ...taskInput("manual-require"), required: true },
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    expect(preview().tasks[0]).toMatchObject({
      manualLaunchApprovalRequired: true,
      approvalState: "blocked",
    });

    expect(
      setFleetTaskManualLaunchApproval(
        RUN_ID,
        TASK_ID,
        { ...taskInput("manual-release"), required: false },
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    expect(preview().tasks[0]).toMatchObject({
      manualLaunchApprovalRequired: false,
      approvalState: "approved",
    });
  });

  it("skips an exact untouched task without changing the approved contract", () => {
    seedApprovedRun();
    const before = preview();
    expect(
      skipFleetTaskWithApproval(
        RUN_ID,
        TASK_ID,
        skipInput("skip-1"),
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    const after = preview();
    expect(after.tasks[0].status).toBe("skipped");
    expect(after.bindings.approvedPlanHash).toBe(
      before.bindings.approvedPlanHash
    );
    expect(after.bindings.approvedExecutionHash).toBe(
      before.bindings.approvedExecutionHash
    );
  });

  it("propagates skip through the exact untouched blocking descendant closure", () => {
    seedApprovedRun();
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order,
        file_claims_json, approval_state, current_attempt, updated_at)
       VALUES ('dependent-task', ?, 'Dependent implementation', 'ready',
        'implement', 1, '["test"]', 'approved', 0,
        '2026-08-01T12:00:02.000Z')`
    ).run(RUN_ID);
    db.prepare(
      `INSERT INTO fleet_task_claims
       (id, fleet_run_id, task_id, path, claim_type, confidence)
       VALUES ('dependent-claim', ?, 'dependent-task', 'test', 'exclusive', 1)`
    ).run(RUN_ID);
    db.prepare(
      `INSERT INTO fleet_task_dependencies
       (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
       VALUES ('dependency-edge', ?, 'dependent-task', ?, 'blocks')`
    ).run(RUN_ID, TASK_ID);
    bindApprovedContract();

    const state = preview();
    expect(state.tasks[0].skipClosure).toMatchObject({
      taskIds: [TASK_ID, "dependent-task"],
      eligible: true,
    });
    expect(
      skipFleetTaskWithApproval(
        RUN_ID,
        TASK_ID,
        skipInput("skip-propagated"),
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    expect(
      db
        .prepare(
          `SELECT id, status, failure_code FROM fleet_tasks
           WHERE fleet_run_id = ? ORDER BY sort_order`
        )
        .all(RUN_ID)
    ).toEqual([
      { id: TASK_ID, status: "skipped", failure_code: "operator_skipped" },
      {
        id: "dependent-task",
        status: "skipped",
        failure_code: "operator_skip_dependency_propagated",
      },
    ]);
  });

  it("rejects a skip closure once a descendant has worker history", () => {
    seedApprovedRun();
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order,
        file_claims_json, approval_state, current_attempt, updated_at)
       VALUES ('dependent-task', ?, 'Dependent implementation', 'ready',
        'implement', 1, '[]', 'approved', 0,
        '2026-08-01T12:00:02.000Z')`
    ).run(RUN_ID);
    db.prepare(
      `INSERT INTO fleet_task_dependencies
       (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
       VALUES ('dependency-edge', ?, 'dependent-task', ?, 'blocks')`
    ).run(RUN_ID, TASK_ID);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, attempt)
       VALUES ('dependent-history', ?, 'dependent-task', 'failed', 1)`
    ).run(RUN_ID);
    bindApprovedContract();
    const input = skipInput("skip-blocked-descendant");

    expect(preview().tasks[0].skipClosure.eligible).toBe(false);
    expect(
      skipFleetTaskWithApproval(RUN_ID, TASK_ID, input, "admin", runtime())
    ).toMatchObject({
      status: 409,
      error: expect.stringContaining("skip closure is unsafe"),
    });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "ready" });
  });

  it("converts write scope to read-only and atomically rebinds plan/execution", () => {
    seedApprovedRun({ taskClaims: ["src", "test"] });
    const before = preview();
    expect(
      convertFleetTaskToReadOnly(
        RUN_ID,
        TASK_ID,
        taskInput("read-only-1"),
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true });
    const after = preview();
    expect(after.tasks[0].plannedClaims).toEqual([]);
    expect(after.bindings.approvedPlanHash).not.toBe(
      before.bindings.approvedPlanHash
    );
    expect(after.approvedVsCurrent).toEqual({
      planChanged: false,
      executionChanged: false,
      policyChanged: false,
    });
    expect(
      db.prepare(`SELECT task_type FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ task_type: "explore" });
  });

  it("never changes a task once any worker history exists", () => {
    seedApprovedRun();
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, attempt)
       VALUES ('historical-worker', ?, ?, 'failed', 1)`
    ).run(RUN_ID, TASK_ID);
    expect(
      skipFleetTaskWithApproval(
        RUN_ID,
        TASK_ID,
        skipInput("skip-history"),
        "admin",
        runtime()
      )
    ).toMatchObject({
      status: 409,
      error: expect.stringContaining("no worker history"),
    });
  });
});

describe("Fleet quarantined claim approval", () => {
  function seedQuarantine(): void {
    seedApprovedRun({
      taskStatus: "needs_inspection",
      taskClaims: ["src"],
      currentAttempt: 1,
      taskBaseSha: BASE_SHA,
      taskHeadSha: HEAD_SHA,
      actualClaims: ["src/a.ts", ".github/workflows/ci.yml"],
      failureCode: "claim_drift",
    });
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, attempt, base_sha, head_sha,
        report_state, report_status, report_collected_at)
       VALUES ('claim-worker', ?, ?, 'completed', 1, ?, ?, 'accepted',
        'succeeded', '2026-08-01T13:00:00.000Z')`
    ).run(RUN_ID, TASK_ID, BASE_SHA, HEAD_SHA);
  }

  it("shows approved-vs-actual drift and requires explicit sensitive approval", () => {
    seedQuarantine();
    const before = preview();
    expect(before.tasks[0]).toMatchObject({
      quarantinedForClaimApproval: true,
      addedActualClaims: [".github/workflows/ci.yml"],
    });
    expect(before.tasks[0].sensitivePaths).toEqual([
      { path: ".github/workflows/ci.yml", reason: "automation" },
    ]);
    const common = {
      ...taskInput("claims-sensitive"),
      expectedActualClaimsHash: before.tasks[0].actualClaimsHash,
      approvedActualClaims: before.tasks[0].actualClaims,
    };
    expect(
      approveFleetTaskClaimExpansion(
        RUN_ID,
        TASK_ID,
        { ...common, approveSensitivePaths: false },
        "admin",
        runtime()
      )
    ).toMatchObject({
      status: 409,
      error: "sensitive paths require explicit approval",
    });

    expect(
      approveFleetTaskClaimExpansion(
        RUN_ID,
        TASK_ID,
        { ...common, approveSensitivePaths: true },
        "admin",
        runtime()
      )
    ).toMatchObject({ ok: true, idempotent: false });
    const after = preview();
    expect(after.tasks[0]).toMatchObject({
      status: "verifying",
      addedActualClaims: [],
      quarantinedForClaimApproval: false,
    });
    expect(after.tasks[0].plannedClaims).toEqual([
      ".github/workflows/ci.yml",
      "src",
      "src/a.ts",
    ]);
    expect(after.approvedVsCurrent).toEqual({
      planChanged: false,
      executionChanged: false,
      policyChanged: false,
    });
    expect(
      db
        .prepare(
          `SELECT verification_id, review_status, failure_code
           FROM fleet_tasks WHERE id = ?`
        )
        .get(TASK_ID)
    ).toEqual({
      verification_id: null,
      review_status: null,
      failure_code: null,
    });
  });

  it("refuses to reuse a head that already has verification evidence", () => {
    seedQuarantine();
    db.prepare(
      `INSERT INTO fleet_verifications
       (id, fleet_run_id, task_id, attempt, base_sha, head_sha, spec_hash,
        command, status)
       VALUES ('old-verification', ?, ?, 1, ?, ?, ?, 'npm test', 'pass')`
    ).run(RUN_ID, TASK_ID, BASE_SHA, HEAD_SHA, "c".repeat(64));
    const state = preview();
    expect(
      approveFleetTaskClaimExpansion(
        RUN_ID,
        TASK_ID,
        {
          ...taskInput("claims-old-evidence"),
          expectedActualClaimsHash: state.tasks[0].actualClaimsHash,
          approvedActualClaims: state.tasks[0].actualClaims,
          approveSensitivePaths: true,
        },
        "admin",
        runtime()
      )
    ).toMatchObject({
      status: 409,
      error: expect.stringContaining("fresh descendant head"),
    });
  });
});

describe("Fleet approval preview", () => {
  it("detects unapproved plan/execution drift without mutating it", () => {
    seedApprovedRun();
    db.prepare(
      `UPDATE fleet_tasks SET file_claims_json = '["foreign"]' WHERE id = ?`
    ).run(TASK_ID);
    expect(preview().approvedVsCurrent).toMatchObject({
      planChanged: true,
      executionChanged: true,
    });
  });
});
