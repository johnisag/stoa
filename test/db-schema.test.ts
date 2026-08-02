/**
 * Fresh DB schema integrity — locks the indexes/columns that the rest of the
 * app assumes exist when createSchema runs on a brand-new database.
 */
import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  createSchema(db);
});

function hasIndex(name: string): boolean {
  return (
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .all(name) as { name: string }[]
    ).length > 0
  );
}

function hasTable(name: string): boolean {
  return (
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .all(name) as { name: string }[]
    ).length > 0
  );
}

function hasTrigger(name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?")
      .get(name)
  );
}

function hasColumn(table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => (c as { name: string }).name === column);
}

describe("fresh schema indexes", () => {
  it("has the dev_servers project_id index", () => {
    expect(hasIndex("idx_dev_servers_project")).toBe(true);
  });

  it("has the sessions group/conductor/project indexes", () => {
    expect(hasIndex("idx_sessions_group")).toBe(true);
    expect(hasIndex("idx_sessions_conductor")).toBe(true);
    expect(hasIndex("idx_sessions_project")).toBe(true);
    expect(hasIndex("idx_sessions_fleet_ownership")).toBe(true);
  });
});

describe("fresh schema sessions columns", () => {
  it("has the orchestration columns referenced by indexes", () => {
    expect(hasColumn("sessions", "conductor_session_id")).toBe(true);
    expect(hasColumn("sessions", "project_id")).toBe(true);
    expect(hasColumn("sessions", "fleet_ownership_key")).toBe(true);
  });

  it("has the fork_cost_baseline column (#1 — schema/migration parity)", () => {
    // schema.ts must carry it too, so migration 44's guarded ALTER is a no-op on a
    // fresh DB (and the cost path can read s.fork_cost_baseline).
    expect(hasColumn("sessions", "fork_cost_baseline")).toBe(true);
  });
});

describe("fresh schema checkpoints (#44 — schema/migration parity)", () => {
  it("has the checkpoints table with its pin + lineage columns", () => {
    for (const col of [
      "id",
      "session_id",
      "seq",
      "snapshot_sha",
      "summary",
      "transcript_session_id",
      "kind",
      "created_by",
      "parent_checkpoint_id",
      "created_at",
    ]) {
      expect(hasColumn("checkpoints", col)).toBe(true);
    }
  });

  it("has the checkpoints session + parent indexes (mirrors migration 52)", () => {
    expect(hasIndex("idx_checkpoints_session")).toBe(true);
    expect(hasIndex("idx_checkpoints_parent")).toBe(true);
  });
});

describe("fresh schema fleet management tables", () => {
  it("has the Phase 1 durable run graph tables", () => {
    for (const table of [
      "fleet_runs",
      "fleet_tasks",
      "fleet_workers",
      "fleet_events",
      "fleet_artifacts",
      "fleet_action_authorizations",
      "fleet_reviews",
      "fleet_capabilities",
      "fleet_capability_audit",
    ]) {
      expect(hasTable(table)).toBe(true);
    }
  });

  it("has the run, task, worker, and event columns Phase 1 queries rely on", () => {
    for (const col of [
      "id",
      "name",
      "goal",
      "repo_id",
      "project_id",
      "status",
      "budget_usd",
      "provider",
      "model",
      "max_concurrency",
      "review_policy",
      "approval_state",
      "plan_hash",
      "approved_plan_hash",
      "approved_by",
      "approved_at",
      "desired_state",
      "automation_policy_version",
      "automation_policy_json",
      "automation_policy_hash",
      "automation_base_sha",
      "source_kind",
      "source_id",
      "source_name",
      "settings_json",
    ]) {
      expect(hasColumn("fleet_runs", col)).toBe(true);
    }
    for (const col of [
      "id",
      "fleet_run_id",
      "parent_task_id",
      "title",
      "status",
      "task_type",
      "sort_order",
      "file_claims_json",
      "source_ref",
      "source_step_id",
      "source_issue_id",
      "source_issue_number",
    ]) {
      expect(hasColumn("fleet_tasks", col)).toBe(true);
    }
    for (const col of [
      "id",
      "fleet_run_id",
      "task_id",
      "session_id",
      "status",
      "attempt",
      "last_heartbeat_at",
      "session_ownership_key",
    ]) {
      expect(hasColumn("fleet_workers", col)).toBe(true);
    }
    for (const col of [
      "id",
      "fleet_run_id",
      "event_type",
      "actor",
      "payload",
    ]) {
      expect(hasColumn("fleet_events", col)).toBe(true);
    }
    for (const col of [
      "id",
      "fleet_run_id",
      "task_id",
      "plan_hash",
      "artifact_type",
      "title",
      "body",
      "severity",
      "actor",
      "created_at",
    ]) {
      expect(hasColumn("fleet_artifacts", col)).toBe(true);
    }
  });

  it("has the fleet management query indexes", () => {
    expect(hasIndex("idx_fleet_runs_status")).toBe(true);
    expect(hasIndex("idx_fleet_runs_updated")).toBe(true);
    expect(hasIndex("idx_fleet_runs_source")).toBe(true);
    expect(hasIndex("idx_fleet_tasks_run")).toBe(true);
    expect(hasIndex("idx_fleet_tasks_source")).toBe(true);
    expect(hasIndex("idx_fleet_tasks_source_issue")).toBe(true);
    expect(hasIndex("idx_fleet_workers_run")).toBe(true);
    expect(hasIndex("idx_fleet_workers_session_ownership")).toBe(true);
    expect(hasIndex("idx_fleet_events_run")).toBe(true);
    expect(hasIndex("idx_fleet_artifacts_run")).toBe(true);
    expect(hasIndex("idx_fleet_action_authorizations_run")).toBe(true);
    expect(hasIndex("idx_fleet_reviews_subject")).toBe(true);
    expect(hasIndex("idx_fleet_capabilities_token_hash")).toBe(true);
    expect(hasIndex("idx_fleet_capability_audit_capability")).toBe(true);
  });

  it("enforces unique immutable ownership keys and tolerates orphan evidence on replay", () => {
    const firstKey = "a".repeat(64);
    const secondKey = "b".repeat(64);
    db.prepare(
      `INSERT INTO fleet_runs (id, name, goal) VALUES ('ownership-run', 'Run', 'Goal')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, status, session_ownership_key)
       VALUES ('ownership-worker', 'ownership-run', 'spawning', ?)`
    ).run(firstKey);
    db.prepare(
      `INSERT INTO sessions (id, name, fleet_ownership_key)
       VALUES ('ownership-session', 'Session', ?)`
    ).run(firstKey);

    expect(() =>
      db
        .prepare(
          `UPDATE fleet_workers SET session_ownership_key = ? WHERE id = 'ownership-worker'`
        )
        .run(secondKey)
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .prepare(
          `UPDATE sessions SET fleet_ownership_key = ? WHERE id = 'ownership-session'`
        )
        .run(secondKey)
    ).toThrow(/immutable/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, name, fleet_ownership_key)
           VALUES ('ownership-duplicate', 'Duplicate', ?)`
        )
        .run(firstKey)
    ).toThrow();
    expect(hasTrigger("trg_sessions_fleet_ownership_immutable")).toBe(true);
    expect(hasTrigger("trg_fleet_workers_session_ownership_immutable")).toBe(
      true
    );

    db.prepare(`DELETE FROM fleet_workers WHERE id = 'ownership-worker'`).run();
    expect(() => createSchema(db)).not.toThrow();
  });
});
