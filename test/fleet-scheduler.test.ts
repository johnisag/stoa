import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import {
  cancelFleetRun,
  fleetClaimsConflict,
  pauseFleetRun,
  reconcileFleetRun,
  selectReadyFleetTasks,
  startFleetRun,
  type FleetSpawnAdapter,
} from "@/lib/fleet/scheduler";
import { buildFleetWorkerPrompt } from "@/lib/fleet/spawn";
import type {
  FleetEventRow,
  FleetRunRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "@/lib/fleet/types";
import type { DispatchRepo } from "@/lib/dispatch/types";

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
});

function createRun(maxConcurrency = 4) {
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
      maxConcurrency,
      "four_agent",
      "{}"
    );
  db.prepare(
    `UPDATE fleet_runs
     SET status = 'planned',
         approval_state = 'approved',
         plan_hash = 'hash-a',
         approved_plan_hash = 'hash-a'
     WHERE id = 'run-1'`
  ).run();
}

function createTask(
  id: string,
  sortOrder: number,
  claims: string[] = [],
  status = "draft",
  parentTaskId: string | null = null
) {
  queries
    .createFleetTask(db)
    .run(
      id,
      "run-1",
      parentTaskId,
      `Task ${id}`,
      `Details for ${id}`,
      status,
      "task",
      sortOrder,
      JSON.stringify(claims)
    );
}

