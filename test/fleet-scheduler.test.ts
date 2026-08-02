import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import type { Session } from "@/lib/db";
import { registerFleetCostAccount } from "@/lib/fleet/cost-runtime";
import {
  reconcileFleetRun,
  reconcileFleetRuns,
  reconcileFleetCostTelemetry,
  recoverFleetRuns,
  fleetSessionBackendExists,
  type FleetSchedulerDeps,
} from "@/lib/fleet/scheduler";
import {
  hashFleetAutomationPolicy,
  hashFleetExecutionContract,
  hashFleetTaskRows,
} from "@/lib/fleet/hash";
import { DEFAULT_FLEET_AUTOMATION_POLICY } from "@/lib/fleet/automation-policy";
import type {
  FleetRunRow,
  FleetTaskClaimRow,
  FleetTaskDependencyRow,
  FleetTaskRow,
} from "@/lib/fleet/types";
import { FleetSpawnError } from "@/lib/fleet/spawn";

let db: InstanceType<typeof Database>;
let serial = 0;
const RUN_BASE_SHA = "a".repeat(40);

function addRun(
  overrides: {
    status?: string;
    concurrency?: number;
    provider?: string;
    recovery?: number;
    budget?: number | null;
    desiredState?: string;
    allowUnconfinedAgents?: boolean;
  } = {}
) {
  const id = `run-${++serial}`;
  const status = overrides.status ?? "running";
  const automationPolicy = {
    ...DEFAULT_FLEET_AUTOMATION_POLICY,
    allowUnconfinedAgents: overrides.allowUnconfinedAgents ?? true,
  };
  db.prepare(
    `INSERT INTO fleet_runs
    (id, name, goal, status, desired_state, approval_state, provider,
     max_concurrency, recovery_required, budget_usd, automation_base_sha,
     automation_policy_json, automation_policy_hash, settings_json)
    VALUES (?, 'Fleet', 'Ship safely', ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, '{}')`
  ).run(
    id,
    status,
    overrides.desiredState ??
      (["running", "reviewing", "merging"].includes(status)
        ? "running"
        : status === "paused"
          ? "paused"
          : status),
    overrides.provider ?? "codex",
    overrides.concurrency ?? 6,
    overrides.recovery ?? 0,
    overrides.budget ?? null,
    RUN_BASE_SHA,
    JSON.stringify(automationPolicy),
    hashFleetAutomationPolicy(automationPolicy)
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

function addAuxiliaryCostAccount(
  runId: string,
  input: {
    ownerType?:
      "planner" | "plan_review" | "task_review" | "fixer" | "supervisor";
    ownerId?: string;
    reservationUsd?: number;
    reservationTokens?: number;
  } = {}
) {
  const ownerType = input.ownerType ?? "planner";
  const ownerId = input.ownerId ?? `${runId}-${ownerType}`;
  const sessionId = `${ownerId}-session`;
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, worker_status, working_directory,
      model, group_path, agent_type)
     VALUES (?, ?, ?, 'running', 'working', 'C:\\repo', 'gpt',
             'sessions', 'codex')`
  ).run(sessionId, sessionId, `codex-${sessionId}`);
  const session = db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(sessionId) as Session;
  const reservationUsd = input.reservationUsd ?? 0.25;
  const reservationTokens = input.reservationTokens ?? 500;
  expect(
    registerFleetCostAccount(db, {
      runId,
      ownerType,
      ownerId,
      session,
      provider: "codex",
      model: "gpt",
      reservation: {
        usd: reservationUsd,
        tokens: reservationTokens,
        confidence: "medium",
        basis: "provider-default",
        sampleCount: 0,
      },
    })
  ).toBe(true);
  db.prepare(
    `UPDATE fleet_runs SET reserved_budget_usd = reserved_budget_usd + ?,
     reserved_budget_tokens = reserved_budget_tokens + ? WHERE id = ?`
  ).run(reservationUsd, reservationTokens, runId);
  db.prepare(
    `INSERT INTO fleet_runtime_leases
     (id, fleet_run_id, owner_type, owner_id, resource_type, resource_key,
      units, status)
     VALUES (?, ?, ?, ?, 'pty', 'local', 1, 'reserved')`
  ).run(`${ownerId}-lease`, runId, ownerType, ownerId);
  return { ownerType, ownerId, sessionId, session };
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
    resolveBaseSha: async () => RUN_BASE_SHA,
    prepareAttempt: vi.fn(async ({ runId, taskId, attempt, baseRef }) => ({
      attemptDirectory: `C:\\fleet\\${runId}\\${taskId}\\${attempt}`,
      reportPath: `C:\\fleet\\${runId}\\${taskId}\\${attempt}\\report.json`,
      nonce: "n".repeat(43),
      nonceHash: "a".repeat(64),
      baseSha: baseRef,
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
  it("resolves a nullable tmux name through the provider backend key", async () => {
    const exists = vi.fn(async () => true);
    await expect(
      fleetSessionBackendExists(
        {
          id: "session-pty",
          tmux_name: null,
          agent_type: "codex",
        } as unknown as Parameters<typeof fleetSessionBackendExists>[0],
        { exists }
      )
    ).resolves.toBe(true);
    expect(exists).toHaveBeenCalledWith("codex-session-pty");
  });

  it("delivers one durable interrupt notice and preserves the operator terminal cause", async () => {
    const runId = addRun({ status: "paused" });
    const sessionId = `session-interrupt-${runId}`;
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, group_path, agent_type,
        worker_status)
       VALUES (?, 'Interrupt worker', ?, 'running', 'C:\\repo', 'sessions',
               'codex', 'running')`
    ).run(sessionId, `interrupt-${runId}`);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        interrupt_requested_at, interrupt_deadline_at, interrupt_cause)
       VALUES (?, ?, ?, 'running', 'codex', 1, ?, ?, 'operator_pause')`
    ).run(
      `${runId}-worker-interrupt`,
      runId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    let now = new Date("2026-08-01T12:00:00.000Z");
    let alive = true;
    const sendMessage = vi.fn(async () => {});
    const stopSession = vi.fn(async () => {
      alive = false;
    });
    const deps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => now,
      sessionExists: async () => alive,
      sendMessage,
      stopSession,
      sampleCosts: async () => 0,
    };

    await reconcileFleetRun(runId, deps);
    await reconcileFleetRun(runId, deps);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT interrupt_notice_state, interrupt_stop_state
           FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      interrupt_notice_state: "delivered",
      interrupt_stop_state: "unattempted",
    });

    now = new Date("2026-08-01T12:00:30.000Z");
    await reconcileFleetRun(runId, deps);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      interrupt_stop_state: "confirmed",
      terminal_cause: "operator_interrupt_stop_requested",
    });

    now = new Date("2026-08-01T12:00:31.000Z");
    await reconcileFleetRun(runId, deps);
    expect(
      db
        .prepare(
          `SELECT status, terminal_cause FROM fleet_workers
           WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "dead",
      terminal_cause: "operator_interrupt_stop_requested",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledTimes(1);
  });

  it("fails open on a transient session probe and still enforces an expired interrupt", async () => {
    const runId = addRun({ status: "paused" });
    const sessionId = `session-interrupt-probe-${runId}`;
    const workerId = `${runId}-worker-interrupt-probe`;
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, group_path, agent_type,
        worker_status)
       VALUES (?, 'Interrupt probe worker', ?, 'running', 'C:\\repo',
               'sessions', 'codex', 'running')`
    ).run(sessionId, `interrupt-probe-${runId}`);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        interrupt_requested_at, interrupt_deadline_at, interrupt_notice_state,
        interrupt_cause)
       VALUES (?, ?, ?, 'running', 'codex', 1, ?, ?, 'delivered',
               'operator_pause')`
    ).run(
      workerId,
      runId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    const sessionExists = vi.fn(async () => {
      throw new Error("transient backend probe failure");
    });
    const stopSession = vi.fn(async () => {});

    await reconcileFleetRun(runId, {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sessionExists,
      stopSession,
      sampleCosts: async () => 0,
    });

    expect(sessionExists).toHaveBeenCalledTimes(1);
    expect(stopSession).toHaveBeenCalledWith(sessionId, "failed");
    expect(
      db
        .prepare(
          `SELECT status, interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE id = ?`
        )
        .get(workerId)
    ).toEqual({
      status: "running",
      interrupt_stop_state: "confirmed",
      terminal_cause: "operator_interrupt_stop_requested",
    });
  });

  it("replays a durably requested interrupt stop after a restart", async () => {
    const runId = addRun({ status: "paused" });
    const sessionId = `session-interrupt-replay-${runId}`;
    const workerId = `${runId}-worker-interrupt-replay`;
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, group_path, agent_type,
        worker_status)
       VALUES (?, 'Interrupt replay worker', ?, 'running', 'C:\\repo',
               'sessions', 'codex', 'running')`
    ).run(sessionId, `interrupt-replay-${runId}`);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        interrupt_requested_at, interrupt_deadline_at, interrupt_notice_state,
        interrupt_cause)
       VALUES (?, ?, ?, 'running', 'codex', 1, ?, ?, 'delivered',
               'operator_pause')`
    ).run(
      workerId,
      runId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    let stopAttempts = 0;
    const firstProcessDeps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sessionExists: async () => true,
      stopSession: vi.fn(async () => {
        stopAttempts += 1;
        throw new Error("simulated process exit during stop");
      }),
      sampleCosts: async () => 0,
    };

    await reconcileFleetRun(runId, firstProcessDeps);
    expect(stopAttempts).toBe(1);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE id = ?`
        )
        .get(workerId)
    ).toEqual({
      interrupt_stop_state: "requested",
      terminal_cause: null,
    });

    const restartedDeps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:31.000Z"),
      sessionExists: async () => true,
      stopSession: vi.fn(async () => {
        stopAttempts += 1;
      }),
      sampleCosts: async () => 0,
    };
    await reconcileFleetRun(runId, restartedDeps);

    expect(stopAttempts).toBe(2);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE id = ?`
        )
        .get(workerId)
    ).toEqual({
      interrupt_stop_state: "confirmed",
      terminal_cause: "operator_interrupt_stop_requested",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'worker_interrupt_stop_requested'`
        )
        .get(runId)
    ).toEqual({ count: 1 });
  });

  it("preserves the interrupt cause when stop succeeds but confirmation is lost", async () => {
    const runId = addRun({ status: "paused" });
    const sessionId = `session-interrupt-ambiguous-${runId}`;
    const workerId = `${runId}-worker-interrupt-ambiguous`;
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, group_path, agent_type,
        worker_status)
       VALUES (?, 'Ambiguous interrupt worker', ?, 'running', 'C:\\repo',
               'sessions', 'codex', 'running')`
    ).run(sessionId, `interrupt-ambiguous-${runId}`);
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        interrupt_requested_at, interrupt_deadline_at, interrupt_notice_state,
        interrupt_cause)
       VALUES (?, ?, ?, 'running', 'codex', 1, ?, ?, 'delivered',
               'operator_pause')`
    ).run(
      workerId,
      runId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    let alive = true;
    const stopSession = vi.fn(async () => {
      alive = false;
      throw new Error("process exited before stop confirmation was persisted");
    });
    const deps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sessionExists: async () => alive,
      stopSession,
      sampleCosts: async () => 0,
    };

    await reconcileFleetRun(runId, deps);
    expect(
      db
        .prepare(
          `SELECT status, interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE id = ?`
        )
        .get(workerId)
    ).toEqual({
      status: "running",
      interrupt_stop_state: "requested",
      terminal_cause: null,
    });

    await reconcileFleetRun(runId, deps);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT status, interrupt_stop_state, terminal_cause
           FROM fleet_workers WHERE id = ?`
        )
        .get(workerId)
    ).toEqual({
      status: "dead",
      interrupt_stop_state: "requested",
      terminal_cause: "operator_interrupt_stop_requested",
    });
  });

  it("refuses interrupt side effects for an ambiguously bound active session", async () => {
    const runId = addRun({ status: "paused" });
    const otherRunId = addRun({ status: "paused" });
    const sessionId = `session-duplicate-${runId}`;
    db.prepare(`DROP INDEX idx_fleet_workers_one_active_session`).run();
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, group_path, agent_type,
        worker_status)
       VALUES (?, 'Duplicate owner session', ?, 'running', 'C:\\repo',
               'sessions', 'codex', 'running')`
    ).run(sessionId, `duplicate-${runId}`);
    const insertWorker = db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        interrupt_requested_at, interrupt_deadline_at, interrupt_cause)
       VALUES (?, ?, ?, 'running', 'codex', 1, ?, ?, 'operator_pause')`
    );
    insertWorker.run(
      `${runId}-worker-duplicate`,
      runId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    insertWorker.run(
      `${otherRunId}-worker-duplicate`,
      otherRunId,
      sessionId,
      "2026-08-01T12:00:00.000Z",
      "2026-08-01T12:00:30.000Z"
    );
    const sendMessage = vi.fn(async () => {});
    const stopSession = vi.fn(async () => {});

    await reconcileFleetRun(runId, {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:10.000Z"),
      sessionExists: async () => true,
      sendMessage,
      stopSession,
      sampleCosts: async () => 0,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT event_type, payload FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'worker_interrupt_attention_required'`
        )
        .get(runId)
    ).toMatchObject({
      event_type: "worker_interrupt_attention_required",
      payload: expect.stringContaining("not bound to exactly one"),
    });
  });

  it("samples and hard-stops every auxiliary owner across draft and reviewing phases", async () => {
    const owners = (
      [
        ["planner", "draft", "draft"],
        ["plan_review", "draft", "draft"],
        ["task_review", "reviewing", "running"],
        ["fixer", "reviewing", "running"],
        ["supervisor", "reviewing", "running"],
      ] as const
    ).map(([ownerType, status, desiredState]) => {
      const runId = addRun({
        status,
        desiredState,
        budget: 0.1,
      });
      db.prepare(
        `UPDATE fleet_runs SET budget_stop_mode = 'hard-stop' WHERE id = ?`
      ).run(runId);
      return {
        runId,
        ...addAuxiliaryCostAccount(runId, {
          ownerType,
          reservationUsd: 0,
          reservationTokens: 0,
        }),
      };
    });
    const sendMessage = vi.fn(async () => {});
    const sampleCosts = vi.fn(async (sessions: Session[]) => {
      expect(new Set(sessions.map((session) => session.id))).toEqual(
        new Set(owners.map((owner) => owner.sessionId))
      );
      const insert = db.prepare(
        `INSERT INTO session_costs
         (session_key, day, session_id, agent_type, model, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
          updated_at)
         VALUES (?, '2026-08-01', ?, 'codex', 'gpt', 1000, 0, 0, 0,
                 0.2, '2026-08-01T12:00:00.000Z')`
      );
      for (const owner of owners) {
        const identity = db
          .prepare(
            `SELECT session_key FROM fleet_cost_accounts
             WHERE fleet_run_id = ? AND owner_id = ?`
          )
          .get(owner.runId, owner.ownerId) as { session_key: string };
        insert.run(identity.session_key, owner.sessionId);
      }
      return sessions.length;
    });

    await reconcileFleetRuns({
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      sampleCosts,
      sendMessage,
      sessionExists: async () => true,
    });

    expect(sampleCosts).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(5);
    for (const owner of owners) {
      expect(
        db
          .prepare(
            `SELECT status, desired_state, spent_budget_usd,
                    budget_interrupt_deadline_at
             FROM fleet_runs WHERE id = ?`
          )
          .get(owner.runId)
      ).toEqual({
        status: "paused",
        desired_state: "paused",
        spent_budget_usd: 0.2,
        budget_interrupt_deadline_at: "2026-08-01T12:00:30.000Z",
      });
      expect(
        db
          .prepare(
            `SELECT interrupt_notice_state, interrupt_stop_state,
                    interrupt_cause
             FROM fleet_cost_accounts WHERE fleet_run_id = ?`
          )
          .get(owner.runId)
      ).toEqual({
        interrupt_notice_state: "delivered",
        interrupt_stop_state: "unattempted",
        interrupt_cause: "budget_hard_limit",
      });
    }
  });

  it("rotates bounded cost sampling past unsupported accounts", async () => {
    const runId = addRun({ status: "draft", desiredState: "draft" });
    const unsupported = Array.from({ length: 8 }, (_, index) =>
      addAuxiliaryCostAccount(runId, {
        ownerType: "planner",
        ownerId: `unsupported-${index}`,
      })
    );
    const trackable = addAuxiliaryCostAccount(runId, {
      ownerType: "planner",
      ownerId: "trackable-after-batch",
    });
    for (const owner of unsupported) {
      db.prepare(`UPDATE sessions SET agent_type = 'hermes' WHERE id = ?`).run(
        owner.sessionId
      );
      db.prepare(
        `UPDATE fleet_cost_accounts SET provider = 'hermes'
         WHERE fleet_run_id = ? AND owner_id = ?`
      ).run(runId, owner.ownerId);
    }
    db.prepare(
      `UPDATE fleet_cost_accounts SET sample_attempt_cursor = 1
       WHERE fleet_run_id = ? AND owner_id = ?`
    ).run(runId, trackable.ownerId);

    const sampledBatches: string[][] = [];
    const sampleCosts = vi.fn(async (sessions: Session[]) => {
      sampledBatches.push(sessions.map((session) => session.id));
      if (!sessions.some((session) => session.id === trackable.sessionId)) {
        return 0;
      }
      const account = db
        .prepare(
          `SELECT session_key FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_id = ?`
        )
        .get(runId, trackable.ownerId) as { session_key: string };
      db.prepare(
        `INSERT INTO session_costs
         (session_key, day, session_id, agent_type, model, input_tokens,
          output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
          updated_at)
         VALUES (?, '2026-08-01', ?, 'codex', 'gpt', 1000, 0, 0, 0,
                 0.2, '2026-08-01T12:00:31.000Z')`
      ).run(account.session_key, trackable.sessionId);
      return 1;
    });

    await reconcileFleetCostTelemetry({
      db,
      now: () => new Date("2026-08-01T12:00:00.000Z"),
      sampleCosts,
    });
    await reconcileFleetCostTelemetry({
      db,
      now: () => new Date("2026-08-01T12:00:31.000Z"),
      sampleCosts,
    });

    expect(sampledBatches[0]).not.toContain(trackable.sessionId);
    expect(sampledBatches[1]).toContain(trackable.sessionId);
    expect(
      db
        .prepare(
          `SELECT observed_cost_usd, last_sample_at
           FROM fleet_cost_accounts
           WHERE fleet_run_id = ? AND owner_id = ?`
        )
        .get(runId, trackable.ownerId)
    ).toEqual({
      observed_cost_usd: 0.2,
      last_sample_at: "2026-08-01T12:00:31.000Z",
    });
    expect(
      db
        .prepare(`SELECT spent_budget_usd FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ spent_budget_usd: 0.2 });
  });

  it("claims one auxiliary hard stop across concurrent ticks and replays a transient failure", async () => {
    const runId = addRun({ status: "paused" });
    const account = addAuxiliaryCostAccount(runId, {
      ownerType: "task_review",
    });
    db.prepare(
      `UPDATE fleet_cost_accounts
       SET interrupt_requested_at = '2026-08-01T12:00:00.000Z',
           interrupt_deadline_at = '2026-08-01T12:00:30.000Z',
           interrupt_notice_state = 'delivered',
           interrupt_cause = 'budget_hard_limit'
       WHERE fleet_run_id = ? AND owner_id = ?`
    ).run(runId, account.ownerId);
    let alive = true;
    let attempts = 0;
    const stopSession = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient stop failure");
      alive = false;
    });
    const deps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sampleCosts: async () => 0,
      sessionExists: async () => alive,
      stopSession,
    };

    await Promise.all([
      reconcileFleetRun(runId, deps),
      reconcileFleetRun(runId, deps),
    ]);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, reservation_released_at
           FROM fleet_cost_accounts WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      interrupt_stop_state: "requested",
      reservation_released_at: null,
    });

    await reconcileFleetRun(runId, deps);
    await reconcileFleetRun(runId, deps);
    expect(stopSession).toHaveBeenCalledTimes(2);
    const cost = db
      .prepare(
        `SELECT interrupt_stop_state, terminal_at, reservation_released_at,
                charged_cost_usd, charged_tokens
         FROM fleet_cost_accounts WHERE fleet_run_id = ?`
      )
      .get(runId) as {
      interrupt_stop_state: string;
      terminal_at: string | null;
      reservation_released_at: string | null;
      charged_cost_usd: number;
      charged_tokens: number;
    };
    expect(cost).toMatchObject({
      interrupt_stop_state: "confirmed",
      charged_cost_usd: 0.25,
      charged_tokens: 500,
    });
    expect(cost.terminal_at).not.toBeNull();
    expect(cost.reservation_released_at).not.toBeNull();
    expect(
      db
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens,
                  reserved_budget_usd, reserved_budget_tokens
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      spent_budget_usd: 0.25,
      spent_budget_tokens: 500,
      reserved_budget_usd: 0,
      reserved_budget_tokens: 0,
    });
    expect(
      db
        .prepare(`SELECT status FROM fleet_runtime_leases WHERE owner_id = ?`)
        .get(account.ownerId)
    ).toEqual({ status: "released" });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'auxiliary_interrupt_stop_requested'`
        )
        .get(runId)
    ).toEqual({ count: 1 });
  });

  it("recovers a completed auxiliary stop without issuing it twice or double charging", async () => {
    const runId = addRun({ status: "paused" });
    const account = addAuxiliaryCostAccount(runId, { ownerType: "fixer" });
    db.prepare(
      `UPDATE fleet_cost_accounts
       SET interrupt_requested_at = '2026-08-01T12:00:00.000Z',
           interrupt_deadline_at = '2026-08-01T12:00:30.000Z',
           interrupt_notice_state = 'delivered',
           interrupt_cause = 'budget_hard_limit'
       WHERE fleet_run_id = ? AND owner_id = ?`
    ).run(runId, account.ownerId);
    db.exec(`
      CREATE TRIGGER reject_auxiliary_stop_confirmation
      BEFORE UPDATE OF interrupt_stop_state ON fleet_cost_accounts
      WHEN NEW.interrupt_stop_state = 'confirmed'
      BEGIN
        SELECT RAISE(ABORT, 'simulated confirmation crash');
      END;
    `);
    let alive = true;
    const stopSession = vi.fn(async () => {
      alive = false;
    });
    const deps: Partial<FleetSchedulerDeps> = {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sampleCosts: async () => 0,
      sessionExists: async () => alive,
      stopSession,
    };

    await expect(reconcileFleetRun(runId, deps)).rejects.toThrow(
      "simulated confirmation crash"
    );
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, reservation_released_at
           FROM fleet_cost_accounts WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      interrupt_stop_state: "requested",
      reservation_released_at: null,
    });

    db.exec(`DROP TRIGGER reject_auxiliary_stop_confirmation`);
    await reconcileFleetRun(runId, deps);
    await reconcileFleetRun(runId, deps);
    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(
          `SELECT interrupt_stop_state, charged_cost_usd, charged_tokens
           FROM fleet_cost_accounts WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      interrupt_stop_state: "confirmed",
      charged_cost_usd: 0.25,
      charged_tokens: 500,
    });
    expect(
      db
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ spent_budget_usd: 0.25, spent_budget_tokens: 500 });
  });

  it("refuses to stop an auxiliary session with ambiguous active cost ownership", async () => {
    const runId = addRun({ status: "paused" });
    const account = addAuxiliaryCostAccount(runId, {
      ownerType: "plan_review",
    });
    db.prepare(
      `UPDATE fleet_cost_accounts
       SET interrupt_requested_at = '2026-08-01T12:00:00.000Z',
           interrupt_deadline_at = '2026-08-01T12:00:30.000Z',
           interrupt_notice_state = 'delivered',
           interrupt_cause = 'budget_hard_limit'
       WHERE fleet_run_id = ? AND owner_id = ?`
    ).run(runId, account.ownerId);
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_id, session_key, owner_type, owner_id,
        provider, model)
       VALUES ('ambiguous-cost-owner', ?, ?, 'corrupt-backend-key',
               'task_review', 'ambiguous-request', 'codex', 'gpt')`
    ).run(runId, account.sessionId);
    const stopSession = vi.fn(async () => {});

    await reconcileFleetRun(runId, {
      ...schedulerDeps(),
      now: () => new Date("2026-08-01T12:00:30.000Z"),
      sampleCosts: async () => 0,
      sessionExists: async () => true,
      stopSession,
    });

    expect(stopSession).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT event_type, payload FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'auxiliary_interrupt_attention_required'`
        )
        .get(runId)
    ).toMatchObject({
      event_type: "auxiliary_interrupt_attention_required",
      payload: expect.stringContaining("not bound to exactly one"),
    });
  });

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

  it("pins a root task to the approved run SHA after its branch moves", async () => {
    const movedBranchSha = "b".repeat(40);
    const runId = addRun();
    addTask(runId, "lib/exact-base.ts", 1);
    db.prepare(
      `UPDATE fleet_tasks SET base_branch = 'main' WHERE fleet_run_id = ?`
    ).run(runId);
    const prepareAttempt = vi.fn(
      async ({ runId: rid, taskId, attempt, baseRef }) => ({
        attemptDirectory: `C:\\fleet\\${rid}\\${taskId}\\${attempt}`,
        reportPath: `C:\\fleet\\${rid}\\${taskId}\\${attempt}\\report.json`,
        nonce: "n".repeat(43),
        nonceHash: "a".repeat(64),
        // This models the old behavior: resolving the branch after approval
        // would produce B. Passing the approved SHA remains pinned to A.
        baseSha: baseRef === "main" ? movedBranchSha : baseRef,
      })
    );
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));

    expect(
      await reconcileFleetRun(runId, {
        ...schedulerDeps(spawn),
        prepareAttempt,
      })
    ).toBe(1);

    expect(prepareAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ baseRef: RUN_BASE_SHA })
    );
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.objectContaining({
          base_branch: RUN_BASE_SHA,
          base_sha: RUN_BASE_SHA,
        }),
      })
    );
  });

  it("rejects a prepared A-to-B base drift before spawning or persisting it", async () => {
    const runId = addRun();
    addTask(runId, "lib/import-gap.ts", 1);
    const prepareAttempt = vi.fn(async ({ runId: rid, taskId, attempt }) => ({
      attemptDirectory: `C:\\fleet\\${rid}\\${taskId}\\${attempt}`,
      reportPath: `C:\\fleet\\${rid}\\${taskId}\\${attempt}\\report.json`,
      nonce: "n".repeat(43),
      nonceHash: "a".repeat(64),
      baseSha: "b".repeat(40),
    }));
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));

    expect(
      await reconcileFleetRun(runId, {
        ...schedulerDeps(spawn),
        prepareAttempt,
      })
    ).toBe(1);

    expect(spawn).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT base_sha FROM fleet_tasks WHERE fleet_run_id = ?`)
        .get(runId)
    ).toEqual({ base_sha: null });
  });

  it("uses the exact integrated task SHA for a dependency task", async () => {
    const runId = addRun();
    const upstreamId = addTask(runId, "lib/upstream.ts", 1);
    const dependentId = addTask(runId, "lib/dependent.ts", 2);
    const integratedSha = "c".repeat(40);
    db.prepare(`UPDATE fleet_tasks SET status = 'completed' WHERE id = ?`).run(
      upstreamId
    );
    db.prepare(`UPDATE fleet_tasks SET base_sha = ? WHERE id = ?`).run(
      integratedSha,
      dependentId
    );
    db.prepare(
      `INSERT INTO fleet_task_dependencies
       (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
       VALUES ('exact-base-dependency', ?, ?, ?, 'blocks')`
    ).run(runId, dependentId, upstreamId);
    const prepareAttempt = vi.fn(
      async ({ runId: rid, taskId, attempt, baseRef }) => ({
        attemptDirectory: `C:\\fleet\\${rid}\\${taskId}\\${attempt}`,
        reportPath: `C:\\fleet\\${rid}\\${taskId}\\${attempt}\\report.json`,
        nonce: "n".repeat(43),
        nonceHash: "a".repeat(64),
        baseSha: baseRef,
      })
    );

    expect(
      await reconcileFleetRun(runId, {
        ...schedulerDeps(),
        prepareAttempt,
      })
    ).toBe(1);
    expect(prepareAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: dependentId, baseRef: integratedSha })
    );
  });

  it("rechecks the current target branch before leasing any worker", async () => {
    const runId = addRun();
    addTask(runId, "lib/base-drift.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const deps = {
      ...schedulerDeps(spawn),
      resolveBaseSha: vi.fn(async () => "b".repeat(40)),
    };

    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(deps.resolveBaseSha).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    expect(deps.prepareAttempt).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT status, approval_state, pause_reason, automation_last_error
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "paused",
      approval_state: "blocked",
      pause_reason: "approval_changed",
      automation_last_error:
        "Fleet base commit changed before worker admission",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
           WHERE fleet_run_id = ? AND event_type = 'fleet_base_drift_detected'`
        )
        .get(runId)
    ).toEqual({ count: 1 });
  });

  it("durably blocks a legacy unconsented run before leasing", async () => {
    const runId = addRun({ allowUnconfinedAgents: false });
    addTask(runId, "lib/consent.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));

    expect(await reconcileFleetRun(runId, schedulerDeps(spawn))).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          `SELECT status, approval_state, pause_reason, automation_last_error
           FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "paused",
      approval_state: "blocked",
      pause_reason: "approval_changed",
      automation_last_error:
        "Fleet run lacks explicit unconfined-agent consent; recreate it with consent before execution",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_events
           WHERE fleet_run_id = ?
             AND event_type = 'fleet_unattended_consent_required'`
        )
        .get(runId)
    ).toEqual({ count: 1 });
  });

  it("blocks an approved run whose exact base binding is absent", async () => {
    const runId = addRun();
    addTask(runId, "lib/missing-base.ts", 1);
    db.prepare(
      `UPDATE fleet_runs SET automation_base_sha = NULL WHERE id = ?`
    ).run(runId);
    const deps = schedulerDeps();

    expect(await reconcileFleetRun(runId, deps)).toBe(0);
    expect(deps.prepareAttempt).not.toHaveBeenCalled();
    expect(
      db
        .prepare(`SELECT status, approval_state FROM fleet_runs WHERE id = ?`)
        .get(runId)
    ).toEqual({ status: "paused", approval_state: "blocked" });
  });

  it("continues scheduler admission in reviewing and merging phases while honoring desired state", async () => {
    const reviewing = addRun({ status: "reviewing" });
    const merging = addRun({ status: "merging" });
    const pausedIntent = addRun({
      status: "reviewing",
      desiredState: "paused",
    });
    addTask(reviewing, "lib/reviewing.ts", 1);
    addTask(merging, "lib/merging.ts", 1);
    addTask(pausedIntent, "lib/paused-intent.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));

    expect(await reconcileFleetRuns(schedulerDeps(spawn))).toBe(2);
    const statuses = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT fleet_run_id, status FROM fleet_tasks
             WHERE fleet_run_id IN (?, ?, ?)`
          )
          .all(reviewing, merging, pausedIntent) as Array<{
          fleet_run_id: string;
          status: string;
        }>
      ).map((row) => [row.fleet_run_id, row.status])
    );
    expect(statuses).toEqual({
      [reviewing]: "running",
      [merging]: "running",
      [pausedIntent]: "ready",
    });
  });

  it("rotates a bounded durable batch across every active run", async () => {
    for (let index = 0; index < 45; index += 1) addRun();
    const deps = schedulerDeps();

    await reconcileFleetRuns(deps);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runs
           WHERE scheduler_poll_cursor = 0`
        )
        .get()
    ).toEqual({ count: 5 });

    await reconcileFleetRuns(deps);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runs
           WHERE scheduler_poll_cursor = 0`
        )
        .get()
    ).toEqual({ count: 0 });
  });

  it("recovers an in-flight worker while the run is presented as reviewing", async () => {
    const runId = addRun({ status: "reviewing" });
    const taskId = addTask(runId, "lib/recovery-review.ts", 1);
    const spawned = fakeSpawnResult(taskId);
    db.prepare(`UPDATE fleet_tasks SET status = 'spawning' WHERE id = ?`).run(
      taskId
    );
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, session_id, status, provider, attempt,
        spawn_request_id, lease_expires_at)
       VALUES ('reviewing-recovery-worker', ?, ?, ?, 'spawning', 'codex', 1,
               'reviewing-recovery-request', '2026-08-01T12:01:00.000Z')`
    ).run(runId, taskId, spawned.sessionId);

    await recoverFleetRuns({
      ...schedulerDeps(),
      sessionExists: async () => true,
      sampleCosts: async () => 0,
    });

    expect(
      db
        .prepare(
          `SELECT status, recovery_required FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ status: "reviewing", recovery_required: 0 });
    expect(
      db
        .prepare(
          `SELECT status, session_id FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({ status: "running", session_id: spawned.sessionId });
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

  it("stops and preserves a successful spawn when post-spawn persistence fails", async () => {
    const runId = addRun();
    const taskId = addTask(runId, "lib/post-spawn.ts", 1);
    const spawn = vi.fn(async ({ task }) => fakeSpawnResult(task.id));
    const stopSession = vi.fn(async () => {});
    const deps = { ...schedulerDeps(spawn), stopSession };
    db.exec(`
      CREATE TRIGGER reject_post_spawn_task_start
      BEFORE UPDATE OF status ON fleet_tasks
      WHEN NEW.status = 'running'
      BEGIN
        SELECT RAISE(ABORT, 'simulated post-spawn persistence failure');
      END;
    `);

    await expect(reconcileFleetRun(runId, deps)).resolves.toBe(1);

    const sessionId = `session-${taskId}`;
    expect(stopSession).toHaveBeenCalledWith(sessionId);
    expect(
      db
        .prepare(
          `SELECT status, session_id, worktree_path, terminal_cause
           FROM fleet_workers WHERE fleet_run_id = ?`
        )
        .get(runId)
    ).toEqual({
      status: "failed",
      session_id: sessionId,
      worktree_path: `C:\\wt\\${taskId}`,
      terminal_cause: "spawn_failed_preserved",
    });
    expect(
      db
        .prepare(`SELECT status, worktree_path FROM fleet_tasks WHERE id = ?`)
        .get(taskId)
    ).toEqual({
      status: "needs_inspection",
      worktree_path: `C:\\wt\\${taskId}`,
    });
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
