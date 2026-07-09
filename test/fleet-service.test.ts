import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));

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

import { queries } from "@/lib/db";
import {
  approveFleetRunPlan,
  attachFleetPlanCriticArtifact,
  createDraftFleetRun,
  getFleetRunDetail,
  ingestFleetRunPlan,
  listFleetRuns,
} from "@/lib/fleet/service";

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
