import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import {
  reconcileFleetRun,
  reconcileFleetRuns,
  recoverFleetRuns,
  type FleetSchedulerDeps,
} from "@/lib/fleet/scheduler";
import {
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";
import { FleetSpawnError } from "@/lib/fleet/spawn";

let db: InstanceType<typeof Database>;
let serial = 0;

function addRun(
  overrides: {
    status?: string;
    concurrency?: number;
    provider?: string;
    recovery?: number;
    budget?: number | null;
  } = {}
) {
  const id = `run-${++serial}`;
  db.prepare(
    `INSERT INTO fleet_runs
    (id, name, goal, status, approval_state, provider, max_concurrency, recovery_required, budget_usd, settings_json)
    VALUES (?, 'Fleet', 'Ship safely', ?, 'approved', ?, ?, ?, ?, '{}')`
  ).run(
    id,
    overrides.status ?? "running",
    overrides.provider ?? "codex",
    overrides.concurrency ?? 6,
    overrides.recovery ?? 0,
    overrides.budget ?? null
  );
  return id;
}

function addTask(runId: string, claim: string, order: number) {
  const id = `${runId}-task-${order}`;
  db.prepare(
    `INSERT INTO fleet_tasks
    (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
     approval_state, working_directory)
    VALUES (?, ?, ?, 'ready', 'task', ?, ?, 'approved', ?)`
  ).run(id, runId, `Task ${order}`, order, JSON.stringify([claim]), "C:\\repo");
  db.prepare(
    `INSERT INTO fleet_task_claims (id, fleet_run_id, task_id, path, claim_type, confidence)
    VALUES (?, ?, ?, ?, 'exclusive', 1)`
  ).run(`claim-${id}`, runId, id, claim);
  return id;
}

function fakeSpawnResult(taskId: string) {
  const sessionId = `session-${taskId}`;
  db.prepare(
    `INSERT OR IGNORE INTO sessions
      (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
     VALUES (?, ?, ?, 'running', 'C:\\repo', 'gpt', 'sessions', 'codex')`
  ).run(sessionId, taskId, `codex-${taskId}`);
  return { sessionId, worktreePath: `C:\\wt\\${taskId}` };
}

function schedulerDeps(
  spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id))
): Partial<FleetSchedulerDeps> {
  const runs = db
    .prepare(`SELECT id FROM fleet_runs WHERE approved_plan_hash IS NULL`)
    .all() as { id: string }[];
  for (const run of runs) {
    const tasks = db
      .prepare(`SELECT * FROM fleet_tasks WHERE fleet_run_id = ?`)
      .all(run.id) as FleetTaskRow[];
    const runRow = db
      .prepare(`SELECT * FROM fleet_runs WHERE id = ?`)
      .get(run.id) as FleetRunRow;
    const claims = db
      .prepare(`SELECT * FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .all(run.id) as FleetTaskClaimRow[];
    const dependencies = db
      .prepare(`SELECT * FROM fleet_task_dependencies WHERE fleet_run_id = ?`)
      .all(run.id) as FleetTaskDependencyRow[];
    const executionHash = hashFleetExecutionContract({
      run: runRow,
      tasks,
      claims,
      dependencies,
    });
    db.prepare(
      `UPDATE fleet_runs SET approved_plan_hash = ?, settings_json = ? WHERE id = ?`
    ).run(
      hashFleetTaskRows(tasks, dependencies),
      JSON.stringify({ approvedExecutionHash: executionHash }),
      run.id
    );
  }
  return {
    db,
    now: () => new Date("2026-08-01T12:00:00.000Z"),
    spawn,
    prepareAttempt: vi.fn(async ({ runId, taskId, attempt }) => ({
      attemptDirectory: `C:\\fleet\\${runId}\\${taskId}\\${attempt}`,
      reportPath: `C:\\fleet\\${runId}\\${taskId}\\${attempt}\\report.json`,
      nonce: "n".repeat(43),
      nonceHash: "a".repeat(64),
      baseSha: "b".repeat(40),
    })),
    sessionExists: async () => false,
    stopSession: async () => {},
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

describe("fleet scheduler", () => {
  it("launches independent tasks and serializes overlapping claims", async () => {
    const runId = addRun();
    addTask(runId, "lib/a.ts", 1);
    addTask(runId, "test/b.ts", 2);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(2);
    const reserved = db
      .prepare(
        `SELECT COUNT(*) AS n FROM fleet_resource_leases WHERE fleet_run_id = ? AND status = 'reserved'`
      )
      .get(runId) as { n: number };
    expect(reserved.n).toBe(6);

    const conflictRun = addRun();
    addTask(conflictRun, "lib/fleet", 1);
    addTask(conflictRun, "lib/fleet/service.ts", 2);
    expect(await reconcileFleetRun(conflictRun, schedulerDeps(spawn))).toBe(1);
    const statuses = db
      .prepare(
        `SELECT status FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(conflictRun) as { status: string }[];
    expect(statuses.map((row) => row.status)).toEqual(["running", "ready"]);
  });

  it("surfaces a task whose blocking dependency failed", async () => {
    const runId = addRun();
    const upstreamId = addTask(runId, "lib/a.ts", 1);
    const downstreamId = addTask(runId, "lib/b.ts", 2);
    db.prepare(`UPDATE fleet_tasks SET status = 'failed' WHERE id = ?`).run(
      upstreamId
    );
    db.prepare(
      `INSERT INTO fleet_task_dependencies
       (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
       VALUES ('dependency-failure', ?, ?, ?, 'blocks')`
    ).run(runId, downstreamId, upstreamId);

    expect(await reconcileFleetRun(runId, schedulerDeps())).toBe(0);
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks WHERE id = ?`)
        .get(downstreamId)
    ).toEqual({ status: "blocked", failure_code: "dependency_failed" });
  });

  it("deduplicates concurrent ticks with a per-run lock", async () => {
    const runId = addRun();
    addTask(runId, "lib/a.ts", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async ({ task }) => {
      await gate;
      return fakeSpawnResult(task.id);
    });
    const first = reconcileFleetRun(runId, schedulerDeps(spawn));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(0);
    release();
    expect(await first).toBe(1);
  });

  it("does not resurrect a worker canceled during external spawn", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async ({ task }) => {
      await gate;
      return fakeSpawnResult(task.id);
    });
    const stopSession = vi.fn(async () => {});
    const running = reconcileFleetRun(runId, {
      ...schedulerDeps(spawn),
      stopSession,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    db.prepare(`UPDATE fleet_runs SET status = 'canceled' WHERE id = ?`).run(
      runId
    );
    db.prepare(`UPDATE fleet_tasks SET status = 'canceled' WHERE id = ?`).run(
      taskId
    );
    db.prepare(
      `UPDATE fleet_workers SET status = 'canceled' WHERE fleet_run_id = ?`
    ).run(runId);
    db.prepare(
      `UPDATE fleet_resource_leases SET status = 'released' WHERE fleet_run_id = ?`
    ).run(runId);
    release();
    await running;
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_complete");
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
          .get(taskId) as {
          status: string;
        }
      ).status
    ).toBe("canceled");
  });

  it("does not finalize canceled cleanup while its spawn is still in flight", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async ({ task }) => {
      await gate;
      return fakeSpawnResult(task.id);
    });
    const stopSession = vi.fn(async () => {});
    const deps = { ...schedulerDeps(spawn), stopSession };
    const launch = reconcileFleetRun(runId, deps);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    db.prepare(`UPDATE fleet_runs SET status = 'canceled' WHERE id = ?`).run(
      runId
    );
    db.prepare(`UPDATE fleet_tasks SET status = 'canceled' WHERE id = ?`).run(
      taskId
    );
    db.prepare(
      `UPDATE fleet_workers SET status = 'cleanup_pending' WHERE fleet_run_id = ?`
    ).run(runId);

    await reconcileFleetRuns(deps);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_pending");
    release();
    await launch;
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_complete");
  });

  it("keeps a late recovered spawn cleanup-pending when stop fails", async () => {
    const runId = addRun();
    addTask(runId, "lib/a.ts", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async ({ task }) => {
      await gate;
      return fakeSpawnResult(task.id);
    });
    const stopSession = vi.fn(async () => {
      throw new Error("still alive");
    });
    const launch = reconcileFleetRun(runId, {
      ...schedulerDeps(spawn),
      stopSession,
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    db.prepare(
      `UPDATE fleet_workers SET status = 'failed', terminal_cause = 'recovery_expired'
       WHERE fleet_run_id = ?`
    ).run(runId);
    release();
    await launch;
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_pending");
  });

  it("accepts an idempotent launch already correlated by recovery", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawn = vi.fn(async () => {
      const result = fakeSpawnResult(taskId);
      await gate;
      return result;
    });
    const stopSession = vi.fn(async () => {});
    const deps = {
      ...schedulerDeps(spawn),
      sessionExists: async () => true,
      stopSession,
    };
    const launch = reconcileFleetRun(runId, deps);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    db.prepare(`UPDATE fleet_runs SET recovery_required = 1 WHERE id = ?`).run(
      runId
    );
    await recoverFleetRuns(deps, { markActive: false });
    release();
    await launch;

    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
        .get(runId)
    ).toEqual({ status: "running" });
  });

  it("retries a failed spawn after its durable provider backoff", async () => {
    const runId = addRun();
    addTask(runId, "lib/a.ts", 1);
    const spawn = vi
      .fn()
      .mockRejectedValueOnce(new Error("worktree failed"))
      .mockImplementationOnce(async ({ task }) => fakeSpawnResult(task.id));
    const deps = schedulerDeps(spawn);
    expect(await reconcileFleetRun(runId, deps)).toBe(1);
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM fleet_resource_leases WHERE fleet_run_id = ? AND status = 'reserved'`
          )
          .get(runId) as { n: number }
      ).n
    ).toBe(0);
    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'provider_spawn_backoff_scheduled'`
        )
        .get(runId)
    ).toEqual({ n: 1 });
    expect(
      db
        .prepare(
          `SELECT retry_not_before, provider_state, provider_failure_count
           FROM fleet_tasks WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      retry_not_before: "2026-08-01T12:00:05.000Z",
      provider_state: "backoff",
      provider_failure_count: 1,
    });
    expect(
      await reconcileFleetRun(runId, {
        ...deps,
        now: () => new Date("2026-08-01T12:00:05.000Z"),
      })
    ).toBe(1);
    const requests = db
      .prepare(
        `SELECT spawn_request_id FROM fleet_workers WHERE fleet_run_id = ? ORDER BY attempt`
      )
      .all(runId) as { spawn_request_id: string }[];
    expect(requests.map((row) => row.spawn_request_id)).toEqual([
      expect.stringMatching(/:1$/),
      expect.stringMatching(/:2$/),
    ]);
  });

  it("preserves a failed launched worktree for operator inspection", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    const session = fakeSpawnResult(taskId);
    const spawn = vi.fn(async () => {
      throw new FleetSpawnError(
        "task delivery failed",
        session.sessionId,
        session.worktreePath
      );
    });
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(1);
    const worker = db
      .prepare(
        `SELECT status, session_id, worktree_path FROM fleet_workers WHERE fleet_run_id = ?`
      )
      .get(runId) as {
      status: string;
      session_id: string;
      worktree_path: string;
    };
    expect(worker).toEqual({
      status: "failed",
      session_id: session.sessionId,
      worktree_path: session.worktreePath,
    });
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
          .get(taskId) as {
          status: string;
        }
      ).status
    ).toBe("needs_inspection");
  });

  it("retries a failed spawn cleanup during normal reconciliation", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    const session = fakeSpawnResult(taskId);
    const spawn = vi.fn(async () => {
      throw new FleetSpawnError(
        "task delivery failed",
        session.sessionId,
        session.worktreePath
      );
    });
    const stopSession = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("still alive"))
      .mockResolvedValue(undefined);
    const deps = { ...schedulerDeps(spawn), stopSession };
    await reconcileFleetRun(runId, deps);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_pending");

    await reconcileFleetRuns(deps);
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("failed");
  });

  it("blocks launch during recovery and expires stale leases before retry", async () => {
    const runId = addRun({ recovery: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'leasing', lease_expires_at = '2026-07-31T00:00:00.000Z', current_attempt = 1 WHERE id = ?`
    ).run(taskId);
    db.prepare(
      `INSERT INTO fleet_workers
      (id, fleet_run_id, task_id, status, provider, attempt, spawn_request_id, lease_expires_at, reservation_usd)
      VALUES ('stale-worker', ?, ?, 'spawning', 'codex', 1, 'stale-request', '2026-07-31T00:00:00.000Z', 0.25)`
    ).run(runId, taskId);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const deps = schedulerDeps(spawn);
    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    await recoverFleetRuns(deps);
    const recovered = db
      .prepare(`SELECT recovery_required FROM fleet_runs WHERE id = ?`)
      .get(runId) as { recovery_required: number };
    expect(recovered.recovery_required).toBe(0);
    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(
      await reconcileFleetRun(runId, {
        ...deps,
        now: () => new Date("2026-08-01T12:00:05.000Z"),
      })
    ).toBe(1);
  });

  it("does not retry an expired final attempt and accounts committed budget", async () => {
    const runId = addRun({ recovery: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    db.prepare(
      `UPDATE fleet_runs SET reserved_budget_usd = 0.25 WHERE id = ?`
    ).run(runId);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'spawning', current_attempt = 2, max_attempts = 2,
       lease_expires_at = '2026-07-31T00:00:00.000Z' WHERE id = ?`
    ).run(taskId);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, provider, attempt, spawn_request_id,
        worktree_path, lease_expires_at, reservation_usd)
       VALUES ('final-worker', ?, ?, 'spawning', 'codex', 2, 'final-request',
        'C:\\wt\\final', '2026-07-31T00:00:00.000Z', 0.25)`
    ).run(runId, taskId);

    await recoverFleetRuns(schedulerDeps());
    const task = db
      .prepare(`SELECT status FROM fleet_tasks WHERE id = ?`)
      .get(taskId) as { status: string };
    const run = db
      .prepare(
        `SELECT reserved_budget_usd, spent_budget_usd FROM fleet_runs WHERE id = ?`
      )
      .get(runId) as {
      reserved_budget_usd: number;
      spent_budget_usd: number;
    };
    expect(task.status).toBe("needs_inspection");
    expect(run).toEqual({ reserved_budget_usd: 0, spent_budget_usd: 0.25 });
  });

  it("preserves a committed non-final recovery attempt for inspection", async () => {
    const runId = addRun({ recovery: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    db.prepare(
      `UPDATE fleet_runs SET reserved_budget_usd = 0.25 WHERE id = ?`
    ).run(runId);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'spawning', current_attempt = 1, max_attempts = 2,
       lease_expires_at = '2026-07-31T00:00:00.000Z' WHERE id = ?`
    ).run(taskId);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, provider, attempt, spawn_request_id,
        worktree_path, lease_expires_at, reservation_usd)
       VALUES ('committed-worker', ?, ?, 'spawning', 'codex', 1, 'committed-request',
        'C:\\wt\\committed', '2026-07-31T00:00:00.000Z', 0.25)`
    ).run(runId, taskId);

    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const deps = schedulerDeps(spawn);
    await recoverFleetRuns(deps);
    expect(
      db
        .prepare(`SELECT status, worktree_path FROM fleet_tasks WHERE id = ?`)
        .get(taskId) as { status: string; worktree_path: string }
    ).toEqual({
      status: "needs_inspection",
      worktree_path: "C:\\wt\\committed",
    });
    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("fences concurrent recovery accounting for one expired worker", async () => {
    const runId = addRun({ recovery: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    const session = fakeSpawnResult(taskId);
    db.prepare(
      `UPDATE fleet_runs SET reserved_budget_usd = 0.25 WHERE id = ?`
    ).run(runId);
    db.prepare(
      `UPDATE fleet_tasks SET status = 'spawning', current_attempt = 1,
       lease_expires_at = '2026-07-31T00:00:00.000Z' WHERE id = ?`
    ).run(taskId);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, session_id, status, provider, attempt,
        spawn_request_id, worktree_path, lease_expires_at, reservation_usd)
       VALUES ('concurrent-recovery', ?, ?, ?, 'spawning', 'codex', 1,
        'concurrent-request', 'C:\\wt\\concurrent', '2026-07-31T00:00:00.000Z', 0.25)`
    ).run(runId, taskId, session.sessionId);
    let releaseChecks!: () => void;
    const checkGate = new Promise<void>((resolve) => {
      releaseChecks = resolve;
    });
    const sessionExists = vi.fn(async () => {
      await checkGate;
      return false;
    });
    const deps = { ...schedulerDeps(), sessionExists };

    const first = recoverFleetRuns(deps);
    const second = recoverFleetRuns(deps);
    await vi.waitFor(() => expect(sessionExists).toHaveBeenCalledTimes(2));
    releaseChecks();
    await Promise.all([first, second]);

    expect(
      db
        .prepare(
          `SELECT reserved_budget_usd, spent_budget_usd FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ reserved_budget_usd: 0, spent_budget_usd: 0.25 });
    expect(
      db
        .prepare(
          `SELECT event_type, COUNT(*) AS n FROM fleet_events
         WHERE fleet_run_id = ? AND event_type IN ('recovery_expired', 'recovery_completed')
         GROUP BY event_type ORDER BY event_type`
        )
        .all(runId)
    ).toEqual([
      { event_type: "recovery_completed", n: 1 },
      { event_type: "recovery_expired", n: 1 },
    ]);
  });

  it("admits only one local wave from a 40-task plan", async () => {
    const runId = addRun({ concurrency: 40, provider: "codex" });
    for (let index = 0; index < 40; index++)
      addTask(runId, `area-${index}/file.ts`, index);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const started = Date.now();
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(6);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(spawn).toHaveBeenCalledTimes(6);
  });

  it("applies the effective task provider cap", async () => {
    const runId = addRun({ concurrency: 6, provider: "codex" });
    for (let index = 0; index < 3; index++) {
      const taskId = addTask(runId, `area-${index}/file.ts`, index);
      db.prepare(
        `UPDATE fleet_tasks SET agent_type = 'hermes' WHERE id = ?`
      ).run(taskId);
    }
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(2);
  });

  it("counts active planners against worker provider capacity", async () => {
    const runId = addRun({ concurrency: 6, provider: "hermes" });
    addTask(runId, "lib/a.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const deps = schedulerDeps(spawn);
    for (let index = 0; index < 2; index++) {
      const plannerRunId = addRun({ status: "draft", provider: "hermes" });
      db.prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`).run(
        JSON.stringify({ planner: { state: "running", provider: "hermes" } }),
        plannerRunId
      );
    }

    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("releases a terminal wave and admits later work", async () => {
    const runId = addRun({ concurrency: 1 });
    addTask(runId, "lib/a.ts", 1);
    addTask(runId, "lib/b.ts", 2);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(1);
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(1);
    const statuses = db
      .prepare(
        `SELECT status FROM fleet_tasks WHERE fleet_run_id = ? ORDER BY sort_order`
      )
      .all(runId) as { status: string }[];
    expect(statuses.map((row) => row.status)).toEqual([
      "needs_inspection",
      "running",
    ]);
  });

  it("does not trust a terminal session flag while its backend is alive", async () => {
    const runId = addRun({ concurrency: 1 });
    addTask(runId, "lib/a.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const stopSession = vi.fn(async () => {
      throw new Error("still alive");
    });
    const deps = {
      ...schedulerDeps(spawn),
      sessionExists: async () => true,
      stopSession,
    };
    await reconcileFleetRun(runId, deps);
    db.prepare(
      `UPDATE sessions SET worker_status = 'completed' WHERE id = (
       SELECT session_id FROM fleet_workers WHERE fleet_run_id = ?)`
    ).run(runId);
    await reconcileFleetRun(runId, deps);
    expect(
      (
        db
          .prepare(`SELECT status FROM fleet_workers WHERE fleet_run_id = ?`)
          .get(runId) as { status: string }
      ).status
    ).toBe("cleanup_pending");
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM fleet_resource_leases
             WHERE fleet_run_id = ? AND status = 'reserved'`
          )
          .get(runId) as { n: number }
      ).n
    ).toBe(3);

    const before = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events WHERE fleet_run_id = ?`
        )
        .get(runId) as { n: number }
    ).n;
    await reconcileFleetRuns(deps);
    await reconcileFleetRuns(deps);
    const after = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events WHERE fleet_run_id = ?`
        )
        .get(runId) as { n: number }
    ).n;
    expect(after).toBe(before);
  });

  it("does not overwrite cancellation while terminal cleanup is in flight", async () => {
    const runId = addRun({ concurrency: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stopSession = vi.fn(async () => stopGate);
    const deps = {
      ...schedulerDeps(),
      sessionExists: async () => true,
      stopSession,
    };
    await reconcileFleetRun(runId, deps);
    db.prepare(
      `UPDATE sessions SET worker_status = 'completed' WHERE id = (
       SELECT session_id FROM fleet_workers WHERE fleet_run_id = ?)`
    ).run(runId);
    const polling = reconcileFleetRun(runId, deps);
    await vi.waitFor(() => expect(stopSession).toHaveBeenCalledTimes(1));
    db.prepare(`UPDATE fleet_runs SET status = 'canceled' WHERE id = ?`).run(
      runId
    );
    db.prepare(`UPDATE fleet_tasks SET status = 'canceled' WHERE id = ?`).run(
      taskId
    );
    db.prepare(
      `UPDATE fleet_workers SET status = 'cleanup_pending', terminal_cause = 'operator_cancel_pending'
       WHERE fleet_run_id = ?`
    ).run(runId);
    releaseStop();
    await polling;

    expect(
      db
        .prepare(
          `SELECT status, terminal_cause FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "cleanup_pending",
      terminal_cause: "operator_cancel_pending",
    });
  });

  it("counts terminal reservations as cumulative conservative spend", async () => {
    const runId = addRun({ concurrency: 1, budget: 0.25 });
    addTask(runId, "lib/a.ts", 1);
    addTask(runId, "lib/b.ts", 2);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(1);
    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(0);
    const run = db
      .prepare(
        `SELECT status, spent_budget_usd, reserved_budget_usd FROM fleet_runs WHERE id = ?`
      )
      .get(runId) as {
      status: string;
      spent_budget_usd: number;
      reserved_budget_usd: number;
    };
    expect(run).toEqual({
      status: "paused",
      spent_budget_usd: 0.25,
      reserved_budget_usd: 0,
    });
  });

  it("honors pause and budget admission", async () => {
    const paused = addRun({ status: "paused" });
    addTask(paused, "lib/a.ts", 1);
    expect(await reconcileFleetRun(paused, schedulerDeps())).toBe(0);
    const budgeted = addRun({ budget: 0.1 });
    addTask(budgeted, "lib/b.ts", 1);
    expect(await reconcileFleetRun(budgeted, schedulerDeps())).toBe(0);
  });

  it("continues polling active workers while pause-new is set", async () => {
    const runId = addRun({ concurrency: 1 });
    const taskId = addTask(runId, "lib/a.ts", 1);
    const deps = schedulerDeps();
    await reconcileFleetRun(runId, deps);
    db.prepare(
      `UPDATE fleet_runs SET status = 'paused', pause_mode = 'pause-new' WHERE id = ?`
    ).run(runId);

    await reconcileFleetRuns(deps);
    expect(
      db.prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(taskId)
    ).toEqual({ status: "needs_inspection" });
  });

  it("blocks an approved plan that was changed after approval", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    const approvedDeps = schedulerDeps();
    db.prepare(`UPDATE fleet_tasks SET title = 'Tampered' WHERE id = ?`).run(
      taskId
    );
    expect(await reconcileFleetRun(runId, approvedDeps)).toBe(0);
    const run = db
      .prepare(`SELECT status, approval_state FROM fleet_runs WHERE id = ?`)
      .get(runId) as { status: string; approval_state: string };
    expect(run).toEqual({ status: "paused", approval_state: "blocked" });
  });

  it("blocks execution-claim changes made after approval", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/a.ts", 1);
    const approvedDeps = schedulerDeps();
    db.prepare(
      `UPDATE fleet_task_claims SET path = 'lib/unsafe.ts' WHERE task_id = ?`
    ).run(taskId);
    expect(await reconcileFleetRun(runId, approvedDeps)).toBe(0);
    expect(
      (
        db
          .prepare(`SELECT approval_state FROM fleet_runs WHERE id = ?`)
          .get(runId) as { approval_state: string }
      ).approval_state
    ).toBe("blocked");
  });

  it("finishes durable canceled cleanup during startup recovery", async () => {
    const runId = addRun({ status: "canceled" });
    const taskId = addTask(runId, "lib/a.ts", 1);
    const session = fakeSpawnResult(taskId);
    db.prepare(`UPDATE fleet_tasks SET status = 'canceled' WHERE id = ?`).run(
      taskId
    );
    db.prepare(
      `INSERT INTO fleet_workers
      (id, fleet_run_id, task_id, session_id, status, provider, attempt, spawn_request_id)
      VALUES ('cleanup-worker', ?, ?, ?, 'cleanup_pending', 'codex', 1, 'cleanup-request')`
    ).run(runId, taskId, session.sessionId);
    const stopSession = vi.fn(async () => {});
    await recoverFleetRuns({
      ...schedulerDeps(),
      stopSession,
    });
    expect(stopSession).toHaveBeenCalledWith(session.sessionId, "failed");
    expect(
      (
        db
          .prepare(
            `SELECT status FROM fleet_workers WHERE id = 'cleanup-worker'`
          )
          .get() as {
          status: string;
        }
      ).status
    ).toBe("cleanup_complete");
  });
});
