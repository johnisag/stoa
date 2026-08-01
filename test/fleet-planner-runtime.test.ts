import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpDir } from "@/lib/platform";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({
  db: null as unknown,
  spawn: vi.fn(),
  stop: vi.fn(async () => true),
  remove: vi.fn(async () => undefined),
  runGit: vi.fn(async (_cwd?: string, _args?: string[]) => ({
    stdout: "",
    stderr: "",
  })),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

vi.mock("@/lib/git-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-status")>();
  return {
    ...actual,
    getDefaultBranch: () => "main",
    isGitRepo: () => true,
  };
});

vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  return { ...actual, runGit: state.runGit };
});

vi.mock("@/lib/readiness-server", () => ({
  detectAgentBinaries: () => ({
    claude: true,
    codex: true,
    hermes: false,
    kilo: false,
    kimi: false,
  }),
}));

vi.mock("@/lib/orchestration", () => {
  class WorkerSpawnError extends Error {
    constructor(
      message: string,
      readonly sessionId: string | null,
      readonly worktreePath: string | null
    ) {
      super(message);
    }
  }
  return { WorkerSpawnError, spawnWorker: state.spawn };
});

vi.mock("@/lib/fleet/stop", () => ({
  stopFleetSession: state.stop,
}));

vi.mock("@/lib/worktrees", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/worktrees")>();
  return { ...actual, deleteWorktree: state.remove };
});

import { queries } from "@/lib/db";
import {
  cancelFleetPlanner,
  pollFleetPlanner,
  readBoundedFleetPlannerFile,
  startFleetPlanner,
} from "@/lib/fleet/planner";
import { createDraftFleetRun } from "@/lib/fleet/service";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const memory = new Database(":memory:");
  createSchema(memory);
  runMigrations(memory);
  state.db = memory;
});

beforeEach(() => {
  state.spawn.mockReset();
  state.stop.mockClear();
  state.remove.mockClear();
  state.runGit.mockClear();
  db().exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  queries
    .createProject(db())
    .run("planner-project", "Planner", "C:\\repo", "claude", "sonnet", null, 1);
  queries
    .createDispatchRepo(db())
    .run(
      "planner-repo",
      "C:\\repo",
      "owner/repo",
      "claude",
      10,
      4,
      null,
      "main",
      "review",
      1,
      0,
      0,
      0,
      0,
      null,
      "planner-project"
    );
  state.spawn.mockResolvedValue({
    id: "planner-session",
    worktree_path: "C:\\worktrees\\planner",
  });
});

