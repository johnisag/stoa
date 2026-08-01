import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import {
  DEFAULT_FLEET_AUTOMATION_POLICY,
  fleetAutomationPolicyJson,
} from "@/lib/fleet/automation-policy";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import {
  killFleetWorker,
  messageFleetWorker,
  reconcileFleetTaskReview,
  reconcileFleetTaskVerification,
  retryFleetTask,
  type FleetOperatorDeps,
} from "@/lib/fleet/operator-actions";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";

const RUN_ID = "run-operator";
const TASK_ID = "task-operator";
const WORKER_ID = "worker-operator";
const SESSION_ID = "session-operator";
const NOW = new Date("2026-08-01T12:00:00.000Z");
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const OUTPUT_HASH = "c".repeat(64);
const WORKTREE = "C:\\repo\\.stoa-worktrees\\task-operator";
const BRANCH = "fleet-task-operator";

let db: Database.Database;
let planHash: string;

function operatorDeps(
  overrides: Partial<FleetOperatorDeps> = {}
): Partial<FleetOperatorDeps> {
  return {
    db,
    now: () => NOW,
    sendMessage: async () => true,
    stopSession: async () => true,
    reconcileVerification: async () => 1,
    reconcileReview: async () => 1,
    ...overrides,
  };
}

function seedApprovedTask(
  input: {
    status?: string;
    currentAttempt?: number;
    maxAttempts?: number;
    headSha?: string | null;
    budgetUsd?: number | null;
    spentBudgetUsd?: number;
    reservedBudgetUsd?: number;
  } = {}
): void {
  const policyJson = fleetAutomationPolicyJson(DEFAULT_FLEET_AUTOMATION_POLICY);
  const policyHash = hashFleetAutomationPolicy(DEFAULT_FLEET_AUTOMATION_POLICY);
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, desired_state, provider, review_policy,
      approval_state, automation_policy_json, automation_policy_hash,
      budget_usd, spent_budget_usd, reserved_budget_usd, settings_json)
     VALUES (?, 'Operator run', 'Exercise controls', 'running', 'running',
      'codex', 'four_agent', 'approved', ?, ?, ?, ?, ?, '{}')`
  ).run(
    RUN_ID,
    policyJson,
    policyHash,
    input.budgetUsd ?? 10,
    input.spentBudgetUsd ?? 0,
    input.reservedBudgetUsd ?? 0
  );
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, description, status, task_type, sort_order,
      file_claims_json, priority, working_directory, base_branch, branch_name,
      worktree_path, base_sha, head_sha, actual_file_claims_json,
      current_attempt, max_attempts, acceptance_criteria, verify_command,
      approval_state, failure_code)
     VALUES (?, ?, 'Operator task', 'Change code safely', ?, 'implementation', 0,
      '[]', 0, 'C:\\repo', 'main', ?, ?, ?, ?, '["src/a.ts"]', ?, ?,
      'tests pass', 'npm test', 'approved', 'test_failure')`
  ).run(
    TASK_ID,
    RUN_ID,
    input.status ?? "needs_inspection",
    BRANCH,
    WORKTREE,
    BASE_SHA,
    "headSha" in input ? input.headSha : HEAD_SHA,
    input.currentAttempt ?? 1,
    input.maxAttempts ?? 3
  );

  const tasks = db
    .prepare(`SELECT * FROM fleet_tasks WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskRow[];
  const dependencies = db
    .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskDependencyRow[];
  planHash = hashFleetTaskRows(tasks, dependencies);
  db.prepare(
    `UPDATE fleet_runs SET plan_hash = ?, approved_plan_hash = ? WHERE id = ?`
  ).run(planHash, planHash, RUN_ID);
  db.prepare(`UPDATE fleet_tasks SET approved_task_hash = ? WHERE id = ?`).run(
    planHash,
    TASK_ID
  );
  const run = db
    .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
    .get(RUN_ID) as FleetRunRow;
  const approvedTasks = db
    .prepare(`SELECT * FROM fleet_tasks WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskRow[];
  const claims = db
    .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
    .all(RUN_ID) as FleetTaskClaimRow[];
  const executionHash = hashFleetExecutionContract({
    run,
    tasks: approvedTasks,
    claims,
    dependencies,
  });
  db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
    JSON.stringify({ approvedExecutionHash: executionHash }),
    RUN_ID
  );
}

