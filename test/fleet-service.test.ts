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
  createDraftFleetRun,
  getFleetRunDetail,
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