function fakeSpawn(seen: string[] = []): FleetSpawnAdapter {
  return async ({ task, workerId }) => {
    seen.push(task.id);
    const sessionId = `session-${workerId}`;
    const worktreePath = `C:\\worktrees\\${task.id}`;
    queries
      .createWorkerSession(db)
      .run(
        sessionId,
        `Worker ${task.id}`,
        `tmux-${workerId}`,
        worktreePath,
        null,
        task.title,
        "sonnet",
        "sessions",
        "claude",
        "proj-fleet"
      );
    return {
      sessionId,
      worktreePath,
      branchName: `feature/${task.id}`,
    };
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function workers() {
  return queries.listFleetWorkersForRun(db).all("run-1") as FleetWorkerRow[];
}

function tasks() {
  return queries.listFleetTasksForRun(db).all("run-1") as FleetTaskRow[];
}

function liveWorkerSessionNames() {
  return new Set(
    workers()
      .map((worker) => worker.session_id)
      .filter((id): id is string => Boolean(id))
      .map(
        (id) =>
          (queries.getSession(db).get(id) as { tmux_name: string } | undefined)
            ?.tmux_name
      )
      .filter((name): name is string => Boolean(name))
  );
}

describe("fleet scheduler admission", () => {
  it("detects overlapping file claims by path boundary", () => {
    expect(fleetClaimsConflict(["app/page.tsx"], ["app/page.tsx"])).toBe(true);
    expect(fleetClaimsConflict(["app"], ["app/page.tsx"])).toBe(true);
    expect(fleetClaimsConflict(["app/page"], ["app/page-two"])).toBe(false);
    expect(fleetClaimsConflict([], ["app/page.tsx"])).toBe(false);
  });

  it("normalizes claim path variants before admission", () => {
    createRun(3);
    createTask("task-a", 1, ["./app//"]);
    createTask("task-b", 2, ["app/page.tsx"]);
    createTask("task-c", 3, ["lib/../src/x.ts"]);
    createTask("task-d", 4, ["src/x.ts"]);
    createTask("task-e", 5, ["C:\\repo\\src\\x.ts"]);
    createTask("task-f", 6, ["/repo/src/x.ts"]);
    createTask("task-g", 7, ["\\\\server\\share\\repo\\src\\x.ts"]);
    createTask("task-h", 8, ["~/repo/src/x.ts"]);
    createTask("task-i", 9, ["C:repo\\src\\x.ts"]);

    const decision = selectReadyFleetTasks({
      tasks: tasks(),
      workers: [],
      maxConcurrency: 3,
    });

    expect(decision.selected.map((task) => task.id)).toEqual([
      "task-a",
      "task-c",
    ]);
    expect(decision.skipped).toBe(7);
  });

  it("serializes write tasks with unknown file claims", () => {
    createRun(3);
    createTask("task-a", 1, []);
    createTask("task-b", 2, ["app/page.tsx"]);
    createTask("task-c", 3, []);

    const decision = selectReadyFleetTasks({
      tasks: tasks(),
      workers: [],
      maxConcurrency: 3,
    });

    expect(decision.selected.map((task) => task.id)).toEqual(["task-a"]);
    expect(decision.skipped).toBe(2);
  });

  it("selects ready tasks under concurrency and parent constraints", () => {
    createRun(3);
    createTask("parent", 1, ["app/parent.ts"], "draft");
    createTask("child", 2, ["app/child.ts"], "draft", "parent");
    createTask("free", 3, ["lib/free.ts"], "draft");

    const decision = selectReadyFleetTasks({
      tasks: tasks(),
      workers: [],
      maxConcurrency: 3,
    });

    expect(decision.selected.map((task) => task.id)).toEqual([
      "parent",
      "free",
    ]);
    expect(decision.skipped).toBe(1);
  });
});

describe("reconcileFleetRun", () => {
  it("launches two independent tasks and links workers to sessions", async () => {
    createRun(2);
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    const seen: string[] = [];

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(seen),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ launched: 2, recovered: 0 });
    expect(seen).toEqual(["task-a", "task-b"]);
    expect(result.run.run.status).toBe("running");
    expect(result.run.workers).toHaveLength(2);
    expect(
      result.run.workers.every((worker) => worker.status === "running")
    ).toBe(true);
    expect(tasks().map((task) => task.status)).toEqual(["running", "running"]);
  });

  it("does not launch conflicting tasks concurrently", async () => {
    createRun(3);
    createTask("task-a", 1, ["app"]);
    createTask("task-b", 2, ["app/page.tsx"]);
    createTask("task-c", 3, ["lib"]);
    const seen: string[] = [];

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(seen),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(seen).toEqual(["task-a", "task-c"]);
    expect(result.summary.skipped).toBe(1);
    expect(workers()).toHaveLength(2);
    expect(tasks().find((task) => task.id === "task-b")?.status).toBe("draft");
  });

  it("does not duplicate workers on repeated ticks", async () => {
    createRun(2);
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    const seen: string[] = [];

    await reconcileFleetRun("run-1", { db, spawn: fakeSpawn(seen) });
    const liveSessionNames = new Set(
      workers()
        .map((worker) => worker.session_id)
        .filter((id): id is string => Boolean(id))
        .map(
          (id) =>
            (
              queries.getSession(db).get(id) as
                { tmux_name: string } | undefined
            )?.tmux_name
        )
        .filter((name): name is string => Boolean(name))
    );
    const second = await reconcileFleetRun("run-1", {
      db,
      liveSessionNames,
      spawn: fakeSpawn(seen),
    });

    expect(second).toHaveProperty("run");
    if ("error" in second) throw new Error(second.error);
    expect(second.summary.launched).toBe(0);
    expect(second.summary.recovered).toBe(0);
    expect(seen).toEqual(["task-a", "task-b"]);
    expect(workers()).toHaveLength(2);
  });

  it("respects the repository concurrency cap", async () => {
    createRun(4);
    db.prepare(
      "UPDATE dispatch_repos SET max_concurrency = 1 WHERE id = ?"
    ).run("repo-fleet");
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    const seen: string[] = [];

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(seen),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(1);
    expect(seen).toEqual(["task-a"]);
  });

  it("respects active fleet workers from other runs on the same repository", async () => {
    createRun(2);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 10, max_concurrency = 1 WHERE id = ?"
    ).run("repo-fleet");
    queries
      .createFleetRun(db)
      .run(
        "run-other",
        "Other run",
        "Already active",
        "repo-fleet",
        "proj-fleet",
        null,
        "claude",
        null,
        1,
        "four_agent",
        "{}"
      );
    queries
      .createFleetTask(db)
      .run(
        "task-other",
        "run-other",
        null,
        "Other",
        null,
        "running",
        "task",
        1,
        JSON.stringify(["other/file.ts"])
      );
    queries
      .createFleetWorkerLease(db)
      .run(
        "worker-other",
        "run-other",
        "task-other",
        "claude",
        null,
        1,
        "lease-other",
        "2026-07-09T00:10:00.000Z"
      );
    queries
      .markFleetWorkerSpawning(db)
      .run("2026-07-09T00:10:00.000Z", "worker-other", "lease-other");
    createTask("task-a", 1, ["app/a.ts"]);

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(0);
  });

  it("unpins cleanup-pending workers from other runs before admission", async () => {
    createRun(1);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 10, max_concurrency = 1 WHERE id = ?"
    ).run("repo-fleet");
    queries
      .createFleetRun(db)
      .run(
        "run-other",
        "Other run",
        "Cleanup is stale",
        "repo-fleet",
        "proj-fleet",
        null,
        "claude",
        null,
        1,
        "four_agent",
        "{}"
      );
    queries
      .createFleetTask(db)
      .run(
        "task-other",
        "run-other",
        null,
        "Other",
        null,
        "running",
        "task",
        1,
        JSON.stringify(["other/file.ts"])
      );
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, session_id, status, provider, model, attempt,
        spawn_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-other",
      "run-other",
      "task-other",
      null,
      "cleanup_pending",
      "claude",
      null,
      1,
      "backend down"
    );
    createTask("task-a", 1, ["app/a.ts"]);

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(1);
    expect(
      queries.getFleetWorker(db).get("worker-other") as FleetWorkerRow
    ).toMatchObject({
      status: "failed",
      spawn_error: "cleanup ownership missing; unpinned by recovery",
    });
  });

  it("serializes claims held by active workers in other fleet runs", async () => {
    createRun(3);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 10, max_concurrency = 3 WHERE id = ?"
    ).run("repo-fleet");
    queries
      .createFleetRun(db)
      .run(
        "run-other",
        "Other run",
        "Already active",
        "repo-fleet",
        "proj-fleet",
        null,
        "claude",
        null,
        1,
        "four_agent",
        "{}"
      );
    queries
      .createFleetTask(db)
      .run(
        "task-other",
        "run-other",
        null,
        "Other",
        null,
        "running",
        "task",
        1,
        JSON.stringify(["app"])
      );
    queries
      .createFleetWorkerLease(db)
      .run(
        "worker-other",
        "run-other",
        "task-other",
        "claude",
        null,
        1,
        "lease-other",
        "2026-07-09T00:10:00.000Z"
      );
    queries
      .markFleetWorkerSpawning(db)
      .run("2026-07-09T00:10:00.000Z", "worker-other", "lease-other");
    createTask("task-a", 1, ["app/page.tsx"]);
    createTask("task-b", 2, ["lib/b.ts"]);

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(1);
    expect(result.run.workers[0].taskId).toBe("task-b");
  });

  it("does not exceed the repo cap when the current run already has active workers", async () => {
    createRun(4);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 10, max_concurrency = 3 WHERE id = ?"
    ).run("repo-fleet");
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    createTask("task-c", 3, ["pkg/c.ts"]);
    createTask("task-d", 4, ["docs/d.md"]);

    const first = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) throw new Error(first.error);
    expect(first.summary.launched).toBe(3);

    const second = await reconcileFleetRun("run-1", {
      db,
      liveSessionNames: liveWorkerSessionNames(),
      spawn: fakeSpawn(),
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) throw new Error(second.error);
    expect(second.summary.launched).toBe(0);
    expect(workers()).toHaveLength(3);
  });

  it("uses daily quota as new launch headroom after existing workers are counted", async () => {
    createRun(2);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 3, max_concurrency = 4 WHERE id = ?"
    ).run("repo-fleet");
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    await reconcileFleetRun("run-1", { db, spawn: fakeSpawn() });
    db.prepare("UPDATE fleet_runs SET max_concurrency = 4 WHERE id = ?").run(
      "run-1"
    );
    createTask("task-c", 3, ["pkg/c.ts"]);

    const second = await reconcileFleetRun("run-1", {
      db,
      liveSessionNames: liveWorkerSessionNames(),
      spawn: fakeSpawn(),
    });

    expect(second).toHaveProperty("run");
    if ("error" in second) throw new Error(second.error);
    expect(second.summary.launched).toBe(1);
    expect(workers()).toHaveLength(3);
  });

  it("treats repository daily quota zero as no launch slots", async () => {
    createRun(2);
    db.prepare("UPDATE dispatch_repos SET daily_quota = 0 WHERE id = ?").run(
      "repo-fleet"
    );
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    const seen: string[] = [];

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(seen),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(0);
    expect(seen).toEqual([]);
    expect(workers()).toHaveLength(0);
  });

  it("blocks new launches when the fleet run budget is exhausted", async () => {
    createRun(2);
    db.prepare("UPDATE fleet_runs SET budget_usd = 0 WHERE id = ?").run(
      "run-1"
    );
    createTask("task-a", 1, ["app/a.ts"]);

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(0);
    expect(workers()).toHaveLength(0);
  });

  it("serializes budgeted runs to one active worker", async () => {
    createRun(2);
    db.prepare("UPDATE fleet_runs SET budget_usd = 1 WHERE id = ?").run(
      "run-1"
    );
    createTask("task-a", 1, ["app/a.ts"]);
    createTask("task-b", 2, ["lib/b.ts"]);

    const first = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) throw new Error(first.error);
    expect(first.summary.launched).toBe(1);

    const second = await reconcileFleetRun("run-1", {
      db,
      liveSessionNames: liveWorkerSessionNames(),
      spawn: fakeSpawn(),
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) throw new Error(second.error);
    expect(second.summary.launched).toBe(0);
    expect(workers()).toHaveLength(1);
  });

  it("serializes fleet launches against live dispatch file claims", async () => {
    createRun(2);
    createTask("task-a", 1, ["app/page.tsx"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    queries
      .upsertDispatchCandidate(db)
      .run(
        "dispatch-a",
        "repo-fleet",
        101,
        "Dispatch A",
        "https://example.test/101",
        "2026-07-09T00:00:00Z"
      );
    queries.setDispatchClaims(db).run(JSON.stringify(["app"]), "dispatch-a");
    db.prepare(
      "UPDATE issue_dispatches SET status = 'dispatched', dispatched_at = datetime('now') WHERE id = ?"
    ).run("dispatch-a");

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(1);
    expect(result.run.workers[0].taskId).toBe("task-b");
  });

  it("treats absolute live dispatch claims as unknown custody", async () => {
    createRun(2);
    createTask("task-a", 1, ["app/page.tsx"]);
    createTask("task-b", 2, ["lib/b.ts"]);
    queries
      .upsertDispatchCandidate(db)
      .run(
        "dispatch-a",
        "repo-fleet",
        101,
        "Dispatch A",
        "https://example.test/101",
        "2026-07-09T00:00:00Z"
      );
    queries
      .setDispatchClaims(db)
      .run(JSON.stringify(["/repo/app/page.tsx"]), "dispatch-a");
    db.prepare(
      "UPDATE issue_dispatches SET status = 'dispatched', dispatched_at = datetime('now') WHERE id = ?"
    ).run("dispatch-a");

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(0);
    expect(workers()).toHaveLength(0);
  });

  it("recovers stale launch leases before selecting work", async () => {
    createRun(1);
    createTask("task-a", 1, [], "running");
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, status, provider, model, attempt,
        lease_token, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "stale-worker",
      "run-1",
      "task-a",
      "leasing",
      "claude",
      null,
      1,
      "stale-token",
      "2020-01-01T00:00:00.000Z"
    );

    const result = await reconcileFleetRun("run-1", {
      db,
      now: new Date("2026-07-09T00:00:00.000Z"),
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ recovered: 1, launched: 1 });
    expect(workers().map((worker) => worker.status)).toEqual([
      "failed",
      "running",
    ]);
    expect(tasks()[0].status).toBe("running");
  });

  it("recovers linked spawning workers without duplicating them", async () => {
    createRun(1);
    createTask("task-a", 1, [], "running");
    queries
      .createWorkerSession(db)
      .run(
        "session-a",
        "Worker task-a",
        "tmux-task-a",
        "C:\\worktrees\\task-a",
        null,
        "Task task-a",
        "sonnet",
        "sessions",
        "claude",
        "proj-fleet"
      );
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, session_id, status, provider, model, attempt,
        lease_token, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "spawning-worker",
      "run-1",
      "task-a",
      "session-a",
      "spawning",
      "claude",
      null,
      1,
      "lease-a",
      "2020-01-01T00:00:00.000Z"
    );

    const seen: string[] = [];
    const result = await reconcileFleetRun("run-1", {
      db,
      now: new Date("2026-07-09T00:00:00.000Z"),
      liveSessionNames: new Set(["tmux-task-a"]),
      spawn: fakeSpawn(seen),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ recovered: 1, launched: 0 });
    expect(seen).toEqual([]);
    expect(workers()[0]).toMatchObject({
      session_id: "session-a",
      status: "running",
      lease_token: null,
    });
    expect(tasks()[0].status).toBe("running");
  });

  it("leaves in-flight linked spawning workers alone before their lease expires", async () => {
    createRun(1);
    createTask("task-a", 1, [], "running");
    queries
      .createWorkerSession(db)
      .run(
        "session-a",
        "Worker task-a",
        "tmux-task-a",
        "C:\\worktrees\\task-a",
        null,
        "Task task-a",
        "sonnet",
        "sessions",
        "claude",
        "proj-fleet"
      );
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, session_id, status, provider, model, attempt,
        lease_token, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "spawning-worker",
      "run-1",
      "task-a",
      "session-a",
      "spawning",
      "claude",
      null,
      1,
      "lease-a",
      "2026-07-09T00:10:00.000Z"
    );

    const result = await reconcileFleetRun("run-1", {
      db,
      now: new Date("2026-07-09T00:00:00.000Z"),
      liveSessionNames: new Set(["tmux-task-a"]),
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ recovered: 0, launched: 0 });
    expect(workers()[0]).toMatchObject({
      status: "spawning",
      lease_token: "lease-a",
    });
    expect(tasks()[0].status).toBe("running");
  });

  it("does not promote linked spawning workers missing from the backend", async () => {
    createRun(1);
    createTask("task-a", 1, [], "running");
    queries
      .createWorkerSession(db)
      .run(
        "session-a",
        "Worker task-a",
        "tmux-task-a",
        "C:\\worktrees\\task-a",
        null,
        "Task task-a",
        "sonnet",
        "sessions",
        "claude",
        "proj-fleet"
      );
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, session_id, status, provider, model, attempt,
        lease_token, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "spawning-worker",
      "run-1",
      "task-a",
      "session-a",
      "spawning",
      "claude",
      null,
      1,
      "lease-a",
      "2020-01-01T00:00:00.000Z"
    );

    const result = await reconcileFleetRun("run-1", {
      db,
      now: new Date("2026-07-09T00:00:00.000Z"),
      liveSessionNames: new Set(),
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ recovered: 1, launched: 1 });
    expect(workers()[0]).toMatchObject({
      status: "failed",
      spawn_error: "recovered missing backend session before scheduler tick",
    });
    expect(workers()[1].status).toBe("running");
    expect(tasks()[0].status).toBe("running");
  });

  it("recovers running workers missing from the backend", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"], "running");
    queries
      .createWorkerSession(db)
      .run(
        "session-a",
        "Worker task-a",
        "tmux-task-a",
        "C:\\worktrees\\task-a",
        null,
        "Task task-a",
        "sonnet",
        "sessions",
        "claude",
        "proj-fleet"
      );
    db.prepare(
      `INSERT INTO fleet_workers (
        id, fleet_run_id, task_id, session_id, status, provider, model, attempt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "running-worker",
      "run-1",
      "task-a",
      "session-a",
      "running",
      "claude",
      null,
      1
    );

    const result = await reconcileFleetRun("run-1", {
      db,
      liveSessionNames: new Set(),
      spawn: fakeSpawn(),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toMatchObject({ recovered: 1, launched: 1 });
    expect(workers()[0]).toMatchObject({
      status: "failed",
      spawn_error: "recovered missing backend session for running worker",
    });
    expect(workers()[1].status).toBe("running");
  });

  it("fails closed when the spawn adapter returns no isolated worktree", async () => {
    createRun(1);
    createTask("task-a", 1);

    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: async ({ workerId }) => ({
        sessionId: `session-${workerId}`,
        worktreePath: "",
        branchName: "feature/no-worktree",
      }),
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.run.workers[0]).toMatchObject({
      status: "failed",
    });
    expect(result.run.workers[0].spawnError).toContain("isolated worktree");
    expect(result.run.tasks[0].status).toBe("blocked");
  });

  it("keeps a 40 fake-worker run bounded", async () => {
    createRun(40);
    db.prepare(
      "UPDATE dispatch_repos SET daily_quota = 40, max_concurrency = 40 WHERE id = ?"
    ).run("repo-fleet");
    for (let i = 0; i < 40; i++) {
      createTask(`task-${String(i).padStart(2, "0")}`, i, [`pkg/${i}`]);
    }

    const started = Date.now();
    const result = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
      providerCap: 40,
    });
    const elapsed = Date.now() - started;

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(40);
    expect(result.run.workers).toHaveLength(40);
    expect(elapsed).toBeLessThan(1000);
    const events = queries
      .listFleetEventsForRun(db)
      .all("run-1", 100) as FleetEventRow[];
    expect(events.length).toBeLessThanOrEqual(45);
  });
});

describe("fleet lifecycle controls", () => {
  it("pause stops new launches and start resumes them", async () => {
    createRun(1);
    createTask("task-a", 1);
    expect(await pauseFleetRun("run-1", { db })).toHaveProperty("run");

    const pausedTick = await reconcileFleetRun("run-1", {
      db,
      spawn: fakeSpawn(),
    });
    expect(pausedTick).toHaveProperty("run");
    if ("error" in pausedTick) throw new Error(pausedTick.error);
    expect(pausedTick.summary.launched).toBe(0);
    expect(workers()).toHaveLength(0);

    const resumed = await startFleetRun("run-1", { db, spawn: fakeSpawn() });
    expect(resumed).toHaveProperty("run");
    if ("error" in resumed) throw new Error(resumed.error);
    expect(resumed.summary.launched).toBe(1);
    expect(resumed.run.run.status).toBe("running");
  });

  it("start refuses runs without a repository before mutating state", async () => {
    createRun(1);
    createTask("task-a", 1);
    db.prepare("UPDATE fleet_runs SET repo_id = NULL WHERE id = ?").run(
      "run-1"
    );

    const result = await startFleetRun("run-1", { db, spawn: fakeSpawn() });

    expect(result).toMatchObject({
      error: "fleet run needs a repository before launch",
      status: 409,
    });
    expect((queries.getFleetRun(db).get("run-1") as FleetRunRow).status).toBe(
      "planned"
    );
    expect(workers()).toHaveLength(0);
  });

  it("cancel persists terminal scheduling state", async () => {
    createRun(2);
    createTask("task-a", 1);
    createTask("task-b", 2);
    expect(await cancelFleetRun("run-1", { db })).toHaveProperty("run");

    const tick = await reconcileFleetRun("run-1", { db, spawn: fakeSpawn() });
    expect(tick).toHaveProperty("run");
    if ("error" in tick) throw new Error(tick.error);
    expect(tick.summary.launched).toBe(0);
    expect(tick.run.run.status).toBe("canceled");
    expect(tick.run.tasks.map((task) => task.status)).toEqual([
      "canceled",
      "canceled",
    ]);
  });

  it("can return after leasing without waiting for slow worker launch", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    const gate = deferred<{
      sessionId: string;
      worktreePath: string;
      branchName: string;
    }>();
    let sessionId = "";

    const result = await reconcileFleetRun("run-1", {
      db,
      awaitLaunches: false,
      spawn: async ({ task, workerId }) => {
        sessionId = `session-${workerId}`;
        queries
          .createWorkerSession(db)
          .run(
            sessionId,
            `Worker ${task.id}`,
            `tmux-${workerId}`,
            `C:\\worktrees\\${task.id}`,
            null,
            task.title,
            "sonnet",
            "sessions",
            "claude",
            "proj-fleet"
          );
        return gate.promise;
      },
    });

    expect(result).toHaveProperty("run");
    if ("error" in result) throw new Error(result.error);
    expect(result.summary.launched).toBe(1);
    expect(workers()[0].status).toBe("spawning");

    gate.resolve({
      sessionId,
      worktreePath: "C:\\worktrees\\task-a",
      branchName: "feature/task-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("does not clean up a linked spawn already promoted by recovery", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    const gate = deferred<{
      sessionId: string;
      worktreePath: string;
      branchName: string;
    }>();
    const started = deferred<{ sessionId: string; tmuxName: string }>();
    const cleaned: string[] = [];
    let sessionId = "";

    await reconcileFleetRun("run-1", {
      db,
      awaitLaunches: false,
      cleanupSpawn: async ({ result }) => {
        cleaned.push(result.sessionId);
      },
      spawn: async ({ task, workerId, leaseToken }) => {
        sessionId = `session-${workerId}`;
        const tmuxName = `tmux-${workerId}`;
        queries
          .createWorkerSession(db)
          .run(
            sessionId,
            `Worker ${task.id}`,
            tmuxName,
            `C:\\worktrees\\${task.id}`,
            null,
            task.title,
            "sonnet",
            "sessions",
            "claude",
            "proj-fleet"
          );
        queries.linkFleetWorkerSession(db).run(sessionId, workerId, leaseToken);
        started.resolve({ sessionId, tmuxName });
        return gate.promise;
      },
    });
    const linked = await started.promise;
    expect(workers()[0]).toMatchObject({
      status: "spawning",
      session_id: linked.sessionId,
    });

    const recovered = await reconcileFleetRun("run-1", {
      db,
      now: new Date("2999-01-01T00:00:00.000Z"),
      liveSessionNames: new Set([linked.tmuxName]),
      spawn: fakeSpawn(),
    });

    expect(recovered).toHaveProperty("run");
    if ("error" in recovered) throw new Error(recovered.error);
    expect(recovered.summary).toMatchObject({ recovered: 1, launched: 0 });

    gate.resolve({
      sessionId,
      worktreePath: "C:\\worktrees\\task-a",
      branchName: "feature/task-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleaned).toEqual([]);
    expect(workers()[0]).toMatchObject({
      status: "running",
      session_id: linked.sessionId,
    });
    expect(queries.getSession(db).get(linked.sessionId)).toBeTruthy();
  });

  it("cleans up a worker that finishes spawning after cancel wins the race", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    const gate = deferred<{
      sessionId: string;
      worktreePath: string;
      branchName: string;
    }>();
    const started = deferred<string>();
    const cleaned: string[] = [];
    let sessionId = "";

    await reconcileFleetRun("run-1", {
      db,
      awaitLaunches: false,
      cleanupSpawn: async ({ result }) => {
        cleaned.push(result.sessionId);
      },
      spawn: async ({ task, workerId }) => {
        sessionId = `session-${workerId}`;
        queries
          .createWorkerSession(db)
          .run(
            sessionId,
            `Worker ${task.id}`,
            `tmux-${workerId}`,
            `C:\\worktrees\\${task.id}`,
            null,
            task.title,
            "sonnet",
            "sessions",
            "claude",
            "proj-fleet"
          );
        started.resolve(sessionId);
        return gate.promise;
      },
    });
    await started.promise;
    expect(workers()[0].status).toBe("spawning");

    expect(await cancelFleetRun("run-1", { db })).toHaveProperty("run");
    expect(workers()[0].status).toBe("canceled");
    gate.resolve({
      sessionId,
      worktreePath: "C:\\worktrees\\task-a",
      branchName: "feature/task-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleaned).toEqual([sessionId]);
  });

  it("cancel stops a worker session linked during an in-flight spawn", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    const gate = deferred<{
      sessionId: string;
      worktreePath: string;
      branchName: string;
    }>();
    const started = deferred<string>();
    const stopped: string[] = [];
    const cleaned: string[] = [];
    let sessionId = "";

    await reconcileFleetRun("run-1", {
      db,
      awaitLaunches: false,
      cleanupSpawn: async ({ result }) => {
        cleaned.push(result.sessionId);
      },
      spawn: async ({ task, workerId, leaseToken }) => {
        sessionId = `session-${workerId}`;
        queries
          .createWorkerSession(db)
          .run(
            sessionId,
            `Worker ${task.id}`,
            `tmux-${workerId}`,
            `C:\\worktrees\\${task.id}`,
            null,
            task.title,
            "sonnet",
            "sessions",
            "claude",
            "proj-fleet"
          );
        queries.linkFleetWorkerSession(db).run(sessionId, workerId, leaseToken);
        started.resolve(sessionId);
        return gate.promise;
      },
    });
    await started.promise;

    const result = await cancelFleetRun("run-1", {
      db,
      stopSession: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });
    expect(result).toHaveProperty("run");
    expect(stopped).toEqual([sessionId]);

    gate.resolve({
      sessionId,
      worktreePath: "C:\\worktrees\\task-a",
      branchName: "feature/task-a",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleaned).toEqual([sessionId]);
  });

  it("cancel stops already running fleet worker sessions", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    await reconcileFleetRun("run-1", { db, spawn: fakeSpawn() });
    const sessionId = workers()[0].session_id;
    const stopped: string[] = [];

    const result = await cancelFleetRun("run-1", {
      db,
      stopSession: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
    });

    expect(result).toHaveProperty("run");
    expect(stopped).toEqual([sessionId]);
    expect(workers()[0].status).toBe("canceled");
  });

  it("surfaces backend stop failures during cancel", async () => {
    createRun(1);
    createTask("task-a", 1, ["app/a.ts"]);
    await reconcileFleetRun("run-1", { db, spawn: fakeSpawn() });

    const result = await cancelFleetRun("run-1", {
      db,
      stopSession: async () => ({ ok: false, error: "backend down" }),
    });

    expect(result).toHaveProperty("run");
    expect(workers()[0]).toMatchObject({
      status: "cleanup_pending",
      spawn_error: "backend down",
    });
    const events = queries
      .listFleetEventsForRun(db)
      .all("run-1", 10) as FleetEventRow[];
    expect(
      events.some((event) => event.event_type === "fleet_worker_stop_failed")
    ).toBe(true);
  });
});

describe("buildFleetWorkerPrompt", () => {
  it("pins the worker to its isolated worktree and claims", () => {
    createRun(1);
    createTask("task-a", 1, ["app/fleet.ts"]);
    const run = queries.getFleetRun(db).get("run-1") as FleetRunRow;
    const task = queries
      .getFleetTaskForRun(db)
      .get("run-1", "task-a") as FleetTaskRow;
    const repo = queries.getDispatchRepo(db).get("repo-fleet") as DispatchRepo;

    const prompt = buildFleetWorkerPrompt({
      run,
      task,
      repo,
      worktreePath: "C:\\worktrees\\fleet-task",
      branchName: "feature/fleet-task",
    });

    expect(prompt).toContain("C:\\worktrees\\fleet-task");
    expect(prompt).toContain("feature/fleet-task");
    expect(prompt).toContain("app/fleet.ts");
    expect(prompt).toContain("Do not merge");
  });
});
