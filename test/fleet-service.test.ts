import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({
  db: null as unknown,
  stopFleetSession: async () => true,
}));

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
    getDefaultBranch: () => "develop",
    isGitRepo: () => true,
  };
});

vi.mock("@/lib/fleet/stop", () => ({
  stopFleetSession: vi.fn(() => state.stopFleetSession()),
}));

import { queries } from "@/lib/db";
import { hashFleetTaskRows } from "@/lib/fleet/hash";
import {
  approveFleetRunPlan,
  attachFleetPlanCriticArtifact,
  cancelFleetRun,
  completeFleetWorker,
  createDraftFleetRun,
  getFleetRunDetail,
  ingestFleetRunPlan,
  ingestGeneratedFleetRunPlan,
  listFleetRuns,
  pauseFleetRun,
  reconcileFleetCancellationCleanup,
  resumeFleetRun,
  tickFleetRun,
} from "@/lib/fleet/service";
import { cancelFleetPlanner } from "@/lib/fleet/planner";
import type { FleetTaskDependencyRow, FleetTaskRow } from "@/lib/fleet/types";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  state.db = mem;
});

beforeEach(() => {
  (
    globalThis as typeof globalThis & { __stoaFleetSchedulerReady?: boolean }
  ).__stoaFleetSchedulerReady = false;
  state.stopFleetSession = async () => true;
  db().exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM sessions
      WHERE id LIKE 'fleet-%' OR id LIKE 'review-%' OR id LIKE 'fix-%';
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  queries
    .createProject(db())
    .run(
      "proj-fleet",
      "Fleet Project",
      "C:\\repo",
      "claude",
      "sonnet",
      null,
      1
    );
  queries
    .createDispatchRepo(db())
    .run(
      "repo-fleet",
      "C:\\repo",
      "owner/repo",
      "claude",
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
      "proj-fleet"
    );
});