function seedHistoricalEvidence(): void {
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, task_id, attempt, plan_hash, base_sha, head_sha,
      artifact_type, title, body, severity, actor)
     VALUES ('report-old', ?, ?, 1, ?, ?, ?, 'worker_report', 'Report', '{}',
      'info', 'worker')`
  ).run(RUN_ID, TASK_ID, planHash, BASE_SHA, HEAD_SHA);
  db.prepare(
    `INSERT INTO fleet_artifacts
     (id, fleet_run_id, task_id, attempt, plan_hash, base_sha, head_sha,
      artifact_type, title, body, severity, actor)
     VALUES ('verify-old-output', ?, ?, 1, ?, ?, ?, 'verification_output',
      'Verify', 'failed', 'blocker', 'verifier')`
  ).run(RUN_ID, TASK_ID, planHash, BASE_SHA, HEAD_SHA);
  db.prepare(
    `INSERT INTO fleet_verifications
     (id, fleet_run_id, task_id, attempt, base_sha, head_sha, spec_hash,
      command, status, output_artifact_id, output_hash)
     VALUES ('verify-old', ?, ?, 1, ?, ?, ?, 'npm test', 'fail',
      'verify-old-output', ?)`
  ).run(RUN_ID, TASK_ID, BASE_SHA, HEAD_SHA, "d".repeat(64), OUTPUT_HASH);
  db.prepare(
    `INSERT INTO fleet_task_reviews
     (id, fleet_run_id, task_id, attempt, base_sha, head_sha, verification_id,
      verification_spec_hash, verification_evidence_hash, policy_hash, lens,
      reviewer_session_id, verdict, state)
     VALUES ('review-old', ?, ?, 1, ?, ?, 'verify-old', ?, ?, ?,
      'correctness_security', 'reviewer-old', 'changes_requested', 'failed')`
  ).run(
    RUN_ID,
    TASK_ID,
    BASE_SHA,
    HEAD_SHA,
    "d".repeat(64),
    OUTPUT_HASH,
    "e".repeat(64)
  );
  db.prepare(
    `UPDATE fleet_tasks SET report_artifact_id = 'report-old',
     verification_id = 'verify-old', verification_status = 'fail',
     verification_spec_hash = ?, verified_head_sha = ?,
     verification_artifact_id = 'verify-old-output',
     review_status = 'changes_requested', review_head_sha = ?,
     review_verification_hash = ? WHERE id = ?`
  ).run("d".repeat(64), HEAD_SHA, HEAD_SHA, OUTPUT_HASH, TASK_ID);
}

function seedActiveWorker(): void {
  db.prepare(
    `INSERT INTO sessions
     (id, name, status, working_directory, group_path, agent_type, worktree_path,
      branch_name, worker_status, tmux_name)
     VALUES (?, 'Fleet worker', 'running', ?, 'sessions', 'codex', ?, ?,
      'running', 'stoa-codex-worker')`
  ).run(SESSION_ID, WORKTREE, WORKTREE, BRANCH);
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, session_id, status, provider, attempt,
      worktree_path, branch_name, base_sha, reservation_usd)
     VALUES (?, ?, ?, ?, 'running', 'codex', 1, ?, ?, ?, 0.25)`
  ).run(WORKER_ID, RUN_ID, TASK_ID, SESSION_ID, WORKTREE, BRANCH, BASE_SHA);
  db.prepare(
    `INSERT INTO fleet_resource_leases
     (id, fleet_run_id, worker_id, resource_type, resource_key, status)
     VALUES ('lease-pty', ?, ?, 'pty', 'local', 'reserved'),
            ('lease-worktree', ?, ?, 'worktree', ?, 'reserved')`
  ).run(RUN_ID, WORKER_ID, RUN_ID, WORKER_ID, WORKTREE);
  db.prepare(
    `UPDATE fleet_runs SET reserved_budget_usd = 0.25 WHERE id = ?`
  ).run(RUN_ID);
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe("Fleet task operator actions", () => {
  it("queues one exact retry while preserving immutable evidence and worktrees", () => {
    seedApprovedTask();
    seedHistoricalEvidence();
    const input = {
      requestId: "retry-1",
      expectedPlanHash: planHash,
      expectedAttempt: 1,
      expectedHeadSha: HEAD_SHA,
    };

    expect(
      retryFleetTask(RUN_ID, TASK_ID, input, "admin", operatorDeps())
    ).toMatchObject({
      ok: true,
      idempotent: false,
      queued: true,
    });
    expect(
      retryFleetTask(RUN_ID, TASK_ID, input, "admin", operatorDeps())
    ).toMatchObject({
      ok: true,
      idempotent: true,
    });

    const task = db
      .prepare(`SELECT * FROM fleet_tasks WHERE id = ?`)
      .get(TASK_ID) as FleetTaskRow;
    expect(task).toMatchObject({
      status: "ready",
      current_attempt: 1,
      head_sha: null,
      worktree_path: null,
      verification_id: null,
      review_status: null,
      base_sha: BASE_SHA,
      branch_name: BRANCH,
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_verifications`).get()
    ).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_task_reviews`).get()
    ).toEqual({ n: 1 });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_artifacts`).get()
    ).toEqual({ n: 2 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events WHERE event_type = 'task_retry_queued'`
        )
        .get()
    ).toEqual({ n: 1 });
  });

  it("refuses stale, exhausted, and budget-blocked retries", () => {
    seedApprovedTask();
    expect(
      retryFleetTask(
        RUN_ID,
        TASK_ID,
        {
          requestId: "retry-stale",
          expectedPlanHash: planHash,
          expectedAttempt: 1,
          expectedHeadSha: "f".repeat(40),
        },
        "admin",
        operatorDeps()
      )
    ).toMatchObject({ status: 409, error: "task head changed" });

    db.prepare(
      `UPDATE fleet_tasks SET current_attempt = max_attempts WHERE id = ?`
    ).run(TASK_ID);
    expect(
      retryFleetTask(
        RUN_ID,
        TASK_ID,
        {
          requestId: "retry-exhausted",
          expectedPlanHash: planHash,
          expectedAttempt: 3,
          expectedHeadSha: HEAD_SHA,
        },
        "admin",
        operatorDeps()
      )
    ).toMatchObject({ status: 409, error: expect.stringContaining("maximum") });
  });

  it("does not queue a retry that the approved run budget cannot reserve", () => {
    seedApprovedTask({ budgetUsd: 0.25, spentBudgetUsd: 0.25 });
    expect(
      retryFleetTask(
        RUN_ID,
        TASK_ID,
        {
          requestId: "retry-budget",
          expectedPlanHash: planHash,
          expectedAttempt: 1,
          expectedHeadSha: HEAD_SHA,
        },
        "admin",
        operatorDeps()
      )
    ).toMatchObject({
      status: 409,
      error: "Fleet budget cannot reserve another attempt",
    });
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(TASK_ID)
    ).toEqual({ status: "needs_inspection" });
  });

  it("dispatches exact scoped verification and review reconciliation once", async () => {
    seedApprovedTask({ status: "verifying" });
    const verify = vi.fn(async () => 1);
    const verifyInput = {
      requestId: "verify-1",
      expectedPlanHash: planHash,
      expectedAttempt: 1,
      expectedHeadSha: HEAD_SHA,
    };
    await expect(
      reconcileFleetTaskVerification(
        RUN_ID,
        TASK_ID,
        verifyInput,
        "admin",
        operatorDeps({ reconcileVerification: verify })
      )
    ).resolves.toMatchObject({ ok: true, processed: 1, idempotent: false });
    await reconcileFleetTaskVerification(
      RUN_ID,
      TASK_ID,
      verifyInput,
      "admin",
      operatorDeps({ reconcileVerification: verify })
    );
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({
      runId: RUN_ID,
      taskId: TASK_ID,
      maxPerTick: 1,
    });

    db.prepare(
      `INSERT INTO fleet_verifications
       (id, fleet_run_id, task_id, attempt, base_sha, head_sha, spec_hash,
        command, status, output_hash)
       VALUES ('verify-current', ?, ?, 1, ?, ?, ?, 'npm test', 'pass', ?)`
    ).run(RUN_ID, TASK_ID, BASE_SHA, HEAD_SHA, "d".repeat(64), OUTPUT_HASH);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'reviewing', verification_id = 'verify-current',
       verification_status = 'pass', verified_head_sha = ? WHERE id = ?`
    ).run(HEAD_SHA, TASK_ID);
    const review = vi.fn(async () => 1);
    await expect(
      reconcileFleetTaskReview(
        RUN_ID,
        TASK_ID,
        {
          requestId: "review-1",
          expectedPlanHash: planHash,
          expectedAttempt: 1,
          expectedHeadSha: HEAD_SHA,
          expectedVerificationEvidenceHash: OUTPUT_HASH,
        },
        "admin",
        operatorDeps({ reconcileReview: review })
      )
    ).resolves.toMatchObject({ ok: true, processed: 1 });
    expect(review).toHaveBeenCalledWith({
      runId: RUN_ID,
      taskId: TASK_ID,
      maxTasks: 1,
    });
  });
});

describe("Fleet worker operator actions", () => {
  it("delivers a bounded message once even when redaction would match the request id", async () => {
    seedApprovedTask({ status: "running", headSha: null });
    seedActiveWorker();
    const send = vi.fn(async () => true);
    const requestId = `stoa_fleet_v1_${"a".repeat(43)}`;
    const input = {
      requestId,
      expectedAttempt: 1,
      expectedSessionId: SESSION_ID,
      message: "Please report your blocker.",
    };
    await expect(
      messageFleetWorker(
        RUN_ID,
        WORKER_ID,
        input,
        "admin",
        operatorDeps({ sendMessage: send })
      )
    ).resolves.toMatchObject({ ok: true, idempotent: false });
    await expect(
      messageFleetWorker(
        RUN_ID,
        WORKER_ID,
        input,
        "admin",
        operatorDeps({ sendMessage: send })
      )
    ).resolves.toMatchObject({ ok: true, idempotent: true });
    expect(send).toHaveBeenCalledTimes(1);
    const payloads = db
      .prepare(
        `SELECT payload FROM fleet_events WHERE event_type LIKE 'worker_message_%'`
      )
      .all() as Array<{ payload: string }>;
    expect(payloads).toHaveLength(2);
    expect(
      payloads.every((row) => !row.payload.includes("Please report"))
    ).toBe(true);
    expect(payloads.every((row) => !row.payload.includes(requestId))).toBe(
      true
    );
    expect(
      payloads.every((row) =>
        /^[0-9a-f]{64}$/.test(
          String(JSON.parse(row.payload).requestIdHash ?? "")
        )
      )
    ).toBe(true);
  });

  it("fails closed on a mismatched worker session binding", async () => {
    seedApprovedTask({ status: "running", headSha: null });
    seedActiveWorker();
    db.prepare(
      `UPDATE sessions SET worktree_path = 'C:\\foreign' WHERE id = ?`
    ).run(SESSION_ID);
    const send = vi.fn(async () => true);
    await expect(
      messageFleetWorker(
        RUN_ID,
        WORKER_ID,
        {
          requestId: "message-mismatch",
          expectedAttempt: 1,
          expectedSessionId: SESSION_ID,
          message: "Hello",
        },
        "admin",
        operatorDeps({ sendMessage: send })
      )
    ).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("inconsistent"),
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("persists restart-safe inspection state when kill cannot prove stop, then recovers idempotently", async () => {
    seedApprovedTask({ status: "running", headSha: null });
    seedActiveWorker();
    const stop = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const input = {
      requestId: "kill-1",
      expectedAttempt: 1,
      expectedSessionId: SESSION_ID,
      preserveWorktree: true,
    };
    await expect(
      killFleetWorker(
        RUN_ID,
        WORKER_ID,
        input,
        "admin",
        operatorDeps({ stopSession: stop })
      )
    ).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("cleanup remains pending"),
    });
    expect(
      db
        .prepare(
          `SELECT status, terminal_cause FROM fleet_workers WHERE id = ?`
        )
        .get(WORKER_ID)
    ).toEqual({
      status: "cleanup_pending",
      terminal_cause: "session_failed_operator_kill_stop_failed",
    });
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks WHERE id = ?`)
        .get(TASK_ID)
    ).toEqual({
      status: "needs_inspection",
      failure_code: "operator_kill_stop_failed",
    });
    expect(
      db
        .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
        .get(RUN_ID)
    ).toEqual({ recovery_required: 1 });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_resource_leases WHERE id = 'lease-worktree'`
        )
        .get()
    ).toEqual({ status: "reserved" });

    await expect(
      killFleetWorker(
        RUN_ID,
        WORKER_ID,
        input,
        "admin",
        operatorDeps({ stopSession: stop })
      )
    ).resolves.toMatchObject({ ok: true, idempotent: false });
    await expect(
      killFleetWorker(
        RUN_ID,
        WORKER_ID,
        input,
        "admin",
        operatorDeps({ stopSession: stop })
      )
    ).resolves.toMatchObject({ ok: true, idempotent: true });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(
      db
        .prepare(
          `SELECT status, terminal_cause, worktree_path FROM fleet_workers WHERE id = ?`
        )
        .get(WORKER_ID)
    ).toEqual({
      status: "failed",
      terminal_cause: "operator_killed",
      worktree_path: WORKTREE,
    });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_resource_leases WHERE id = 'lease-pty'`
        )
        .get()
    ).toEqual({ status: "released" });
    expect(
      db
        .prepare(
          `SELECT status FROM fleet_resource_leases WHERE id = 'lease-worktree'`
        )
        .get()
    ).toEqual({ status: "reserved" });
  });
});
