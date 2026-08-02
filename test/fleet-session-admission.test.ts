import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import type { Session } from "@/lib/db";
import {
  activateFleetPaidSession,
  finishFleetPaidSession,
  reserveFleetPaidSession,
} from "@/lib/fleet/session-admission";
import { acquireFleetRuntimeResources } from "@/lib/fleet/resource-runtime";
import { normalizeFleetResourceLimits } from "@/lib/fleet/resource-admission";
import type { FleetRunRow } from "@/lib/fleet/types";

function fixture() {
  const db = new Database(":memory:");
  createSchema(db);
  db.prepare(
    `INSERT INTO fleet_runs (id, name, goal)
     VALUES ('run-1', 'Fleet', 'Goal')`
  ).run();
  db.prepare(
    `INSERT INTO sessions
     (id, name, tmux_name, status, working_directory, model, group_path, agent_type)
     VALUES ('session-1', 'Planner', 'codex-session-1', 'running', 'C:\\repo',
             'gpt-5.4', 'sessions', 'codex')`
  ).run();
  return {
    db,
    run: db
      .prepare(`SELECT * FROM fleet_runs WHERE id = 'run-1'`)
      .get() as FleetRunRow,
    session: db
      .prepare(`SELECT * FROM sessions WHERE id = 'session-1'`)
      .get() as Session,
  };
}

function reserve(
  db: InstanceType<typeof Database>,
  run: FleetRunRow,
  now: Date,
  leaseExpiresAt: string
) {
  return reserveFleetPaidSession(db, {
    run,
    ownerType: "planner",
    ownerId: "planner-request-1",
    taskType: "planning",
    provider: "codex",
    model: "gpt-5.4",
    repositoryKey: "repo-1",
    now,
    leaseExpiresAt,
  });
}

function activate(
  db: InstanceType<typeof Database>,
  session: Session,
  now: Date
) {
  return activateFleetPaidSession(db, {
    runId: "run-1",
    ownerType: "planner",
    ownerId: "planner-request-1",
    session,
    provider: "codex",
    model: "gpt-5.4",
    now,
  });
}

