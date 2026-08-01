import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { getFleetAnalytics } from "@/lib/fleet/analytics";
import {
  executeFleetWorker,
  type FleetWorkerExecutor,
} from "@/lib/fleet/executor";
import type { FleetSpawnInput } from "@/lib/fleet/spawn";

let db: InstanceType<typeof Database>;

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

describe("Fleet historical analytics", () => {
  it("derives bounded run, duration, task, provider, and budget outcomes", () => {
    const insertRun = db.prepare(
      `INSERT INTO fleet_runs
       (id, name, goal, status, approval_state, provider, max_concurrency,
        settings_json, budget_usd, reserved_budget_usd, spent_budget_usd,
        started_at, ended_at, archived_at, created_at)
       VALUES (?, ?, 'Ship', ?, 'approved', ?, 2, '{}', ?, ?, ?, ?, ?, ?, ?)`
    );
    insertRun.run(
      "run-old",
      "Old",
      "failed",
      "claude",
      10,
      0,
      8,
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T01:00:00.000Z",
      null,
      "2026-07-01T00:00:00.000Z"
    );
    insertRun.run(
      "run-1",
      "One",
      "completed",
      "codex",
      2,
      0,
      1.25,
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:02:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-01T10:00:00.000Z"
    );
    insertRun.run(
      "run-2",
      "Two",
      "failed",
      "codex",
      3,
      0.5,
      2,
      "2026-08-02T10:00:00.000Z",
      "2026-08-02T10:01:00.000Z",
      null,
      "2026-08-02T10:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO fleet_tasks
       (id, fleet_run_id, title, status, task_type, sort_order, file_claims_json,
        approval_state)
       VALUES ('task-1', 'run-1', 'One', 'merged', 'task', 1, '["lib"]', 'approved'),
              ('task-2', 'run-2', 'Two', 'failed', 'task', 1, '["test"]', 'approved')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, status, provider, attempt)
       VALUES ('worker-1', 'run-1', 'task-1', 'completed', 'codex', 1),
              ('worker-2', 'run-2', 'task-2', 'failed', 'codex', 1)`
    ).run();

    expect(getFleetAnalytics({ db, limitRuns: 2 })).toEqual({
      runLimit: 2,
      runCount: 2,
      archivedRunCount: 1,
      runOutcomes: { completed: 1, failed: 1 },
      taskOutcomes: { failed: 1, merged: 1 },
      providerOutcomes: {
        codex: { total: 2, completed: 1, failed: 1, other: 0 },
      },
      durations: {
        completedRuns: 2,
        averageSeconds: 90,
        maximumSeconds: 120,
      },
      budget: {
        configuredUsd: 5,
        reservedUsd: 0.5,
        spentUsd: 3.25,
      },
    });
  });
});

describe("Fleet worker executor adapter", () => {
  const input = {
    run: { id: "run-1" },
    task: { id: "task-1" },
    workingDirectory: "C:\\repo",
    claims: ["lib"],
    dependencies: [],
    attempt: 1,
    spawnRequestId: "run-1:task-1:1",
  } as unknown as FleetSpawnInput;

  it("falls back to the local SessionBackend-owned executor when unsupported", async () => {
    const remote: FleetWorkerExecutor = {
      id: "cloud",
      supports: vi.fn(() => false),
      spawn: vi.fn(async () => ({
        sessionId: "cloud-session",
        worktreePath: "C:\\cloud",
      })),
    };
    const local: FleetWorkerExecutor = {
      id: "local",
      supports: () => true,
      spawn: vi.fn(async () => ({
        sessionId: "local-session",
        worktreePath: "C:\\local",
      })),
    };

    await expect(executeFleetWorker(input, remote, local)).resolves.toEqual({
      sessionId: "local-session",
      worktreePath: "C:\\local",
    });
    expect(remote.spawn).not.toHaveBeenCalled();
    expect(local.spawn).toHaveBeenCalledWith(input);
  });

  it("uses an explicitly compatible adapter without changing the local default", async () => {
    const remote: FleetWorkerExecutor = {
      id: "cloud",
      supports: () => true,
      spawn: vi.fn(async () => ({
        sessionId: "cloud-session",
        worktreePath: "C:\\cloud",
      })),
    };
    const local: FleetWorkerExecutor = {
      id: "local",
      supports: () => true,
      spawn: vi.fn(async () => ({
        sessionId: "local-session",
        worktreePath: "C:\\local",
      })),
    };

    await expect(executeFleetWorker(input, remote, local)).resolves.toEqual({
      sessionId: "cloud-session",
      worktreePath: "C:\\cloud",
    });
    expect(remote.spawn).toHaveBeenCalledWith(input);
    expect(local.spawn).not.toHaveBeenCalled();
  });
});
