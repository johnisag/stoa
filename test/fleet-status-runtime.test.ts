import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchema } from "@/lib/db/schema";
import { FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK } from "@/lib/fleet/status-aggregation";
import { reconcileFleetRenderedStatuses } from "@/lib/fleet/status-runtime";

const START = new Date("2026-08-01T12:00:00.000Z");
let db: InstanceType<typeof Database>;

function seedWorkers(count: number): void {
  db.prepare(
    `INSERT INTO fleet_runs
     (id, name, goal, status, approval_state, provider, max_concurrency,
      review_policy, settings_json)
     VALUES ('run-1', 'Fleet', 'Ship', 'running', 'approved', 'codex', 40,
             'four_agent', '{}')`
  ).run();
  const session = db.prepare(
    `INSERT INTO sessions (id, name, tmux_name, agent_type)
     VALUES (?, ?, ?, 'codex')`
  );
  const worker = db.prepare(
    `INSERT INTO fleet_workers
     (id, fleet_run_id, session_id, status, provider, attempt,
      rendered_status, rendered_status_stability_count,
      rendered_status_last_captured_at, rendered_status_next_capture_at)
     VALUES (?, 'run-1', ?, 'running', 'codex', 1, 'running', 0, ?, ?)`
  );
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(2, "0");
    const sessionId = `session-${suffix}`;
    session.run(sessionId, `Worker ${suffix}`, `fleet-worker-${suffix}`);
    worker.run(
      `worker-${suffix}`,
      sessionId,
      new Date(START.getTime() - (60 - index) * 1_000).toISOString(),
      new Date(START.getTime() - 1_000).toISOString()
    );
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => db.close());