describe("Fleet pause and resume interrupt integration", () => {
  function addRunningRun() {
    const created = createDraftFleetRun({
      name: "Interruptible fleet",
      goal: "Pause workers safely",
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Pause safely [files: lib/pause.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash!,
    });
    if ("error" in approved) throw new Error(approved.error);
    const taskId = approved.run.tasks[0].id;
    const sessionId = `fleet-pause-session-${runId}`;
    db()
      .prepare(
        `INSERT INTO sessions
         (id, name, tmux_name, status, worker_status, working_directory,
          group_path, agent_type)
         VALUES (?, 'Pause worker', ?, 'running', 'working', 'C:\\repo',
                 'sessions', 'codex')`
      )
      .run(sessionId, `pause-${runId}`);
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'running', desired_state = 'running'
         WHERE id = ?`
      )
      .run(runId);
    db()
      .prepare(`UPDATE fleet_tasks SET status = 'running' WHERE id = ?`)
      .run(taskId);
    db()
      .prepare(
        `INSERT INTO fleet_workers
         (id, fleet_run_id, task_id, session_id, status, provider, attempt)
         VALUES (?, ?, ?, ?, 'running', 'codex', 1)`
      )
      .run(`worker-${runId}`, runId, taskId, sessionId);
    return { runId, taskId, sessionId, workerId: `worker-${runId}` };
  }

  it("refuses resume and explicit tick without mutating an unresolved recovery run", async () => {
    const { runId } = addRunningRun();
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused',
         recovery_required = 1 WHERE id = ?`
      )
      .run(runId);
    (
      globalThis as typeof globalThis & {
        __stoaFleetSchedulerReady?: boolean;
      }
    ).__stoaFleetSchedulerReady = true;
    const beforeEvents = db()
      .prepare(`SELECT COUNT(*) AS n FROM fleet_events WHERE fleet_run_id = ?`)
      .get(runId) as { n: number };

    await expect(resumeFleetRun(runId, {})).resolves.toMatchObject({
      status: 503,
    });
    await expect(tickFleetRun(runId)).resolves.toMatchObject({ status: 503 });
    expect(
      db()
        .prepare(
          `SELECT status, desired_state, recovery_required FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "paused",
      desired_state: "paused",
      recovery_required: 1,
    });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual(beforeEvents);
  });

  function addAuxiliaryAccount(
    runId: string,
    ownerType: "planner" | "plan_review" | "task_review" | "fixer",
    index: number,
    sessionId = `fleet-aux-${index}-${runId}`
  ) {
    const accountId = `cost-${index}-${runId}`;
    const ownerId = `owner-${index}-${runId}`;
    if (!queries.getSession(db()).get(sessionId)) {
      db()
        .prepare(
          `INSERT INTO sessions
           (id, name, tmux_name, status, worker_status, working_directory,
            group_path, agent_type)
           VALUES (?, 'Auxiliary', ?, 'running', 'working', 'C:\\repo',
                   'sessions', 'codex')`
        )
        .run(sessionId, `aux-${index}-${runId}`);
    }
    db()
      .prepare(
        `INSERT INTO fleet_cost_accounts
         (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
          provider, model)
         VALUES (?, ?, ?, ?, ?, ?, 'codex', 'gpt-5.5')`
      )
      .run(
        accountId,
        runId,
        sessionId,
        `aux-key-${index}-${runId}`,
        ownerType,
        ownerId
      );
    return { accountId, ownerId, sessionId };
  }

  it("rejects invalid pause modes and grace periods without mutating the run", async () => {
    const { runId } = addRunningRun();
    await expect(
      pauseFleetRun(runId, { mode: "pause-everything" })
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      pauseFleetRun(runId, {
        mode: "pause-and-interrupt",
        graceMs: 1,
      })
    ).resolves.toMatchObject({ status: 400 });
    expect(
      db().prepare(`SELECT status FROM fleet_runs WHERE id = ?`).get(runId)
    ).toEqual({ status: "running" });
  });

  it("persists an exact interrupt and blocks resume until it is terminal", async () => {
    const { runId, workerId } = addRunningRun();
    db()
      .prepare(
        `INSERT INTO fleet_resource_usage_buckets
         (fleet_run_id, resource_type, resource_key, bucket_start_ms, units)
         VALUES (?, 'event_bytes_total', 'fleet', 0, ?)
         ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
         DO UPDATE SET units = excluded.units`
      )
      .run(runId, 256 * 1024 ** 2);
    const before = Date.now();
    await expect(
      pauseFleetRun(runId, {
        actor: "operator",
        mode: "pause-and-interrupt",
        graceMs: 15_000,
      })
    ).resolves.toHaveProperty("run");
    const interrupt = db()
      .prepare(
        `SELECT interrupt_requested_at, interrupt_deadline_at,
                interrupt_notice_state, interrupt_stop_state, interrupt_cause
         FROM fleet_workers WHERE id = ?`
      )
      .get(workerId) as {
      interrupt_requested_at: string;
      interrupt_deadline_at: string;
      interrupt_notice_state: string;
      interrupt_stop_state: string;
      interrupt_cause: string;
    };
    expect(
      Date.parse(interrupt.interrupt_deadline_at) -
        Date.parse(interrupt.interrupt_requested_at)
    ).toBe(15_000);
    expect(Date.parse(interrupt.interrupt_requested_at)).toBeGreaterThanOrEqual(
      before
    );
    expect(interrupt).toMatchObject({
      interrupt_notice_state: "unattempted",
      interrupt_stop_state: "unattempted",
      interrupt_cause: "operator_pause",
    });

    (
      globalThis as typeof globalThis & {
        __stoaFleetSchedulerReady?: boolean;
      }
    ).__stoaFleetSchedulerReady = true;
    await expect(resumeFleetRun(runId, {})).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("interrupt cleanup is unresolved"),
    });
    db()
      .prepare(
        `UPDATE fleet_workers SET status = 'dead', terminal_cause = 'operator_interrupt_stop_requested'
         WHERE id = ?`
      )
      .run(workerId);
    await expect(resumeFleetRun(runId, {})).resolves.toHaveProperty("run");
    expect(
      db().prepare(`SELECT status FROM fleet_runs WHERE id = ?`).get(runId)
    ).toEqual({ status: "running" });
  });

  it("durably interrupts every auxiliary owner and reconciles when no worker is active", async () => {
    const { runId, workerId } = addRunningRun();
    db().prepare(`DELETE FROM fleet_workers WHERE id = ?`).run(workerId);
    db()
      .prepare(`UPDATE fleet_runs SET status = 'reviewing' WHERE id = ?`)
      .run(runId);
    const owners = (
      ["planner", "plan_review", "task_review", "fixer"] as const
    ).map((ownerType, index) => addAuxiliaryAccount(runId, ownerType, index));
    const reconcileRun = vi.fn(async () => 0);
    const now = new Date("2026-08-01T12:00:00.000Z");

    await expect(
      pauseFleetRun(
        runId,
        { mode: "pause-and-interrupt", graceMs: 15_000 },
        {
          db: db(),
          now: () => now,
          schedulerReady: () => true,
          reconcileRun,
        }
      )
    ).resolves.toHaveProperty("run");

    expect(reconcileRun).toHaveBeenCalledTimes(1);
    expect(reconcileRun).toHaveBeenCalledWith(runId);
    expect(
      db()
        .prepare(
          `SELECT owner_type, interrupt_requested_at, interrupt_deadline_at,
                  interrupt_notice_state, interrupt_stop_state, interrupt_cause
           FROM fleet_cost_accounts WHERE fleet_run_id = ?
           ORDER BY id`
        )
        .all(runId)
    ).toEqual(
      expect.arrayContaining(
        owners.map((_owner, index) => ({
          owner_type: (
            ["planner", "plan_review", "task_review", "fixer"] as const
          )[index],
          interrupt_requested_at: now.toISOString(),
          interrupt_deadline_at: "2026-08-01T12:00:15.000Z",
          interrupt_notice_state: "unattempted",
          interrupt_stop_state: "unattempted",
          interrupt_cause: "operator_pause",
        }))
      )
    );
    const pausedEvent = db()
      .prepare(
        `SELECT payload FROM fleet_events
         WHERE fleet_run_id = ? AND event_type = 'run_paused'`
      )
      .get(runId) as { payload: string };
    expect(JSON.parse(pausedEvent.payload)).toMatchObject({
      interruptCount: 4,
      workerInterruptCount: 0,
      auxiliaryInterruptCount: 4,
    });

    (
      globalThis as typeof globalThis & {
        __stoaFleetSchedulerReady?: boolean;
      }
    ).__stoaFleetSchedulerReady = true;
    await expect(resumeFleetRun(runId, {})).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("interrupt cleanup is unresolved"),
    });
    db()
      .prepare(
        `UPDATE fleet_cost_accounts
         SET terminal_at = ?, reservation_released_at = ?,
             interrupt_stop_state = 'confirmed'
         WHERE fleet_run_id = ? AND owner_type <> 'worker'`
      )
      .run(now.toISOString(), now.toISOString(), runId);
    await expect(resumeFleetRun(runId, {})).resolves.toHaveProperty("run");
  });

  it("rejects an ambiguously shared auxiliary session without mutating pause state", async () => {
    const { runId, workerId } = addRunningRun();
    db().prepare(`DELETE FROM fleet_workers WHERE id = ?`).run(workerId);
    db()
      .prepare(`UPDATE fleet_runs SET status = 'merging' WHERE id = ?`)
      .run(runId);
    const sharedSession = `fleet-aux-shared-${runId}`;
    addAuxiliaryAccount(runId, "plan_review", 1, sharedSession);
    addAuxiliaryAccount(runId, "task_review", 2, sharedSession);
    const reconcileRun = vi.fn(async () => 0);

    await expect(
      pauseFleetRun(
        runId,
        { mode: "pause-and-interrupt" },
        {
          db: db(),
          schedulerReady: () => true,
          reconcileRun,
        }
      )
    ).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("exactly one active session owner"),
    });
    expect(reconcileRun).not.toHaveBeenCalled();
    expect(
      db().prepare(`SELECT status FROM fleet_runs WHERE id = ?`).get(runId)
    ).toEqual({ status: "merging" });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND interrupt_requested_at IS NOT NULL`
        )
        .get(runId)
    ).toEqual({ n: 0 });
  });

  it("fails closed when an auxiliary interrupt ledger is incomplete", async () => {
    const { runId, workerId } = addRunningRun();
    db().prepare(`DELETE FROM fleet_workers WHERE id = ?`).run(workerId);
    const account = addAuxiliaryAccount(runId, "planner", 1);
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'paused', desired_state = 'paused',
         pause_mode = 'pause-and-interrupt', pause_reason = 'operator_pause'
         WHERE id = ?`
      )
      .run(runId);
    db()
      .prepare(
        `UPDATE fleet_cost_accounts SET interrupt_cause = 'operator_pause'
         WHERE id = ?`
      )
      .run(account.accountId);
    (
      globalThis as typeof globalThis & {
        __stoaFleetSchedulerReady?: boolean;
      }
    ).__stoaFleetSchedulerReady = true;

    await expect(resumeFleetRun(runId, {})).resolves.toMatchObject({
      status: 409,
      error: expect.stringContaining("interrupt cleanup is unresolved"),
    });
    expect(
      db()
        .prepare(`SELECT status, desired_state FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ status: "paused", desired_state: "paused" });
  });

  it("preserves an existing auxiliary budget interrupt deadline and cause", async () => {
    const { runId, workerId } = addRunningRun();
    db().prepare(`DELETE FROM fleet_workers WHERE id = ?`).run(workerId);
    const account = addAuxiliaryAccount(runId, "fixer", 1);
    db()
      .prepare(
        `UPDATE fleet_cost_accounts
         SET interrupt_requested_at = '2026-08-01T11:59:30.000Z',
             interrupt_deadline_at = '2026-08-01T12:00:00.000Z',
             interrupt_notice_state = 'delivered',
             interrupt_cause = 'budget_hard_limit'
         WHERE id = ?`
      )
      .run(account.accountId);

    await expect(
      pauseFleetRun(
        runId,
        { mode: "pause-and-interrupt", graceMs: 60_000 },
        {
          db: db(),
          now: () => new Date("2026-08-01T12:01:00.000Z"),
          schedulerReady: () => false,
        }
      )
    ).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(
          `SELECT interrupt_requested_at, interrupt_deadline_at,
                  interrupt_notice_state, interrupt_cause
           FROM fleet_cost_accounts WHERE id = ?`
        )
        .get(account.accountId)
    ).toEqual({
      interrupt_requested_at: "2026-08-01T11:59:30.000Z",
      interrupt_deadline_at: "2026-08-01T12:00:00.000Z",
      interrupt_notice_state: "delivered",
      interrupt_cause: "budget_hard_limit",
    });
  });

  it.each(["reviewing", "merging"] as const)(
    "keeps operator pause available while the run is %s",
    async (phase) => {
      const { runId } = addRunningRun();
      db()
        .prepare(`UPDATE fleet_runs SET status = ? WHERE id = ?`)
        .run(phase, runId);

      await expect(
        pauseFleetRun(runId, { mode: "pause-new" })
      ).resolves.toHaveProperty("run");
      expect(
        db()
          .prepare(`SELECT status, desired_state FROM fleet_runs WHERE id = ?`)
          .get(runId)
      ).toEqual({ status: "paused", desired_state: "paused" });
    }
  );

  it.each(["pause-new", "pause-and-interrupt"] as const)(
    "rejects %s after external landing has been authorized",
    async (mode) => {
      const { runId } = addRunningRun();
      db()
        .prepare(
          `UPDATE fleet_runs SET status = 'merging', merge_requested_at = ?,
           merge_requested_by = 'fleet-automation',
           merge_request_kind = 'automatic', merge_target = 'local'
           WHERE id = ?`
        )
        .run("2026-08-01T12:00:00.000Z", runId);

      await expect(pauseFleetRun(runId, { mode })).resolves.toEqual({
        error:
          "external landing is already authorized and cannot be paused safely",
        status: 409,
      });
      expect(
        db()
          .prepare(
            `SELECT status, desired_state, pause_mode FROM fleet_runs WHERE id = ?`
          )
          .get(runId)
      ).toEqual({
        status: "merging",
        desired_state: "running",
        pause_mode: null,
      });
    }
  );
});

