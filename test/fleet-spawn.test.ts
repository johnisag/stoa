import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import type { DispatchRepo } from "@/lib/dispatch/types";
import {
  cleanupFleetWorkerSpawn,
  spawnFleetWorkerSession,
} from "@/lib/fleet/spawn";
import type {
  FleetRunRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "@/lib/fleet/types";
import { deleteWorktree } from "@/lib/worktrees";

const state = vi.hoisted(() => ({ db: null as unknown }));
const mocks = vi.hoisted(() => ({
  kill: vi.fn<() => Promise<void>>(),
  list: vi.fn<() => Promise<string[]>>(),
  create: vi.fn<() => Promise<void>>(),
  capture: vi.fn<() => Promise<string>>(),
  pasteText: vi.fn<() => Promise<void>>(),
  sendEnter: vi.fn<() => Promise<void>>(),
  createWorktree:
    vi.fn<() => Promise<{ worktreePath: string; branchName: string }>>(),
  deleteWorktree: vi.fn<() => Promise<void>>(),
  setupWorktree: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/session-backend", () => ({
  getSessionBackend: () => ({
    kill: mocks.kill,
    list: mocks.list,
    create: mocks.create,
    capture: mocks.capture,
    pasteText: mocks.pasteText,
    sendEnter: mocks.sendEnter,
  }),
}));

vi.mock("@/lib/worktrees", () => ({
  createWorktree: mocks.createWorktree,
  deleteWorktree: mocks.deleteWorktree,
}));

vi.mock("@/lib/env-setup", () => ({
  setupWorktree: mocks.setupWorktree,
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => state.db };
});

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
  state.db = db;
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
  mocks.create.mockReset();
  mocks.capture.mockReset();
  mocks.pasteText.mockReset();
  mocks.sendEnter.mockReset();
  mocks.createWorktree.mockReset();
  mocks.deleteWorktree.mockReset();
  mocks.setupWorktree.mockReset();
  mocks.kill.mockResolvedValue(undefined);
  mocks.list.mockResolvedValue(["tmux-session-1"]);
  mocks.create.mockResolvedValue(undefined);
  mocks.capture.mockResolvedValue("? for shortcuts");
  mocks.pasteText.mockResolvedValue(undefined);
  mocks.sendEnter.mockResolvedValue(undefined);
  mocks.createWorktree.mockResolvedValue({
    worktreePath: "C:\\worktrees\\task-1",
    branchName: "fleet/task-1",
  });
  mocks.deleteWorktree.mockResolvedValue(undefined);
  mocks.setupWorktree.mockResolvedValue(undefined);
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

function run(): FleetRunRow {
  return queries.getFleetRun(db).get("run-1") as FleetRunRow;
}

function task(): FleetTaskRow {
  return queries.getFleetTaskForRun(db).get("run-1", "task-1") as FleetTaskRow;
}

describe("spawnFleetWorkerSession", () => {
  it("does not clean up a linked session already promoted by recovery", async () => {
    expect(
      db
        .prepare(
          `UPDATE fleet_workers
         SET session_id = NULL,
             status = 'spawning',
             lease_token = 'lease-1',
             lease_expires_at = '2020-01-01T00:00:00.000Z',
             spawn_error = NULL
         WHERE id = ?`
        )
        .run("worker-1").changes
    ).toBe(1);
    expect(worker()).toMatchObject({
      status: "spawning",
      lease_token: "lease-1",
      session_id: null,
    });
    mocks.createWorktree.mockResolvedValueOnce({
      worktreePath: "C:\\worktrees\\task-1-race",
      branchName: "fleet/task-1-race",
    });
    mocks.capture.mockImplementationOnce(async () => {
      const linked = worker();
      expect(linked.session_id).toBeTruthy();
      expect(linked.lease_token).toBe("lease-1");
      queries
        .markFleetWorkerRunning(db)
        .run(linked.session_id, "worker-1", "lease-1");
      return "? for shortcuts";
    });

    const result = await spawnFleetWorkerSession({
      run: { ...run(), project_id: "uncategorized" },
      task: task(),
      repo: { ...repo(), project_id: "uncategorized" },
      workerId: "worker-1",
      leaseToken: "lease-1",
    });

    expect(result).toMatchObject({
      worktreePath: "C:\\worktrees\\task-1-race",
      branchName: "fleet/task-1-race",
    });
    expect(worker()).toMatchObject({
      status: "running",
      session_id: result.sessionId,
      lease_token: null,
    });
    expect(mocks.pasteText).toHaveBeenCalledTimes(1);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(deleteWorktree).not.toHaveBeenCalled();
    expect(queries.getSession(db).get(result.sessionId)).toBeTruthy();
  });

  it("records cleanup ownership when cancel wins before session link", async () => {
    expect(
      db
        .prepare(
          `UPDATE fleet_workers
         SET session_id = NULL,
             status = 'canceled',
             lease_token = NULL,
             lease_expires_at = NULL,
             spawn_error = 'run canceled before worker launch'
         WHERE id = ?`
        )
        .run("worker-1").changes
    ).toBe(1);
    mocks.createWorktree.mockResolvedValueOnce({
      worktreePath: "C:\\worktrees\\task-1-orphan",
      branchName: "fleet/task-1-orphan",
    });
    mocks.deleteWorktree.mockRejectedValueOnce(new Error("worktree locked"));

    await expect(
      spawnFleetWorkerSession({
        run: { ...run(), project_id: "uncategorized" },
        task: task(),
        repo: { ...repo(), project_id: "uncategorized" },
        workerId: "worker-1",
        leaseToken: "lease-1",
      })
    ).rejects.toThrow("fleet worker launch lease changed before session link");

    const updated = worker();
    expect(updated).toMatchObject({
      status: "cleanup_pending",
      spawn_error: "worktree locked",
    });
    expect(updated.session_id).toBeTruthy();
    expect(
      queries.getSession(db).get(updated.session_id as string)
    ).toBeTruthy();
    expect(deleteWorktree).toHaveBeenCalledWith(
      "C:\\worktrees\\task-1-orphan",
      "C:\\repo",
      true
    );
  });
});

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
    expect(worker().status).toBe("cleanup_complete");
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