describe("Fleet rendered status runtime", () => {
  it.each(["reviewing", "merging"] as const)(
    "continues observing active workers while the run is %s",
    async (phase) => {
      seedWorkers(1);
      db.prepare(`UPDATE fleet_runs SET status = ? WHERE id = 'run-1'`).run(
        phase
      );
      const observe = vi.fn(async () => ({
        status: "running" as const,
        rendered: "working",
      }));

      await expect(
        reconcileFleetRenderedStatuses({ db, now: () => START, observe })
      ).resolves.toBe(1);
      expect(observe).toHaveBeenCalledTimes(1);
    }
  );

  it("globally bounds and fairly rotates captures across 40 workers", async () => {
    seedWorkers(40);
    let now = START;
    const secret = "correct-horse-battery-staple";
    const observe = vi.fn(async () => ({
      status: "waiting" as const,
      rendered: `password=${secret}`,
    }));

    await expect(
      reconcileFleetRenderedStatuses(
        { db, now: () => now, observe },
        { maxCaptures: 10_000 }
      )
    ).resolves.toBe(FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK);
    expect(observe).toHaveBeenCalledTimes(
      FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK
    );
    expect(
      db
        .prepare(
          `SELECT id FROM fleet_workers
           WHERE rendered_status_last_captured_at = ? ORDER BY id`
        )
        .all(START.toISOString())
    ).toEqual(
      Array.from(
        { length: FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK },
        (_, index) => ({ id: `worker-${String(index).padStart(2, "0")}` })
      )
    );
    const persisted = db
      .prepare(
        `SELECT rendered_status_summary FROM fleet_workers
         WHERE rendered_status_last_captured_at = ?`
      )
      .all(START.toISOString()) as Array<{
      rendered_status_summary: string;
    }>;
    expect(persisted).toHaveLength(FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK);
    expect(
      persisted.every(
        (row) =>
          row.rendered_status_summary === "password=[REDACTED]" &&
          !row.rendered_status_summary.includes(secret)
      )
    ).toBe(true);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE event_type = 'worker_rendered_status_changed'`
        )
        .get()
    ).toEqual({ n: FLEET_STATUS_CAPTURE_HARD_MAX_PER_TICK });

    for (const expected of [12, 12, 4, 0]) {
      await expect(
        reconcileFleetRenderedStatuses({ db, now: () => now, observe })
      ).resolves.toBe(expected);
    }
    expect(observe).toHaveBeenCalledTimes(40);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_workers
           WHERE rendered_status_last_captured_at = ?`
        )
        .get(now.toISOString())
    ).toEqual({ n: 40 });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_events
           WHERE event_type = 'worker_rendered_status_changed'`
        )
        .get()
    ).toEqual({ n: 40 });
  });

  it("backs off failures and refuses a session bound to two active workers", async () => {
    seedWorkers(2);
    db.prepare(
      `UPDATE fleet_workers SET session_id = 'session-00' WHERE id = 'worker-01'`
    ).run();
    const observe = vi.fn(async () => {
      throw new Error("password=must-not-be-persisted");
    });

    await expect(
      reconcileFleetRenderedStatuses({ db, now: () => START, observe })
    ).resolves.toBe(0);
    expect(observe).not.toHaveBeenCalled();

    db.prepare(
      `UPDATE fleet_workers SET session_id = 'session-01' WHERE id = 'worker-01'`
    ).run();
    await expect(
      reconcileFleetRenderedStatuses({ db, now: () => START, observe })
    ).resolves.toBe(2);
    expect(
      db
        .prepare(
          `SELECT DISTINCT rendered_status_error,
                  rendered_status_next_capture_at
           FROM fleet_workers`
        )
        .all()
    ).toEqual([
      {
        rendered_status_error: "rendered status capture failed",
        rendered_status_next_capture_at: new Date(
          START.getTime() + 60_000
        ).toISOString(),
      },
    ]);
  });

  it("isolates a transition event quota failure to its own run", async () => {
    seedWorkers(1);
    db.prepare(
      `UPDATE fleet_runs SET resource_limits_json = ? WHERE id = 'run-1'`
    ).run(JSON.stringify({ eventBytesTotal: 1 }));
    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, approval_state, provider, max_concurrency,
        review_policy, settings_json)
       VALUES ('run-2', 'Other Fleet', 'Keep scheduling', 'running',
               'approved', 'codex', 1, 'four_agent', '{}')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type)
       VALUES ('session-other', 'Other worker', 'fleet-worker-other', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        rendered_status, rendered_status_stability_count,
        rendered_status_last_captured_at, rendered_status_next_capture_at)
       VALUES ('worker-other', 'run-2', 'session-other', 'running', 'codex', 1,
               'running', 0, ?, ?)`
    ).run(
      new Date(START.getTime() - 60_000).toISOString(),
      new Date(START.getTime() - 1_000).toISOString()
    );

    await expect(
      reconcileFleetRenderedStatuses({
        db,
        now: () => START,
        observe: async () => ({ status: "waiting", rendered: "waiting" }),
      })
    ).resolves.toBe(2);
    expect(
      db
        .prepare(
          `SELECT rendered_status, rendered_status_error,
                  rendered_status_next_capture_at
           FROM fleet_workers WHERE id = 'worker-00'`
        )
        .get()
    ).toEqual({
      rendered_status: "running",
      rendered_status_error: "rendered status capture failed",
      rendered_status_next_capture_at: new Date(
        START.getTime() + 60_000
      ).toISOString(),
    });
    expect(
      db
        .prepare(
          `SELECT rendered_status, rendered_status_error
           FROM fleet_workers WHERE id = 'worker-other'`
        )
        .get()
    ).toEqual({ rendered_status: "waiting", rendered_status_error: null });
  });

  it("filters malformed and terminal-run rows before the global candidate cap", async () => {
    seedWorkers(1);
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type)
       VALUES (?, ?, ?, 'codex')`
    );
    const insertWorker = db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        rendered_status, rendered_status_stability_count,
        rendered_status_last_captured_at, rendered_status_next_capture_at)
       VALUES (?, 'run-1', ?, 'running', 'codex', 1, 'running', 0, ?, ?)`
    );
    const seedMalformed = db.transaction(() => {
      for (let index = 0; index < 4_096; index++) {
        const suffix = String(index).padStart(4, "0");
        const sessionId = `malformed-session-${suffix}`;
        insertSession.run(sessionId, sessionId, sessionId);
        insertWorker.run(
          `!malformed-worker-${suffix}`,
          sessionId,
          new Date(START.getTime() - 60_000).toISOString(),
          new Date(START.getTime() - 1_000).toISOString()
        );
      }
    });
    seedMalformed();

    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, approval_state, provider, max_concurrency,
        review_policy, settings_json)
       VALUES ('run-terminal', 'Terminal Fleet', 'Ignore stale worker',
               'completed', 'approved', 'codex', 1, 'four_agent', '{}')`
    ).run();
    insertSession.run(
      "terminal-session",
      "Terminal session",
      "terminal-session"
    );
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt,
        rendered_status, rendered_status_stability_count,
        rendered_status_last_captured_at, rendered_status_next_capture_at)
       VALUES ('terminal-worker', 'run-terminal', 'terminal-session', 'running',
               'codex', 1, 'running', 0, ?, ?)`
    ).run(
      new Date(START.getTime() - 120_000).toISOString(),
      new Date(START.getTime() - 60_000).toISOString()
    );
    const observe = vi.fn(async () => ({
      status: "idle" as const,
      rendered: "valid worker",
    }));

    await expect(
      reconcileFleetRenderedStatuses({ db, now: () => START, observe })
    ).resolves.toBe(1);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare(`SELECT rendered_status FROM fleet_workers WHERE id = ?`)
        .get("worker-00")
    ).toEqual({ rendered_status: "idle" });
    expect(
      db
        .prepare(`SELECT rendered_status FROM fleet_workers WHERE id = ?`)
        .get("terminal-worker")
    ).toEqual({ rendered_status: "running" });
  });
});
