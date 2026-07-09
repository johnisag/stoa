import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import type { DispatchRepo } from "@/lib/dispatch/types";
import { cleanupFleetWorkerSpawn } from "@/lib/fleet/spawn";
import type { FleetWorkerRow } from "@/lib/fleet/types";
import { deleteWorktree } from "@/lib/worktrees";

const mocks = vi.hoisted(() => ({
  kill: vi.fn<() => Promise<void>>(),
  list: vi.fn<() => Promise<string[]>>(),
  deleteWorktree: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    kill: mocks.kill,
    list: mocks.list,
  }),
}));

vi.mock("@/lib/worktrees", () => ({
  createWorktree: vi.fn(),
  deleteWorktree: mocks.deleteWorktree,
}));

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

beforeEach(() => {
  db.exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM sessions;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  mocks.kill.mockReset();
  mocks.list.mockReset();
  mocks.deleteWorktree.mockReset();
  mocks.kill.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue(["tmux-session-1"]);
  mocks.deleteWorktree.mockResolvedValue(undefined);
  queries
    .createProject(db)
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
    .createDispatchRepo(db)
    .run(
      "repo-fleet",
      "C:\\repo",
      "owner/repo",
      "claude",
      10,
      40,
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
  queries
    .createFleetRun(db)
    .run(
      "run-1",
      "Phase 3",
      "Launch workers safely",
      "repo-fleet",
      "proj-fleet",
      null,
      "claude",
      null,
      4,
      "four_agent",
      "{}"
    );
  queries
    .createFleetTask(db)
    .run(
      "task-1",
      "run-1",
      null,
      "Task",
      null,
      "running",
      "task",
      1,
      JSON.stringify(["app/a.ts"])
    );
  queries
    .createWorkerSession(db)
    .run(
      "session-1",
      "Worker",
      "tmux-session-1",
      "C:\\worktrees\\task-1",
      null,
      "Task",
      "sonnet",
      "sessions",
      "claude",
      "proj-fleet"
    );
  db.prepare(
    `INSERT INTO fleet_workers (
      id,
      fleet_run_id,
      task_id,
      session_id,
      status,
      provider,
      model,
      attempt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "worker-1",
    "run-1",
    "task-1",
    "session-1",
    "running",
    "claude",
    null,
    1
  );
});

function repo(): DispatchRepo {
  return queries.getDispatchRepo(db).get("repo-fleet") as DispatchRepo;
}

function worker(): FleetWorkerRow {
  return queries.getFleetWorker(db).get("worker-1") as FleetWorkerRow;
}

describe("cleanupFleetWorkerSpawn", () => {
  it("keeps session ownership when backend stop fails", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("backend down"));

    await cleanupFleetWorkerSpawn({
      db,
      repo: repo(),
      reason: "test cleanup",
      result: {
        sessionId: "session-1",
        worktreePath: "C:\\worktrees\\task-1",
        branchName: "fleet/task-1",
      },
    });

    expect(worker()).toMatchObject({
      status: "cleanup_pending",
      spawn_error: "backend down",
    });
    expect(queries.getSession(db).get("session-1")).toBeTruthy();
    expect(deleteWorktree).not.toHaveBeenCalled();
  });

  it("continues cleanup when backend stop reports an already-missing session", async () => {
    mocks.kill.mockRejectedValueOnce(new Error("missing session"));
    mocks.list.mockResolvedValueOnce([]);

    await cleanupFleetWorkerSpawn({
      db,
      repo: repo(),
      reason: "test cleanup",
      result: {
        sessionId: "session-1",
        worktreePath: "C:\\worktrees\\task-1",
        branchName: "fleet/task-1",
      },
    });

    expect(deleteWorktree).toHaveBeenCalledWith(
      "C:\\worktrees\\task-1",
      "C:\\repo",
      true
    );
    expect(queries.getSession(db).get("session-1")).toBeUndefined();
  });

  it("keeps session ownership when worktree cleanup fails", async () => {
    mocks.deleteWorktree.mockRejectedValueOnce(new Error("worktree locked"));

    await cleanupFleetWorkerSpawn({
      db,
      repo: repo(),
      reason: "test cleanup",
      result: {
        sessionId: "session-1",
        worktreePath: "C:\\worktrees\\task-1",
        branchName: "fleet/task-1",
      },
    });

    expect(worker()).toMatchObject({
      status: "cleanup_pending",
      spawn_error: "worktree locked",
    });
    expect(queries.getSession(db).get("session-1")).toBeTruthy();
    expect(deleteWorktree).toHaveBeenCalledWith(
      "C:\\worktrees\\task-1",
      "C:\\repo",
      true
    );
  });
});
