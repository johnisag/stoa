import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchema } from "@/lib/db/schema";
import {
  assertFleetLaunchReady,
  fleetLaunchBlockedResult,
  setFleetSchedulerReady,
} from "@/lib/fleet/recovery-gate";
import { requestFleetMerge } from "@/lib/fleet/merge-runtime";
import { reconcileFleetTaskReviews } from "@/lib/fleet/task-review";
import { reconcileFleetVerifications } from "@/lib/fleet/verification";

describe("Fleet launch recovery gate", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, desired_state, recovery_required)
       VALUES ('run-1', 'Run', 'Goal', 'running', 'running', 0)`
    ).run();
    setFleetSchedulerReady(true);
  });

  afterEach(() => {
    setFleetSchedulerReady(true);
    db.close();
  });

  it("returns one 503 boundary before merge intent or review/verification side effects", async () => {
    setFleetSchedulerReady(false);
    expect(fleetLaunchBlockedResult(db, "run-1")).toEqual({
      error: "fleet scheduler recovery is not ready",
      status: 503,
    });
    expect(() => assertFleetLaunchReady(db, "run-1")).toThrow(
      "fleet scheduler recovery is not ready"
    );
    await expect(
      requestFleetMerge("run-1", "local", "operator", { db })
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      reconcileFleetVerifications({ db }, { runId: "run-1" })
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      reconcileFleetTaskReviews({ db }, { runId: "run-1" })
    ).rejects.toMatchObject({ status: 503 });
    expect(
      db
        .prepare(
          `SELECT merge_request_kind, merge_target, merge_requested_at
           FROM fleet_runs WHERE id = 'run-1'`
        )
        .get()
    ).toEqual({
      merge_request_kind: null,
      merge_target: null,
      merge_requested_at: null,
    });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM fleet_events`).get()).toEqual({
      n: 0,
    });
  });

  it("blocks one unresolved run after global startup recovery is ready", async () => {
    db.prepare(
      `UPDATE fleet_runs SET recovery_required = 1 WHERE id = 'run-1'`
    ).run();
    expect(fleetLaunchBlockedResult(db, "run-1")?.status).toBe(503);
    await expect(
      requestFleetMerge("run-1", "local", "operator", { db })
    ).resolves.toMatchObject({ status: 503 });
    await expect(
      reconcileFleetVerifications({ db }, { runId: "run-1" })
    ).rejects.toMatchObject({ status: 503 });
  });
});