describe("Fleet paid-session admission", () => {
  it("promotes an unexpired admission exactly once and survives activation replay", () => {
    const { db, run, session } = fixture();
    expect(
      reserve(
        db,
        run,
        new Date("2026-08-01T12:00:00.000Z"),
        "2026-08-01T12:02:00.000Z"
      )
    ).toMatchObject({ admitted: true });
    expect(activate(db, session, new Date("2026-08-01T12:01:00.000Z"))).toBe(
      true
    );
    expect(activate(db, session, new Date("2026-08-01T12:01:30.000Z"))).toBe(
      true
    );
    expect(
      db
        .prepare(
          `SELECT session_id, COUNT(*) OVER () AS account_count
           FROM fleet_cost_accounts WHERE fleet_run_id = 'run-1'`
        )
        .get()
    ).toEqual({ session_id: "session-1", account_count: 1 });
    expect(
      db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM fleet_runtime_leases
           GROUP BY status ORDER BY status`
        )
        .all()
    ).toEqual([
      { status: "released", n: 1 },
      { status: "reserved", n: 5 },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_runtime_leases
           WHERE status = 'reserved' AND lease_expires_at IS NOT NULL`
        )
        .get()
    ).toEqual({ n: 0 });
  });

  it("fails closed after lease expiry and leaves a safely settleable admission", () => {
    const { db, run, session } = fixture();
    expect(
      reserve(
        db,
        run,
        new Date("2026-08-01T12:00:00.000Z"),
        "2026-08-01T12:00:30.000Z"
      )
    ).toMatchObject({ admitted: true });
    expect(activate(db, session, new Date("2026-08-01T12:00:30.000Z"))).toBe(
      false
    );
    expect(
      db
        .prepare(
          `SELECT session_id, reservation_released_at, terminal_at
           FROM fleet_cost_accounts WHERE owner_id = 'planner-request-1'`
        )
        .get()
    ).toEqual({
      session_id: null,
      reservation_released_at: null,
      terminal_at: null,
    });
    expect(
      db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM fleet_runtime_leases
           GROUP BY status`
        )
        .all()
    ).toEqual([{ status: "reserved", n: 6 }]);

    finishFleetPaidSession(db, {
      runId: "run-1",
      ownerType: "planner",
      ownerId: "planner-request-1",
      sessionCreated: true,
      now: new Date("2026-08-01T12:00:31.000Z"),
    });
    const ledger = db
      .prepare(
        `SELECT reserved_budget_usd, reserved_budget_tokens,
                spent_budget_usd, spent_budget_tokens
         FROM fleet_runs WHERE id = 'run-1'`
      )
      .get() as {
      reserved_budget_usd: number;
      reserved_budget_tokens: number;
      spent_budget_usd: number;
      spent_budget_tokens: number;
    };
    expect(ledger.reserved_budget_usd).toBe(0);
    expect(ledger.reserved_budget_tokens).toBe(0);
    expect(ledger.spent_budget_usd).toBeGreaterThan(0);
    expect(ledger.spent_budget_tokens).toBeGreaterThan(0);
    expect(
      db
        .prepare(
          `SELECT status, COUNT(*) AS n FROM fleet_runtime_leases
           GROUP BY status`
        )
        .all()
    ).toEqual([{ status: "released", n: 6 }]);
  });

  it("starts a fixer at the full repository worktree cap without double-counting its reused worktree", () => {
    const { db, run, session } = fixture();
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(
      acquireFleetRuntimeResources(db, {
        runId: run.id,
        ownerType: "worker",
        ownerId: "retained-worker-wave",
        resources: [
          { kind: "repo_worktree", key: "repo-1", units: 40 },
          {
            kind: "disk_bytes",
            key: "fleet",
            units: 40 * 512 * 1024 ** 2,
          },
        ],
        limits: normalizeFleetResourceLimits({}),
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      acquireFleetRuntimeResources(db, {
        runId: run.id,
        ownerType: "task_review",
        ownerId: "transient-review-headroom",
        resources: [
          { kind: "repo_worktree", key: "repo-1", units: 8 },
          {
            kind: "disk_bytes",
            key: "fleet",
            units: 8 * 512 * 1024 ** 2,
          },
        ],
        limits: normalizeFleetResourceLimits({}),
        now,
      })
    ).toMatchObject({ admitted: true });
    expect(
      db
        .prepare(
          `SELECT SUM(units) AS units FROM fleet_runtime_leases
           WHERE resource_type = 'repo_worktree' AND status = 'reserved'`
        )
        .get()
    ).toEqual({ units: 48 });

    expect(
      reserveFleetPaidSession(db, {
        run,
        ownerType: "fixer",
        ownerId: "fixer-request-1",
        taskType: "fix",
        provider: "codex",
        model: "gpt-5.4",
        repositoryKey: "repo-1",
        now,
        leaseExpiresAt: "2026-08-01T12:02:00.000Z",
      })
    ).toMatchObject({ admitted: true });
    expect(
      db
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE owner_type = 'fixer' AND owner_id = 'fixer-request-1'
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "git_operation" },
      { resource_type: "provider" },
      { resource_type: "pty" },
      { resource_type: "transport_host" },
    ]);
    expect(
      activateFleetPaidSession(db, {
        runId: run.id,
        ownerType: "fixer",
        ownerId: "fixer-request-1",
        session,
        provider: "codex",
        model: "gpt-5.4",
        now: new Date("2026-08-01T12:01:00.000Z"),
      })
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT resource_type, units FROM fleet_runtime_leases
           WHERE owner_type = 'worker' AND status = 'reserved'
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "disk_bytes", units: 40 * 512 * 1024 ** 2 },
      { resource_type: "repo_worktree", units: 40 },
    ]);
  });

  it("accounts for an advisory supervisor without reserving Git, worktree, or disk capacity", () => {
    const { db, run, session } = fixture();
    const ownerId = "supervisor-request-1";
    expect(
      reserveFleetPaidSession(db, {
        run,
        ownerType: "supervisor",
        ownerId,
        taskType: "supervision",
        provider: "codex",
        model: "gpt-5.4",
        repositoryKey: "fleet-supervisor:run-1",
        now: new Date("2026-08-01T12:00:00.000Z"),
        leaseExpiresAt: "2026-08-01T12:02:00.000Z",
      })
    ).toMatchObject({ admitted: true });
    expect(
      db
        .prepare(
          `SELECT resource_type FROM fleet_runtime_leases
           WHERE owner_type = 'supervisor' AND owner_id = ?
           ORDER BY resource_type`
        )
        .all(ownerId)
    ).toEqual([
      { resource_type: "provider" },
      { resource_type: "pty" },
      { resource_type: "transport_host" },
    ]);
    expect(
      activateFleetPaidSession(db, {
        runId: run.id,
        ownerType: "supervisor",
        ownerId,
        session,
        provider: "codex",
        model: "gpt-5.4",
        now: new Date("2026-08-01T12:01:00.000Z"),
      })
    ).toBe(true);
    expect(
      activateFleetPaidSession(db, {
        runId: run.id,
        ownerType: "supervisor",
        ownerId,
        session,
        provider: "codex",
        model: "gpt-5.4",
        now: new Date("2026-08-01T12:01:30.000Z"),
      })
    ).toBe(true);
    finishFleetPaidSession(db, {
      runId: run.id,
      ownerType: "supervisor",
      ownerId,
      sessionCreated: true,
      now: new Date("2026-08-01T12:02:00.000Z"),
    });
    expect(
      db
        .prepare(
          `SELECT reservation_released_at IS NOT NULL AS released,
                  terminal_at IS NOT NULL AS terminal
           FROM fleet_cost_accounts
           WHERE owner_type = 'supervisor' AND owner_id = ?`
        )
        .get(ownerId)
    ).toEqual({ released: 1, terminal: 1 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM fleet_runtime_leases
           WHERE owner_type = 'supervisor' AND owner_id = ?
             AND status <> 'released'`
        )
        .get(ownerId)
    ).toEqual({ count: 0 });
  });
});
