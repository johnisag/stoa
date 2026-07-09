import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrations";
import { createSchema } from "@/lib/db/schema";
import { queries } from "@/lib/db/queries";

function markAppliedThrough(db: InstanceType<typeof Database>, id: number) {
  db.exec(`
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const insert = db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)");
  for (let i = 1; i <= id; i++) insert.run(i, `migration-${i}`);
}

function hasColumn(
  db: InstanceType<typeof Database>,
  table: string,
  column: string
) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => (row as { name: string }).name === column);
}

function expectColumns(
  db: InstanceType<typeof Database>,
  table: string,
  columns: string[]
) {
  for (const column of columns) {
    expect(hasColumn(db, table, column), `${table}.${column}`).toBe(true);
  }
}

describe("fleet migrations", () => {
  it("migration 56 survives an already-marked partial phase 2 schema", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 55);
    db.exec(`
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft'
      );
      CREATE TABLE fleet_artifacts (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      );
      INSERT INTO fleet_runs (id) VALUES ('run-1');
      INSERT INTO fleet_artifacts (id, fleet_run_id, severity)
        VALUES ('artifact-1', 'run-1', 'blocker');
    `);

    runMigrations(db);

    expectColumns(db, "fleet_runs", [
      "plan_hash",
      "approved_plan_hash",
      "approved_by",
      "approved_at",
    ]);
    expectColumns(db, "fleet_artifacts", [
      "task_id",
      "plan_hash",
      "artifact_type",
      "title",
      "body",
      "severity",
      "actor",
      "created_at",
    ]);

    expect(() =>
      queries.clearFleetArtifactTaskLinksForRun(db).run("run-1")
    ).not.toThrow();
  });

  it("migration 56 backfills artifact plan hashes when the run hash exists", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 55);
    db.exec(`
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        plan_hash TEXT
      );
      CREATE TABLE fleet_artifacts (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      );
      INSERT INTO fleet_runs (id, plan_hash) VALUES ('run-1', 'hash-a');
      INSERT INTO fleet_artifacts (id, fleet_run_id, severity)
        VALUES ('artifact-1', 'run-1', 'blocker');
    `);

    runMigrations(db);

    const row = db
      .prepare("SELECT plan_hash FROM fleet_artifacts WHERE id = ?")
      .get("artifact-1") as { plan_hash: string | null };
    expect(row.plan_hash).toBe("hash-a");
  });

  it("schema init repairs partial fleet artifacts before index creation", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 55);
    db.exec(`
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft'
      );
      CREATE TABLE fleet_artifacts (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'warning'
      );
    `);

    expect(() => createSchema(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();

    queries
      .createFleetRun(db)
      .run(
        "run-2",
        "Phase 2",
        "Approve the fleet plan",
        null,
        null,
        null,
        "claude",
        null,
        1,
        "four_agent",
        "{}"
      );
    queries
      .createFleetArtifact(db)
      .run(
        "artifact-2",
        "run-2",
        null,
        "hash-b",
        "critic_finding",
        "Schema repaired",
        "Runtime artifact insert still works after startup repair.",
        "warning",
        "red-team"
      );

    const artifact = queries.listFleetArtifactsForRun(db).get("run-2", 10) as {
      created_at: string;
      title: string;
    };
    expect(artifact).toMatchObject({
      title: "Schema repaired",
    });
    expect(artifact.created_at).toEqual(expect.any(String));
    expect(artifact.created_at.length).toBeGreaterThan(0);
  });
});