describe("Phase 3 worker completion", () => {
  function addRunningWorker() {
    const created = createDraftFleetRun({
      name: "Runtime fleet",
      goal: "Finish a worker safely",
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const planned = ingestFleetRunPlan(created.run.run.id, {
      planText: "- Build runtime [files: lib/runtime.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const approved = approveFleetRunPlan(created.run.run.id, {
      expectedPlanHash: planned.run.run.planHash!,
    });
    if ("error" in approved) throw new Error(approved.error);
    const taskId = approved.run.tasks[0].id;
    db()
      .prepare(
        `INSERT INTO sessions
       (id, name, tmux_name, status, worker_status, working_directory, group_path, agent_type)
       VALUES ('fleet-session', 'Worker', 'fleet-session', 'running', 'working', 'C:\\repo', 'sessions', 'codex')`
      )
      .run();
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'running', reserved_budget_usd = 0.25 WHERE id = ?`
      )
      .run(created.run.run.id);
    db()
      .prepare(`UPDATE fleet_tasks SET status = 'running' WHERE id = ?`)
      .run(taskId);
    db()
      .prepare(
        `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, session_id, status, provider, attempt, reservation_usd)
       VALUES ('fleet-worker', ?, ?, 'fleet-session', 'running', 'codex', 1, 0.25)`
      )
      .run(created.run.run.id, taskId);
    const insertLease = db().prepare(
      `INSERT INTO fleet_resource_leases
       (id, fleet_run_id, worker_id, resource_type, resource_key)
       VALUES (?, ?, 'fleet-worker', ?, ?)`
    );
    for (const resourceType of [
      "pty",
      "provider",
      "git_operation",
      "worktree",
    ]) {
      insertLease.run(
        `lease-${resourceType}`,
        created.run.run.id,
        resourceType,
        resourceType
      );
    }
    return { runId: created.run.run.id, taskId };
  }

  it("stops the backend before releasing runtime resources", async () => {
    const { runId, taskId } = addRunningWorker();

    const result = await completeFleetWorker(runId, "fleet-worker", {
      actor: "operator",
    });
    expect(result).toHaveProperty("run");
    expect(
      db()
        .prepare(`SELECT status FROM fleet_workers WHERE id = 'fleet-worker'`)
        .get()
    ).toEqual({ status: "completed" });
    expect(
      db().prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(taskId)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db()
        .prepare(
          `SELECT resource_type FROM fleet_resource_leases WHERE worker_id = 'fleet-worker' AND status = 'reserved'`
        )
        .all()
    ).toEqual([{ resource_type: "worktree" }]);
  });

  it("lets cancellation take ownership of an in-flight completion cleanup", async () => {
    const { runId } = addRunningWorker();
    let releaseFirstStop!: (value: boolean) => void;
    const firstStop = new Promise<boolean>((resolve) => {
      releaseFirstStop = resolve;
    });
    let calls = 0;
    state.stopFleetSession = async () => {
      calls += 1;
      return calls === 1 ? firstStop : true;
    };

    const completing = completeFleetWorker(runId, "fleet-worker", {
      actor: "operator",
    });
    await vi.waitFor(() =>
      expect(
        db()
          .prepare(
            `SELECT status, terminal_cause FROM fleet_workers WHERE id = 'fleet-worker'`
          )
          .get()
      ).toEqual({
        status: "cleanup_pending",
        terminal_cause: "operator_completion_pending",
      })
    );
    const canceled = await cancelFleetRun(runId, {
      actor: "operator",
      mode: "cancel-preserve-worktrees",
    });
    expect(canceled).toHaveProperty("run");
    releaseFirstStop(true);
    await completing;

    expect(
      db()
        .prepare(
          `SELECT status, terminal_cause FROM fleet_workers WHERE id = 'fleet-worker'`
        )
        .get()
    ).toEqual({
      status: "cleanup_complete",
      terminal_cause: "operator_cancel",
    });
    expect(
      db()
        .prepare(
          `SELECT spent_budget_usd, reserved_budget_usd FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ spent_budget_usd: 0.25, reserved_budget_usd: 0 });
    expect(
      db()
        .prepare(
          `SELECT resource_type FROM fleet_resource_leases
           WHERE worker_id = 'fleet-worker' AND status = 'reserved'`
        )
        .all()
    ).toEqual([{ resource_type: "worktree" }]);
  });

  it("keeps cancellation available after the data-plane event quota is exhausted", async () => {
    const { runId } = addRunningWorker();
    db()
      .prepare(
        `INSERT INTO fleet_resource_usage_buckets
         (fleet_run_id, resource_type, resource_key, bucket_start_ms, units)
         VALUES (?, 'event_bytes_total', 'fleet', 0, ?)
         ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
         DO UPDATE SET units = excluded.units`
      )
      .run(runId, 256 * 1024 ** 2);

    await expect(
      cancelFleetRun(runId, { mode: "cancel-preserve-worktrees" })
    ).resolves.toHaveProperty("run");
    expect(
      db().prepare(`SELECT status FROM fleet_runs WHERE id = ?`).get(runId)
    ).toEqual({ status: "canceled" });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'run_canceled'`
        )
        .get(runId)
    ).toEqual({ n: 1 });
  });

  it("keeps cancellation available throughout internal integration staging", async () => {
    const { runId } = addRunningWorker();
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'merging',
         integration_state = 'integrating' WHERE id = ?`
      )
      .run(runId);

    await expect(
      cancelFleetRun(runId, { mode: "cancel-preserve-worktrees" })
    ).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(`SELECT status, cancel_mode FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({
      status: "canceled",
      cancel_mode: "cancel-preserve-worktrees",
    });
  });

  it("freezes cancellation after external landing authorization", async () => {
    const { runId } = addRunningWorker();
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'merging', desired_state = 'running',
         merge_requested_at = ?,
         merge_requested_by = 'fleet-automation',
         merge_request_kind = 'automatic', merge_target = 'local'
         WHERE id = ?`
      )
      .run(new Date().toISOString(), runId);

    await expect(
      cancelFleetRun(runId, { mode: "cancel-preserve-worktrees" })
    ).resolves.toEqual({
      error:
        "external landing is already authorized and cannot be canceled safely",
      status: 409,
    });
    expect(
      db()
        .prepare(
          `SELECT status, desired_state, cancel_mode FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "merging",
      desired_state: "running",
      cancel_mode: null,
    });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'run_canceled'`
        )
        .get(runId)
    ).toEqual({ n: 0 });
  });

  it("conservatively settles partial terminal telemetry once and preserves owned worktree capacity", async () => {
    const { runId } = addRunningWorker();
    db()
      .prepare(
        `UPDATE fleet_runs SET reserved_budget_tokens = 500 WHERE id = ?`
      )
      .run(runId);
    db()
      .prepare(
        `UPDATE fleet_workers SET reservation_tokens = 500 WHERE id = 'fleet-worker'`
      )
      .run();
    db()
      .prepare(
        `INSERT INTO fleet_cost_accounts
         (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
          task_id, provider, reservation_usd, reservation_tokens)
         VALUES ('worker-account', ?, 'fleet-session', 'fleet-session',
                 'worker', 'fleet-worker', NULL, 'codex', 0.25, 500)`
      )
      .run(runId);
    db()
      .prepare(
        `INSERT INTO session_costs
         (session_key, session_id, day, agent_type, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
         VALUES ('fleet-session', 'fleet-session', '2026-08-01', 'codex',
                 60, 40, 0, 0, 0.1)`
      )
      .run();
    const insertRuntimeLease = db().prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key, units)
       VALUES (?, ?, 'worker', 'fleet-worker', ?, ?, ?)`
    );
    insertRuntimeLease.run("runtime-pty", runId, "pty", "local", 1);
    insertRuntimeLease.run(
      "runtime-worktree",
      runId,
      "repo_worktree",
      "repo-fleet",
      1
    );
    insertRuntimeLease.run("runtime-disk", runId, "disk_bytes", "fleet", 1024);

    await expect(
      cancelFleetRun(runId, { mode: "cancel-preserve-worktrees" })
    ).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens, reserved_budget_usd,
                  reserved_budget_tokens FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      spent_budget_usd: 0.25,
      spent_budget_tokens: 500,
      reserved_budget_usd: 0,
      reserved_budget_tokens: 0,
    });
    expect(
      db()
        .prepare(
          `SELECT terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts WHERE id = 'worker-account'`
        )
        .get()
    ).toEqual({ terminal: 1 });
    expect(
      db()
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE status = 'reserved' ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "disk_bytes" },
      { resource_type: "repo_worktree" },
    ]);

    await expect(cancelFleetRun(runId, {})).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ spent_budget_usd: 0.25, spent_budget_tokens: 500 });
  });

  it("keeps failed stop cleanup durable and completes it on cancellation retry", async () => {
    const { runId } = addRunningWorker();
    state.stopFleetSession = async () => false;

    await expect(cancelFleetRun(runId, {})).resolves.toEqual({
      error: "fleet cancellation cleanup remains pending",
      status: 409,
    });
    expect(
      db()
        .prepare(`SELECT status FROM fleet_workers WHERE id = 'fleet-worker'`)
        .get()
    ).toEqual({ status: "cleanup_pending" });
    expect(
      db()
        .prepare(
          `SELECT reserved_budget_usd, spent_budget_usd
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ reserved_budget_usd: 0.25, spent_budget_usd: 0 });

    state.stopFleetSession = async () => true;
    await expect(
      reconcileFleetCancellationCleanup({
        db: db(),
        stopSession: async () => true,
      })
    ).resolves.toBe(1);
    expect(
      db()
        .prepare(
          `SELECT reserved_budget_usd, spent_budget_usd
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ reserved_budget_usd: 0, spent_budget_usd: 0.25 });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'run_canceled'`
        )
        .get(runId)
    ).toEqual({ n: 1 });
  });

  it("settles paid reviewers and fixers while refunding an unspawned owner", async () => {
    const created = createDraftFleetRun({
      name: "Cancel non-worker owners",
      goal: "Stop every Fleet-paid session",
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const planned = ingestFleetRunPlan(created.run.run.id, {
      planText: "- Review cancellation [files: lib/cancel.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const runId = created.run.run.id;
    const taskId = planned.run.tasks[0].id;
    for (const sessionId of [
      "review-plan-session",
      "review-task-session",
      "fix-task-session",
    ]) {
      db()
        .prepare(
          `INSERT INTO sessions
           (id, name, tmux_name, status, worker_status, working_directory,
            group_path, agent_type)
           VALUES (?, ?, ?, 'running', 'working', 'C:\\repo', 'sessions', 'codex')`
        )
        .run(sessionId, sessionId, sessionId);
    }
    db().exec(`
      INSERT INTO fleet_verifications
       (id, fleet_run_id, task_id, attempt, base_sha, head_sha, spec_hash,
        command, status)
      VALUES ('verification-cancel', '${runId}', '${taskId}', 1,
              '${"a".repeat(40)}', '${"b".repeat(40)}', '${"c".repeat(64)}',
              'npm test', 'pass');
      INSERT INTO fleet_reviews
       (id, fleet_run_id, subject_hash, policy_hash, execution_hash, base_sha,
        lens, reviewer_session_id, verdict, state, request_id)
      VALUES ('plan-review-cancel', '${runId}', '${"d".repeat(64)}',
              '${"e".repeat(64)}', '${"f".repeat(64)}', '${"a".repeat(40)}',
              'correctness', 'review-plan-session', 'changes_requested',
              'running', 'plan-owner-paid');
      INSERT INTO fleet_reviews
       (id, fleet_run_id, subject_hash, policy_hash, execution_hash, base_sha,
        lens, reviewer_session_id, verdict, state, request_id)
      VALUES ('plan-review-pending', '${runId}', '${"1".repeat(64)}',
              '${"2".repeat(64)}', '${"3".repeat(64)}', '${"a".repeat(40)}',
              'security', '', 'changes_requested', 'pending',
              'plan-owner-pending');
      INSERT INTO fleet_task_reviews
       (id, fleet_run_id, task_id, attempt, base_sha, head_sha, verification_id,
        verification_spec_hash, verification_evidence_hash, policy_hash, lens,
        reviewer_session_id, verdict, state, request_id)
      VALUES ('task-review-cancel', '${runId}', '${taskId}', 1,
              '${"a".repeat(40)}', '${"b".repeat(40)}', 'verification-cancel',
              '${"c".repeat(64)}', '${"4".repeat(64)}', '${"e".repeat(64)}',
              'correctness', 'review-task-session', 'changes_requested',
              'running', 'task-owner-paid');
      INSERT INTO fleet_task_fixes
       (id, fleet_run_id, task_id, attempt, round, old_head_sha, policy_hash,
        verification_evidence_hash, state, request_id, fixer_session_id)
      VALUES ('task-fix-cancel', '${runId}', '${taskId}', 1, 1,
              '${"b".repeat(40)}', '${"e".repeat(64)}', '${"4".repeat(64)}',
              'running', 'fix-owner-paid', 'fix-task-session');
    `);
    const insertAccount = db().prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
        task_id, provider, reservation_usd, reservation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'codex', 0.2, 200)`
    );
    insertAccount.run(
      "account-plan-paid",
      runId,
      "review-plan-session",
      "review-plan-session",
      "plan_review",
      "plan-owner-paid",
      null
    );
    insertAccount.run(
      "account-plan-pending",
      runId,
      null,
      "pending:plan_review:plan-owner-pending",
      "plan_review",
      "plan-owner-pending",
      null
    );
    insertAccount.run(
      "account-task-paid",
      runId,
      "review-task-session",
      "review-task-session",
      "task_review",
      "task-owner-paid",
      taskId
    );
    insertAccount.run(
      "account-fix-paid",
      runId,
      "fix-task-session",
      "fix-task-session",
      "fixer",
      "fix-owner-paid",
      taskId
    );
    db()
      .prepare(
        `UPDATE fleet_runs SET reserved_budget_usd = 0.8,
         reserved_budget_tokens = 800 WHERE id = ?`
      )
      .run(runId);
    const insertLease = db().prepare(
      `INSERT INTO fleet_runtime_leases
       (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key, units)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    );
    for (const [ownerType, ownerId] of [
      ["plan_review", "plan-owner-paid"],
      ["plan_review", "plan-owner-pending"],
      ["task_review", "task-owner-paid"],
      ["fixer", "fix-owner-paid"],
    ]) {
      insertLease.run(
        `lease-${ownerId}-pty`,
        runId,
        ownerType,
        ownerId,
        "pty",
        "local"
      );
    }
    insertLease.run(
      "lease-plan-worktree",
      runId,
      "plan_review",
      "plan-owner-paid",
      "repo_worktree",
      "repo-fleet"
    );

    await expect(cancelFleetRun(runId, {})).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens, reserved_budget_usd,
                  reserved_budget_tokens FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      spent_budget_usd: 0.6000000000000001,
      spent_budget_tokens: 600,
      reserved_budget_usd: 0,
      reserved_budget_tokens: 0,
    });
    expect(
      db()
        .prepare(
          `SELECT owner_id, terminal_at IS NOT NULL AS terminal,
                  reservation_released_at IS NOT NULL AS released
           FROM fleet_cost_accounts ORDER BY owner_id`
        )
        .all()
    ).toEqual([
      { owner_id: "fix-owner-paid", terminal: 1, released: 1 },
      { owner_id: "plan-owner-paid", terminal: 1, released: 1 },
      { owner_id: "plan-owner-pending", terminal: 1, released: 1 },
      { owner_id: "task-owner-paid", terminal: 1, released: 1 },
    ]);
    expect(
      db().prepare(`SELECT state FROM fleet_reviews ORDER BY id`).all()
    ).toEqual([{ state: "changes_requested" }, { state: "changes_requested" }]);
    expect(db().prepare(`SELECT state FROM fleet_task_reviews`).get()).toEqual({
      state: "changes_requested",
    });
    expect(db().prepare(`SELECT state FROM fleet_task_fixes`).get()).toEqual({
      state: "failed",
    });
    expect(
      db()
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE status = 'reserved'`
        )
        .all()
    ).toEqual([{ resource_type: "repo_worktree" }]);
  });

  it("validates cancellation mode and exact destructive confirmation before mutation", async () => {
    const created = createDraftFleetRun({
      name: "Validated cancellation",
      goal: "Never broaden a destructive request",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;

    await expect(
      cancelFleetRun(runId, { mode: "destroy-everything" })
    ).resolves.toEqual({ error: "cancel mode is invalid", status: 400 });
    await expect(
      cancelFleetRun(runId, {
        mode: "cancel-and-clean-owned-worktrees",
        confirm: true,
        confirmation: "wrong-run",
      })
    ).resolves.toMatchObject({ status: 400 });
    expect(
      db()
        .prepare(`SELECT status, cancel_mode FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ status: "draft", cancel_mode: null });

    await expect(
      cancelFleetRun(runId, {
        mode: "cancel-and-clean-owned-worktrees",
        confirm: true,
        confirmation: runId,
      })
    ).resolves.toMatchObject({ status: 400 });
    const { previewFleetDestructiveAction } =
      await import("@/lib/fleet/lifecycle");
    const preview = await previewFleetDestructiveAction(runId, {
      db: db(),
      pathExists: () => false,
    });
    if ("error" in preview) throw new Error(preview.error);
    await expect(
      cancelFleetRun(runId, {
        mode: "cancel-and-clean-owned-worktrees",
        confirm: true,
        confirmation: runId,
        previewDigest: preview.targetDigest,
      })
    ).resolves.toHaveProperty("run");
    expect(
      db()
        .prepare(`SELECT status, cancel_mode FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({
      status: "canceled",
      cancel_mode: "cancel-and-clean-owned-worktrees",
    });
  });
});

describe("generated Fleet plans", () => {
  function generatedTask(
    title: string,
    sortOrder: number,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      title,
      description: `${title} description`,
      taskType: "implementation",
      parentIndex: null,
      sortOrder,
      fileClaims: [`lib/${title.toLowerCase()}.ts`],
      agentType: "codex",
      model: null,
      acceptanceCriteria: `${title} passes`,
      verifyCommand: "npm test",
      ...overrides,
    };
  }

  it("redacts durable run and plan prose before computing the stored hash", () => {
    const canary = "sk-FLEETCANARY0123456789";
    const created = createDraftFleetRun({
      name: `Generated ${canary}`,
      goal: `Deliver safely with ${canary}`,
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    const planned = ingestGeneratedFleetRunPlan(runId, {
      planText: `1. Implement ${canary}`,
      tasks: [
        generatedTask(`Implement ${canary}`, 0, {
          description: `Never persist ${canary}`,
          fileClaims: ["lib/safe.ts"],
          acceptanceCriteria: `No trace of ${canary}`,
        }),
      ],
      source: "operator",
    });
    if ("error" in planned) throw new Error(planned.error);

    const tasks = db()
      .prepare(`SELECT * FROM fleet_tasks WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskRow[];
    const dependencies = db()
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(runId) as FleetTaskDependencyRow[];
    const storedRun = db()
      .prepare(
        `SELECT name, goal, settings_json, plan_hash FROM fleet_runs WHERE id = ?`
      )
      .get(runId) as {
      name: string;
      goal: string;
      settings_json: string;
      plan_hash: string;
    };
    expect(hashFleetTaskRows(tasks, dependencies)).toBe(storedRun.plan_hash);

    const attached = attachFleetPlanCriticArtifact(runId, {
      expectedPlanHash: storedRun.plan_hash,
      title: `Finding ${canary}`,
      body: `Credential ${canary} must be removed`,
    });
    if ("error" in attached) throw new Error(attached.error);
    const artifacts = db()
      .prepare(`SELECT title, body FROM fleet_artifacts WHERE fleet_run_id = ?`)
      .all(runId);
    const events = db()
      .prepare(`SELECT actor, payload FROM fleet_events WHERE fleet_run_id = ?`)
      .all(runId);
    expect(
      JSON.stringify({ storedRun, tasks, artifacts, events })
    ).not.toContain(canary);
    expect(JSON.stringify({ storedRun, tasks, artifacts })).toContain(
      "[REDACTED]"
    );
  });

  it("redacts a credential that crosses the persisted run-name boundary", () => {
    const canary = "sk-BOUNDARYCANARY0123456789";
    const created = createDraftFleetRun({
      // The 120-character name cap lands inside the token. Capping first would
      // leave a short, no-longer-detectable credential fragment in the row.
      name: `${"x".repeat(104)} ${canary}`,
      goal: "Boundary redaction",
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);

    const stored = db()
      .prepare(`SELECT name FROM fleet_runs WHERE id = ?`)
      .get(created.run.run.id) as { name: string };
    expect(stored.name).toContain("[REDACTED]");
    expect(stored.name).not.toContain("sk-BOUNDARY");
  });

  it("persists automatic allocations and dependencies into the approved contract", () => {
    const created = createDraftFleetRun({
      name: "Generated plan",
      goal: "Split this goal",
      repoId: "repo-fleet",
      provider: "claude",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: { state: "finalizing", requestId: "planner-1" },
        }),
        runId
      );

    const planned = ingestGeneratedFleetRunPlan(runId, {
      planText: "1. API\n2. UI",
      tasks: [
        generatedTask("API", 0),
        generatedTask("UI", 1, {
          agentType: "kimi",
          taskType: "review",
          fileClaims: [],
        }),
      ],
      dependencies: [[], [0]],
      expectedPlannerRequestId: "planner-1",
      source: "planner",
    });
    if ("error" in planned) throw new Error(planned.error);
    expect(planned.run.run.plannerState).toBe("cleanup_pending");
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "planner finalization and cleanup must finish before approval",
      status: 409,
    });
    expect(planned.run.tasks.map((task) => task.agentType)).toEqual([
      "codex",
      "kimi",
    ]);
    expect(planned.run.tasks[0].acceptanceCriteria).toBe("API passes");
    const dependency = db()
      .prepare(
        `SELECT task_id, depends_on_task_id FROM fleet_task_dependencies WHERE fleet_run_id = ?`
      )
      .get(runId) as { task_id: string; depends_on_task_id: string };
    expect(dependency).toEqual({
      task_id: planned.run.tasks[1].id,
      depends_on_task_id: planned.run.tasks[0].id,
    });
    const readOnlyClaims = db()
      .prepare(`SELECT COUNT(*) AS n FROM fleet_task_claims WHERE task_id = ?`)
      .get(planned.run.tasks[1].id) as { n: number };
    expect(readOnlyClaims.n).toBe(0);

    expect(
      ingestGeneratedFleetRunPlan(runId, {
        planText: "1. Duplicate poll",
        tasks: [generatedTask("Duplicate", 0)],
        expectedPlannerRequestId: "planner-1",
        source: "planner",
      })
    ).toMatchObject({
      error: "planner result was superseded",
      status: 409,
    });

    const row = db()
      .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
      .get(runId) as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    settings.planner = { state: "ready", requestId: "planner-1" };
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(JSON.stringify(settings), runId);

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
    });
    expect(approved).not.toHaveProperty("error");
  });

  it("rejects a late planner result after its request was superseded", () => {
    const created = createDraftFleetRun({
      name: "Superseded planner",
      goal: "Do not overwrite the new plan",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    const result = ingestGeneratedFleetRunPlan(created.run.run.id, {
      planText: "1. Old",
      tasks: [generatedTask("Old", 0)],
      expectedPlannerRequestId: "old-request",
      source: "planner",
    });
    expect(result).toMatchObject({
      error: "planner result was superseded",
      status: 409,
    });
  });

  it("requires an active planner to be canceled before manual replacement", async () => {
    const created = createDraftFleetRun({
      name: "Planner cancellation",
      goal: "Keep one plan writer",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: { state: "starting", requestId: "planner-active" },
        }),
        runId
      );
    expect(
      ingestFleetRunPlan(runId, { planText: "- Manual [files: lib/x.ts]" })
    ).toMatchObject({
      error: "cancel the active planner before ingesting a manual plan",
      status: 409,
    });

    const canceled = await cancelFleetPlanner(runId);
    if ("error" in canceled) throw new Error(canceled.error);
    expect(canceled.run.run.plannerState).toBe("idle");
    expect(
      ingestFleetRunPlan(runId, { planText: "- Manual [files: lib/x.ts]" })
    ).not.toHaveProperty("error");
  });

  it("refuses run cancellation while planner cleanup is still owned", async () => {
    const created = createDraftFleetRun({
      name: "Planner-owned cancel",
      goal: "Do not orphan the planner",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: {
            state: "cleanup_pending",
            requestId: "planner-cleanup",
          },
        }),
        created.run.run.id
      );
    await expect(
      cancelFleetRun(created.run.run.id, { actor: "operator" })
    ).resolves.toMatchObject({
      error: "cancel the active planner and finish its cleanup first",
      status: 409,
    });
  });
});

