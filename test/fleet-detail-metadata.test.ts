import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import {
  countFleetEventsForDetail,
  loadFleetDetailArtifactMetadata,
} from "@/lib/fleet/detail-metadata";
import type { FleetTaskRow } from "@/lib/fleet/types";

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
    DELETE FROM fleet_tasks;
    DELETE FROM fleet_runs;
  `);
  queries
    .createFleetRun(db)
    .run(
      "run-1",
      "Large evidence run",
      "Keep task evidence discoverable",
      null,
      null,
      15,
      "codex",
      "gpt-5.5",
      4,
      "manual",
      JSON.stringify({ phase: "draft", canSpawnWorkers: false })
    );
  queries
    .createFleetTask(db)
    .run("task-1", "run-1", null, "Old task", null, "draft", "task", 1, "[]");
});

describe("Fleet detail metadata windows", () => {
  it("keeps task-referenced evidence discoverable beyond 100 newer artifacts", () => {
    for (let index = 0; index < 105; index += 1) {
      const id = `artifact-${String(index).padStart(3, "0")}`;
      queries
        .createFleetArtifact(db)
        .run(
          id,
          "run-1",
          "task-1",
          "plan-hash",
          "task_review_result",
          `Artifact ${index}`,
          `body ${index}`,
          "info",
          "reviewer"
        );
      db.prepare(`UPDATE fleet_artifacts SET created_at = ? WHERE id = ?`).run(
        `2026-08-02T00:00:00.${String(index).padStart(3, "0")}Z`,
        id
      );
    }
    db.prepare(
      `UPDATE fleet_tasks
       SET report_artifact_id = 'artifact-000',
           diff_artifact_id = 'artifact-001',
           verification_artifact_id = 'artifact-002'
       WHERE id = 'task-1'`
    ).run();

    const tasks = queries
      .listFleetTasksForRun(db)
      .all("run-1") as FleetTaskRow[];
    const result = loadFleetDetailArtifactMetadata(db, "run-1", tasks, 100);

    expect(result.total).toBe(105);
    expect(result.hasMore).toBe(true);
    expect(result.rows).toHaveLength(103);
    expect(result.rows.map((artifact) => artifact.id)).toEqual(
      expect.arrayContaining(["artifact-000", "artifact-001", "artifact-002"])
    );
    expect(result.rows.map((artifact) => artifact.id)).not.toContain(
      "artifact-003"
    );
    expect(result.rows.every((artifact) => artifact.body === "")).toBe(true);
  });

  it("reports the full event count independently of the rendered window", () => {
    for (let index = 0; index < 51; index += 1) {
      queries
        .createFleetEvent(db)
        .run("run-1", "test_event", "test", JSON.stringify({ index }));
    }

    expect(queries.listFleetEventsForRun(db).all("run-1", 50)).toHaveLength(50);
    expect(countFleetEventsForDetail(db, "run-1")).toBe(51);
  });
});
