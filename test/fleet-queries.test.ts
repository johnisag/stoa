import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import type {
  FleetEventRow,
  FleetRunRow,
  FleetTaskRow,
  FleetWorkerRow,
} from "@/lib/fleet/types";

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
  runMigrations(db);
});

beforeEach(() => {
  db.exec(`
    DELETE FROM fleet_events;
    DELETE FROM fleet_workers;
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
    DELETE FROM dispatch_repos;
    DELETE FROM projects WHERE id <> 'uncategorized';
  `);
});

function createFleetRun(id: string, name = "Fleet run") {
  queries
    .createFleetRun(db)
    .run(
      id,
      name,
      "Coordinate a phase",
      null,
      null,
      15,
      "claude",
      "opus",
      6,
      "four_agent",
      JSON.stringify({ phase: "draft", canSpawnWorkers: false })
    );
}

describe("fleet run queries", () => {
  it("lists runs newest first with task and worker counts", () => {
    createFleetRun("run-a", "A");
    createFleetRun("run-b", "B");
    db.prepare(
      "UPDATE fleet_runs SET updated_at = datetime('now', '+1 second') WHERE id = ?"
    ).run("run-b");
    queries
      .createFleetTask(db)
      .run("task-a1", "run-a", null, "Scope", null, "draft", "scope", 0, "[]");
    queries
      .createFleetTask(db)
      .run(
        "task-a2",
        "run-a",
        "task-a1",
        "Build",
        null,
        "draft",
        "task",
        1,
        "[]"
      );
    db.prepare(
      `INSERT INTO fleet_workers (id, fleet_run_id, task_id, session_id, status, provider, model, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-a",
      "run-a",
      "task-a1",
      null,
      "waiting_for_operator",
      "claude",
      "opus",
      1
    );

    const rows = queries.listFleetRuns(db).all(100) as Array<
      FleetRunRow & { task_count: number; worker_count: number }
    >;

    expect(rows.map((r) => r.id)).toEqual(["run-b", "run-a"]);
    expect(rows.find((r) => r.id === "run-a")).toMatchObject({
      task_count: 2,
      worker_count: 1,
      max_concurrency: 6,
      approval_state: "draft",
    });
  });

  it("reads a run graph in stable task, worker, and event order", () => {
    createFleetRun("run-1");
    queries
      .createFleetTask(db)
      .run("task-2", "run-1", null, "Second", null, "draft", "task", 2, "[]");
    queries
      .createFleetTask(db)
      .run("task-1", "run-1", null, "First", null, "draft", "task", 1, "[]");
    db.prepare(
      `INSERT INTO fleet_workers (id, fleet_run_id, task_id, session_id, status, provider, model, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "worker-1",
      "run-1",
      "task-1",
      null,
      "waiting_for_operator",
      "codex",
      null,
      1
    );
    queries
      .createFleetEvent(db)
      .run("run-1", "draft_created", "operator", "{}");
    queries
      .createFleetEvent(db)
      .run("run-1", "preview_viewed", "operator", "{}");

    const run = queries.getFleetRun(db).get("run-1") as FleetRunRow;
    const tasks = queries
      .listFleetTasksForRun(db)
      .all("run-1") as FleetTaskRow[];
    const workers = queries
      .listFleetWorkersForRun(db)
      .all("run-1") as FleetWorkerRow[];
    const events = queries
      .listFleetEventsForRun(db)
      .all("run-1", 1) as FleetEventRow[];

    expect(run.name).toBe("Fleet run");
    expect(tasks.map((t) => t.id)).toEqual(["task-1", "task-2"]);
    expect(workers.map((w) => w.id)).toEqual(["worker-1"]);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe("preview_viewed");
  });

  it("bounds the polling list and truncates previews without losing detail rows", () => {
    const longGoal = "g".repeat(800);
    const longProvider = "p".repeat(80);
    const longModel = "m".repeat(160);
    for (let i = 0; i < 105; i++) {
      createFleetRun(`run-${String(i).padStart(3, "0")}`, `Run ${i}`);
    }
    db.prepare(
      "UPDATE fleet_runs SET goal = ?, provider = ?, model = ? WHERE id = ?"
    ).run(longGoal, longProvider, longModel, "run-104");

    const rows = queries.listFleetRuns(db).all(100) as FleetRunRow[];
    const fullRow = queries.getFleetRun(db).get("run-104") as FleetRunRow;

    expect(rows).toHaveLength(100);
    expect(rows[0].id).toBe("run-104");
    expect(rows[0].goal).toHaveLength(600);
    expect(rows[0].provider).toHaveLength(40);
    expect(rows[0].model).toHaveLength(120);
    expect(fullRow.goal).toHaveLength(800);
    expect(fullRow.provider).toHaveLength(80);
    expect(fullRow.model).toHaveLength(160);
  });

  it("returns undefined or empty arrays for missing runs", () => {
    expect(queries.getFleetRun(db).get("missing")).toBeUndefined();
    expect(queries.listFleetTasksForRun(db).all("missing")).toEqual([]);
    expect(queries.listFleetWorkersForRun(db).all("missing")).toEqual([]);
    expect(queries.listFleetEventsForRun(db).all("missing", 50)).toEqual([]);
  });
});
