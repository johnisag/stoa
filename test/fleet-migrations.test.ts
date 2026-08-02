import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
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

  it("migration 66 adds durable cost watermarks and generic resource admission idempotently", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 65);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_workers (id TEXT PRIMARY KEY);
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expectColumns(db, "fleet_runs", [
      "budget_tokens",
      "reserved_budget_tokens",
      "spent_budget_tokens",
      "cost_confidence",
      "budget_stop_mode",
      "budget_warning_threshold",
      "provider_caps_json",
      "resource_limits_json",
      "default_max_attempts",
    ]);
    expectColumns(db, "fleet_workers", [
      "reservation_tokens",
      "reservation_confidence",
      "actual_cost_usd",
      "actual_tokens",
      "cost_confidence",
      "cost_reconciled_at",
      "interrupt_requested_at",
      "interrupt_deadline_at",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('fleet_cost_accounts', 'fleet_runtime_leases',
                        'fleet_resource_usage_buckets', 'fleet_provider_cooldowns')`
        )
        .all()
    ).toHaveLength(4);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name IN ('idx_fleet_cost_accounts_session',
                        'idx_fleet_runtime_leases_active',
                        'idx_fleet_resource_usage_bucket_time',
                        'idx_fleet_provider_cooldowns_until')`
        )
        .all()
    ).toHaveLength(4);
  });

  it("migration 67 replaces unsafe global usage buckets with per-run scope", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 66);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_resource_usage_buckets (
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (resource_type, resource_key, bucket_start_ms)
      );
      INSERT INTO fleet_resource_usage_buckets
        (resource_type, resource_key, bucket_start_ms, units)
      VALUES ('event_fanout_per_minute', 'fleet', 1, 10);
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(hasColumn(db, "fleet_resource_usage_buckets", "fleet_run_id")).toBe(
      true
    );
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM fleet_resource_usage_buckets`).get()
    ).toEqual({ n: 0 });
  });

  it("migration 67 repairs a crash after the scoped table swap but before index creation", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 66);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_resource_usage_buckets (
        fleet_run_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (fleet_run_id, resource_type, resource_key, bucket_start_ms)
      );
      CREATE TABLE fleet_resource_usage_buckets_unscoped (
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (resource_type, resource_key, bucket_start_ms)
      );
    `);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_fleet_resource_usage_bucket_time'`
        )
        .get()
    ).toEqual({ name: "idx_fleet_resource_usage_bucket_time" });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table'
             AND name = 'fleet_resource_usage_buckets_unscoped'`
        )
        .get()
    ).toBeUndefined();
  });

  it("migration 68 adds restart-safe rendered status and interrupt state", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 67);
    db.exec(`CREATE TABLE fleet_workers (id TEXT PRIMARY KEY, status TEXT)`);

    expect(() => runMigrations(db)).not.toThrow();
    expect(() => runMigrations(db)).not.toThrow();
    expectColumns(db, "fleet_workers", [
      "interrupt_notice_state",
      "interrupt_stop_state",
      "interrupt_cause",
      "rendered_status",
      "rendered_status_summary",
      "rendered_status_summary_redacted",
      "rendered_status_replacement_count",
      "rendered_status_stability_count",
      "rendered_status_last_captured_at",
      "rendered_status_next_capture_at",
      "rendered_status_error",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_fleet_workers_rendered_status_due'`
        )
        .get()
    ).toEqual({ name: "idx_fleet_workers_rendered_status_due" });
  });

  it("migration 69 binds only legacy null interrupt causes", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE fleet_workers (
        id TEXT PRIMARY KEY,
        interrupt_requested_at TEXT,
        interrupt_cause TEXT
      );
      INSERT INTO fleet_workers
        (id, interrupt_requested_at, interrupt_cause)
      VALUES
        ('legacy', '2026-08-01T12:00:00.000Z', NULL),
        ('unknown', '2026-08-01T12:00:00.000Z', 'corrupt'),
        ('unused', NULL, NULL);
      CREATE TABLE _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO _migrations (id, name)
      SELECT value, 'already-applied' FROM json_each(
        '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68]'
      );
    `);

    runMigrations(db);
    expect(
      db
        .prepare(`SELECT id, interrupt_cause FROM fleet_workers ORDER BY id`)
        .all()
    ).toEqual([
      { id: "legacy", interrupt_cause: "operator_pause" },
      { id: "unknown", interrupt_cause: "corrupt" },
      { id: "unused", interrupt_cause: null },
    ]);
    db.close();
  });

  it("migration 70 quarantines ambiguous owners and enforces one active session", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO fleet_runs (id, name, goal)
      VALUES ('run-duplicate', 'Duplicate', 'Quarantine');
      INSERT INTO sessions (id, name, tmux_name, agent_type)
      VALUES ('shared-session', 'Shared session', 'shared-session', 'codex');
      INSERT INTO fleet_tasks
        (id, fleet_run_id, title, status, task_type, sort_order,
         file_claims_json, approval_state)
      VALUES
        ('task-a', 'run-duplicate', 'A', 'running', 'task', 1, '[]', 'approved'),
        ('task-b', 'run-duplicate', 'B', 'running', 'task', 2, '[]', 'approved');
      INSERT INTO fleet_workers
        (id, fleet_run_id, task_id, session_id, status, provider, attempt)
      VALUES
        ('worker-a', 'run-duplicate', 'task-a', 'shared-session', 'running', 'codex', 1),
        ('worker-b', 'run-duplicate', 'task-b', 'shared-session', 'waiting_for_operator', 'codex', 1);
      INSERT INTO _migrations (id, name)
      SELECT value, 'already-applied' FROM json_each(
        '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69]'
      );
    `);

    runMigrations(db);
    expect(
      db
        .prepare(`SELECT status, terminal_cause FROM fleet_workers ORDER BY id`)
        .all()
    ).toEqual([
      {
        status: "cleanup_pending",
        terminal_cause: "duplicate_active_session_binding",
      },
      {
        status: "cleanup_pending",
        terminal_cause: "duplicate_active_session_binding",
      },
    ]);
    expect(
      db
        .prepare(`SELECT status, failure_code FROM fleet_tasks ORDER BY id`)
        .all()
    ).toEqual([
      {
        status: "needs_inspection",
        failure_code: "duplicate_active_session_binding",
      },
      {
        status: "needs_inspection",
        failure_code: "duplicate_active_session_binding",
      },
    ]);
    db.prepare(
      `INSERT INTO sessions (id, name, tmux_name, agent_type)
       VALUES ('unique-session', 'Unique session', 'unique-session', 'codex')`
    ).run();
    db.prepare(
      `INSERT INTO fleet_workers
       (id, fleet_run_id, session_id, status, provider, attempt)
       VALUES ('worker-c', 'run-duplicate', 'unique-session', 'running', 'codex', 1)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO fleet_workers
         (id, fleet_run_id, session_id, status, provider, attempt)
         VALUES ('worker-d', 'run-duplicate', 'unique-session', 'running', 'codex', 1)`
        )
        .run()
    ).toThrow(/UNIQUE/);
    db.close();
  });

  it("migration 71 backfills cumulative durable bytes without double charging", () => {
    const db = new Database(":memory:");
    createSchema(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO fleet_runs (id, name, goal)
      VALUES ('run-usage', 'Usage', 'Backfill');
      INSERT INTO fleet_events
        (fleet_run_id, event_type, actor, payload)
      VALUES ('run-usage', 'event', 'actor', 'payload');
      INSERT INTO fleet_artifacts
        (id, fleet_run_id, artifact_type, title, body, severity, actor,
         metadata_json, byte_count)
      VALUES ('artifact-usage', 'run-usage', 'report', 'title', 'body',
              'info', 'worker', '{}', 4);
      INSERT INTO fleet_resource_usage_buckets
        (fleet_run_id, resource_type, resource_key, bucket_start_ms, units)
      VALUES ('run-usage', 'event_bytes_total', 'fleet', 0, 1);
      INSERT INTO _migrations (id, name)
      SELECT value, 'already-applied' FROM json_each(
        '[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66,67,68,69,70]'
      );
    `);

    runMigrations(db);
    expect(
      db
        .prepare(
          `SELECT resource_type, units FROM fleet_resource_usage_buckets
           WHERE fleet_run_id = 'run-usage' AND bucket_start_ms = 0
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "artifact_bytes_total", units: 11 },
      { resource_type: "event_bytes_total", units: 17 },
    ]);
    runMigrations(db);
    expect(
      db
        .prepare(
          `SELECT resource_type, units FROM fleet_resource_usage_buckets
           WHERE fleet_run_id = 'run-usage' AND bucket_start_ms = 0
           ORDER BY resource_type`
        )
        .all()
    ).toEqual([
      { resource_type: "artifact_bytes_total", units: 11 },
      { resource_type: "event_bytes_total", units: 17 },
    ]);
    db.close();
  });

  it("fresh schema persists actual provider and model for every auxiliary session", () => {
    const db = new Database(":memory:");
    createSchema(db);

    expectColumns(db, "fleet_cost_accounts", [
      "interrupt_requested_at",
      "interrupt_deadline_at",
      "interrupt_notice_state",
      "interrupt_stop_state",
      "interrupt_cause",
    ]);

    for (const table of [
      "fleet_reviews",
      "fleet_task_reviews",
      "fleet_task_fixes",
    ]) {
      expectColumns(db, table, [
        "provider",
        "model",
        "launch_failure_count",
        "retry_not_before",
      ]);
    }
    db.close();
  });

  it("migration 72 adds and backfills auxiliary provider bindings from reservations", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 71);
    db.exec(`
      CREATE TABLE fleet_reviews (
        id TEXT PRIMARY KEY, fleet_run_id TEXT, request_id TEXT,
        reviewer_session_id TEXT
      );
      CREATE TABLE fleet_task_reviews (
        id TEXT PRIMARY KEY, fleet_run_id TEXT, request_id TEXT,
        reviewer_session_id TEXT
      );
      CREATE TABLE fleet_task_fixes (
        id TEXT PRIMARY KEY, fleet_run_id TEXT, request_id TEXT,
        fixer_session_id TEXT
      );
      CREATE TABLE fleet_cost_accounts (
        fleet_run_id TEXT, owner_type TEXT, owner_id TEXT,
        provider TEXT, model TEXT
      );
      INSERT INTO fleet_reviews
        (id, fleet_run_id, request_id, reviewer_session_id)
      VALUES ('plan-review', 'run-1', 'plan-request', '');
      INSERT INTO fleet_task_reviews
        (id, fleet_run_id, request_id, reviewer_session_id)
      VALUES ('task-review', 'run-1', 'review-request', '');
      INSERT INTO fleet_task_fixes
        (id, fleet_run_id, request_id, fixer_session_id)
      VALUES ('task-fix', 'run-1', 'fix-request', '');
      INSERT INTO fleet_cost_accounts
        (fleet_run_id, owner_type, owner_id, provider, model)
      VALUES
        ('run-1', 'plan_review', 'plan-request', 'codex', 'gpt-5.5'),
        ('run-1', 'task_review', 'review-request', 'claude', 'sonnet'),
        ('run-1', 'fixer', 'fix-request', 'hermes', 'kimi-k3');
    `);

    runMigrations(db);
    for (const table of [
      "fleet_reviews",
      "fleet_task_reviews",
      "fleet_task_fixes",
    ]) {
      expectColumns(db, table, ["provider", "model"]);
    }
    expect(
      db.prepare(`SELECT provider, model FROM fleet_reviews`).get()
    ).toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(
      db.prepare(`SELECT provider, model FROM fleet_task_reviews`).get()
    ).toEqual({ provider: "claude", model: "sonnet" });
    expect(
      db.prepare(`SELECT provider, model FROM fleet_task_fixes`).get()
    ).toEqual({ provider: "hermes", model: "kimi-k3" });
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("migration 73 adds restart-safe auxiliary launch retry state", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 72);
    for (const table of [
      "fleet_reviews",
      "fleet_task_reviews",
      "fleet_task_fixes",
    ]) {
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, state TEXT)`);
    }

    runMigrations(db);
    for (const table of [
      "fleet_reviews",
      "fleet_task_reviews",
      "fleet_task_fixes",
    ]) {
      expectColumns(db, table, ["launch_failure_count", "retry_not_before"]);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND name = ?`
          )
          .get(`idx_${table}_launch_retry`)
      ).toEqual({ name: `idx_${table}_launch_retry` });
    }
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("migration 74 adds durable auxiliary cost interrupts and repairs legacy active intent", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 73);
    db.exec(`
      CREATE TABLE fleet_cost_accounts (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        terminal_at TEXT,
        reservation_released_at TEXT
      );
      CREATE TABLE fleet_runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        desired_state TEXT NOT NULL
      );
      INSERT INTO fleet_runs (id, status, desired_state) VALUES
        ('legacy-reviewing', 'reviewing', 'draft'),
        ('legacy-merging', 'merging', 'planned'),
        ('paused', 'paused', 'paused');
    `);

    runMigrations(db);
    expectColumns(db, "fleet_cost_accounts", [
      "interrupt_requested_at",
      "interrupt_deadline_at",
      "interrupt_notice_state",
      "interrupt_stop_state",
      "interrupt_cause",
    ]);
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name = 'idx_fleet_cost_accounts_interrupt'`
        )
        .get()
    ).toEqual({ name: "idx_fleet_cost_accounts_interrupt" });
    expect(
      db.prepare(`SELECT id, desired_state FROM fleet_runs ORDER BY id`).all()
    ).toEqual([
      { id: "legacy-merging", desired_state: "running" },
      { id: "legacy-reviewing", desired_state: "running" },
      { id: "paused", desired_state: "paused" },
    ]);
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("migration 75 adds durable planner risk notes with a safe legacy default", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 74);
    db.exec(`
      CREATE TABLE fleet_tasks (id TEXT PRIMARY KEY);
      INSERT INTO fleet_tasks (id) VALUES ('legacy-task');
    `);

    runMigrations(db);

    expectColumns(db, "fleet_tasks", ["risk_notes_json"]);
    expect(
      db
        .prepare(`SELECT risk_notes_json FROM fleet_tasks WHERE id = ?`)
        .get("legacy-task")
    ).toEqual({ risk_notes_json: "[]" });
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it("migration 76 atomically rolls back partial profile installation", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 75);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        session_role TEXT NOT NULL DEFAULT 'interactive'
      );
      INSERT INTO sessions (id, name, session_role)
      VALUES ('partial-internal', 'Partial internal', 'fleet_supervisor');
    `);
    const error = console.error;
    console.error = () => undefined;
    try {
      expect(() => runMigrations(db)).toThrow(
        /invalid persisted session launch profile/
      );
    } finally {
      console.error = error;
    }

    expect(hasColumn(db, "sessions", "launch_profile_json")).toBe(false);
    expect(hasColumn(db, "sessions", "launch_profile_hash")).toBe(false);
    expect(
      db.prepare(`SELECT 1 FROM _migrations WHERE id = 76`).get()
    ).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'trg_sessions_launch_profile_%'`
        )
        .all()
    ).toEqual([]);
    db.close();
  });

  it("migration 76 rejects malformed internal inserts and interactive profile smuggling", () => {
    const db = new Database(":memory:");
    createSchema(db);
    const validProfile = JSON.stringify({ role: "fleet_supervisor" });
    const validHash = createHash("sha256")
      .update(validProfile, "utf8")
      .digest("hex");
    const insert = db.prepare(
      `INSERT INTO sessions
       (id, name, session_role, launch_profile_json, launch_profile_hash)
       VALUES (?, ?, ?, ?, ?)`
    );

    for (const [id, role, profile, hash] of [
      ["missing", "fleet_supervisor", null, null],
      ["invalid-json", "fleet_supervisor", "not-json", validHash],
      ["wrong-role", "fleet_supervisor", '{"role":"other"}', validHash],
      ["short-hash", "fleet_supervisor", validProfile, "abc"],
      ["smuggled", "interactive", validProfile, validHash],
    ] as const) {
      expect(() => insert.run(id, id, role, profile, hash), id).toThrow(
        /invalid session launch profile/
      );
    }

    expect(() =>
      insert.run(
        "valid-internal",
        "Valid internal",
        "fleet_supervisor",
        validProfile,
        validHash
      )
    ).not.toThrow();
    expect(() =>
      insert.run(
        "valid-interactive",
        "Valid interactive",
        "interactive",
        null,
        null
      )
    ).not.toThrow();
    db.close();
  });

  it("migration 76 repairs and replays both profile triggers idempotently", () => {
    const db = new Database(":memory:");
    createSchema(db);
    markAppliedThrough(db, 75);

    runMigrations(db);
    db.exec(`
      DELETE FROM _migrations WHERE id = 76;
      DROP TRIGGER trg_sessions_launch_profile_insert_valid;
    `);
    expect(() => runMigrations(db)).not.toThrow();

    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name LIKE 'trg_sessions_launch_profile_%'
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: "trg_sessions_launch_profile_immutable" },
      { name: "trg_sessions_launch_profile_insert_valid" },
    ]);
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM _migrations WHERE id = 76`)
        .get()
    ).toEqual({ count: 1 });
    db.close();
  });

  it("migration 77 adds and idempotently repairs durable Fleet fairness cursors", () => {
    const db = new Database(":memory:");
    markAppliedThrough(db, 76);
    db.exec(`
      CREATE TABLE fleet_runs (id TEXT PRIMARY KEY);
      CREATE TABLE fleet_cost_accounts (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        terminal_at TEXT,
        session_id TEXT
      );
      INSERT INTO fleet_runs (id) VALUES ('legacy-run');
      INSERT INTO fleet_cost_accounts
        (id, owner_type, terminal_at, session_id)
      VALUES ('legacy-account', 'supervisor', NULL, 'legacy-session');
    `);

    runMigrations(db);

    expectColumns(db, "fleet_runs", ["managed_supervisor_poll_cursor"]);
    expectColumns(db, "fleet_cost_accounts", [
      "sample_attempt_cursor",
      "fallback_recovery_cursor",
    ]);
    expect(
      db
        .prepare(
          `SELECT managed_supervisor_poll_cursor FROM fleet_runs
           WHERE id = 'legacy-run'`
        )
        .get()
    ).toEqual({ managed_supervisor_poll_cursor: 0 });
    expect(
      db
        .prepare(
          `SELECT sample_attempt_cursor, fallback_recovery_cursor
           FROM fleet_cost_accounts WHERE id = 'legacy-account'`
        )
        .get()
    ).toEqual({ sample_attempt_cursor: 0, fallback_recovery_cursor: 0 });
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE '%_cursor'
           ORDER BY name`
        )
        .all()
    ).toEqual([
      { name: "idx_fleet_cost_accounts_fallback_recovery_cursor" },
      { name: "idx_fleet_cost_accounts_sample_attempt_cursor" },
      { name: "idx_fleet_runs_supervisor_poll_cursor" },
    ]);

    db.exec(`
      DELETE FROM _migrations WHERE id = 77;
      DROP INDEX idx_fleet_cost_accounts_sample_attempt_cursor;
    `);
    expect(() => runMigrations(db)).not.toThrow();
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM _migrations WHERE id = 77`)
        .get()
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          `SELECT 1 AS present FROM sqlite_master
           WHERE type = 'index'
             AND name = 'idx_fleet_cost_accounts_sample_attempt_cursor'`
        )
        .get()
    ).toEqual({ present: 1 });
    db.close();
  });
});
