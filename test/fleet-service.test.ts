import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({
  db: null as unknown,
  stopFleetSession: async () => true,
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
    getDefaultBranch: () => "develop",
    isGitRepo: () => true,
  };
});

vi.mock("@/lib/fleet/stop", () => ({
  stopFleetSession: vi.fn(() => state.stopFleetSession()),
}));

import { queries } from "@/lib/db";
import {
  approveFleetRunPlan,
  attachFleetPlanCriticArtifact,
  cancelFleetRun,
  completeFleetWorker,
  createDraftFleetRun,
  getFleetRunDetail,
  ingestFleetRunPlan,
  ingestGeneratedFleetRunPlan,
  listFleetRuns,
} from "@/lib/fleet/service";
import { cancelFleetPlanner } from "@/lib/fleet/planner";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  state.db = mem;
});

beforeEach(() => {
  state.stopFleetSession = async () => true;
  db().exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_artifacts;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM sessions WHERE id = 'fleet-session';
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
  queries
    .createProject(db())
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
    .createDispatchRepo(db())
    .run(
      "repo-fleet",
      "C:\\repo",
      "owner/repo",
      "claude",
      10,
      4,
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

describe("Phase 3 worker completion", () => {
  function addRunningWorker() {
    const created = createDraftFleetRun({
      name: "Runtime fleet",
      goal: "Finish a worker safely",
      repoId: "repo-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const planned = ingestFleetRunPlan(created.run.run.id, {
      planText: "- Build runtime [files: lib/runtime.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const approved = approveFleetRunPlan(created.run.run.id, {
      expectedPlanHash: planned.run.run.planHash!,
    });
    if ("error" in approved) throw new Error(approved.error);
    const taskId = approved.run.tasks[0].id;
    db()
      .prepare(
        `INSERT INTO sessions
       (id, name, tmux_name, status, worker_status, working_directory, group_path, agent_type)
       VALUES ('fleet-session', 'Worker', 'fleet-session', 'running', 'working', 'C:\\repo', 'sessions', 'codex')`
      )
      .run();
    db()
      .prepare(
        `UPDATE fleet_runs SET status = 'running', reserved_budget_usd = 0.25 WHERE id = ?`
      )
      .run(created.run.run.id);
    db()
      .prepare(`UPDATE fleet_tasks SET status = 'running' WHERE id = ?`)
      .run(taskId);
    db()
      .prepare(
        `INSERT INTO fleet_workers
       (id, fleet_run_id, task_id, session_id, status, provider, attempt, reservation_usd)
       VALUES ('fleet-worker', ?, ?, 'fleet-session', 'running', 'codex', 1, 0.25)`
      )
      .run(created.run.run.id, taskId);
    const insertLease = db().prepare(
      `INSERT INTO fleet_resource_leases
       (id, fleet_run_id, worker_id, resource_type, resource_key)
       VALUES (?, ?, 'fleet-worker', ?, ?)`
    );
    for (const resourceType of [
      "pty",
      "provider",
      "git_operation",
      "worktree",
    ]) {
      insertLease.run(
        `lease-${resourceType}`,
        created.run.run.id,
        resourceType,
        resourceType
      );
    }
    return { runId: created.run.run.id, taskId };
  }

  it("stops the backend before releasing runtime resources", async () => {
    const { runId, taskId } = addRunningWorker();

    const result = await completeFleetWorker(runId, "fleet-worker", {
      actor: "operator",
    });
    expect(result).toHaveProperty("run");
    expect(
      db()
        .prepare(`SELECT status FROM fleet_workers WHERE id = 'fleet-worker'`)
        .get()
    ).toEqual({ status: "completed" });
    expect(
      db().prepare(`SELECT status FROM fleet_tasks WHERE id = ?`).get(taskId)
    ).toEqual({ status: "needs_inspection" });
    expect(
      db()
        .prepare(
          `SELECT resource_type FROM fleet_resource_leases WHERE worker_id = 'fleet-worker' AND status = 'reserved'`
        )
        .all()
    ).toEqual([{ resource_type: "worktree" }]);
  });

  it("lets cancellation take ownership of an in-flight completion cleanup", async () => {
    const { runId } = addRunningWorker();
    let releaseFirstStop!: (value: boolean) => void;
    const firstStop = new Promise<boolean>((resolve) => {
      releaseFirstStop = resolve;
    });
    let calls = 0;
    state.stopFleetSession = async () => {
      calls += 1;
      return calls === 1 ? firstStop : true;
    };

    const completing = completeFleetWorker(runId, "fleet-worker", {
      actor: "operator",
    });
    await vi.waitFor(() =>
      expect(
        db()
          .prepare(
            `SELECT status, terminal_cause FROM fleet_workers WHERE id = 'fleet-worker'`
          )
          .get()
      ).toEqual({
        status: "cleanup_pending",
        terminal_cause: "operator_completion_pending",
      })
    );
    const canceled = await cancelFleetRun(runId, {
      actor: "operator",
      mode: "cancel-preserve-worktrees",
    });
    expect(canceled).toHaveProperty("run");
    releaseFirstStop(true);
    await completing;

    expect(
      db()
        .prepare(
          `SELECT status, terminal_cause FROM fleet_workers WHERE id = 'fleet-worker'`
        )
        .get()
    ).toEqual({
      status: "cleanup_complete",
      terminal_cause: "operator_cancel",
    });
    expect(
      db()
        .prepare(
          `SELECT spent_budget_usd, reserved_budget_usd FROM fleet_runs WHERE id = ?`
        )
        .get(runId)
    ).toEqual({ spent_budget_usd: 0.25, reserved_budget_usd: 0 });
    expect(
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_resource_leases WHERE worker_id = 'fleet-worker' AND status = 'reserved'`
        )
        .get()
    ).toEqual({ n: 0 });
  });
});

describe("generated Fleet plans", () => {
  function generatedTask(
    title: string,
    sortOrder: number,
    overrides: Record<string, unknown> = {}
  ) {
    return {
      title,
      description: `${title} description`,
      taskType: "implementation",
      parentIndex: null,
      sortOrder,
      fileClaims: [`lib/${title.toLowerCase()}.ts`],
      agentType: "codex",
      model: null,
      acceptanceCriteria: `${title} passes`,
      verifyCommand: "npm test",
      ...overrides,
    };
  }

  it("persists automatic allocations and dependencies into the approved contract", () => {
    const created = createDraftFleetRun({
      name: "Generated plan",
      goal: "Split this goal",
      repoId: "repo-fleet",
      provider: "claude",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: { state: "finalizing", requestId: "planner-1" },
        }),
        runId
      );

    const planned = ingestGeneratedFleetRunPlan(runId, {
      planText: "1. API\n2. UI",
      tasks: [
        generatedTask("API", 0),
        generatedTask("UI", 1, {
          agentType: "kimi",
          taskType: "review",
          fileClaims: [],
        }),
      ],
      dependencies: [[], [0]],
      expectedPlannerRequestId: "planner-1",
      source: "planner",
    });
    if ("error" in planned) throw new Error(planned.error);
    expect(planned.run.run.plannerState).toBe("cleanup_pending");
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "planner finalization and cleanup must finish before approval",
      status: 409,
    });
    expect(planned.run.tasks.map((task) => task.agentType)).toEqual([
      "codex",
      "kimi",
    ]);
    expect(planned.run.tasks[0].acceptanceCriteria).toBe("API passes");
    const dependency = db()
      .prepare(
        `SELECT task_id, depends_on_task_id FROM fleet_task_dependencies WHERE fleet_run_id = ?`
      )
      .get(runId) as { task_id: string; depends_on_task_id: string };
    expect(dependency).toEqual({
      task_id: planned.run.tasks[1].id,
      depends_on_task_id: planned.run.tasks[0].id,
    });
    const readOnlyClaims = db()
      .prepare(`SELECT COUNT(*) AS n FROM fleet_task_claims WHERE task_id = ?`)
      .get(planned.run.tasks[1].id) as { n: number };
    expect(readOnlyClaims.n).toBe(0);

    expect(
      ingestGeneratedFleetRunPlan(runId, {
        planText: "1. Duplicate poll",
        tasks: [generatedTask("Duplicate", 0)],
        expectedPlannerRequestId: "planner-1",
        source: "planner",
      })
    ).toMatchObject({
      error: "planner result was superseded",
      status: 409,
    });

    const row = db()
      .prepare(`SELECT settings_json FROM fleet_runs WHERE id = ?`)
      .get(runId) as { settings_json: string };
    const settings = JSON.parse(row.settings_json);
    settings.planner = { state: "ready", requestId: "planner-1" };
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(JSON.stringify(settings), runId);

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
    });
    expect(approved).not.toHaveProperty("error");
  });

  it("rejects a late planner result after its request was superseded", () => {
    const created = createDraftFleetRun({
      name: "Superseded planner",
      goal: "Do not overwrite the new plan",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    const result = ingestGeneratedFleetRunPlan(created.run.run.id, {
      planText: "1. Old",
      tasks: [generatedTask("Old", 0)],
      expectedPlannerRequestId: "old-request",
      source: "planner",
    });
    expect(result).toMatchObject({
      error: "planner result was superseded",
      status: 409,
    });
  });

  it("requires an active planner to be canceled before manual replacement", async () => {
    const created = createDraftFleetRun({
      name: "Planner cancellation",
      goal: "Keep one plan writer",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    const runId = created.run.run.id;
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: { state: "starting", requestId: "planner-active" },
        }),
        runId
      );
    expect(
      ingestFleetRunPlan(runId, { planText: "- Manual [files: lib/x.ts]" })
    ).toMatchObject({
      error: "cancel the active planner before ingesting a manual plan",
      status: 409,
    });

    const canceled = await cancelFleetPlanner(runId);
    if ("error" in canceled) throw new Error(canceled.error);
    expect(canceled.run.run.plannerState).toBe("idle");
    expect(
      ingestFleetRunPlan(runId, { planText: "- Manual [files: lib/x.ts]" })
    ).not.toHaveProperty("error");
  });

  it("refuses run cancellation while planner cleanup is still owned", async () => {
    const created = createDraftFleetRun({
      name: "Planner-owned cancel",
      goal: "Do not orphan the planner",
      repoId: "repo-fleet",
    });
    if ("error" in created) throw new Error(created.error);
    db()
      .prepare(`UPDATE fleet_runs SET settings_json = ? WHERE id = ?`)
      .run(
        JSON.stringify({
          phase: "planning",
          canSpawnWorkers: false,
          planner: {
            state: "cleanup_pending",
            requestId: "planner-cleanup",
          },
        }),
        created.run.run.id
      );
    await expect(
      cancelFleetRun(created.run.run.id, { actor: "operator" })
    ).resolves.toMatchObject({
      error: "cancel the active planner and finish its cleanup first",
      status: 409,
    });
  });
});

describe("createDraftFleetRun", () => {
  it("persists a draft run, one root task, and an audit event without spawning workers", () => {
    const res = createDraftFleetRun({
      name: "  Phase 1  ",
      goal: "  Durable model and read-only UI  ",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      budgetUsd: 25,
      provider: "codex",
      model: "gpt-5.5",
      maxConcurrency: 80,
      reviewPolicy: "four_agent_plus_red_team",
    });

    expect(res).toHaveProperty("run");
    if ("error" in res) return;
    expect(res.run.run).toMatchObject({
      name: "Phase 1",
      goal: "Durable model and read-only UI",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      budgetUsd: 25,
      provider: "codex",
      model: "gpt-5.5",
      maxConcurrency: 40,
      reviewPolicy: "four_agent_plus_red_team",
      status: "draft",
      approvalState: "draft",
      planHash: null,
      planText: null,
      taskCount: 1,
      workerCount: 0,
    });
    expect(res.run.run.approvalPreview.canApproveExecutableWork).toBe(false);
    expect(res.run.tasks).toHaveLength(1);
    expect(res.run.tasks[0]).toMatchObject({
      title: "Draft scope",
      taskType: "scope",
      status: "draft",
    });
    expect(res.run.workers).toEqual([]);
    expect(res.run.events.map((e) => e.eventType)).toEqual(["draft_created"]);

    const workerCount = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_workers")
      .get() as { n: number };
    expect(workerCount.n).toBe(0);

    const settings = db()
      .prepare("SELECT settings_json FROM fleet_runs WHERE id = ?")
      .get(res.run.run.id) as { settings_json: string };
    expect(JSON.parse(settings.settings_json)).toEqual({
      phase: "draft",
      canSpawnWorkers: false,
    });

    expect(listFleetRuns().map((r) => r.id)).toEqual([res.run.run.id]);
    expect(getFleetRunDetail(res.run.run.id)?.run.name).toBe("Phase 1");
  });

  it("rejects unknown repoId or projectId before writing anything", () => {
    expect(
      createDraftFleetRun({
        name: "Run",
        goal: "Goal",
        repoId: "missing",
      })
    ).toEqual({ error: "unknown repoId" });
    expect(
      createDraftFleetRun({
        name: "Run",
        goal: "Goal",
        projectId: "missing",
      })
    ).toEqual({ error: "unknown projectId" });

    const count = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_runs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects non-object JSON payloads before writing anything", () => {
    expect(createDraftFleetRun(null)).toEqual({ error: "name is required" });

    const count = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_runs")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("Phase 2 plan ingestion and approval", () => {
  function createRun() {
    const created = createDraftFleetRun({
      name: "Phase 2",
      goal: "Create a reviewable task graph",
      repoId: "repo-fleet",
      projectId: "proj-fleet",
      provider: "codex",
    });
    expect(created).toHaveProperty("run");
    if ("error" in created) throw new Error(created.error);
    return created.run.run.id;
  }

  it("ingests a markdown plan into durable tasks without spawning workers", () => {
    const runId = createRun();
    const res = ingestFleetRunPlan(runId, {
      planText: `
- Build parser - Parse markdown into tasks [files: lib/fleet/plan.ts]
  - Add tests: cover \`test/fleet-plan.test.ts\`
- Add approval endpoint: require expected hash
`,
      actor: "operator",
    });

    expect(res).toHaveProperty("run");
    if ("error" in res) return;
    expect(res.run.run).toMatchObject({
      status: "draft",
      approvalState: "needs_approval",
      taskCount: 3,
      workerCount: 0,
    });
    expect(res.run.run.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(res.run.run.planText).toContain("Build parser");
    expect(res.run.run.approvedPlanHash).toBeNull();
    expect(res.run.tasks.map((task) => task.title)).toEqual([
      "Build parser",
      "Add tests",
      "Add approval endpoint",
    ]);
    expect(res.run.tasks[1].parentTaskId).toBe(res.run.tasks[0].id);
    expect(res.run.tasks[0].fileClaims).toEqual(["lib/fleet/plan.ts"]);
    expect(res.run.events[0]).toMatchObject({
      eventType: "plan_ingested",
      actor: "operator",
    });

    const workerCount = db()
      .prepare("SELECT COUNT(*) AS n FROM fleet_workers")
      .get() as { n: number };
    expect(workerCount.n).toBe(0);
  });

  it("approves the currently reviewed hash and records audit metadata", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
      approvedBy: "operator",
    });

    expect(approved).toHaveProperty("run");
    if ("error" in approved) return;
    expect(approved.run.run).toMatchObject({
      status: "planned",
      approvalState: "approved",
      approvedPlanHash: planned.run.run.planHash,
      approvedBy: "operator",
      workerCount: 0,
    });
    expect(approved.run.run.approvedAt).toBeTruthy();
    expect(approved.run.events[0]).toMatchObject({
      eventType: "plan_approved",
      actor: "operator",
    });
  });

  it("resolves a project checkout default branch into the approved contract", () => {
    const created = createDraftFleetRun({
      name: "Project fleet",
      goal: "Use the checkout default branch",
      projectId: "proj-fleet",
      provider: "codex",
    });
    if ("error" in created) throw new Error(created.error);
    const planned = ingestFleetRunPlan(created.run.run.id, {
      planText: "- Build project task [files: lib/project.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    const approved = approveFleetRunPlan(created.run.run.id, {
      expectedPlanHash: planned.run.run.planHash!,
    });
    expect(approved).toHaveProperty("run");
    expect(
      (
        db()
          .prepare(`SELECT base_branch FROM fleet_tasks WHERE fleet_run_id = ?`)
          .get(created.run.run.id) as { base_branch: string }
      ).base_branch
    ).toBe("develop");
  });

  it("rejects unsupported providers before executable approval", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, { planText: "- Build parser" });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(`UPDATE fleet_runs SET provider = 'unknown' WHERE id = ?`)
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
      })
    ).toEqual({
      error: "select a supported agent provider before approval",
      status: 409,
    });
  });

  it("rejects approval when current-plan blocker findings exist", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const blocked = attachFleetPlanCriticArtifact(runId, {
      taskId: planned.run.tasks[0].id,
      expectedPlanHash: planned.run.run.planHash,
      title: "Unsafe plan",
      body: "This finding must be addressed before approval.",
      severity: "blocker",
      actor: "red-team",
    });
    expect(blocked).toHaveProperty("run");

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "blocker findings must be addressed before approval",
      status: 409,
    });

    const revised = ingestFleetRunPlan(runId, {
      planText: "- Build safer parser\n- Add approval",
    });
    expect(revised).toHaveProperty("run");
    if ("error" in revised) return;
    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: revised.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");
  });

  it("rejects approval when persisted claim rows were weakened", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser [files: lib/fleet/plan.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(`DELETE FROM fleet_task_claims WHERE fleet_run_id = ?`)
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "plan graph claims do not match the reviewed task claims",
      status: 409,
    });
  });

  it("rejects approval when dependency semantics were changed", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText:
        "- Foundation [files: lib/a.ts]\n  - Dependent [files: lib/b.ts]",
    });
    if ("error" in planned) throw new Error(planned.error);
    db()
      .prepare(
        `UPDATE fleet_task_dependencies SET dependency_type = 'informs' WHERE fleet_run_id = ?`
      )
      .run(runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash!,
      })
    ).toEqual({
      error: "plan graph has unsupported dependency semantics",
      status: 409,
    });
  });

  it("rejects lifecycle replay after a plan has been approved", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;
    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: planned.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");

    expect(
      ingestFleetRunPlan(runId, {
        planText: "- Reset an approved run",
      })
    ).toEqual({
      error: "cannot replace a plan for the current run state",
      status: 409,
    });
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "run is not awaiting plan approval",
      status: 409,
    });
  });

  it("rejects stale approval hashes and resets approval when the graph changes", () => {
    const runId = createRun();
    const first = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) return;

    const second = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval\n- Add critic artifacts",
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) return;

    expect(second.run.run.planHash).not.toBe(first.run.run.planHash);
    expect(second.run.run.approvedPlanHash).toBeNull();
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: first.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });
  });

  it("rejects approval when durable task rows drift from the stored hash", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    db()
      .prepare(
        "UPDATE fleet_tasks SET title = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("Changed parser", runId);

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });
  });

  it("rejects approval when durable task rows are structurally invalid", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    const other = createDraftFleetRun({
      name: "Other run",
      goal: "Other task",
    });
    expect(other).toHaveProperty("run");
    if ("error" in other) return;
    const otherTaskId = other.run.tasks[0]?.id;
    expect(otherTaskId).toBeTruthy();
    if (!otherTaskId) return;

    db()
      .prepare(
        "UPDATE fleet_tasks SET parent_task_id = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run(otherTaskId, runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has invalid parents", status: 409 });

    const replanned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(replanned).toHaveProperty("run");
    if ("error" in replanned) return;
    db()
      .prepare(
        "UPDATE fleet_tasks SET file_claims_json = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("{", runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: replanned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has invalid file claims", status: 409 });

    const finalPlan = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(finalPlan).toHaveProperty("run");
    if ("error" in finalPlan) return;
    db()
      .prepare(
        "UPDATE fleet_tasks SET status = ? WHERE fleet_run_id = ? AND sort_order = 0"
      )
      .run("queued", runId);
    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: finalPlan.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({ error: "plan graph has non-draft tasks", status: 409 });
  });

  it("attaches critic findings as artifacts and validates task ownership", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    expect(
      attachFleetPlanCriticArtifact(runId, {
        taskId: "missing",
        expectedPlanHash: planned.run.run.planHash,
        title: "Wrong task",
        body: "Should fail",
      })
    ).toEqual({ error: "unknown taskId", status: 400 });

    const attached = attachFleetPlanCriticArtifact(runId, {
      taskId: planned.run.tasks[0].id,
      expectedPlanHash: planned.run.run.planHash,
      title: "Need narrower parser",
      body: "The plan parser should be bounded and deterministic.",
      severity: "blocker",
      actor: "critic-a",
    });

    expect(attached).toHaveProperty("run");
    if ("error" in attached) return;
    expect(attached.run.artifacts[0]).toMatchObject({
      taskId: planned.run.tasks[0].id,
      title: "Need narrower parser",
      severity: "blocker",
      actor: "critic-a",
    });
    expect(attached.run.events[0]).toMatchObject({
      eventType: "critic_artifact_attached",
      actor: "critic-a",
    });
  });

  it("rejects stale or late critic artifact submissions", () => {
    const runId = createRun();
    const first = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(first).toHaveProperty("run");
    if ("error" in first) return;
    const second = ingestFleetRunPlan(runId, {
      planText: "- Build safer parser\n- Add approval",
    });
    expect(second).toHaveProperty("run");
    if ("error" in second) return;

    expect(
      attachFleetPlanCriticArtifact(runId, {
        expectedPlanHash: first.run.run.planHash,
        title: "Stale finding",
        body: "This finding reviewed the previous graph.",
      })
    ).toEqual({ error: "plan hash changed", status: 409 });

    const approved = approveFleetRunPlan(runId, {
      expectedPlanHash: second.run.run.planHash,
      approvedBy: "operator",
    });
    expect(approved).toHaveProperty("run");

    expect(
      attachFleetPlanCriticArtifact(runId, {
        expectedPlanHash: second.run.run.planHash,
        title: "Late blocker",
        body: "This should not mutate an approved run.",
        severity: "blocker",
      })
    ).toEqual({ error: "run is not awaiting plan findings", status: 409 });
  });

  it("fails closed on legacy blocker artifacts without a plan hash", () => {
    const runId = createRun();
    const planned = ingestFleetRunPlan(runId, {
      planText: "- Build parser\n- Add approval",
    });
    expect(planned).toHaveProperty("run");
    if ("error" in planned) return;

    queries
      .createFleetArtifact(db())
      .run(
        "legacy-blocker",
        runId,
        null,
        null,
        "critic_finding",
        "Legacy blocker",
        "This blocker predates artifact hash pinning.",
        "blocker",
        "red-team"
      );

    expect(
      approveFleetRunPlan(runId, {
        expectedPlanHash: planned.run.run.planHash,
        approvedBy: "operator",
      })
    ).toEqual({
      error: "blocker findings must be addressed before approval",
      status: 409,
    });
  });
});