describe("createDraftFleetRun", () => {
  it("persists one-request automation intent and per-action grants", () => {
    const res = createDraftFleetRun(
      {
        name: "Autonomous run",
        goal: "Plan, review, and execute",
        repoId: "repo-fleet",
        provider: "codex",
        automationPolicy: {
          automaticPlanning: true,
          automaticPlanApproval: true,
          automaticStart: true,
          allowUnconfinedAgents: true,
          plannerTaskCap: 10,
        },
      },
      "authenticated-admin"
    );
    if ("error" in res) throw new Error(res.error);

    expect(res.run.run).toMatchObject({
      desiredState: "running",
      automationGrantedBy: "authenticated-admin",
      automationPolicy: {
        version: 1,
        automaticPlanning: true,
        automaticPlanApproval: true,
        automaticStart: true,
        automaticMerge: false,
        plannerTaskCap: 10,
      },
    });
    expect(res.run.run.automationPolicyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      db()
        .prepare(
          `SELECT action, status, granted_by
           FROM fleet_action_authorizations WHERE fleet_run_id = ?
           ORDER BY action`
        )
        .all(res.run.run.id)
    ).toEqual([
      {
        action: "plan_approval",
        status: "authorized",
        granted_by: "authenticated-admin",
      },
      {
        action: "planning",
        status: "authorized",
        granted_by: "authenticated-admin",
      },
      {
        action: "start",
        status: "authorized",
        granted_by: "authenticated-admin",
      },
    ]);
  });

  it("persists a draft run, one root task, and an audit event without spawning workers", () => {
    const res = createDraftFleetRun({
      name: "  Phase 1  ",
      goal: "  Durable model and read-only UI  ",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      budgetUsd: 25,
      provider: "codex",
      model: "gpt-5.5",
      maxConcurrency: 80,
      reviewPolicy: "four_agent_plus_red_team",
    });

    expect(res).toHaveProperty("run");
    if ("error" in res) return;
    expect(res.run.run).toMatchObject({
      name: "Phase 1",
      goal: "Durable model and read-only UI",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      budgetUsd: 25,
      provider: "codex",
      model: "gpt-5.5",
      maxConcurrency: 40,
      reviewPolicy: "four_agent_plus_red_team",
      status: "draft",
      approvalState: "draft",
      planHash: null,
      planText: null,
      taskCount: 1,
      workerCount: 0,
    });
    expect(res.run.run.approvalPreview.canApproveExecutableWork).toBe(false);
    expect(res.run.tasks).toHaveLength(1);
    expect(res.run.tasks[0]).toMatchObject({
      title: "Draft scope",
      taskType: "scope",
      status: "draft",
    });
    expect(res.run.workers).toEqual([]);
    expect(res.run.events.map((e) => e.eventType)).toEqual(["draft_created"]);

    const workerCount = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_workers")
      .get() as { n: number };
    expect(workerCount.n).toBe(0);

    const settings = db()
      .prepare("SELECT settings_json FROM fleet_runs WHERE id = ?")
      .get(res.run.run.id) as { settings_json: string };
    expect(JSON.parse(settings.settings_json)).toEqual({
      phase: "draft",
      canSpawnWorkers: false,
    });

    expect(listFleetRuns().map((r) => r.id)).toEqual([res.run.run.id]);
    expect(getFleetRunDetail(res.run.run.id)?.run.name).toBe("Phase 1");
  });

  it("rejects unknown repoId or projectId before writing anything", () => {
    expect(
      createDraftFleetRun({
        name: "Run",
        goal: "Goal",
        repoId: "missing",
      })
    ).toEqual({ error: "unknown repoId" });
    expect(
      createDraftFleetRun({
        name: "Run",
        goal: "Goal",
        projectId: "missing",
      })
    ).toEqual({ error: "unknown projectId" });

    const count = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_runs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects non-object JSON payloads before writing anything", () => {
    expect(createDraftFleetRun(null)).toEqual({ error: "name is required" });

    const count = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_runs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("Phase 2 plan ingestion and approval", () => {
  function createRun() {
    const created = createDraftFleetRun({
      name: "Phase 2",
      goal: "Create a reviewable task graph",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      provider: "codex",
    });
    expect(created).toHaveProperty("run");
    if ("error" in created) throw new Error(created.error);
    return created.run.run.id;
  }

  it("ingests a markdown plan into durable tasks without spawning workers", () => {
    const runId = createRun();
    const res = ingestFleetRunPlan(runId, {
      planText: `
- Build parser - Parse markdown into tasks [files: lib/fleet/plan.ts]
  - Add tests: cover \`test/fleet-plan.test.ts\`
- Add approval endpoint: require expected hash
`,
      actor: "operator",
    });

    expect(res).toHaveProperty("run");
    if ("error" in res) return;
    expect(res.run.run).toMatchObject({
      status: "draft",
      approvalState: "needs_approval",
      taskCount: 3,
      workerCount: 0,
    });
    expect(res.run.run.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.run.run.planText).toContain("Build parser");
    expect(res.run.run.approvedPlanHash).toBeNull();
    expect(res.run.tasks.map((task) => task.title)).toEqual([
      "Build parser",
      "Add tests",
      "Add approval endpoint",
    ]);
    expect(res.run.tasks[1].parentTaskId).toBe(res.run.tasks[0].id);
    expect(res.run.tasks[0].fileClaims).toEqual(["lib/fleet/plan.ts"]);
    expect(res.run.events[0]).toMatchObject({
      eventType: "plan_ingested",
      actor: "operator",
    });

    const workerCount = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_workers")
      .get() as { n: number };
    expect(workerCount.n).toBe(0);
  });

  it("approves the currently reviewed hash and records audit metadata", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
      approvedBy: "spoofed-client-identity",
    });

    expect(approved).toHaveProperty("run");
    if ("error" in approved) return;
    expect(approved.run.run).toMatchObject({
      status: "planned",
      approvalState: "approved",
      approvedPlanHash: planned.run.run.planHash,
      approvedBy: "operator",
      workerCount: 0,
    });
    expect(approved.run.run.approvedAt).toBeTruthy();
    expect(approved.run.events[0]).toMatchObject({
      eventType: "plan_approved",
      actor: "operator",
    });
  });

  it("resolves a project checkout default branch into the approved contract", () => {
    const created = createDraftFleetRun({
      name: "Project fleet",
      goal: "Use the checkout default branch",
      projectId: "proj-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const planned = ingestFleetRunPlan(created.run.run.id, {
      planText: "- Build project task [files: lib/project.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const approved = approveFleetRunPlan(created.run.run.id, {
      expectedPlanHash: planned.run.run.planHash!,
    });
    expect(approved).toHaveProperty("run");
    expect(
      (
        db()
          .prepare(`SELECT base_branch FROM fleet_tasks WHERE fleet_run_id = ?`)
          .get(created.run.run.id) as { base_branch: string }
      ).base_branch
    ).toBe("develop");
  });

  it("rejects unsupported providers before executable approval", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, { planText: "- Build parser" });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(`UPDATE fleet_runs SET provider = 'unknown' WHERE id = ?`)
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
      })
    ).toEqual({
      error: "select a supported agent provider before approval",
      status: 409,
    });
  });

  it("rejects approval when current-plan blocker findings exist", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const blocked = attachFleetPlanCriticArtifact(runId, {
      taskId: planned.run.tasks[0].id,
      expectedPlanHash: planned.run.run.planHash,
      title: "Unsafe plan",
      body: "This finding must be addressed before approval.",
      severity: "blocker",
      actor: "red-team",
    });
    expect(blocked).toHaveProperty("run");

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "blocker findings must be addressed before approval",
      status: 409,
    });

    const revised = ingestFleetRunPlan(runId, {
      planText: "- Build safer parser\n- Add approval",
    });
    expect(revised).toHaveProperty("run");
    if ("error" in revised) return;
    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: revised.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");
  });

  it("rejects approval when persisted claim rows were weakened", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser [files: lib/fleet/plan.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(`DELETE FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "plan graph claims do not match the reviewed task claims",
      status: 409,
    });
  });

  it("rejects approval when dependency semantics were changed", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText:
        "- Foundation [files: lib/a.ts]\n  - Dependent [files: lib/b.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(
        `UPDATE fleet_task_dependencies SET dependency_type = 'informs' WHERE fleet_run_id = ?`
      )
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "plan graph has unsupported dependency semantics",
      status: 409,
    });
  });

  it("rejects lifecycle replay after a plan has been approved", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;
    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");

    expect(
      ingestFleetRunPlan(runId, {
        planText: "- Reset an approved run",
      })
    ).toEqual({
      error: "cannot replace a plan for the current run state",
      status: 409,
    });
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "run is not awaiting plan approval",
      status: 409,
    });
  });

  it("rejects stale approval hashes and resets approval when the graph changes", () => {
    const runId = createRun();
    const first = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) return;

    const second = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval\n- Add critic artifacts",
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) return;

    expect(second.run.run.planHash).not.toBe(first.run.run.planHash);
    expect(second.run.run.approvedPlanHash).toBeNull();
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: first.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });
  });

  it("rejects approval when durable task rows drift from the stored hash", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    db()
      .prepare(
        "UPDATE fleet_tasks SET title = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("Changed parser", runId);

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });
  });

  it("rejects approval when durable task rows are structurally invalid", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const other = createDraftFleetRun({
      name: "Other run",
      goal: "Other task",
    });
    expect(other).toHaveProperty("run");
    if ("error" in other) return;
    const otherTaskId = other.run.tasks[0]?.id;
    expect(otherTaskId).toBeTruthy();
    if (!otherTaskId) return;

    db()
      .prepare(
        "UPDATE fleet_tasks SET parent_task_id = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run(otherTaskId, runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has invalid parents", status: 409 });

    const replanned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(replanned).toHaveProperty("run");
    if ("error" in replanned) return;
    db()
      .prepare(
        "UPDATE fleet_tasks SET file_claims_json = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("{", runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: replanned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has invalid file claims", status: 409 });

    const finalPlan = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(finalPlan).toHaveProperty("run");
    if ("error" in finalPlan) return;
    db()
      .prepare(
        "UPDATE fleet_tasks SET status = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("queued", runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: finalPlan.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has non-draft tasks", status: 409 });
  });

  it("attaches critic findings as artifacts and validates task ownership", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    expect(
      attachFleetPlanCriticArtifact(runId, {
        taskId: "missing",
        expectedPlanHash: planned.run.run.planHash,
        title: "Wrong task",
        body: "Should fail",
      })
    ).toEqual({ error: "unknown taskId", status: 400 });

    const attached = attachFleetPlanCriticArtifact(runId, {
      taskId: planned.run.tasks[0].id,
      expectedPlanHash: planned.run.run.planHash,
      title: "Need narrower parser",
      body: "The plan parser should be bounded and deterministic.",
      severity: "blocker",
      actor: "critic-a",
    });

    expect(attached).toHaveProperty("run");
    if ("error" in attached) return;
    expect(attached.run.artifacts[0]).toMatchObject({
      taskId: planned.run.tasks[0].id,
      title: "Need narrower parser",
      severity: "blocker",
      actor: "critic-a",
    });
    expect(attached.run.events[0]).toMatchObject({
      eventType: "critic_artifact_attached",
      actor: "critic-a",
    });
  });

  it("rejects stale or late critic artifact submissions", () => {
    const runId = createRun();
    const first = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) return;
    const second = ingestFleetRunPlan(runId, {
      planText: "- Build safer parser\n- Add approval",
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) return;

    expect(
      attachFleetPlanCriticArtifact(runId, {
        expectedPlanHash: first.run.run.planHash,
        title: "Stale finding",
        body: "This finding reviewed the previous graph.",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: second.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");

    expect(
      attachFleetPlanCriticArtifact(runId, {
        expectedPlanHash: second.run.run.planHash,
        title: "Late blocker",
        body: "This should not mutate an approved run.",
        severity: "blocker",
      })
    ).toEqual({ error: "run is not awaiting plan findings", status: 409 });
  });

  it("fails closed on legacy blocker artifacts without a plan hash", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    queries
      .createFleetArtifact(db())
      .run(
        "legacy-blocker",
        runId,
        null,
        null,
        "critic_finding",
        "Legacy blocker",
        "This blocker predates artifact hash pinning.",
        "blocker",
        "red-team"
      );

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "blocker findings must be addressed before approval",
      status: 409,
    });
  });
});
