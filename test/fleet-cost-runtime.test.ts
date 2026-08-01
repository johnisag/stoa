import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import type { Session } from "@/lib/db";
import {
  finalizeFleetWorkerCost,
  reconcileFleetCostAccount,
  registerFleetCostAccount,
  releaseFleetCostOwnerReservation,
  reserveFleetCostOwner,
  settleFleetWorkerCost,
  settleFleetCostOwner,
} from "@/lib/fleet/cost-runtime";
import type { FleetWorkerRow } from "@/lib/fleet/types";

function fixture() {
  const db = new Database(":memory:");
  createSchema(db);
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, reserved_budget_usd, reserved_budget_tokens)
     VALUES ('run-1', 'Fleet', 'Goal', 1, 100000)`
  ).run();
  db.prepare(
    `INSERT INTO fleet_tasks
     (id, fleet_run_id, title, task_type, file_claims_json)
     VALUES ('task-1', 'run-1', 'Task', 'implementation', '[]')`
  ).run();
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
     VALUES ('session-1', 'Worker', 'codex-session-1', 'running', 'C:\\repo',
             'gpt-5.4', 'sessions', 'codex')`
  ).run();
  db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, task_id, session_id, status, provider, model, attempt,
      reservation_usd, reservation_tokens, reservation_confidence)
     VALUES ('worker-1', 'run-1', 'task-1', 'session-1', 'running', 'codex',
             'gpt-5.4', 1, 1, 100000, 'medium')`
  ).run();
  const session = db
    .prepare(`SELECT * FROM sessions WHERE id = 'session-1'`)
    .get() as Session;
  registerFleetCostAccount(db, {
    runId: "run-1",
    ownerType: "worker",
    ownerId: "worker-1",
    taskId: "task-1",
    session,
    provider: "codex",
    model: "gpt-5.4",
    confidence: "medium",
  });
  return db;
}

function insertSample(
  db: InstanceType<typeof Database>,
  day: string,
  tokens: number,
  cost: number,
  updatedAt = `${day}T11:00:00.000Z`,
  sessionId = "session-1",
  sessionKey = "codex-session-1"
) {
  db.prepare(
    `INSERT INTO session_costs
     (session_key, day, session_id, agent_type, model, input_tokens,
      output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at)
     VALUES (?, ?, ?, 'codex', 'gpt-5.4', ?, 0, 0, 0, ?, ?)`
  ).run(sessionKey, day, sessionId, tokens, cost, updatedAt);
}

describe("Fleet cost runtime", () => {
  it("does not let a refunded or terminal owner identity bypass a new hold", () => {
    const db = fixture();
    const now = new Date("2026-08-01T12:00:00.000Z");
    const reserve = (ownerId: string) =>
      reserveFleetCostOwner(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId,
        taskType: "review",
        provider: "codex",
        model: "gpt-5.4",
        now,
      });
    expect(reserve("review-refund")).toMatchObject({ reserved: true });
    expect(
      releaseFleetCostOwnerReservation(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId: "review-refund",
        now,
      })
    ).toBe(true);
    expect(() => reserve("review-refund")).toThrow(/already terminal/);

    expect(reserve("review-paid")).toMatchObject({ reserved: true });
    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
       VALUES ('session-paid', 'Paid review', 'codex-session-paid', 'running',
               'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
    ).run();
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-paid'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId: "review-paid",
        session,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(true);
    expect(
      settleFleetCostOwner(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId: "review-paid",
        now,
      })
    ).toBe(true);
    expect(() => reserve("review-paid")).toThrow(/already terminal/);
  });

  it("rejects binding one paid session to two cost owners", () => {
    const db = fixture();
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-1'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId: "critic-1",
        session,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_cost_accounts WHERE session_key = 'codex-session-1'`
        )
        .get()
    ).toEqual({ n: 1 });
  });

  it("rejects a live session id or backend key owned by another run", () => {
    const db = fixture();
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal)
       VALUES ('run-2', 'Other Fleet', 'Other goal')`
    ).run();
    const session = db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-1'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-2",
        ownerType: "planner",
        ownerId: "other-session-owner",
        session,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);

    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
       VALUES ('session-reused-key', 'Reused key', 'codex-session-1', 'running',
               'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
    ).run();
    const reusedKey = db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-reused-key'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-2",
        ownerType: "planner",
        ownerId: "other-key-owner",
        session: reusedKey,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_cost_accounts
           WHERE session_id IS NOT NULL`
        )
        .get()
    ).toEqual({ n: 1 });
  });

  it("never reuses a session id but permits a terminal backend key for a new session", () => {
    const db = fixture();
    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE id = 'worker-1'`)
      .get() as FleetWorkerRow;
    settleFleetWorkerCost(db, worker, new Date("2026-08-01T12:00:00.000Z"));
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal)
       VALUES ('run-2', 'Other Fleet', 'Other goal')`
    ).run();
    const original = db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-1'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-2",
        ownerType: "planner",
        ownerId: "same-session-id",
        session: original,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);

    db.prepare(
      `INSERT INTO sessions
       (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
       VALUES ('replacement-session', 'Replacement', 'codex-session-1', 'running',
               'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
    ).run();
    const replacement = db
      .prepare(`SELECT * FROM sessions WHERE id = 'replacement-session'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-2",
        ownerType: "planner",
        ownerId: "replacement-owner",
        session: replacement,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(true);
  });

  it("never rebinds an active or terminal owner to a different session", () => {
    const db = fixture();
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      reserveFleetCostOwner(db, {
        runId: "run-1",
        ownerType: "task_review",
        ownerId: "review-rebind",
        taskType: "review",
        provider: "codex",
        model: "gpt-5.4",
        now,
      })
    ).toMatchObject({ reserved: true });
    for (const id of ["review-session-a", "review-session-b"]) {
      db.prepare(
        `INSERT INTO sessions
         (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
         VALUES (?, ?, ?, 'running', 'C:\\repo', 'gpt-5.4', 'sessions', 'codex')`
      ).run(id, id, id);
    }
    const first = db
      .prepare(`SELECT * FROM sessions WHERE id = 'review-session-a'`)
      .get() as Session;
    const second = db
      .prepare(`SELECT * FROM sessions WHERE id = 'review-session-b'`)
      .get() as Session;
    expect(
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "task_review",
        ownerId: "review-rebind",
        session: first,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(true);
    expect(
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "task_review",
        ownerId: "review-rebind",
        session: second,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);
    settleFleetCostOwner(db, {
      runId: "run-1",
      ownerType: "task_review",
      ownerId: "review-rebind",
      now,
    });
    expect(
      registerFleetCostAccount(db, {
        runId: "run-1",
        ownerType: "task_review",
        ownerId: "review-rebind",
        session: second,
        provider: "codex",
        model: "gpt-5.4",
      })
    ).toBe(false);
    expect(
      db
        .prepare(
          `SELECT session_id, session_key FROM fleet_cost_accounts
           WHERE owner_id = 'review-rebind'`
        )
        .get()
    ).toEqual({
      session_id: "review-session-a",
      session_key: "review-session-a",
    });
  });

  it("charges the reservation for pre-terminal partial telemetry and survives replay", () => {
    const db = fixture();
    insertSample(db, "2026-07-31", 80_000, 0.8);
    insertSample(db, "2026-08-01", 90_000, 0.9);
    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE id = 'worker-1'`)
      .get() as FleetWorkerRow;
    settleFleetWorkerCost(db, worker, new Date("2026-08-01T12:00:00.000Z"));
    expect(
      db
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens, reserved_budget_usd,
                reserved_budget_tokens, cost_confidence FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({
      spent_budget_usd: 1,
      spent_budget_tokens: 100000,
      reserved_budget_usd: 0,
      reserved_budget_tokens: 0,
      cost_confidence: "medium",
    });
    settleFleetWorkerCost(db, worker, new Date("2026-08-01T12:01:00.000Z"));
    expect(
      db
        .prepare(`SELECT spent_budget_usd, spent_budget_tokens FROM fleet_runs`)
        .get()
    ).toEqual({ spent_budget_usd: 1, spent_budget_tokens: 100000 });
  });

  it("uses an exact post-terminal sample instead of the reservation", () => {
    const db = fixture();
    db.prepare(
      `UPDATE fleet_workers SET ended_at = '2026-08-01T12:00:00.000Z'
       WHERE id = 'worker-1'`
    ).run();
    insertSample(db, "2026-08-01", 90_000, 0.9, "2026-08-01T12:00:01.000Z");
    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE id = 'worker-1'`)
      .get() as FleetWorkerRow;
    settleFleetWorkerCost(db, worker, new Date("2026-08-01T12:00:02.000Z"));
    expect(
      db
        .prepare(
          `SELECT spent_budget_usd, spent_budget_tokens, reserved_budget_usd,
                  reserved_budget_tokens, cost_confidence
           FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({
      spent_budget_usd: 0.9,
      spent_budget_tokens: 90000,
      reserved_budget_usd: 0,
      reserved_budget_tokens: 0,
      cost_confidence: "high",
    });
  });

  it("attributes bound telemetry by session id, never a reused backend key", () => {
    const db = fixture();
    insertSample(
      db,
      "2026-07-31",
      500_000,
      5,
      "2026-07-31T11:00:00.000Z",
      "historical-session"
    );
    insertSample(db, "2026-08-01", 20_000, 0.2);
    reconcileFleetCostAccount(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      now: new Date("2026-08-01T12:00:00.000Z"),
    });
    expect(
      db
        .prepare(`SELECT spent_budget_usd, spent_budget_tokens FROM fleet_runs`)
        .get()
    ).toEqual({ spent_budget_usd: 0.2, spent_budget_tokens: 20000 });
  });

  it("uses only the synthetic key while a pre-spawn account is pending", () => {
    const db = fixture();
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      reserveFleetCostOwner(db, {
        runId: "run-1",
        ownerType: "plan_review",
        ownerId: "pending-owner",
        taskType: "review",
        provider: "codex",
        model: "gpt-5.4",
        now,
      })
    ).toMatchObject({ reserved: true });
    db.prepare(
      `INSERT INTO session_costs
       (session_key, day, session_id, agent_type, model, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, updated_at)
       VALUES ('pending:plan_review:pending-owner', '2026-08-01',
               'unbound-sample', 'codex', 'gpt-5.4', 30000, 0, 0, 0, 0.3,
               '2026-08-01T11:00:00.000Z')`
    ).run();
    reconcileFleetCostAccount(db, {
      runId: "run-1",
      ownerType: "plan_review",
      ownerId: "pending-owner",
      now,
    });
    expect(
      db
        .prepare(
          `SELECT session_id, observed_cost_usd, charged_tokens
           FROM fleet_cost_accounts WHERE owner_id = 'pending-owner'`
        )
        .get()
    ).toEqual({
      session_id: null,
      observed_cost_usd: 0.3,
      charged_tokens: 30000,
    });
  });

  it("does not rewrite an unchanged account watermark", () => {
    const db = fixture();
    insertSample(db, "2026-08-01", 50_000, 0.4);
    reconcileFleetCostAccount(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      now: new Date("2026-08-01T12:00:00.000Z"),
    });
    db.exec(`
      CREATE TABLE account_update_audit (n INTEGER NOT NULL);
      CREATE TRIGGER audit_account_update AFTER UPDATE ON fleet_cost_accounts
      BEGIN INSERT INTO account_update_audit (n) VALUES (1); END;
    `);
    reconcileFleetCostAccount(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      now: new Date("2026-08-01T12:01:00.000Z"),
    });
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM account_update_audit`).get()
    ).toEqual({ n: 0 });
  });

  it("adds only a later observed amount above the terminal fallback", () => {
    const db = fixture();
    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE id = 'worker-1'`)
      .get() as FleetWorkerRow;
    settleFleetWorkerCost(db, worker, new Date("2026-08-01T12:00:00.000Z"));
    insertSample(db, "2026-08-02", 125_000, 1.5);
    reconcileFleetCostAccount(db, {
      runId: "run-1",
      ownerType: "worker",
      ownerId: "worker-1",
      now: new Date("2026-08-02T12:00:00.000Z"),
    });
    expect(
      db
        .prepare(`SELECT spent_budget_usd, spent_budget_tokens FROM fleet_runs`)
        .get()
    ).toEqual({ spent_budget_usd: 1.5, spent_budget_tokens: 125000 });
  });

  it("rolls back a torn pre-spawn refund and completes it on restart", () => {
    const db = fixture();
    db.prepare(
      `DELETE FROM fleet_cost_accounts WHERE owner_id = 'worker-1'`
    ).run();
    const worker = db
      .prepare(`SELECT * FROM fleet_workers WHERE id = 'worker-1'`)
      .get() as FleetWorkerRow;
    db.exec(`
      CREATE TRIGGER reject_fleet_run_refund
      BEFORE UPDATE OF reserved_budget_usd ON fleet_runs
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;
    `);
    expect(() =>
      finalizeFleetWorkerCost(
        db,
        worker,
        new Date("2026-08-01T12:00:00.000Z"),
        false
      )
    ).toThrow(/simulated crash/);
    expect(
      db
        .prepare(
          `SELECT cost_reconciled_at FROM fleet_workers WHERE id = 'worker-1'`
        )
        .get()
    ).toEqual({ cost_reconciled_at: null });
    expect(
      db
        .prepare(
          `SELECT reserved_budget_usd, reserved_budget_tokens
           FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({ reserved_budget_usd: 1, reserved_budget_tokens: 100000 });

    db.exec(`DROP TRIGGER reject_fleet_run_refund`);
    finalizeFleetWorkerCost(
      db,
      worker,
      new Date("2026-08-01T12:00:01.000Z"),
      false
    );
    expect(
      db
        .prepare(
          `SELECT cost_reconciled_at FROM fleet_workers WHERE id = 'worker-1'`
        )
        .get()
    ).toEqual({ cost_reconciled_at: "2026-08-01T12:00:01.000Z" });
    expect(
      db
        .prepare(
          `SELECT reserved_budget_usd, reserved_budget_tokens
           FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({ reserved_budget_usd: 0, reserved_budget_tokens: 0 });
  });

  it("keeps durable attribution after the session row is deleted", () => {
    const db = fixture();
    db.prepare(`DELETE FROM sessions WHERE id = 'session-1'`).run();
    expect(
      db
        .prepare(
          `SELECT session_id, session_key FROM fleet_cost_accounts WHERE owner_id = 'worker-1'`
        )
        .get()
    ).toEqual({ session_id: "session-1", session_key: "codex-session-1" });
  });
});
