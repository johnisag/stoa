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
    const result = loadFleetDetailArtifactMetadata(
      db,
      "run-1",
      tasks,
      "plan-hash",
      100
    );

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

  it("supplements the newest window with old blockers bound to the current plan and task head", () => {
    const currentHead = "c".repeat(40);
    db.prepare(
      `UPDATE fleet_runs SET plan_hash = 'current-plan' WHERE id = 'run-1'`
    ).run();
    db.prepare(`UPDATE fleet_tasks SET head_sha = ? WHERE id = 'task-1'`).run(
      currentHead
    );
    for (const input of [
      {
        id: "old-current-blocker",
        planHash: "current-plan",
        headSha: currentHead,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "old-plan-blocker",
        planHash: "previous-plan",
        headSha: currentHead,
        createdAt: "2026-08-01T00:00:01.000Z",
      },
      {
        id: "old-head-blocker",
        planHash: "current-plan",
        headSha: "b".repeat(40),
        createdAt: "2026-08-01T00:00:02.000Z",
      },
    ]) {
      queries
        .createFleetArtifact(db)
        .run(
          input.id,
          "run-1",
          "task-1",
          input.planHash,
          "task_review_finding",
          input.id,
          "actionable evidence",
          "blocker",
          "reviewer"
        );
      db.prepare(
        `UPDATE fleet_artifacts SET head_sha = ?, created_at = ? WHERE id = ?`
      ).run(input.headSha, input.createdAt, input.id);
    }
    for (let index = 0; index < 105; index += 1) {
      const id = `new-info-${String(index).padStart(3, "0")}`;
      queries
        .createFleetArtifact(db)
        .run(
          id,
          "run-1",
          null,
          "current-plan",
          "task_review_result",
          `New info ${index}`,
          "newer evidence",
          "info",
          "reviewer"
        );
      db.prepare(`UPDATE fleet_artifacts SET created_at = ? WHERE id = ?`).run(
        `2026-08-02T00:00:00.${String(index).padStart(3, "0")}Z`,
        id
      );
    }

    const tasks = queries
      .listFleetTasksForRun(db)
      .all("run-1") as FleetTaskRow[];
    const result = loadFleetDetailArtifactMetadata(
      db,
      "run-1",
      tasks,
      "current-plan",
      100
    );
    const ids = result.rows.map((artifact) => artifact.id);

    expect(result.total).toBe(108);
    expect(result.hasMore).toBe(true);
    expect(ids).toContain("old-current-blocker");
    expect(ids).not.toContain("old-plan-blocker");
    expect(ids).not.toContain("old-head-blocker");
    expect(result.rows.every((artifact) => artifact.body === "")).toBe(true);
  });

  it("caps supplemental blockers and strips oversized metadata", () => {
    const insert = db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, plan_hash, metadata_json, artifact_type, title, body,
        severity, actor, created_at)
       VALUES (?, 'run-1', 'plan-hash', ?, 'task_review_finding', ?, '',
        'blocker', 'reviewer', ?)`
    );
    const oversized = JSON.stringify({ payload: "x".repeat(256 * 1024) });
    const insertAll = db.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const id = `bounded-blocker-${String(index).padStart(4, "0")}`;
        insert.run(
          id,
          index === 999 ? oversized : "{}",
          `Blocker ${index}`,
          new Date(Date.UTC(2026, 7, 3) + index).toISOString()
        );
      }
    });
    insertAll();

    const tasks = queries
      .listFleetTasksForRun(db)
      .all("run-1") as FleetTaskRow[];
    const result = loadFleetDetailArtifactMetadata(
      db,
      "run-1",
      tasks,
      "plan-hash",
      1
    );

    expect(result.rows).toHaveLength(1_000);
    expect(result.hasMore).toBe(true);
    expect(
      result.rows.find((artifact) => artifact.id === "bounded-blocker-0999")
        ?.metadata_json
    ).toBe("{}");
    expect(
      Math.max(
        ...result.rows.map((artifact) =>
          Buffer.byteLength(artifact.metadata_json ?? "", "utf8")
        )
      )
    ).toBe(2);
  });

  it("preserves rich metadata already admitted by the bounded recent window", () => {
    const metadata = JSON.stringify({ action: "inspect-this-blocker" });
    db.prepare(
      `INSERT INTO fleet_artifacts
       (id, fleet_run_id, plan_hash, metadata_json, artifact_type, title, body,
        severity, actor, created_at)
       VALUES ('recent-blocker', 'run-1', 'plan-hash', ?,
        'task_review_finding', 'Recent blocker', '', 'blocker', 'reviewer',
        '2026-08-04T00:00:00.000Z')`
    ).run(metadata);

    const tasks = queries
      .listFleetTasksForRun(db)
      .all("run-1") as FleetTaskRow[];
    const result = loadFleetDetailArtifactMetadata(
      db,
      "run-1",
      tasks,
      "plan-hash",
      1
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.metadata_json).toBe(metadata);
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
