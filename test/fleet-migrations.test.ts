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
  it("migration 63 repairs lifecycle state without assuming complete task tables", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 62);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_workers (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_artifacts (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_cleanup_actions (id TEXT PRIMARY KEY);
      INSERT INTO fleet_cleanup_actions (id) VALUES ('partial-1'), ('partial-2');
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expectColumns(db, "fleet_runs", [
      "archived_at",
      "archived_by",
      "retention_days",
    ]);
    expectColumns(db, "fleet_tasks", [
      "retry_not_before",
      "provider_failure_count",
      "provider_state",
      "provider_last_error",
      "provider_backoff_event_at",
    ]);
    expectColumns(db, "fleet_artifacts", ["body_pruned_at"]);
    expectColumns(db, "fleet_cleanup_actions", [
      "action_key",
      "fleet_run_id",
      "action_type",
      "state",
      "lease_owner",
      "lease_expires_at",
      "attempt_count",
    ]);
  });

  it("migration 60 adds durable exact-SHA verification state", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 59);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_workers (id TEXT PRIMARY KEY);
    `);

    runMigrations(db);

    expectColumns(db, "fleet_tasks", [
      "verification_id",
      "verification_status",
      "verification_spec_hash",
      "verified_head_sha",
      "verification_artifact_id",
      "verification_started_at",
      "verification_completed_at",
    ]);
    expectColumns(db, "fleet_verifications", [
      "fleet_run_id",
      "task_id",
      "worker_id",
      "attempt",
      "base_sha",
      "head_sha",
      "spec_hash",
      "command",
      "status",
      "run_count",
      "lease_owner",
      "lease_expires_at",
      "output_artifact_id",
      "output_hash",
      "error",
      "started_at",
      "completed_at",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name IN ('idx_fleet_verifications_identity',
                        'idx_fleet_verifications_status',
                        'idx_fleet_verifications_task')`
        )
        .all()
    ).toHaveLength(3);
  });

  it("migration 59 adds durable worker report and Git evidence fields", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 58);
    db.exec(`
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_workers (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_artifacts (id TEXT PRIMARY KEY);
    `);

    runMigrations(db);

    expectColumns(db, "fleet_tasks", [
      "base_sha",
      "head_sha",
      "actual_file_claims_json",
      "report_artifact_id",
      "diff_artifact_id",
    ]);
    expectColumns(db, "fleet_workers", [
      "branch_name",
      "base_sha",
      "head_sha",
      "report_path",
      "report_nonce_hash",
      "report_state",
      "report_poll_count",
      "report_next_poll_at",
    ]);
    expectColumns(db, "fleet_artifacts", [
      "worker_id",
      "attempt",
      "base_sha",
      "head_sha",
      "content_hash",
      "metadata_json",
      "byte_count",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name IN ('idx_fleet_workers_report_poll',
                        'idx_fleet_artifacts_worker_attempt_type')`
        )
        .all()
    ).toHaveLength(2);
  });

  it("migration 58 adds safe-default automation intent and exact review audit tables", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 57);
    db.exec(`
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft'
      );
      INSERT INTO fleet_runs (id) VALUES ('legacy-run');
    `);

    runMigrations(db);

    expectColumns(db, "fleet_runs", [
      "desired_state",
      "automation_policy_version",
      "automation_policy_json",
      "automation_policy_hash",
      "automation_granted_by",
      "automation_granted_at",
      "automation_base_sha",
      "automation_last_error",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('fleet_action_authorizations', 'fleet_reviews')`
        )
        .all()
    ).toHaveLength(2);
    expectColumns(db, "fleet_reviews", [
      "state",
      "request_id",
      "nonce_hash",
      "result_filename",
      "result_verdict",
      "result_bytes",
      "project_path",
      "worktree_path",
      "branch_name",
      "findings_json",
      "error",
      "started_at",
      "deadline_at",
      "completed_at",
      "updated_at",
    ]);
    const legacy = db
      .prepare(
        `SELECT desired_state, automation_policy_json, automation_policy_hash
         FROM fleet_runs WHERE id = 'legacy-run'`
      )
      .get() as {
      desired_state: string;
      automation_policy_json: string;
      automation_policy_hash: string | null;
    };
    expect(legacy.desired_state).toBe("draft");
    expect(JSON.parse(legacy.automation_policy_json)).toMatchObject({
      version: 1,
      automaticPlanning: false,
      automaticPlanApproval: false,
      automaticStart: false,
      automaticMerge: false,
    });
    expect(legacy.automation_policy_hash).toBeNull();
  });

  it("migration 57 repairs the durable scheduler schema", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 56);
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft'
      );
      CREATE TABLE fleet_tasks (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        priority INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE fleet_workers (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        task_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'waiting_for_operator'
      );
    `);
    runMigrations(db);
    expectColumns(db, "fleet_runs", [
      "scheduler_epoch",
      "recovery_required",
      "reserved_budget_usd",
      "spent_budget_usd",
    ]);
    expectColumns(db, "fleet_tasks", [
      "lease_owner",
      "spawn_request_id",
      "approval_state",
    ]);
    expectColumns(db, "fleet_workers", ["spawn_request_id", "reservation_usd"]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('fleet_task_dependencies', 'fleet_task_claims')`
        )
        .all()
    ).toHaveLength(2);
    const conductorFk = db
      .prepare(`PRAGMA foreign_key_list(fleet_runs)`)
      .all() as { from: string; table: string; on_delete: string }[];
    expect(conductorFk).toContainEqual(
      expect.objectContaining({
        from: "conductor_session_id",
        table: "sessions",
        on_delete: "SET NULL",
      })
    );
  });

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

  it("schema init repairs partial scheduler task and worker tables before indexes", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_workers (id TEXT PRIMARY KEY);
    `);
    expect(() => createSchema(db)).not.toThrow();
    expectColumns(db, "fleet_tasks", [
      "fleet_run_id",
      "status",
      "priority",
      "sort_order",
      "approval_state",
    ]);
    expectColumns(db, "fleet_workers", [
      "fleet_run_id",
      "status",
      "session_id",
      "spawn_request_id",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_fleet_tasks_schedule', 'idx_fleet_workers_one_active_task')`
        )
        .all()
    ).toHaveLength(2);
  });

  it("migration 64 repairs partial hash-only capability tables idempotently", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 63);
    db.exec(`
      CREATE TABLE fleet_capabilities (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL
      );
      CREATE TABLE fleet_capability_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        capability_id TEXT NOT NULL
      );
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expectColumns(db, "fleet_capabilities", [
      "version",
      "action",
      "run_id",
      "task_id",
      "worker_id",
      "attempt",
      "bound_hash_kind",
      "bound_hash_value",
      "use_mode",
      "issued_at_ms",
      "expires_at_ms",
      "revoked_at_ms",
      "consumed_at_ms",
      "lease_owner",
      "lease_expires_at_ms",
      "use_count",
      "issued_by",
    ]);
    expectColumns(db, "fleet_capability_audit", [
      "run_id",
      "action",
      "event_type",
      "scope_hash",
      "metadata_json",
      "created_at_ms",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name IN ('idx_fleet_capabilities_token_hash',
                        'idx_fleet_capability_audit_capability')`
        )
        .all()
    ).toHaveLength(2);
  });

  it("migration 65 adds durable Fleet source lineage idempotently", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 64);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY, fleet_run_id TEXT);
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expectColumns(db, "fleet_runs", [
      "source_kind",
      "source_id",
      "source_name",
    ]);
    expectColumns(db, "fleet_tasks", [
      "source_ref",
      "source_step_id",
      "source_issue_id",
      "source_issue_number",
    ]);
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index'
         AND name IN ('idx_fleet_runs_source', 'idx_fleet_tasks_source',
                      'idx_fleet_tasks_source_issue')`
      )
      .all();
    expect(indexes).toHaveLength(3);
  });
});