describe("Fleet planner lifecycle", () => {
  it("reads planner output from one bounded regular-file handle", async () => {
    const directory = await mkdtemp(join(tmpDir(), "stoa-fleet-file-"));
    try {
      const plan = join(directory, "PLAN.md");
      await writeFile(plan, "x".repeat(128 * 1024 + 1), "utf8");
      await expect(readBoundedFleetPlannerFile(plan)).resolves.toMatchObject({
        error: expect.stringContaining("128 KiB"),
      });
      await expect(
        readBoundedFleetPlannerFile(directory)
      ).resolves.toMatchObject({ error: expect.stringContaining("regular") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("claims one launch, uses an isolated worktree, and rejects a duplicate", async () => {
    const created = createDraftFleetRun({
      name: "Automatic plan",
      goal: "Split the work",
      repoId: "planner-repo",
      provider: "codex",
      model: "gpt-test",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;

    const started = await startFleetPlanner(runId, { taskCap: 80 });
    if ("error" in started) throw new Error(started.error);
    expect(started.run.run.plannerState).toBe("running");
    expect(started.run.run.plannerProvider).toBe("codex");
    expect(state.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "codex",
        model: "gpt-test",
        useWorktree: true,
        requireWorktree: true,
        requireTaskDelivery: true,
        skipSetup: true,
        approvalMode: "prompt",
      })
    );
    expect(state.spawn.mock.calls[0]?.[0].task).toContain("at most 40");

    await expect(startFleetPlanner(runId)).resolves.toMatchObject({
      error: "a planner is already active or cleaning up",
      status: 409,
    });
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });

  it("accepts the same launch when reconciliation wins the starting race", async () => {
    const created = createDraftFleetRun({
      name: "Slow launch recovery",
      goal: "Do not kill a recovered live planner",
      repoId: "planner-repo",
    });
    if ("error" in created) throw new Error(created.error);
    let resolveSpawn!: (value: {
      id: string;
      worker_status: string;
      worktree_path: string;
      branch_name: string;
    }) => void;
    state.spawn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSpawn = resolve;
        })
    );
    const starting = startFleetPlanner(created.run.run.id);
    await vi.waitFor(() => {
      const row = db()
        .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
        .get(created.run.run.id) as { settings_json: string };
      expect(JSON.parse(row.settings_json).planner.state).toBe("starting");
    });
    const row = db()
      .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
      .get(created.run.run.id) as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    settings.planner = {
      ...settings.planner,
      state: "running",
      sessionId: "race-session",
      worktreePath: "C:\\worktrees\\race",
    };
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(JSON.stringify(settings), created.run.run.id);
    resolveSpawn({
      id: "race-session",
      worker_status: "running",
      worktree_path: "C:\\worktrees\\race",
      branch_name: settings.planner.branchName,
    });

    const result = await starting;
    if ("error" in result) throw new Error(result.error);
    expect(result.run.run.plannerState).toBe("running");
    expect(state.stop).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("cancels the claimed planner before stopping and reclaiming its worktree", async () => {
    const created = createDraftFleetRun({
      name: "Cancel plan",
      goal: "Stop safely",
      repoId: "planner-repo",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    const started = await startFleetPlanner(runId);
    if ("error" in started) throw new Error(started.error);

    const canceled = await cancelFleetPlanner(runId);
    if ("error" in canceled) throw new Error(canceled.error);
    expect(canceled.run.run.plannerState).toBe("idle");
    expect(state.stop).toHaveBeenCalledWith("planner-session", "failed");
    expect(state.remove).toHaveBeenCalledWith(
      "C:\\worktrees\\planner",
      "C:\\repo",
      false
    );
    expect(state.runGit).toHaveBeenCalledWith(
      "C:\\repo",
      ["branch", "-D", expect.stringMatching(/^feature\/fleet-plan-/)],
      10_000
    );
  });

  it("lets only one concurrent poll finalize a generated plan", async () => {
    const worktree = await mkdtemp(join(tmpDir(), "stoa-fleet-planner-"));
    try {
      await writeFile(
        join(worktree, "PLAN.md"),
        `STOA_FLEET_PLAN_BEGIN\n{"tasks":[{"key":"api","title":"API","description":"Build API","taskType":"implementation","fileClaims":["lib/api"],"dependsOn":[]}]}\nSTOA_FLEET_PLAN_END`,
        "utf8"
      );
      state.spawn.mockResolvedValueOnce({
        id: "planner-concurrent",
        worker_status: "running",
        worktree_path: worktree,
      });
      const created = createDraftFleetRun({
        name: "Concurrent planner",
        goal: "Plan once",
        repoId: "planner-repo",
      });
      if ("error" in created) throw new Error(created.error);
      const started = await startFleetPlanner(created.run.run.id);
      if ("error" in started) throw new Error(started.error);

      await Promise.all([
        pollFleetPlanner(created.run.run.id),
        pollFleetPlanner(created.run.run.id),
      ]);

      const detail = await pollFleetPlanner(created.run.run.id);
      if ("error" in detail) throw new Error(detail.error);
      expect(detail.run.run.plannerState).toBe("ready");
      expect(detail.run.run.plannerError).toBeNull();
      expect(detail.run.tasks).toHaveLength(1);
      expect(state.stop).toHaveBeenCalledTimes(1);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("retries an interrupted durable finalization after restart", async () => {
    const worktree = await mkdtemp(join(tmpDir(), "stoa-fleet-finalize-"));
    try {
      await writeFile(
        join(worktree, "PLAN.md"),
        `STOA_FLEET_PLAN_BEGIN\n{"tasks":[{"key":"docs","title":"Docs","description":"Update docs","taskType":"docs","fileClaims":["docs/fleet.md"],"dependsOn":[]}]}\nSTOA_FLEET_PLAN_END`,
        "utf8"
      );
      state.spawn.mockResolvedValueOnce({
        id: "planner-restart",
        worker_status: "running",
        worktree_path: worktree,
      });
      const created = createDraftFleetRun({
        name: "Restart finalizer",
        goal: "Recover finalization",
        repoId: "planner-repo",
      });
      if ("error" in created) throw new Error(created.error);
      const started = await startFleetPlanner(created.run.run.id);
      if ("error" in started) throw new Error(started.error);
      const row = db()
        .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
        .get(created.run.run.id) as { settings_json: string };
      const settings = JSON.parse(row.settings_json);
      settings.planner.state = "finalizing";
      db()
        .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
        .run(JSON.stringify(settings), created.run.run.id);

      const recovered = await pollFleetPlanner(created.run.run.id);
      if ("error" in recovered) throw new Error(recovered.error);
      expect(recovered.run.run.plannerState).toBe("ready");
      expect(recovered.run.tasks).toHaveLength(1);
      expect(state.stop).toHaveBeenCalledTimes(1);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("recovers a starting planner identity and ingests its completed plan", async () => {
    const worktree = await mkdtemp(join(tmpDir(), "stoa-fleet-starting-"));
    try {
      await writeFile(
        join(worktree, "PLAN.md"),
        `STOA_FLEET_PLAN_BEGIN\n{"tasks":[{"key":"test","title":"Test","description":"Add tests","taskType":"test","fileClaims":["test/fleet.ts"],"dependsOn":[]}]}\nSTOA_FLEET_PLAN_END`,
        "utf8"
      );
      const created = createDraftFleetRun({
        name: "Recover starting",
        goal: "Resume after process restart",
        repoId: "planner-repo",
      });
      if ("error" in created) throw new Error(created.error);
      db()
        .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
        .run(
          JSON.stringify({
            phase: "planning",
            canSpawnWorkers: false,
            planner: {
              state: "starting",
              requestId: "recover-start",
              projectPath: "C:\\repo",
              branchName: "feature/fleet-plan-recover",
              provider: "claude",
              taskCap: 8,
              startedAt: new Date().toISOString(),
            },
          }),
          created.run.run.id
        );
      state.runGit.mockResolvedValueOnce({
        stdout: `worktree ${worktree}\nHEAD abc\nbranch refs/heads/feature/fleet-plan-recover\n\n`,
        stderr: "",
      });

      const recovered = await pollFleetPlanner(created.run.run.id);
      if ("error" in recovered) throw new Error(recovered.error);
      expect(recovered.run.run.plannerState).toBe("ready");
      expect(recovered.run.tasks[0]?.title).toBe("Test");
      expect(
        recovered.run.events.some(
          (event) => event.eventType === "planner_recovered"
        )
      ).toBe(true);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  it("retains cleanup identity and capacity until a failed stop can retry", async () => {
    const created = createDraftFleetRun({
      name: "Cleanup retry",
      goal: "Keep ownership until cleanup",
      repoId: "planner-repo",
    });
    if ("error" in created) throw new Error(created.error);
    const started = await startFleetPlanner(created.run.run.id);
    if ("error" in started) throw new Error(started.error);
    state.stop.mockResolvedValueOnce(false);

    const pending = await cancelFleetPlanner(created.run.run.id);
    if ("error" in pending) throw new Error(pending.error);
    expect(pending.run.run.plannerState).toBe("cleanup_pending");
    expect(state.remove).not.toHaveBeenCalled();

    const retried = await pollFleetPlanner(created.run.run.id);
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.run.run.plannerState).toBe("idle");
    expect(state.stop).toHaveBeenCalledTimes(2);
    expect(state.remove).toHaveBeenCalledWith(
      "C:\\worktrees\\planner",
      "C:\\repo",
      false
    );
  });

  it("keeps cleanup pending when Git cannot prove the branch is absent", async () => {
    const created = createDraftFleetRun({
      name: "Git cleanup retry",
      goal: "Do not forget a branch on Git failure",
      repoId: "planner-repo",
    });
    if ("error" in created) throw new Error(created.error);
    const started = await startFleetPlanner(created.run.run.id);
    if ("error" in started) throw new Error(started.error);
    state.runGit.mockImplementation(async (_cwd?: string, args = []) => {
      if (args[0] === "worktree") return { stdout: "", stderr: "" };
      const error = Object.assign(new Error("git unavailable"), { code: 128 });
      throw error;
    });

    const pending = await cancelFleetPlanner(created.run.run.id);
    if ("error" in pending) throw new Error(pending.error);
    expect(pending.run.run.plannerState).toBe("cleanup_pending");

    state.runGit.mockResolvedValue({ stdout: "", stderr: "" });
    const retried = await pollFleetPlanner(created.run.run.id);
    if ("error" in retried) throw new Error(retried.error);
    expect(retried.run.run.plannerState).toBe("idle");
  });

  it("enforces global and per-provider planner admission", async () => {
    const create = (name: string, provider: "claude" | "codex") => {
      const created = createDraftFleetRun({
        name,
        goal: "Plan within capacity",
        repoId: "planner-repo",
        provider,
      });
      if ("error" in created) throw new Error(created.error);
      return created.run.run.id;
    };
    const ids = [
      create("Claude one", "claude"),
      create("Claude two", "claude"),
      create("Codex one", "codex"),
      create("Codex two", "codex"),
      create("Overflow", "codex"),
    ];
    for (const id of ids.slice(0, 4)) {
      const result = await startFleetPlanner(id);
      if ("error" in result) throw new Error(result.error);
    }
    await expect(startFleetPlanner(ids[4])).resolves.toMatchObject({
      error: "planner capacity is currently full",
      status: 429,
    });
  });

  it("shares planner admission with active Fleet worker capacity", async () => {
    const workerRun = createDraftFleetRun({
      name: "Worker capacity",
      goal: "Occupy shared PTYs",
      repoId: "planner-repo",
      provider: "codex",
    });
    if ("error" in workerRun) throw new Error(workerRun.error);
    const insert = db().prepare(
      `INSERT INTO fleet_workers (id, fleet_run_id, status, provider)
       VALUES (?, ?, 'running', 'codex')`
    );
    for (let index = 0; index < 6; index += 1) {
      insert.run(`active-worker-${index}`, workerRun.run.run.id);
    }
    const plannerRun = createDraftFleetRun({
      name: "Blocked planner",
      goal: "Wait for shared capacity",
      repoId: "planner-repo",
      provider: "codex",
    });
    if ("error" in plannerRun) throw new Error(plannerRun.error);
    await expect(
      startFleetPlanner(plannerRun.run.run.id)
    ).resolves.toMatchObject({
      error: "planner capacity is currently full",
      status: 429,
    });
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("fails and reclaims a planner that exceeds its bounded runtime", async () => {
    const created = createDraftFleetRun({
      name: "Timed planner",
      goal: "Do not occupy capacity forever",
      repoId: "planner-repo",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    const started = await startFleetPlanner(runId);
    if ("error" in started) throw new Error(started.error);
    const row = db()
      .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
      .get(runId) as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    settings.planner.startedAt = "2000-01-01T00:00:00.000Z";
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(JSON.stringify(settings), runId);

    const polled = await pollFleetPlanner(runId);
    if ("error" in polled) throw new Error(polled.error);
    expect(polled.run.run.plannerState).toBe("failed");
    expect(polled.run.run.plannerError).toContain("15-minute timeout");
    expect(state.stop).toHaveBeenCalledWith("planner-session", "failed");
    expect(state.remove).toHaveBeenCalledTimes(1);
  });
});
