import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchema } from "@/lib/db/schema";
import {
  FLEET_FAIRNESS_CURSOR_REBASE_AT,
  prepareFleetFairnessCursor,
  type FleetFairnessCursorTarget,
} from "@/lib/fleet/fairness-cursor";

describe("Fleet fairness cursor rebasing", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createSchema(db);
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal) VALUES
       ('run-a', 'A', 'First'), ('run-b', 'B', 'Second')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_cost_accounts
       (id, fleet_run_id, session_key, owner_type, owner_id, provider)
       VALUES ('account-a', 'run-a', 'pending:a', 'supervisor', 'owner-a', 'claude'),
              ('account-b', 'run-b', 'pending:b', 'supervisor', 'owner-b', 'claude')`
    ).run();
  });

  afterEach(() => db.close());

  it("keeps an ordinary safe cursor domain unchanged", () => {
    db.prepare(
      `UPDATE fleet_runs SET managed_supervisor_poll_cursor = 7
       WHERE id = 'run-b'`
    ).run();

    expect(prepareFleetFairnessCursor(db, "supervisorPoll")).toBe(7);
    expect(
      db
        .prepare(
          `SELECT managed_supervisor_poll_cursor AS cursor
           FROM fleet_runs ORDER BY id`
        )
        .all()
    ).toEqual([{ cursor: 0 }, { cursor: 7 }]);
  });

  it.each<{
    target: FleetFairnessCursorTarget;
    table: string;
    column: string;
  }>([
    {
      target: "supervisorPoll",
      table: "fleet_runs",
      column: "managed_supervisor_poll_cursor",
    },
    {
      target: "schedulerPoll",
      table: "fleet_runs",
      column: "scheduler_poll_cursor",
    },
    {
      target: "automationPoll",
      table: "fleet_runs",
      column: "automation_poll_cursor",
    },
    {
      target: "cancellationPoll",
      table: "fleet_runs",
      column: "cancellation_poll_cursor",
    },
    {
      target: "mergePoll",
      table: "fleet_runs",
      column: "merge_poll_cursor",
    },
    {
      target: "lifecyclePoll",
      table: "fleet_runs",
      column: "lifecycle_poll_cursor",
    },
    {
      target: "costSample",
      table: "fleet_cost_accounts",
      column: "sample_attempt_cursor",
    },
    {
      target: "supervisorRecovery",
      table: "fleet_cost_accounts",
      column: "fallback_recovery_cursor",
    },
  ])(
    "rebases $target before SQLite integer overflow",
    ({ target, table, column }) => {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id LIKE '%-b'`).run(
        FLEET_FAIRNESS_CURSOR_REBASE_AT
      );

      expect(prepareFleetFairnessCursor(db, target)).toBe(0);
      expect(
        db.prepare(`SELECT DISTINCT ${column} AS cursor FROM ${table}`).all()
      ).toEqual([{ cursor: 0 }]);
    }
  );
});
