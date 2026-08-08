import type Database from "better-sqlite3";
import { ensureSessionLaunchProfileSchema } from "./session-launch-profile-schema";
import { ensureFleetSessionOwnershipSchema } from "./fleet-session-ownership-schema";
import { ensureFleetOwnedSessionRoleSchema } from "./fleet-session-role-schema";
import { ensureFleetMergeProvenanceSchema } from "./fleet-merge-provenance-schema";
import { ensureSessionDeletionClaimSchema } from "./session-deletion-claim-schema";

const SAFE_FLEET_AUTOMATION_POLICY_JSON =
  '{"version":1,"automaticPlanning":false,"automaticPlanApproval":false,"automaticStart":false,"automaticFixes":false,"maxAutomaticFixRounds":0,"automaticMerge":false,"mergeTarget":"github_pr","allowSensitivePaths":false,"allowUnconfinedAgents":false,"plannerTaskCap":8,"cleanupPolicy":"preserve","retentionDays":null}';

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

function hasTable(db: Database.Database, table: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .all(table) as { name: string }[];
  return rows.length > 0;
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: { name: string; ddl: string }
): void {
  if (hasTable(db, table) && !hasColumn(db, table, column.name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
  }
}

function ensureFleetRunApprovalColumns(db: Database.Database): void {
  if (!hasTable(db, "fleet_runs")) return;
  for (const column of [
    { name: "plan_hash", ddl: "plan_hash TEXT" },
    { name: "approved_plan_hash", ddl: "approved_plan_hash TEXT" },
    { name: "approved_by", ddl: "approved_by TEXT" },
    { name: "approved_at", ddl: "approved_at TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_runs", column);
  }
}

function ensureFleetArtifactRuntimeColumns(db: Database.Database): void {
  if (!hasTable(db, "fleet_artifacts")) return;
  for (const column of [
    { name: "id", ddl: "id TEXT" },
    { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
    { name: "task_id", ddl: "task_id TEXT" },
    { name: "plan_hash", ddl: "plan_hash TEXT" },
    {
      name: "artifact_type",
      ddl: "artifact_type TEXT NOT NULL DEFAULT 'critic_finding'",
    },
    { name: "title", ddl: "title TEXT NOT NULL DEFAULT ''" },
    { name: "body", ddl: "body TEXT NOT NULL DEFAULT ''" },
    { name: "severity", ddl: "severity TEXT NOT NULL DEFAULT 'warning'" },
    { name: "actor", ddl: "actor TEXT NOT NULL DEFAULT 'critic'" },
    { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
  ]) {
    addColumnIfMissing(db, "fleet_artifacts", column);
  }
  db.exec(`
    UPDATE fleet_artifacts
    SET created_at = datetime('now')
    WHERE created_at IS NULL OR created_at = ''
  `);
}

function ensureFleetSchedulerSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      {
        name: "conductor_session_id",
        ddl: "conductor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL",
      },
      {
        name: "scheduler_epoch",
        ddl: "scheduler_epoch INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "recovery_required",
        ddl: "recovery_required INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "reserved_budget_usd",
        ddl: "reserved_budget_usd REAL NOT NULL DEFAULT 0",
      },
      {
        name: "spent_budget_usd",
        ddl: "spent_budget_usd REAL NOT NULL DEFAULT 0",
      },
      { name: "pause_mode", ddl: "pause_mode TEXT" },
      { name: "pause_reason", ddl: "pause_reason TEXT" },
      { name: "cancel_mode", ddl: "cancel_mode TEXT" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "ended_at", ddl: "ended_at TEXT" },
    ])
      addColumnIfMissing(db, "fleet_runs", column);
  }
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "priority", ddl: "priority INTEGER NOT NULL DEFAULT 0" },
      { name: "agent_type", ddl: "agent_type TEXT" },
      { name: "model", ddl: "model TEXT" },
      { name: "working_directory", ddl: "working_directory TEXT" },
      { name: "base_branch", ddl: "base_branch TEXT" },
      { name: "branch_name", ddl: "branch_name TEXT" },
      { name: "worktree_path", ddl: "worktree_path TEXT" },
      { name: "max_attempts", ddl: "max_attempts INTEGER NOT NULL DEFAULT 2" },
      {
        name: "current_attempt",
        ddl: "current_attempt INTEGER NOT NULL DEFAULT 0",
      },
      { name: "lease_owner", ddl: "lease_owner TEXT" },
      { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
      {
        name: "scheduler_epoch",
        ddl: "scheduler_epoch INTEGER NOT NULL DEFAULT 0",
      },
      { name: "spawn_request_id", ddl: "spawn_request_id TEXT" },
      { name: "acceptance_criteria", ddl: "acceptance_criteria TEXT" },
      {
        name: "risk_notes_json",
        ddl: "risk_notes_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "verify_command", ddl: "verify_command TEXT" },
      { name: "approved_task_hash", ddl: "approved_task_hash TEXT" },
      {
        name: "approval_state",
        ddl: "approval_state TEXT NOT NULL DEFAULT 'draft'",
      },
      { name: "failure_code", ddl: "failure_code TEXT" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "ended_at", ddl: "ended_at TEXT" },
    ])
      addColumnIfMissing(db, "fleet_tasks", column);
  }
  if (hasTable(db, "fleet_workers")) {
    for (const column of [
      { name: "spawn_request_id", ddl: "spawn_request_id TEXT" },
      { name: "worktree_path", ddl: "worktree_path TEXT" },
      { name: "lease_owner", ddl: "lease_owner TEXT" },
      { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
      {
        name: "reservation_usd",
        ddl: "reservation_usd REAL NOT NULL DEFAULT 0",
      },
      { name: "terminal_cause", ddl: "terminal_cause TEXT" },
      { name: "failure_code", ddl: "failure_code TEXT" },
    ])
      addColumnIfMissing(db, "fleet_workers", column);
  }

  if (hasTable(db, "fleet_runs") && hasTable(db, "fleet_tasks")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_task_dependencies (
      id TEXT PRIMARY KEY, fleet_run_id TEXT NOT NULL, task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL, dependency_type TEXT NOT NULL DEFAULT 'blocks',
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
      UNIQUE (fleet_run_id, task_id, depends_on_task_id, dependency_type)
    );
    CREATE TABLE IF NOT EXISTS fleet_task_claims (
      id TEXT PRIMARY KEY, fleet_run_id TEXT NOT NULL, task_id TEXT NOT NULL,
      path TEXT NOT NULL, claim_type TEXT NOT NULL DEFAULT 'exclusive',
      confidence REAL NOT NULL DEFAULT 1.0,
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_schedule ON fleet_tasks(fleet_run_id, status, priority DESC, sort_order);
    CREATE INDEX IF NOT EXISTS idx_fleet_dependencies_task ON fleet_task_dependencies(fleet_run_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_dependencies_upstream ON fleet_task_dependencies(fleet_run_id, depends_on_task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_claims_path ON fleet_task_claims(fleet_run_id, path);
    `);
  }
  if (hasTable(db, "fleet_workers")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_resource_leases (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        units INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'reserved',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        released_at TEXT,
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_fleet_workers_status ON fleet_workers(fleet_run_id, status);
      CREATE INDEX IF NOT EXISTS idx_fleet_workers_session ON fleet_workers(session_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_spawn_request ON fleet_workers(spawn_request_id) WHERE spawn_request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_one_active_task
        ON fleet_workers(fleet_run_id, task_id)
        WHERE status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending');
      CREATE INDEX IF NOT EXISTS idx_fleet_resource_leases_active ON fleet_resource_leases(resource_type, resource_key, status);
      CREATE INDEX IF NOT EXISTS idx_fleet_resource_leases_worker ON fleet_resource_leases(worker_id, status);
    `);
  }
}

function ensureFleetReportRuntimeSchema(db: Database.Database): void {
  // A database can be marked through an older migration while still carrying
  // a partially-created artifacts table. Repair the prerequisite columns
  // before creating the runtime's artifact-type index.
  ensureFleetArtifactRuntimeColumns(db);
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "base_sha", ddl: "base_sha TEXT" },
      { name: "head_sha", ddl: "head_sha TEXT" },
      {
        name: "actual_file_claims_json",
        ddl: "actual_file_claims_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "report_artifact_id", ddl: "report_artifact_id TEXT" },
      { name: "diff_artifact_id", ddl: "diff_artifact_id TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }
  if (hasTable(db, "fleet_workers")) {
    for (const column of [
      { name: "branch_name", ddl: "branch_name TEXT" },
      { name: "base_sha", ddl: "base_sha TEXT" },
      { name: "head_sha", ddl: "head_sha TEXT" },
      { name: "report_path", ddl: "report_path TEXT" },
      { name: "report_nonce_hash", ddl: "report_nonce_hash TEXT" },
      {
        name: "report_state",
        ddl: "report_state TEXT NOT NULL DEFAULT 'legacy'",
      },
      { name: "report_status", ddl: "report_status TEXT" },
      { name: "report_submitted_at", ddl: "report_submitted_at TEXT" },
      { name: "report_collected_at", ddl: "report_collected_at TEXT" },
      {
        name: "report_bytes",
        ddl: "report_bytes INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "actual_claims_json",
        ddl: "actual_claims_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "diff_summary_json", ddl: "diff_summary_json TEXT" },
      {
        name: "report_poll_count",
        ddl: "report_poll_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "report_last_polled_at", ddl: "report_last_polled_at TEXT" },
      { name: "report_next_poll_at", ddl: "report_next_poll_at TEXT" },
      { name: "report_error", ddl: "report_error TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_workers", column);
    }
  }
  if (hasTable(db, "fleet_artifacts")) {
    for (const column of [
      { name: "worker_id", ddl: "worker_id TEXT" },
      { name: "attempt", ddl: "attempt INTEGER" },
      { name: "base_sha", ddl: "base_sha TEXT" },
      { name: "head_sha", ddl: "head_sha TEXT" },
      { name: "content_hash", ddl: "content_hash TEXT" },
      {
        name: "metadata_json",
        ddl: "metadata_json TEXT NOT NULL DEFAULT '{}'",
      },
      { name: "byte_count", ddl: "byte_count INTEGER NOT NULL DEFAULT 0" },
    ]) {
      addColumnIfMissing(db, "fleet_artifacts", column);
    }
  }
  if (hasTable(db, "fleet_workers")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_workers_report_poll
        ON fleet_workers(report_state, report_next_poll_at)
        WHERE report_state = 'pending'
    `);
  }
  if (hasTable(db, "fleet_artifacts")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_artifacts_worker_attempt_type
        ON fleet_artifacts(worker_id, attempt, artifact_type)
        WHERE worker_id IS NOT NULL AND attempt IS NOT NULL
    `);
  }
}

function ensureFleetVerificationSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "verification_id", ddl: "verification_id TEXT" },
      { name: "verification_status", ddl: "verification_status TEXT" },
      {
        name: "verification_spec_hash",
        ddl: "verification_spec_hash TEXT",
      },
      { name: "verified_head_sha", ddl: "verified_head_sha TEXT" },
      {
        name: "verification_artifact_id",
        ddl: "verification_artifact_id TEXT",
      },
      { name: "verification_started_at", ddl: "verification_started_at TEXT" },
      {
        name: "verification_completed_at",
        ddl: "verification_completed_at TEXT",
      },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }
  if (
    hasTable(db, "fleet_runs") &&
    hasTable(db, "fleet_tasks") &&
    hasTable(db, "fleet_workers")
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_verifications (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_id TEXT,
        attempt INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        run_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        output_artifact_id TEXT,
        output_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE SET NULL,
        UNIQUE (task_id, attempt, head_sha, spec_hash)
      )
    `);
  }
  if (!hasTable(db, "fleet_verifications")) return;
  for (const column of [
    { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
    { name: "task_id", ddl: "task_id TEXT NOT NULL DEFAULT ''" },
    { name: "worker_id", ddl: "worker_id TEXT" },
    { name: "attempt", ddl: "attempt INTEGER NOT NULL DEFAULT 1" },
    { name: "base_sha", ddl: "base_sha TEXT NOT NULL DEFAULT ''" },
    { name: "head_sha", ddl: "head_sha TEXT NOT NULL DEFAULT ''" },
    { name: "spec_hash", ddl: "spec_hash TEXT NOT NULL DEFAULT ''" },
    { name: "command", ddl: "command TEXT NOT NULL DEFAULT ''" },
    { name: "status", ddl: "status TEXT NOT NULL DEFAULT 'pending'" },
    { name: "run_count", ddl: "run_count INTEGER NOT NULL DEFAULT 0" },
    { name: "lease_owner", ddl: "lease_owner TEXT" },
    { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
    { name: "output_artifact_id", ddl: "output_artifact_id TEXT" },
    { name: "output_hash", ddl: "output_hash TEXT" },
    { name: "error", ddl: "error TEXT" },
    { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
    { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    { name: "started_at", ddl: "started_at TEXT" },
    { name: "completed_at", ddl: "completed_at TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_verifications", column);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_verifications_identity
      ON fleet_verifications(task_id, attempt, head_sha, spec_hash);
    CREATE INDEX IF NOT EXISTS idx_fleet_verifications_status
      ON fleet_verifications(status, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_verifications_task
      ON fleet_verifications(task_id, attempt, head_sha, spec_hash)
  `);
}

function ensureFleetTaskReviewSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "review_status", ddl: "review_status TEXT" },
      { name: "review_head_sha", ddl: "review_head_sha TEXT" },
      {
        name: "review_verification_hash",
        ddl: "review_verification_hash TEXT",
      },
      { name: "review_completed_at", ddl: "review_completed_at TEXT" },
      {
        name: "fix_rounds",
        ddl: "fix_rounds INTEGER NOT NULL DEFAULT 0",
      },
      { name: "active_fix_id", ddl: "active_fix_id TEXT" },
      { name: "fixer_session_id", ddl: "fixer_session_id TEXT" },
      { name: "fix_error", ddl: "fix_error TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }
  if (
    hasTable(db, "fleet_runs") &&
    hasTable(db, "fleet_tasks") &&
    hasTable(db, "fleet_workers") &&
    hasTable(db, "fleet_verifications")
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_task_reviews (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_id TEXT,
        attempt INTEGER NOT NULL,
        base_sha TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        verification_id TEXT NOT NULL,
        verification_spec_hash TEXT NOT NULL,
        verification_evidence_hash TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        lens TEXT NOT NULL,
        reviewer_session_id TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL DEFAULT 'changes_requested',
        state TEXT NOT NULL DEFAULT 'pending',
        request_id TEXT NOT NULL DEFAULT '',
        nonce_hash TEXT NOT NULL DEFAULT '',
        result_path TEXT NOT NULL DEFAULT '',
        result_verdict TEXT,
        result_bytes INTEGER,
        project_path TEXT,
        reviewer_worktree_path TEXT,
        reviewer_branch_name TEXT NOT NULL DEFAULT '',
        findings_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        started_at TEXT,
        deadline_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE SET NULL,
        FOREIGN KEY (verification_id) REFERENCES fleet_verifications(id) ON DELETE CASCADE,
        UNIQUE (
          task_id, attempt, head_sha, verification_id,
          verification_evidence_hash, policy_hash, lens
        )
      );
      CREATE TABLE IF NOT EXISTS fleet_task_fixes (
        id TEXT PRIMARY KEY,
        fleet_run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        worker_id TEXT,
        attempt INTEGER NOT NULL,
        round INTEGER NOT NULL,
        old_head_sha TEXT NOT NULL,
        new_head_sha TEXT,
        policy_hash TEXT NOT NULL,
        verification_evidence_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        request_id TEXT NOT NULL DEFAULT '',
        nonce_hash TEXT NOT NULL DEFAULT '',
        result_path TEXT NOT NULL DEFAULT '',
        fixer_session_id TEXT NOT NULL DEFAULT '',
        project_path TEXT,
        worktree_path TEXT,
        branch_name TEXT,
        findings_json TEXT NOT NULL DEFAULT '[]',
        result_bytes INTEGER,
        error TEXT,
        started_at TEXT,
        deadline_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE SET NULL,
        UNIQUE (task_id, attempt, old_head_sha, round, policy_hash)
      )
    `);
  }
  if (hasTable(db, "fleet_task_reviews")) {
    for (const column of [
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "task_id", ddl: "task_id TEXT NOT NULL DEFAULT ''" },
      { name: "worker_id", ddl: "worker_id TEXT" },
      { name: "attempt", ddl: "attempt INTEGER NOT NULL DEFAULT 1" },
      { name: "base_sha", ddl: "base_sha TEXT NOT NULL DEFAULT ''" },
      { name: "head_sha", ddl: "head_sha TEXT NOT NULL DEFAULT ''" },
      {
        name: "verification_id",
        ddl: "verification_id TEXT NOT NULL DEFAULT ''",
      },
      {
        name: "verification_spec_hash",
        ddl: "verification_spec_hash TEXT NOT NULL DEFAULT ''",
      },
      {
        name: "verification_evidence_hash",
        ddl: "verification_evidence_hash TEXT NOT NULL DEFAULT ''",
      },
      { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
      { name: "lens", ddl: "lens TEXT NOT NULL DEFAULT ''" },
      {
        name: "reviewer_session_id",
        ddl: "reviewer_session_id TEXT NOT NULL DEFAULT ''",
      },
      {
        name: "verdict",
        ddl: "verdict TEXT NOT NULL DEFAULT 'changes_requested'",
      },
      { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'pending'" },
      { name: "request_id", ddl: "request_id TEXT NOT NULL DEFAULT ''" },
      { name: "nonce_hash", ddl: "nonce_hash TEXT NOT NULL DEFAULT ''" },
      { name: "result_path", ddl: "result_path TEXT NOT NULL DEFAULT ''" },
      { name: "result_verdict", ddl: "result_verdict TEXT" },
      { name: "result_bytes", ddl: "result_bytes INTEGER" },
      { name: "project_path", ddl: "project_path TEXT" },
      { name: "reviewer_worktree_path", ddl: "reviewer_worktree_path TEXT" },
      {
        name: "reviewer_branch_name",
        ddl: "reviewer_branch_name TEXT NOT NULL DEFAULT ''",
      },
      {
        name: "findings_json",
        ddl: "findings_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "error", ddl: "error TEXT" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "deadline_at", ddl: "deadline_at TEXT" },
      { name: "completed_at", ddl: "completed_at TEXT" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_task_reviews", column);
    }
  }
  if (hasTable(db, "fleet_task_fixes")) {
    for (const column of [
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "task_id", ddl: "task_id TEXT NOT NULL DEFAULT ''" },
      { name: "worker_id", ddl: "worker_id TEXT" },
      { name: "attempt", ddl: "attempt INTEGER NOT NULL DEFAULT 1" },
      { name: "round", ddl: "round INTEGER NOT NULL DEFAULT 1" },
      { name: "old_head_sha", ddl: "old_head_sha TEXT NOT NULL DEFAULT ''" },
      { name: "new_head_sha", ddl: "new_head_sha TEXT" },
      { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
      {
        name: "verification_evidence_hash",
        ddl: "verification_evidence_hash TEXT NOT NULL DEFAULT ''",
      },
      { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'pending'" },
      { name: "request_id", ddl: "request_id TEXT NOT NULL DEFAULT ''" },
      { name: "nonce_hash", ddl: "nonce_hash TEXT NOT NULL DEFAULT ''" },
      { name: "result_path", ddl: "result_path TEXT NOT NULL DEFAULT ''" },
      {
        name: "fixer_session_id",
        ddl: "fixer_session_id TEXT NOT NULL DEFAULT ''",
      },
      { name: "project_path", ddl: "project_path TEXT" },
      { name: "worktree_path", ddl: "worktree_path TEXT" },
      { name: "branch_name", ddl: "branch_name TEXT" },
      {
        name: "findings_json",
        ddl: "findings_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "result_bytes", ddl: "result_bytes INTEGER" },
      { name: "error", ddl: "error TEXT" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "deadline_at", ddl: "deadline_at TEXT" },
      { name: "completed_at", ddl: "completed_at TEXT" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_task_fixes", column);
    }
  }
  if (hasTable(db, "fleet_task_reviews")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_task_reviews_exact_lens
        ON fleet_task_reviews(
          task_id, attempt, head_sha, verification_id,
          verification_evidence_hash, policy_hash, lens
        );
      CREATE INDEX IF NOT EXISTS idx_fleet_task_reviews_active
        ON fleet_task_reviews(state, fleet_run_id, task_id)
    `);
  }
  if (hasTable(db, "fleet_task_fixes")) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_task_fixes_round
        ON fleet_task_fixes(task_id, attempt, old_head_sha, round, policy_hash);
      CREATE INDEX IF NOT EXISTS idx_fleet_task_fixes_active
        ON fleet_task_fixes(state, fleet_run_id, task_id)
    `);
  }
}

function ensureFleetMergeRuntimeSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      { name: "merge_requested_at", ddl: "merge_requested_at TEXT" },
      { name: "merge_requested_by", ddl: "merge_requested_by TEXT" },
      { name: "merge_request_kind", ddl: "merge_request_kind TEXT" },
      { name: "merge_target", ddl: "merge_target TEXT" },
      {
        name: "integration_state",
        ddl: "integration_state TEXT NOT NULL DEFAULT 'idle'",
      },
      { name: "integration_branch", ddl: "integration_branch TEXT" },
      { name: "integration_worktree", ddl: "integration_worktree TEXT" },
      { name: "integration_base_sha", ddl: "integration_base_sha TEXT" },
      { name: "integration_head_sha", ddl: "integration_head_sha TEXT" },
      { name: "integration_pr_number", ddl: "integration_pr_number INTEGER" },
      { name: "integration_pr_url", ddl: "integration_pr_url TEXT" },
      { name: "integration_pr_head_sha", ddl: "integration_pr_head_sha TEXT" },
      { name: "integration_merge_sha", ddl: "integration_merge_sha TEXT" },
      { name: "integration_error", ddl: "integration_error TEXT" },
      { name: "integration_updated_at", ddl: "integration_updated_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_runs", column);
    }
  }
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      {
        name: "integration_state",
        ddl: "integration_state TEXT NOT NULL DEFAULT 'pending'",
      },
      {
        name: "integration_operation_id",
        ddl: "integration_operation_id TEXT",
      },
      { name: "integrated_head_sha", ddl: "integrated_head_sha TEXT" },
      { name: "integrated_at", ddl: "integrated_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }
  if (hasTable(db, "fleet_runs") && hasTable(db, "fleet_tasks")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_merge_operations (
        id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL UNIQUE,
        fleet_run_id TEXT NOT NULL,
        task_id TEXT,
        operation_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        target TEXT,
        expected_base_sha TEXT NOT NULL,
        expected_task_head_sha TEXT,
        result_head_sha TEXT,
        verification_commands_json TEXT NOT NULL DEFAULT '[]',
        verification_output_hash TEXT,
        output_artifact_id TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
        UNIQUE (fleet_run_id, task_id, operation_type, expected_base_sha, expected_task_head_sha)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_merge_operations_key
        ON fleet_merge_operations(operation_key);
      CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_queue
        ON fleet_merge_operations(state, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_run
        ON fleet_merge_operations(fleet_run_id, created_at, id);
    `);
  }
  if (hasTable(db, "fleet_merge_operations")) {
    for (const column of [
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "operation_key", ddl: "operation_key TEXT NOT NULL DEFAULT ''" },
      { name: "task_id", ddl: "task_id TEXT" },
      {
        name: "operation_type",
        ddl: "operation_type TEXT NOT NULL DEFAULT 'task_merge'",
      },
      { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'pending'" },
      { name: "target", ddl: "target TEXT" },
      {
        name: "expected_base_sha",
        ddl: "expected_base_sha TEXT NOT NULL DEFAULT ''",
      },
      { name: "expected_task_head_sha", ddl: "expected_task_head_sha TEXT" },
      { name: "result_head_sha", ddl: "result_head_sha TEXT" },
      {
        name: "verification_commands_json",
        ddl: "verification_commands_json TEXT NOT NULL DEFAULT '[]'",
      },
      {
        name: "verification_output_hash",
        ddl: "verification_output_hash TEXT",
      },
      { name: "output_artifact_id", ddl: "output_artifact_id TEXT" },
      {
        name: "attempt_count",
        ddl: "attempt_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "lease_owner", ddl: "lease_owner TEXT" },
      { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
      { name: "error", ddl: "error TEXT" },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "completed_at", ddl: "completed_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_merge_operations", column);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_merge_operations_key
        ON fleet_merge_operations(operation_key);
      CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_queue
        ON fleet_merge_operations(state, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_run
        ON fleet_merge_operations(fleet_run_id, created_at, id);
    `);
  }
}

function ensureFleetLifecycleSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      { name: "archived_at", ddl: "archived_at TEXT" },
      { name: "archived_by", ddl: "archived_by TEXT" },
      { name: "retention_days", ddl: "retention_days INTEGER" },
    ]) {
      addColumnIfMissing(db, "fleet_runs", column);
    }
  }
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "retry_not_before", ddl: "retry_not_before TEXT" },
      {
        name: "provider_failure_count",
        ddl: "provider_failure_count INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "provider_state",
        ddl: "provider_state TEXT NOT NULL DEFAULT 'ready'",
      },
      { name: "provider_last_error", ddl: "provider_last_error TEXT" },
      {
        name: "provider_backoff_event_at",
        ddl: "provider_backoff_event_at TEXT",
      },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }
  if (hasTable(db, "fleet_artifacts")) {
    addColumnIfMissing(db, "fleet_artifacts", {
      name: "body_pruned_at",
      ddl: "body_pruned_at TEXT",
    });
  }
  if (hasTable(db, "fleet_runs")) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_cleanup_actions (
        id TEXT PRIMARY KEY,
        action_key TEXT NOT NULL UNIQUE,
        fleet_run_id TEXT NOT NULL,
        worker_id TEXT,
        artifact_id TEXT,
        action_type TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        target_path TEXT,
        project_path TEXT,
        expected_content_hash TEXT,
        requested_by TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        error TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE SET NULL,
        FOREIGN KEY (artifact_id) REFERENCES fleet_artifacts(id) ON DELETE SET NULL
      )
    `);
  }
  if (!hasTable(db, "fleet_cleanup_actions")) return;
  for (const column of [
    { name: "action_key", ddl: "action_key TEXT NOT NULL DEFAULT ''" },
    { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
    { name: "worker_id", ddl: "worker_id TEXT" },
    { name: "artifact_id", ddl: "artifact_id TEXT" },
    {
      name: "action_type",
      ddl: "action_type TEXT NOT NULL DEFAULT 'delete_worktree'",
    },
    { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'pending'" },
    { name: "target_path", ddl: "target_path TEXT" },
    { name: "project_path", ddl: "project_path TEXT" },
    { name: "expected_content_hash", ddl: "expected_content_hash TEXT" },
    {
      name: "requested_by",
      ddl: "requested_by TEXT NOT NULL DEFAULT 'operator'",
    },
    { name: "attempt_count", ddl: "attempt_count INTEGER NOT NULL DEFAULT 0" },
    { name: "lease_owner", ddl: "lease_owner TEXT" },
    { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
    { name: "error", ddl: "error TEXT" },
    { name: "metadata_json", ddl: "metadata_json TEXT NOT NULL DEFAULT '{}'" },
    { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
    { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    { name: "started_at", ddl: "started_at TEXT" },
    { name: "completed_at", ddl: "completed_at TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_cleanup_actions", column);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_key
      ON fleet_cleanup_actions(action_key) WHERE action_key <> '';
    CREATE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_queue
      ON fleet_cleanup_actions(state, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_run
      ON fleet_cleanup_actions(fleet_run_id, created_at, id)
  `);
  if (
    hasTable(db, "fleet_tasks") &&
    hasColumn(db, "fleet_tasks", "fleet_run_id") &&
    hasColumn(db, "fleet_tasks", "status") &&
    hasColumn(db, "fleet_tasks", "retry_not_before")
  ) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_tasks_retry
        ON fleet_tasks(fleet_run_id, status, retry_not_before)
    `);
  }
}

/**
 * Durable, hash-only authorization for direct Fleet tools.  This schema is
 * deliberately independent of fleet_runs: a fleet:create capability reserves a
 * run id before that run exists, and audit evidence must survive run cleanup.
 *
 * Keep this repair-style (rather than create-only).  Several supported upgrade
 * paths can arrive with a partially-created table after an interrupted startup.
 */
function ensureFleetCapabilitySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_capabilities (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      run_id TEXT NOT NULL,
      task_id TEXT,
      worker_id TEXT,
      attempt INTEGER,
      bound_hash_kind TEXT,
      bound_hash_value TEXT,
      use_mode TEXT NOT NULL DEFAULT 'one_use',
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      consumed_at_ms INTEGER,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      issued_by TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS fleet_capability_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      capability_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      action TEXT NOT NULL,
      event_type TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL
    )
  `);

  for (const column of [
    { name: "token_hash", ddl: "token_hash TEXT NOT NULL DEFAULT ''" },
    { name: "version", ddl: "version INTEGER NOT NULL DEFAULT 1" },
    { name: "action", ddl: "action TEXT NOT NULL DEFAULT ''" },
    { name: "run_id", ddl: "run_id TEXT NOT NULL DEFAULT ''" },
    { name: "task_id", ddl: "task_id TEXT" },
    { name: "worker_id", ddl: "worker_id TEXT" },
    { name: "attempt", ddl: "attempt INTEGER" },
    { name: "bound_hash_kind", ddl: "bound_hash_kind TEXT" },
    { name: "bound_hash_value", ddl: "bound_hash_value TEXT" },
    { name: "use_mode", ddl: "use_mode TEXT NOT NULL DEFAULT 'one_use'" },
    { name: "issued_at_ms", ddl: "issued_at_ms INTEGER NOT NULL DEFAULT 0" },
    { name: "expires_at_ms", ddl: "expires_at_ms INTEGER NOT NULL DEFAULT 0" },
    { name: "revoked_at_ms", ddl: "revoked_at_ms INTEGER" },
    { name: "consumed_at_ms", ddl: "consumed_at_ms INTEGER" },
    { name: "lease_owner", ddl: "lease_owner TEXT" },
    { name: "lease_expires_at_ms", ddl: "lease_expires_at_ms INTEGER" },
    { name: "use_count", ddl: "use_count INTEGER NOT NULL DEFAULT 0" },
    { name: "issued_by", ddl: "issued_by TEXT NOT NULL DEFAULT 'operator'" },
    {
      name: "created_at",
      ddl: "created_at TEXT NOT NULL DEFAULT ''",
    },
    {
      name: "updated_at",
      ddl: "updated_at TEXT NOT NULL DEFAULT ''",
    },
  ]) {
    addColumnIfMissing(db, "fleet_capabilities", column);
  }

  for (const column of [
    { name: "capability_id", ddl: "capability_id TEXT NOT NULL DEFAULT ''" },
    { name: "run_id", ddl: "run_id TEXT NOT NULL DEFAULT ''" },
    { name: "action", ddl: "action TEXT NOT NULL DEFAULT ''" },
    { name: "event_type", ddl: "event_type TEXT NOT NULL DEFAULT ''" },
    { name: "scope_hash", ddl: "scope_hash TEXT NOT NULL DEFAULT ''" },
    {
      name: "metadata_json",
      ddl: "metadata_json TEXT NOT NULL DEFAULT '{}'",
    },
    { name: "created_at_ms", ddl: "created_at_ms INTEGER NOT NULL DEFAULT 0" },
  ]) {
    addColumnIfMissing(db, "fleet_capability_audit", column);
  }

  db.exec(`
    UPDATE fleet_capabilities
    SET created_at = datetime('now')
    WHERE created_at IS NULL OR created_at = '';
    UPDATE fleet_capabilities
    SET updated_at = datetime('now')
    WHERE updated_at IS NULL OR updated_at = '';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_capabilities_token_hash
      ON fleet_capabilities(token_hash);
    CREATE INDEX IF NOT EXISTS idx_fleet_capabilities_scope
      ON fleet_capabilities(run_id, action, expires_at_ms);
    CREATE INDEX IF NOT EXISTS idx_fleet_capability_audit_capability
      ON fleet_capability_audit(capability_id, id);
    CREATE INDEX IF NOT EXISTS idx_fleet_capability_audit_run
      ON fleet_capability_audit(run_id, id);

    CREATE TRIGGER IF NOT EXISTS fleet_capability_audit_no_update
    BEFORE UPDATE ON fleet_capability_audit
    BEGIN
      SELECT RAISE(ABORT, 'fleet capability audit events are immutable');
    END;
    CREATE TRIGGER IF NOT EXISTS fleet_capability_audit_no_delete
    BEFORE DELETE ON fleet_capability_audit
    BEGIN
      SELECT RAISE(ABORT, 'fleet capability audit events are immutable');
    END
  `);
}

function ensureFleetAutomationSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_runs")) return;
  for (const column of [
    {
      name: "desired_state",
      ddl: "desired_state TEXT NOT NULL DEFAULT 'draft'",
    },
    {
      name: "automation_policy_version",
      ddl: "automation_policy_version INTEGER NOT NULL DEFAULT 1",
    },
    {
      name: "automation_policy_json",
      ddl: `automation_policy_json TEXT NOT NULL DEFAULT '${SAFE_FLEET_AUTOMATION_POLICY_JSON}'`,
    },
    { name: "automation_policy_hash", ddl: "automation_policy_hash TEXT" },
    { name: "automation_granted_by", ddl: "automation_granted_by TEXT" },
    { name: "automation_granted_at", ddl: "automation_granted_at TEXT" },
    { name: "automation_base_sha", ddl: "automation_base_sha TEXT" },
    { name: "automation_last_error", ddl: "automation_last_error TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_runs", column);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_action_authorizations (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'authorized',
      policy_hash TEXT NOT NULL,
      plan_hash TEXT,
      execution_hash TEXT,
      base_sha TEXT,
      granted_by TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      consumed_by TEXT,
      consumed_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      UNIQUE (fleet_run_id, action, policy_hash)
    );
    CREATE TABLE IF NOT EXISTS fleet_reviews (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      subject_type TEXT NOT NULL DEFAULT 'plan',
      subject_hash TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      execution_hash TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      lens TEXT NOT NULL,
      reviewer_session_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'changes_requested',
      request_id TEXT NOT NULL DEFAULT '',
      nonce_hash TEXT NOT NULL DEFAULT '',
      result_filename TEXT NOT NULL DEFAULT '',
      result_verdict TEXT,
      result_bytes INTEGER,
      project_path TEXT,
      worktree_path TEXT,
      branch_name TEXT NOT NULL DEFAULT '',
      findings_json TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      started_at TEXT,
      deadline_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      UNIQUE (
        fleet_run_id,
        subject_type,
        subject_hash,
        policy_hash,
        execution_hash,
        base_sha,
        lens
      )
    );
  `);

  for (const column of [
    { name: "id", ddl: "id TEXT" },
    { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
    { name: "action", ddl: "action TEXT NOT NULL DEFAULT 'planning'" },
    { name: "status", ddl: "status TEXT NOT NULL DEFAULT 'authorized'" },
    { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
    { name: "plan_hash", ddl: "plan_hash TEXT" },
    { name: "execution_hash", ddl: "execution_hash TEXT" },
    { name: "base_sha", ddl: "base_sha TEXT" },
    { name: "granted_by", ddl: "granted_by TEXT NOT NULL DEFAULT 'operator'" },
    { name: "granted_at", ddl: "granted_at TEXT NOT NULL DEFAULT ''" },
    { name: "consumed_by", ddl: "consumed_by TEXT" },
    { name: "consumed_at", ddl: "consumed_at TEXT" },
    { name: "attempt_count", ddl: "attempt_count INTEGER NOT NULL DEFAULT 0" },
    { name: "last_error", ddl: "last_error TEXT" },
    { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
  ]) {
    addColumnIfMissing(db, "fleet_action_authorizations", column);
  }
  for (const column of [
    { name: "id", ddl: "id TEXT" },
    { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
    { name: "subject_type", ddl: "subject_type TEXT NOT NULL DEFAULT 'plan'" },
    { name: "subject_hash", ddl: "subject_hash TEXT NOT NULL DEFAULT ''" },
    { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
    { name: "execution_hash", ddl: "execution_hash TEXT NOT NULL DEFAULT ''" },
    { name: "base_sha", ddl: "base_sha TEXT NOT NULL DEFAULT ''" },
    { name: "lens", ddl: "lens TEXT NOT NULL DEFAULT ''" },
    {
      name: "reviewer_session_id",
      ddl: "reviewer_session_id TEXT NOT NULL DEFAULT ''",
    },
    {
      name: "verdict",
      ddl: "verdict TEXT NOT NULL DEFAULT 'changes_requested'",
    },
    { name: "state", ddl: "state TEXT NOT NULL DEFAULT 'changes_requested'" },
    { name: "request_id", ddl: "request_id TEXT NOT NULL DEFAULT ''" },
    { name: "nonce_hash", ddl: "nonce_hash TEXT NOT NULL DEFAULT ''" },
    {
      name: "result_filename",
      ddl: "result_filename TEXT NOT NULL DEFAULT ''",
    },
    { name: "result_verdict", ddl: "result_verdict TEXT" },
    { name: "result_bytes", ddl: "result_bytes INTEGER" },
    { name: "project_path", ddl: "project_path TEXT" },
    { name: "worktree_path", ddl: "worktree_path TEXT" },
    { name: "branch_name", ddl: "branch_name TEXT NOT NULL DEFAULT ''" },
    { name: "findings_json", ddl: "findings_json TEXT NOT NULL DEFAULT '[]'" },
    { name: "error", ddl: "error TEXT" },
    { name: "started_at", ddl: "started_at TEXT" },
    { name: "deadline_at", ddl: "deadline_at TEXT" },
    { name: "completed_at", ddl: "completed_at TEXT" },
    { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
  ]) {
    addColumnIfMissing(db, "fleet_reviews", column);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fleet_action_authorizations_run
      ON fleet_action_authorizations(fleet_run_id, action, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_action_authorizations_unique
      ON fleet_action_authorizations(fleet_run_id, action, policy_hash);
    CREATE INDEX IF NOT EXISTS idx_fleet_reviews_subject
      ON fleet_reviews(fleet_run_id, subject_type, subject_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_reviews_exact_lens
      ON fleet_reviews(
        fleet_run_id,
        subject_type,
        subject_hash,
        policy_hash,
        execution_hash,
        base_sha,
        lens
      );
  `);
}

function ensureFleetSourceLineageSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      { name: "source_kind", ddl: "source_kind TEXT" },
      { name: "source_id", ddl: "source_id TEXT" },
      { name: "source_name", ddl: "source_name TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_runs", column);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_runs_source
        ON fleet_runs(source_kind, source_id)
    `);
  }
  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "source_ref", ddl: "source_ref TEXT" },
      { name: "source_step_id", ddl: "source_step_id TEXT" },
      { name: "source_issue_id", ddl: "source_issue_id TEXT" },
      { name: "source_issue_number", ddl: "source_issue_number INTEGER" },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
    if (hasColumn(db, "fleet_tasks", "fleet_run_id")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fleet_tasks_source
          ON fleet_tasks(fleet_run_id, source_step_id)
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_tasks_source_issue
        ON fleet_tasks(source_issue_id)
        WHERE source_issue_id IS NOT NULL
    `);
  }
}

function ensureFleetCostResourceSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      { name: "budget_tokens", ddl: "budget_tokens INTEGER" },
      {
        name: "reserved_budget_tokens",
        ddl: "reserved_budget_tokens INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "spent_budget_tokens",
        ddl: "spent_budget_tokens INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "cost_confidence",
        ddl: "cost_confidence TEXT NOT NULL DEFAULT 'unknown'",
      },
      {
        name: "budget_stop_mode",
        ddl: "budget_stop_mode TEXT NOT NULL DEFAULT 'pause-new'",
      },
      {
        name: "budget_warning_threshold",
        ddl: "budget_warning_threshold REAL NOT NULL DEFAULT 0.8",
      },
      {
        name: "budget_warning_emitted_at",
        ddl: "budget_warning_emitted_at TEXT",
      },
      { name: "budget_hard_limit_at", ddl: "budget_hard_limit_at TEXT" },
      {
        name: "budget_interrupt_deadline_at",
        ddl: "budget_interrupt_deadline_at TEXT",
      },
      {
        name: "provider_caps_json",
        ddl: "provider_caps_json TEXT NOT NULL DEFAULT '{}'",
      },
      {
        name: "resource_limits_json",
        ddl: "resource_limits_json TEXT NOT NULL DEFAULT '{}'",
      },
      {
        name: "default_max_attempts",
        ddl: "default_max_attempts INTEGER NOT NULL DEFAULT 2",
      },
    ]) {
      addColumnIfMissing(db, "fleet_runs", column);
    }
  }
  if (hasTable(db, "fleet_workers")) {
    for (const column of [
      {
        name: "reservation_tokens",
        ddl: "reservation_tokens INTEGER NOT NULL DEFAULT 0",
      },
      {
        name: "reservation_confidence",
        ddl: "reservation_confidence TEXT NOT NULL DEFAULT 'unknown'",
      },
      { name: "reservation_basis", ddl: "reservation_basis TEXT" },
      { name: "actual_cost_usd", ddl: "actual_cost_usd REAL" },
      { name: "actual_tokens", ddl: "actual_tokens INTEGER" },
      {
        name: "cost_confidence",
        ddl: "cost_confidence TEXT NOT NULL DEFAULT 'unknown'",
      },
      { name: "cost_reconciled_at", ddl: "cost_reconciled_at TEXT" },
      { name: "interrupt_requested_at", ddl: "interrupt_requested_at TEXT" },
      { name: "interrupt_deadline_at", ddl: "interrupt_deadline_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_workers", column);
    }
  }
  if (!hasTable(db, "fleet_runs")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_cost_accounts (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      session_id TEXT,
      session_key TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      task_id TEXT,
      provider TEXT NOT NULL,
      model TEXT,
      reservation_usd REAL NOT NULL DEFAULT 0,
      reservation_tokens INTEGER NOT NULL DEFAULT 0,
      reservation_confidence TEXT NOT NULL DEFAULT 'unknown',
      reservation_basis TEXT,
      reservation_released_at TEXT,
      peak_input_tokens INTEGER NOT NULL DEFAULT 0,
      peak_output_tokens INTEGER NOT NULL DEFAULT 0,
      peak_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      peak_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      observed_cost_usd REAL,
      fallback_cost_usd REAL NOT NULL DEFAULT 0,
      charged_cost_usd REAL NOT NULL DEFAULT 0,
      fallback_tokens INTEGER NOT NULL DEFAULT 0,
      charged_tokens INTEGER NOT NULL DEFAULT 0,
      confidence TEXT NOT NULL DEFAULT 'unknown',
      last_sample_day TEXT,
      last_sample_at TEXT,
      terminal_at TEXT,
      interrupt_requested_at TEXT,
      interrupt_deadline_at TEXT,
      interrupt_notice_state TEXT NOT NULL DEFAULT 'unattempted',
      interrupt_stop_state TEXT NOT NULL DEFAULT 'unattempted',
      interrupt_cause TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      UNIQUE (fleet_run_id, owner_type, owner_id)
    );

    CREATE TABLE IF NOT EXISTS fleet_runtime_leases (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      units INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      lease_expires_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT,
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fleet_resource_usage_buckets (
      fleet_run_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      bucket_start_ms INTEGER NOT NULL,
      units INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (fleet_run_id, resource_type, resource_key, bucket_start_ms),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fleet_provider_cooldowns (
      provider TEXT PRIMARY KEY,
      blocked_until TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 1,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_cost_accounts_session
      ON fleet_cost_accounts(fleet_run_id, session_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_history
      ON fleet_cost_accounts(provider, model, task_id, terminal_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_runtime_leases_owner_resource
      ON fleet_runtime_leases(owner_type, owner_id, resource_type, resource_key)
      WHERE status = 'reserved';
    CREATE INDEX IF NOT EXISTS idx_fleet_runtime_leases_active
      ON fleet_runtime_leases(resource_type, resource_key, status, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_runtime_leases_run
      ON fleet_runtime_leases(fleet_run_id, status, owner_type, owner_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_resource_usage_bucket_time
      ON fleet_resource_usage_buckets(bucket_start_ms, fleet_run_id, resource_type, resource_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_provider_cooldowns_until
      ON fleet_provider_cooldowns(blocked_until, provider)
  `);
  for (const column of [
    {
      name: "reservation_usd",
      ddl: "reservation_usd REAL NOT NULL DEFAULT 0",
    },
    {
      name: "reservation_tokens",
      ddl: "reservation_tokens INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "reservation_confidence",
      ddl: "reservation_confidence TEXT NOT NULL DEFAULT 'unknown'",
    },
    { name: "reservation_basis", ddl: "reservation_basis TEXT" },
    { name: "reservation_released_at", ddl: "reservation_released_at TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_cost_accounts", column);
  }
}

function ensureFleetResourceUsageScopeSchema(db: Database.Database): void {
  db.transaction(() => {
    if (!hasTable(db, "fleet_resource_usage_buckets")) {
      ensureFleetCostResourceSchema(db);
    }
    if (!hasTable(db, "fleet_resource_usage_buckets")) return;

    if (hasColumn(db, "fleet_resource_usage_buckets", "fleet_run_id")) {
      // Recover a pre-fix migration that crashed after replacing the table but
      // before recreating its index (and discard any abandoned legacy table).
      db.exec(`
        DROP TABLE IF EXISTS fleet_resource_usage_buckets_unscoped;
        CREATE INDEX IF NOT EXISTS idx_fleet_resource_usage_bucket_time
          ON fleet_resource_usage_buckets(
            bucket_start_ms, fleet_run_id, resource_type, resource_key
          );
      `);
      return;
    }

    // Minute buckets are transient admission counters. An unscoped legacy
    // bucket cannot be attributed safely to a run, so replace it instead of
    // guessing and accidentally charging one run for another run's allowance.
    // The transaction makes the table swap atomic for new installations; the
    // guards above repair every intermediate state left by the old migration.
    db.exec(`
      DROP INDEX IF EXISTS idx_fleet_resource_usage_bucket_time;
      DROP TABLE IF EXISTS fleet_resource_usage_buckets_unscoped;
      ALTER TABLE fleet_resource_usage_buckets
        RENAME TO fleet_resource_usage_buckets_unscoped;
      CREATE TABLE fleet_resource_usage_buckets (
        fleet_run_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        bucket_start_ms INTEGER NOT NULL,
        units INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (fleet_run_id, resource_type, resource_key, bucket_start_ms),
        FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
      );
      DROP TABLE fleet_resource_usage_buckets_unscoped;
      CREATE INDEX IF NOT EXISTS idx_fleet_resource_usage_bucket_time
        ON fleet_resource_usage_buckets(
          bucket_start_ms, fleet_run_id, resource_type, resource_key
        );
    `);
  })();
}

function ensureFleetStatusAndInterruptSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_workers")) return;
  for (const column of [
    {
      name: "interrupt_notice_state",
      ddl: "interrupt_notice_state TEXT NOT NULL DEFAULT 'unattempted'",
    },
    {
      name: "interrupt_stop_state",
      ddl: "interrupt_stop_state TEXT NOT NULL DEFAULT 'unattempted'",
    },
    { name: "interrupt_cause", ddl: "interrupt_cause TEXT" },
    { name: "rendered_status", ddl: "rendered_status TEXT" },
    { name: "rendered_status_summary", ddl: "rendered_status_summary TEXT" },
    {
      name: "rendered_status_summary_redacted",
      ddl: "rendered_status_summary_redacted INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "rendered_status_replacement_count",
      ddl: "rendered_status_replacement_count INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "rendered_status_stability_count",
      ddl: "rendered_status_stability_count INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "rendered_status_last_captured_at",
      ddl: "rendered_status_last_captured_at TEXT",
    },
    {
      name: "rendered_status_next_capture_at",
      ddl: "rendered_status_next_capture_at TEXT",
    },
    { name: "rendered_status_error", ddl: "rendered_status_error TEXT" },
  ]) {
    addColumnIfMissing(db, "fleet_workers", column);
  }
  if (
    hasColumn(db, "fleet_workers", "id") &&
    hasColumn(db, "fleet_workers", "status")
  ) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_workers_rendered_status_due
        ON fleet_workers(status, rendered_status_next_capture_at, id)
    `);
  }
}

function backfillFleetInterruptCause(db: Database.Database): void {
  if (
    !hasTable(db, "fleet_workers") ||
    !hasColumn(db, "fleet_workers", "interrupt_requested_at") ||
    !hasColumn(db, "fleet_workers", "interrupt_cause")
  ) {
    return;
  }
  // Interrupt requests pre-dating the explicit cause field could only have
  // come from the operator pause path. Bind that one legacy case once; unknown
  // non-null values remain untouched so the runtime can fail closed on them.
  db.prepare(
    `UPDATE fleet_workers SET interrupt_cause = 'operator_pause'
     WHERE interrupt_requested_at IS NOT NULL AND interrupt_cause IS NULL`
  ).run();
}

function ensureFleetActiveSessionOwnership(db: Database.Database): void {
  const required = [
    "id",
    "session_id",
    "status",
    "task_id",
    "terminal_cause",
    "failure_code",
  ];
  if (
    !hasTable(db, "fleet_workers") ||
    required.some((column) => !hasColumn(db, "fleet_workers", column))
  ) {
    return;
  }
  // A pre-existing duplicate has no safe winner. Quarantine every claimant
  // without deleting its session binding, so operator cleanup retains exact
  // evidence and no message/stop side effect can target an ambiguous owner.
  if (hasTable(db, "fleet_tasks") && hasColumn(db, "fleet_tasks", "status")) {
    db.exec(`
      UPDATE fleet_tasks SET status = 'needs_inspection',
        failure_code = 'duplicate_active_session_binding'
      WHERE id IN (
        SELECT task_id FROM fleet_workers
        WHERE session_id IN (
          SELECT session_id FROM fleet_workers
          WHERE session_id IS NOT NULL
            AND status IN ('running', 'waiting_for_operator')
          GROUP BY session_id HAVING COUNT(*) > 1
        )
      ) AND status IN ('running', 'waiting_for_operator')
    `);
  }
  db.exec(`
    UPDATE fleet_workers SET status = 'cleanup_pending',
      terminal_cause = 'duplicate_active_session_binding',
      failure_code = 'duplicate_active_session_binding'
    WHERE session_id IN (
      SELECT session_id FROM fleet_workers
      WHERE session_id IS NOT NULL
        AND status IN ('running', 'waiting_for_operator')
      GROUP BY session_id HAVING COUNT(*) > 1
    ) AND status IN ('running', 'waiting_for_operator');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_one_active_session
      ON fleet_workers(session_id)
      WHERE session_id IS NOT NULL
        AND status IN ('running', 'waiting_for_operator');
  `);
}

function backfillFleetDurableUsageTotals(db: Database.Database): void {
  if (
    !hasTable(db, "fleet_resource_usage_buckets") ||
    !hasColumn(db, "fleet_resource_usage_buckets", "fleet_run_id")
  ) {
    return;
  }
  if (
    hasTable(db, "fleet_events") &&
    ["fleet_run_id", "event_type", "actor", "payload"].every((column) =>
      hasColumn(db, "fleet_events", column)
    )
  ) {
    db.exec(`
      INSERT INTO fleet_resource_usage_buckets
        (fleet_run_id, resource_type, resource_key, bucket_start_ms, units,
         updated_at)
      SELECT fleet_run_id, 'event_bytes_total', 'fleet', 0,
             SUM(
               length(CAST(event_type AS BLOB)) +
               length(CAST(actor AS BLOB)) +
               length(CAST(COALESCE(payload, '') AS BLOB))
             ), datetime('now')
      FROM fleet_events GROUP BY fleet_run_id
      ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
      DO UPDATE SET units = MAX(units, excluded.units),
                    updated_at = excluded.updated_at
    `);
  }
  if (
    hasTable(db, "fleet_artifacts") &&
    [
      "fleet_run_id",
      "title",
      "body",
      "body_pruned_at",
      "byte_count",
      "metadata_json",
    ].every((column) => hasColumn(db, "fleet_artifacts", column))
  ) {
    db.exec(`
      INSERT INTO fleet_resource_usage_buckets
        (fleet_run_id, resource_type, resource_key, bucket_start_ms, units,
         updated_at)
      SELECT fleet_run_id, 'artifact_bytes_total', 'fleet', 0,
             SUM(
               length(CAST(title AS BLOB)) +
               CASE WHEN body_pruned_at IS NULL
                 THEN length(CAST(body AS BLOB))
                 ELSE COALESCE(byte_count, 0)
               END +
               length(CAST(COALESCE(metadata_json, '{}') AS BLOB))
             ), datetime('now')
      FROM fleet_artifacts GROUP BY fleet_run_id
      ON CONFLICT(fleet_run_id, resource_type, resource_key, bucket_start_ms)
      DO UPDATE SET units = MAX(units, excluded.units),
                    updated_at = excluded.updated_at
    `);
  }
}

function ensureFleetAuxiliaryProviderSchema(db: Database.Database): void {
  for (const table of [
    "fleet_reviews",
    "fleet_task_reviews",
    "fleet_task_fixes",
  ]) {
    if (!hasTable(db, table)) continue;
    addColumnIfMissing(db, table, { name: "provider", ddl: "provider TEXT" });
    addColumnIfMissing(db, table, { name: "model", ddl: "model TEXT" });
  }

  // Requests that were already in flight before this migration must retain the
  // provider/model used for their reservation. The cost account is the most
  // authoritative durable launch binding and is preferred over legacy rows.
  if (
    hasTable(db, "fleet_cost_accounts") &&
    ["fleet_run_id", "owner_type", "owner_id", "provider", "model"].every(
      (column) => hasColumn(db, "fleet_cost_accounts", column)
    )
  ) {
    for (const [table, ownerType] of [
      ["fleet_reviews", "plan_review"],
      ["fleet_task_reviews", "task_review"],
      ["fleet_task_fixes", "fixer"],
    ] as const) {
      if (
        !hasTable(db, table) ||
        !hasColumn(db, table, "request_id") ||
        !hasColumn(db, table, "fleet_run_id")
      ) {
        continue;
      }
      db.exec(`
        UPDATE ${table}
        SET model = COALESCE(model, (
              SELECT account.model FROM fleet_cost_accounts account
              WHERE account.fleet_run_id = ${table}.fleet_run_id
                AND account.owner_type = '${ownerType}'
                AND account.owner_id = ${table}.request_id
              LIMIT 1
            )),
            provider = COALESCE(provider, (
              SELECT account.provider FROM fleet_cost_accounts account
              WHERE account.fleet_run_id = ${table}.fleet_run_id
                AND account.owner_type = '${ownerType}'
                AND account.owner_id = ${table}.request_id
              LIMIT 1
            ))
        WHERE request_id <> '' AND provider IS NULL
      `);
    }
  }

  // Older active rows can predate cost accounting. Their linked session still
  // records the exact provider/model that was spawned.
  if (
    hasTable(db, "sessions") &&
    ["id", "agent_type", "model"].every((column) =>
      hasColumn(db, "sessions", column)
    )
  ) {
    for (const [table, sessionColumn] of [
      ["fleet_reviews", "reviewer_session_id"],
      ["fleet_task_reviews", "reviewer_session_id"],
      ["fleet_task_fixes", "fixer_session_id"],
    ] as const) {
      if (
        !hasTable(db, table) ||
        !hasColumn(db, table, sessionColumn) ||
        !hasColumn(db, table, "request_id")
      ) {
        continue;
      }
      db.exec(`
        UPDATE ${table}
        SET model = COALESCE(model, (
              SELECT session.model FROM sessions session
              WHERE session.id = ${table}.${sessionColumn} LIMIT 1
            )),
            provider = COALESCE(provider, (
              SELECT session.agent_type FROM sessions session
              WHERE session.id = ${table}.${sessionColumn} LIMIT 1
            ))
        WHERE request_id <> '' AND provider IS NULL
      `);
    }
  }
}

function ensureFleetAuxiliaryRetrySchema(db: Database.Database): void {
  for (const table of [
    "fleet_reviews",
    "fleet_task_reviews",
    "fleet_task_fixes",
  ]) {
    if (!hasTable(db, table)) continue;
    addColumnIfMissing(db, table, {
      name: "launch_failure_count",
      ddl: "launch_failure_count INTEGER NOT NULL DEFAULT 0",
    });
    addColumnIfMissing(db, table, {
      name: "retry_not_before",
      ddl: "retry_not_before TEXT",
    });
    if (hasColumn(db, table, "state")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_${table}_launch_retry
          ON ${table}(state, retry_not_before)
      `);
    }
  }
}

function ensureFleetCostInterruptSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_cost_accounts")) {
    for (const column of [
      { name: "interrupt_requested_at", ddl: "interrupt_requested_at TEXT" },
      { name: "interrupt_deadline_at", ddl: "interrupt_deadline_at TEXT" },
      {
        name: "interrupt_notice_state",
        ddl: "interrupt_notice_state TEXT NOT NULL DEFAULT 'unattempted'",
      },
      {
        name: "interrupt_stop_state",
        ddl: "interrupt_stop_state TEXT NOT NULL DEFAULT 'unattempted'",
      },
      { name: "interrupt_cause", ddl: "interrupt_cause TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_cost_accounts", column);
    }
    if (
      [
        "fleet_run_id",
        "interrupt_deadline_at",
        "owner_type",
        "terminal_at",
        "reservation_released_at",
      ].every((column) => hasColumn(db, "fleet_cost_accounts", column))
    ) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_interrupt
          ON fleet_cost_accounts(
            fleet_run_id, interrupt_deadline_at, owner_type
          )
          WHERE terminal_at IS NULL AND reservation_released_at IS NULL
      `);
    }
  }

  // Runs created before desired_state existed used status as the execution
  // intent. Preserve that legacy intent once scheduler admission begins
  // enforcing desired_state explicitly; never override a pause or cancel.
  if (
    hasTable(db, "fleet_runs") &&
    ["status", "desired_state"].every((column) =>
      hasColumn(db, "fleet_runs", column)
    )
  ) {
    db.exec(`
      UPDATE fleet_runs SET desired_state = 'running'
      WHERE status IN ('running', 'reviewing', 'merging')
        AND desired_state IN ('draft', 'planned')
    `);
  }
}

function ensureFleetPlannerRiskSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_tasks")) return;
  addColumnIfMissing(db, "fleet_tasks", {
    name: "risk_notes_json",
    ddl: "risk_notes_json TEXT NOT NULL DEFAULT '[]'",
  });
}

function installFleetFairnessCursorSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    addColumnIfMissing(db, "fleet_runs", {
      name: "managed_supervisor_poll_cursor",
      ddl: "managed_supervisor_poll_cursor INTEGER NOT NULL DEFAULT 0",
    });
    if (hasColumn(db, "fleet_runs", "id")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fleet_runs_supervisor_poll_cursor
          ON fleet_runs(managed_supervisor_poll_cursor, id)
      `);
    }
  }
  if (hasTable(db, "fleet_cost_accounts")) {
    addColumnIfMissing(db, "fleet_cost_accounts", {
      name: "sample_attempt_cursor",
      ddl: "sample_attempt_cursor INTEGER NOT NULL DEFAULT 0",
    });
    addColumnIfMissing(db, "fleet_cost_accounts", {
      name: "fallback_recovery_cursor",
      ddl: "fallback_recovery_cursor INTEGER NOT NULL DEFAULT 0",
    });
    if (hasColumn(db, "fleet_cost_accounts", "id")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_sample_attempt_cursor
          ON fleet_cost_accounts(sample_attempt_cursor, id)
      `);
      if (hasColumn(db, "fleet_cost_accounts", "owner_type")) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_fallback_recovery_cursor
            ON fleet_cost_accounts(fallback_recovery_cursor, id)
            WHERE owner_type = 'supervisor'
        `);
      }
    }
  }
}

/** Install every fairness cursor and its ordering index atomically. */
function ensureFleetFairnessCursorSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installFleetFairnessCursorSchema(db);
    return;
  }
  db.transaction(() => installFleetFairnessCursorSchema(db)).immediate();
}

function installFleetSchedulerPollCursorSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_runs")) return;
  addColumnIfMissing(db, "fleet_runs", {
    name: "scheduler_poll_cursor",
    ddl: "scheduler_poll_cursor INTEGER NOT NULL DEFAULT 0",
  });
  if (hasColumn(db, "fleet_runs", "id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fleet_runs_scheduler_poll_cursor
        ON fleet_runs(scheduler_poll_cursor, id)
    `);
  }
}

/** Install the active-run scheduler cursor and ordering index atomically. */
function ensureFleetSchedulerPollCursorSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installFleetSchedulerPollCursorSchema(db);
    return;
  }
  db.transaction(() => installFleetSchedulerPollCursorSchema(db)).immediate();
}

function installFleetControlPlanePollCursorSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_runs")) return;
  for (const column of [
    "automation_poll_cursor",
    "cancellation_poll_cursor",
    "merge_poll_cursor",
    "lifecycle_poll_cursor",
  ]) {
    addColumnIfMissing(db, "fleet_runs", {
      name: column,
      ddl: `${column} INTEGER NOT NULL DEFAULT 0`,
    });
    if (hasColumn(db, "fleet_runs", "id")) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fleet_runs_${column}
          ON fleet_runs(${column}, id)
      `);
    }
  }
}

/** Install the bounded control-plane round-robin domains atomically. */
function ensureFleetControlPlanePollCursorSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installFleetControlPlanePollCursorSchema(db);
    return;
  }
  db.transaction(() =>
    installFleetControlPlanePollCursorSchema(db)
  ).immediate();
}

// All migrations in order. Migrations are idempotent (guarded by PRAGMA table_info
// / IF NOT EXISTS) so a fresh schema or a concurrent-init race never throws a
// duplicate-column/already-exists error. The runner no longer swallows those
// errors, so every migration must be self-guarding.
const migrations: Migration[] = [
  {
    id: 1,
    name: "add_group_path_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "group_path")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN group_path TEXT NOT NULL DEFAULT 'sessions'`
        );
      }
    },
  },
  {
    id: 2,
    name: "add_agent_type_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "agent_type")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'`
        );
      }
    },
  },
  {
    id: 3,
    name: "add_worktree_columns_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "worktree_path")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worktree_path TEXT`);
      }
      if (!hasColumn(db, "sessions", "branch_name")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN branch_name TEXT`);
      }
      if (!hasColumn(db, "sessions", "base_branch")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN base_branch TEXT`);
      }
      if (!hasColumn(db, "sessions", "dev_server_port")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN dev_server_port INTEGER`);
      }
    },
  },
  {
    id: 4,
    name: "add_pr_tracking_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "pr_url")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_url TEXT`);
      }
      if (!hasColumn(db, "sessions", "pr_number")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_number INTEGER`);
      }
      if (!hasColumn(db, "sessions", "pr_status")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN pr_status TEXT`);
      }
    },
  },
  {
    id: 5,
    name: "add_group_path_index",
    up: (db) => {
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path)`
      );
    },
  },
  {
    id: 6,
    name: "add_orchestration_columns_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "conductor_session_id")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN conductor_session_id TEXT REFERENCES sessions(id)`
        );
      }
      if (!hasColumn(db, "sessions", "worker_task")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worker_task TEXT`);
      }
      if (!hasColumn(db, "sessions", "worker_status")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worker_status TEXT`);
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id)`
      );
    },
  },
  {
    id: 7,
    name: "add_auto_approve_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "auto_approve")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    id: 8,
    name: "add_dev_server_columns",
    up: (db) => {
      if (!hasColumn(db, "dev_servers", "type")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN type TEXT NOT NULL DEFAULT 'node'`
        );
      }
      if (!hasColumn(db, "dev_servers", "name")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN name TEXT NOT NULL DEFAULT ''`
        );
      }
      if (!hasColumn(db, "dev_servers", "command")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN command TEXT NOT NULL DEFAULT ''`
        );
      }
      if (!hasColumn(db, "dev_servers", "pid")) {
        db.exec(`ALTER TABLE dev_servers ADD COLUMN pid INTEGER`);
      }
      if (!hasColumn(db, "dev_servers", "working_directory")) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''`
        );
      }
    },
  },
  {
    id: 9,
    name: "add_project_id_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "project_id")) {
        db.exec(
          `ALTER TABLE sessions ADD COLUMN project_id TEXT REFERENCES projects(id)`
        );
      }
      db.exec(
        `UPDATE sessions SET project_id = 'uncategorized' WHERE project_id IS NULL`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`
      );
    },
  },
  {
    id: 10,
    name: "add_project_id_to_dev_servers",
    up: (db) => {
      const projectIdExists = hasColumn(db, "dev_servers", "project_id");
      if (!projectIdExists) {
        db.exec(
          `ALTER TABLE dev_servers ADD COLUMN project_id TEXT REFERENCES projects(id)`
        );
      }
      // Migrate from session_id if it exists
      const hasSessionId = hasColumn(db, "dev_servers", "session_id");
      if (hasSessionId) {
        db.exec(`
          UPDATE dev_servers
          SET project_id = (
            SELECT COALESCE(s.project_id, 'uncategorized')
            FROM sessions s
            WHERE s.id = dev_servers.session_id
          )
          WHERE project_id IS NULL
        `);
      }
      db.exec(
        `UPDATE dev_servers SET project_id = 'uncategorized' WHERE project_id IS NULL`
      );
      // Always ensure the index exists, even when the column was already present
      // (fresh schemas created it, but the index may be missing on some DBs).
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)`
      );
    },
  },
  {
    id: 11,
    name: "add_tmux_name_to_sessions",
    up: (db) => {
      if (!hasColumn(db, "sessions", "tmux_name")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN tmux_name TEXT`);
      }
      // Backfill existing sessions with computed tmux name
      db.exec(
        `UPDATE sessions SET tmux_name = agent_type || '-' || id WHERE tmux_name IS NULL`
      );
    },
  },
  {
    id: 12,
    name: "add_initial_prompt_to_projects",
    up: (db) => {
      if (!hasColumn(db, "projects", "initial_prompt")) {
        db.exec(`ALTER TABLE projects ADD COLUMN initial_prompt TEXT`);
      }
    },
  },
  {
    id: 13,
    name: "add_project_repositories_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_repositories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON project_repositories(project_id)`
      );
    },
  },
  {
    id: 14,
    name: "add_mcp_launch_args_to_sessions",
    up: (db) => {
      // Conductor wiring for providers with no on-disk config (e.g. Codex's
      // `-c mcp_servers.stoa.*`): a JSON array of extra argv tokens replayed at
      // every spawn. NULL for non-conductors and file-configured providers.
      if (!hasColumn(db, "sessions", "mcp_launch_args")) {
        db.exec(`ALTER TABLE sessions ADD COLUMN mcp_launch_args TEXT`);
      }
    },
  },
  {
    id: 15,
    name: "add_push_subscriptions_table",
    up: (db) => {
      // Web Push subscriptions (closed-tab notifications). Keyed by endpoint so
      // a re-subscribe upserts rather than duplicating.
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    },
  },
  {
    id: 16,
    name: "add_dispatch_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dispatch_repos (
          id TEXT PRIMARY KEY,
          repo_path TEXT NOT NULL,
          repo_slug TEXT NOT NULL,
          agent_type TEXT NOT NULL DEFAULT 'claude',
          daily_quota INTEGER NOT NULL DEFAULT 0,
          max_concurrency INTEGER NOT NULL DEFAULT 1,
          label_filter TEXT,
          base_branch TEXT NOT NULL DEFAULT 'main',
          mode TEXT NOT NULL DEFAULT 'review',
          enabled INTEGER NOT NULL DEFAULT 0,
          project_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS issue_dispatches (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          issue_number INTEGER NOT NULL,
          issue_title TEXT,
          issue_url TEXT,
          issue_created_at TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          session_id TEXT,
          branch_name TEXT,
          worktree_path TEXT,
          pr_url TEXT,
          pr_number INTEGER,
          pr_status TEXT,
          dispatched_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        )
      `);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dispatch_status ON issue_dispatches(status)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_dispatch_repo ON issue_dispatches(repo_id)`
      );
    },
  },
  {
    id: 17,
    name: "add_scheduled_at_to_issue_dispatches",
    up: (db) => {
      // One-shot scheduling: a 'scheduled' row waits until scheduled_at, then the
      // reconciler promotes it to 'pending' (normal headroom/mode rules apply).
      if (!hasColumn(db, "issue_dispatches", "scheduled_at")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN scheduled_at TEXT`);
      }
    },
  },
  {
    id: 18,
    name: "add_reviewer_gate_columns",
    up: (db) => {
      // Opt-in reviewer gate (default off). When on, a worker's PR gets a critic
      // agent; Stoa surfaces the GitHub review decision in the cockpit.
      if (!hasColumn(db, "dispatch_repos", "review_gate")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      // reviewer_session_id: set once a critic is spawned (spawn-once guard).
      // review_decision: cached GitHub reviewDecision for the cockpit badge.
      if (!hasColumn(db, "issue_dispatches", "reviewer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN reviewer_session_id TEXT`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "review_decision")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN review_decision TEXT`);
      }
    },
  },
  {
    id: 19,
    name: "add_fix_loop_columns",
    up: (db) => {
      // Fix loop: on CHANGES_REQUESTED a fixer worker addresses the feedback
      // (capped by fix_rounds); fixer_session_id tracks the in-flight fixer.
      if (!hasColumn(db, "issue_dispatches", "fix_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 20,
    name: "add_session_events_ledger",
    up: (db) => {
      // Append-only audit / event ledger. No FK to sessions ON PURPOSE — the
      // trail must outlive a deleted session (the audit-moat value AND the
      // analytics substrate). session_key is the backend key (e.g.
      // "claude-<uuid>"); created_at is epoch millis for cheap ordering.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_key TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT,
          created_at INTEGER NOT NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_key ON session_events(session_key)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at)`
      );
    },
  },
  {
    id: 21,
    name: "add_auto_merge_to_issue_dispatches",
    up: (db) => {
      // Opt-in per-issue auto-merge (default off). When on, the reconciler merges
      // the worker's PR once it's ready (no conflicts, checks green, and — if the
      // repo armed review_gate — the critic approved).
      if (!hasColumn(db, "issue_dispatches", "auto_merge")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    id: 22,
    name: "add_ci_autofix_columns",
    up: (db) => {
      // Opt-in per-repo CI auto-fix (default off). When on, the reconciler spawns
      // a fixer on a worker's PR whose checks are RED, to read the failures, fix
      // them, and push — making red PRs self-heal toward a green, mergeable state.
      if (!hasColumn(db, "dispatch_repos", "ci_autofix")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN ci_autofix INTEGER NOT NULL DEFAULT 0`
        );
      }
      // ci_fix_rounds caps the CI-fix attempts; ci_fixer_session_id tracks the
      // in-flight CI fixer (separate from the review fixer so the two don't clash).
      if (!hasColumn(db, "issue_dispatches", "ci_fix_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN ci_fix_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn(db, "issue_dispatches", "ci_fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN ci_fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 23,
    name: "create_session_ceremonies",
    up: (db) => {
      // Session "go to auto" — enrol a running session's PR into the SAME
      // ceremony the dispatch engine runs (critic panel → fix loop → CI auto-fix
      // → auto-merge), reusing its pure decision functions. One ceremony per
      // session (UNIQUE session_id). The PR/worktree/branch live on the session
      // row; this table mirrors only the review/CI progress fields of
      // issue_dispatches. `step` is a coarse lifecycle marker for the UI badge;
      // the reconciler derives each tick's action from the fields, like dispatch.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_ceremonies (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL UNIQUE,
          step TEXT NOT NULL DEFAULT 'queued',
          seed_prompt TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          reviewer_session_id TEXT,
          review_decision TEXT,
          -- The PR head SHA the CURRENT panel is reviewing (set, fail-closed, at
          -- panel SPAWN). Panelists stamp the SHA they reviewed in their verdict
          -- marker; only markers matching this count, and the merge is pinned to it
          -- (gh --match-head-commit). A push after approval is re-reviewed, never
          -- merged unreviewed — immune to round/time/cancel races.
          review_sha TEXT,
          -- Opt-in: 1 = auto-merge when ready; 0 (default) = stop at 'ready' and
          -- let the human do the final merge (the safe default — the human renders
          -- the verdict on the reviewed, green PR).
          auto_merge INTEGER NOT NULL DEFAULT 0,
          fix_rounds INTEGER NOT NULL DEFAULT 0,
          fixer_session_id TEXT,
          ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
          ci_fixer_session_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_session_ceremonies_step ON session_ceremonies(step)`
      );
    },
  },
  {
    id: 24,
    name: "add_merge_train_columns",
    up: (db) => {
      // Opt-in per-repo merge train (default off). When on, the reconciler keeps a
      // worker's PR LANDABLE: once it's approved + green but CONFLICTING (the base
      // moved under it), it spawns the author to rebase onto the base, resolve the
      // conflicts preserving both intents, and force-push-with-lease — so a ready
      // PR self-heals back to mergeable instead of paging a human to rebase.
      //
      // Each ALTER is guarded INDEPENDENTLY (not relying on the outer
      // "duplicate column → mark applied" recovery): a crash after the first ALTER
      // would otherwise record the migration as applied on retry and silently skip
      // the remaining columns. rebase_rounds caps the rebase attempts;
      // rebase_fixer_session_id tracks the in-flight rebase fixer (separate from the
      // review/CI fixers so they don't clash).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("dispatch_repos", "merge_train")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN merge_train INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("issue_dispatches", "rebase_rounds")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN rebase_rounds INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("issue_dispatches", "rebase_fixer_session_id")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN rebase_fixer_session_id TEXT`
        );
      }
    },
  },
  {
    id: 25,
    name: "add_verify_columns",
    up: (db) => {
      // Opt-in per-repo verification harness (default off). When armed with a
      // verify_command, the reconciler runs it in each worker's PR worktree
      // (typecheck/test/build) and attaches the result to the review card, so
      // approvals are made from EVIDENCE, not by reading code — and (when armed)
      // gates auto-merge on a local pass. Especially fills the gap for repos with
      // NO GitHub CI (where summarizePrChecks → "none" → today merges with zero
      // test evidence). Each ALTER guarded independently (migration-24 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("dispatch_repos", "verify_gate")) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN verify_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!hasColumn("dispatch_repos", "verify_command")) {
        db.exec(`ALTER TABLE dispatch_repos ADD COLUMN verify_command TEXT`);
      }
      // verify_status: NULL | running | pass | fail | error. verify_sha pins the
      // PR head the result is for (once-guard key + stale-verdict gating pin).
      if (!hasColumn("issue_dispatches", "verify_status")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_status TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_output")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_output TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_sha")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_sha TEXT`);
      }
      if (!hasColumn("issue_dispatches", "verify_ran_at")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN verify_ran_at TEXT`);
      }
    },
  },
  {
    id: 26,
    name: "add_file_claims_to_issue_dispatches",
    up: (db) => {
      // Conflict-aware decomposition: a planner partitions a spec into tasks, each
      // owning a DISJOINT set of files (file_claims = a JSON array of repo-relative
      // path prefixes). The reconciler refuses to co-schedule two pending tasks
      // whose claims overlap a live (dispatched/pr_open) claim — so they serialize
      // instead of opening two PRs that collide at merge. NULL/absent = no claims =
      // exactly today's behavior (every legacy/non-planned row). Guarded ALTER
      // (migration-24/25 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("issue_dispatches", "file_claims")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN file_claims TEXT`);
      }
    },
  },
  {
    id: 27,
    name: "add_repo_lessons",
    up: (db) => {
      // Fleet memory (the lessons ledger): persist each blocking critic finding per
      // repo, then inject the recent ones into every new worker's prompt so the
      // fleet stops re-making the same mistakes. CREATE TABLE IF NOT EXISTS is
      // already idempotent (no guard needed, unlike an ALTER).
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_lessons (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          lens TEXT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_repo_lessons_repo ON repo_lessons(repo_id)`
      );
    },
  },
  {
    id: 28,
    name: "add_local_task_intake_to_issue_dispatches",
    up: (db) => {
      // Generalized intake (#7): a task can now come from a real GitHub issue OR a
      // freeform "local" task typed into Stoa (no issue required). Local rows carry
      // source='local', issue_number 0, and the freeform body in task_body. Both
      // sources drain through the SAME reconciler/pool. Guarded ALTERs
      // (migration-24..26 pattern); NULL/'github' default = exactly today's behavior.
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      // Swap the index FIRST: the guarded ALTERs below can throw "duplicate
      // column" under a concurrent-init race, which the runner catches and records
      // the migration as applied — so doing the swap first guarantees it can never
      // be stranded behind a caught ALTER. The swap only touches issue_number
      // (pre-existing), so it doesn't depend on the new columns.
      //
      // Make (repo, issue_number) uniqueness apply only to real GitHub issues
      // (number > 0). Local tasks share issue_number 0 and must not collide, so a
      // partial index excludes them. gh ingest dedupe (getDispatchByRepoIssue +
      // INSERT OR IGNORE) is unchanged — it only ever passes positive numbers.
      db.exec(`DROP INDEX IF EXISTS idx_dispatch_repo_issue`);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number) WHERE issue_number > 0`
      );
      if (!hasColumn("issue_dispatches", "source")) {
        db.exec(
          `ALTER TABLE issue_dispatches ADD COLUMN source TEXT NOT NULL DEFAULT 'github'`
        );
      }
      if (!hasColumn("issue_dispatches", "task_body")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN task_body TEXT`);
      }
    },
  },
  {
    id: 29,
    name: "add_recurrence_to_issue_dispatches",
    up: (db) => {
      // Cron recurrence (#7): a scheduled LOCAL task can repeat. recurrence
      // ('hourly'|'daily'|'weekly'); null/absent = one-shot = exactly today's
      // behavior. Guarded ALTER (migration-24..28 pattern).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("issue_dispatches", "recurrence")) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN recurrence TEXT`);
      }
    },
  },
  {
    id: 30,
    name: "add_source_to_repo_lessons",
    up: (db) => {
      // Fleet memory #9: distinguish operator-curated MANUAL rules from
      // auto-captured critic findings, so "forget findings" can clear the noise
      // while keeping curated facts. Guarded ALTER; default 'auto' = exactly the
      // existing (all-auto) behavior for legacy rows.
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      if (!hasColumn("repo_lessons", "source")) {
        db.exec(
          `ALTER TABLE repo_lessons ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'`
        );
      }
    },
  },
  {
    id: 31,
    name: "add_maintainer_survey",
    up: (db) => {
      // Autonomous maintainer (opt-in, default off): a survey agent proposes its
      // own backlog on a cadence. Proposals carry maintainer_proposed=1 and are
      // structurally fenced out of auto-dispatch (they wait for one-tap Approve).
      // Guarded ALTERs; defaults = exactly today's behavior (no surveys, no fence).
      const hasColumn = (table: string, column: string): boolean =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === column);
      const add = (table: string, column: string, ddl: string) => {
        if (!hasColumn(table, column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
        }
      };
      add(
        "dispatch_repos",
        "maintainer_survey_enabled",
        "maintainer_survey_enabled INTEGER NOT NULL DEFAULT 0"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_goal",
        "maintainer_survey_goal TEXT"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_cadence",
        "maintainer_survey_cadence TEXT"
      );
      add(
        "dispatch_repos",
        "maintainer_survey_last_at",
        "maintainer_survey_last_at TEXT"
      );
      add(
        "issue_dispatches",
        "maintainer_proposed",
        "maintainer_proposed INTEGER NOT NULL DEFAULT 0"
      );
    },
  },
  {
    id: 32,
    name: "backfill_worker_auto_approve",
    up: (db) => {
      // Workers always run with the bypass flag (lib/orchestration.ts spawns them
      // autoApprove:true), but rows created before createWorkerSession set
      // auto_approve=1 stored the column default 0. Backfill so the auto-approve
      // danger badge flags pre-upgrade workers too. Idempotent.
      // Guard the table existing — some migration tests run on a partial DB.
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      db.exec(
        `UPDATE sessions SET auto_approve = 1 WHERE conductor_session_id IS NOT NULL AND auto_approve = 0`
      );
    },
  },
  {
    id: 33,
    name: "add_worktree_paths_to_sessions",
    up: (db) => {
      // Multi-repo "workspace" sessions: a JSON array of the child worktree paths
      // this session created (one per picked sub-repo). NULL for ordinary
      // single-worktree (or no-worktree) sessions. Drives multi-worktree teardown
      // on delete. Guard the table existing (some migration tests run partial).
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      // Idempotent: skip if the column already exists (a bare ADD COLUMN would
      // throw "duplicate column name" on a partial / re-applied DB).
      const hasColumn = (
        db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      ).some((c) => c.name === "worktree_paths");
      if (!hasColumn) {
        db.exec(`ALTER TABLE sessions ADD COLUMN worktree_paths TEXT`);
      }
    },
  },
  {
    id: 34,
    name: "add_saved_workflows",
    up: (db) => {
      // Saved visual-builder workflows: the BuilderDoc (spec + canvas positions)
      // serialized as JSON. CREATE TABLE IF NOT EXISTS is inherently idempotent.
      db.exec(`
        CREATE TABLE IF NOT EXISTS saved_workflows (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          builder_doc TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_saved_workflows_updated ON saved_workflows(updated_at DESC)`
      );
    },
  },
  {
    id: 35,
    name: "add_history_to_saved_workflows",
    up: (db) => {
      // Version-history snapshots for saved workflows. Guarded so it is idempotent
      // under re-runs and concurrent init.
      const savedWorkflowsHasHistory = (
        db.prepare(`PRAGMA table_info(saved_workflows)`).all() as {
          name: string;
        }[]
      ).some((c) => c.name === "history");
      if (!savedWorkflowsHasHistory) {
        db.exec(
          `ALTER TABLE saved_workflows ADD COLUMN history TEXT NOT NULL DEFAULT '[]'`
        );
      }
    },
  },
  {
    id: 36,
    name: "add_dispatch_review_sha_and_composite_indexes",
    up: (db) => {
      // Dispatch review SHA pinning: the head commit a panel verdict was cached for.
      // Set when a complete verdict is cached; cleared on re-review/retry/rebase.
      if (
        hasTable(db, "issue_dispatches") &&
        !hasColumn(db, "issue_dispatches", "review_sha")
      ) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN review_sha TEXT`);
      }
      // Covering/composite indexes for common hot queries. IF NOT EXISTS prevents
      // errors when an index already exists; each CREATE is also guarded by hasTable
      // because a migration may run against a partial legacy DB that hasn't created
      // every table yet (e.g. migration tests that fake a pre-28 state).
      if (hasTable(db, "dev_servers")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id)`
        );
      }
      if (hasTable(db, "sessions")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`
        );
      }
      if (hasTable(db, "messages")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp)`
        );
      }
      if (hasTable(db, "tool_calls")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_timestamp ON tool_calls(session_id, timestamp)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_tool_calls_message_timestamp ON tool_calls(message_id, timestamp)`
        );
      }
      if (hasTable(db, "issue_dispatches")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_dispatch_repo_status ON issue_dispatches(repo_id, status)`
        );
        // dispatched_at was added in migration 17; a heavily-minimized legacy fixture
        // may have skipped it while still claiming that migration.
        if (hasColumn(db, "issue_dispatches", "dispatched_at")) {
          db.exec(
            `CREATE INDEX IF NOT EXISTS idx_dispatch_dispatched_at ON issue_dispatches(dispatched_at DESC)`
          );
        }
      }
      if (hasTable(db, "session_events")) {
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_session_events_key_type_id ON session_events(session_key, event_type, id)`
        );
      }
    },
  },
  {
    id: 37,
    name: "dedupe_repo_lessons_and_unique_index",
    up: (db) => {
      // The lesson INSERT…WHERE NOT EXISTS dedup wasn't atomic, so concurrent
      // captures could double-insert. Collapse any existing duplicates (keep the
      // earliest row per repo_id+text) then enforce uniqueness, so INSERT OR
      // IGNORE is a true idempotent dedup going forward. Guarded + idempotent.
      if (!hasTable(db, "repo_lessons")) return;
      db.exec(
        `DELETE FROM repo_lessons
         WHERE rowid NOT IN (
           SELECT MIN(rowid) FROM repo_lessons GROUP BY repo_id, text
         )`
      );
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_lessons_unique ON repo_lessons(repo_id, text)`
      );
    },
  },
  {
    id: 38,
    name: "add_best_of_n_tables",
    up: (db) => {
      // Best-of-N: run N parallel Claude sessions on the same task, each in an
      // isolated worktree, then present a compare view so the user can pick one
      // winner. The losing sessions and worktrees are cleaned up on pick.
      if (!hasTable(db, "best_of_n_runs")) {
        db.exec(`
          CREATE TABLE best_of_n_runs (
            id TEXT PRIMARY KEY,
            task TEXT NOT NULL,
            base_branch TEXT NOT NULL DEFAULT 'main',
            n INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'running',
            winner_session_id TEXT,
            project_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (winner_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_bon_runs_project ON best_of_n_runs(project_id)`
        );
      }
      if (!hasTable(db, "best_of_n_candidates")) {
        db.exec(`
          CREATE TABLE best_of_n_candidates (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            session_id TEXT,
            worktree_path TEXT,
            branch_name TEXT,
            candidate_index INTEGER NOT NULL,
            diff TEXT,
            is_winner INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (run_id) REFERENCES best_of_n_runs(id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_bon_candidates_run ON best_of_n_candidates(run_id)`
        );
      }
    },
  },
  {
    id: 39,
    name: "add_agent_memory_table",
    up: (db) => {
      // Agent-accessible shared memory: a fleet-wide key→value scratchpad any
      // agent reads/writes via the orchestration MCP server (memory_* tools) or
      // the /api/memory route — the shared human+agent surface.
      if (!hasTable(db, "agent_memory")) {
        db.exec(`
          CREATE TABLE agent_memory (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
    },
  },
  {
    id: 40,
    name: "add_notes_table",
    up: (db) => {
      // Notes / shared knowledge base: persistent markdown docs readable/writable
      // by humans (the /api/notes route + a dialog) and agents (notes_* MCP tools).
      if (!hasTable(db, "notes")) {
        db.exec(`
          CREATE TABLE notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      }
    },
  },
  {
    id: 41,
    name: "add_channel_messages_table",
    up: (db) => {
      // Inter-agent channels: an append-only 1:1 message log between sessions,
      // read/written via /api/channels + the channel_* MCP tools. pair_key is the
      // order-independent thread id; read_at marks a consumed message; delivered_at
      // records the opt-in turn-boundary terminal push.
      if (!hasTable(db, "channel_messages")) {
        db.exec(`
          CREATE TABLE channel_messages (
            id TEXT PRIMARY KEY,
            pair_key TEXT NOT NULL,
            from_session_id TEXT NOT NULL,
            to_session_id TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at TEXT,
            read_at TEXT
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_channel_messages_inbox
             ON channel_messages (to_session_id, read_at, created_at)`
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
             ON channel_messages (pair_key, created_at)`
        );
      }
    },
  },
  {
    id: 42,
    name: "add_schedules_table",
    up: (db) => {
      // General-purpose scheduler: fire a prompt into a session on a cadence. At
      // the due time the server enqueues the prompt into the session's prompt
      // queue (delivered by the existing safe turn-boundary path).
      if (!hasTable(db, "schedules")) {
        db.exec(`
          CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            session_id TEXT NOT NULL,
            prompt TEXT NOT NULL,
            recurrence TEXT,
            next_run_at TEXT NOT NULL,
            last_run_at TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_schedules_due
             ON schedules (enabled, next_run_at)`
        );
      }
    },
  },
  {
    id: 43,
    name: "add_session_costs_table",
    up: (db) => {
      // Persisted token/cost samples (#15). Cost was recomputed from the live
      // transcript on every request — so analytics had no HISTORY and a sample
      // vanished when the session was deleted or its transcript scrolled off.
      // One row per (session_key, day): the session's cumulative usage as last
      // sampled that UTC day, upserted idempotently. Survives transcript loss.
      if (!hasTable(db, "session_costs")) {
        db.exec(`
          CREATE TABLE session_costs (
            session_key TEXT NOT NULL,
            day TEXT NOT NULL,
            session_id TEXT NOT NULL,
            agent_type TEXT NOT NULL DEFAULT '',
            model TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (session_key, day)
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_session_costs_day
             ON session_costs (day)`
        );
      }
    },
  },
  {
    id: 44,
    name: "add_fork_cost_baseline",
    up: (db) => {
      // #1: a NATIVE Claude fork (--resume <parent> --fork-session) inherits the
      // parent's ENTIRE transcript, so the cost reader books the parent's full
      // history as the fork's usage (the fleet cost ~doubles, the persisted curve
      // spikes on the fork day). Record the parent's cumulative usage AT FORK TIME
      // here (a JSON TokenUsage); the cost path nets it out so only the fork's OWN
      // spend above the inherited baseline counts. NULL = no baseline (the common
      // case: not a native fork). Guarded ALTER (migration-24.. pattern).
      const hasSessions =
        (
          db
            .prepare(
              `SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'`
            )
            .all() as { name: string }[]
        ).length > 0;
      if (!hasSessions) return;
      const hasColumn = (
        db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
      ).some((c) => c.name === "fork_cost_baseline");
      if (!hasColumn) {
        db.exec(`ALTER TABLE sessions ADD COLUMN fork_cost_baseline TEXT`);
      }
    },
  },
  {
    id: 45,
    name: "add_playbooks",
    up: (db) => {
      // #13: Project Playbooks + auto-recalled Knowledge. A named prompt snippet;
      // SELECT it as a recipe, or pin=1 with a project to auto-prepend it.
      if (!hasTable(db, "playbooks")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS playbooks (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            body TEXT NOT NULL,
            project_id TEXT,
            pinned INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_playbooks_project ON playbooks(project_id)`
        );
      }
    },
  },
  {
    id: 46,
    name: "add_project_startup_commands",
    up: (db) => {
      // #14b: per-project startup commands run on new-session boot (build,
      // codegen, db migrate — warming the worktree beyond npm install).
      // Safe-exec only: tokenizeCommand-validated at the API, spawned as argv.
      if (!hasTable(db, "project_startup_commands")) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS project_startup_commands (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            command TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
          );
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_project_startup_commands_project ON project_startup_commands(project_id)`
        );
      }
    },
  },
  {
    id: 47,
    name: "add_verify_badge",
    up: (db) => {
      // #19: outcome-based verify badge. A project may configure a verify
      // command (validated with parseVerifySteps — Stoa's no-shell grammar);
      // when an interactive session finishes a turn it runs in the session's
      // worktree and the verdict lands on the sessions row (turn-scoped:
      // cleared when the next turn starts).
      const hasCol = (table: string, col: string) =>
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
        ).some((c) => c.name === col);
      // hasTable guards: an upgrade fixture mid-migration may not have created
      // these tables yet (they'd be born WITH the columns via schema.ts).
      if (hasTable(db, "projects") && !hasCol("projects", "verify_command")) {
        db.exec(`ALTER TABLE projects ADD COLUMN verify_command TEXT`);
      }
      if (hasTable(db, "sessions")) {
        for (const col of ["verify_status", "verify_output", "verify_ran_at"]) {
          if (!hasCol("sessions", col)) {
            db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
          }
        }
      }
    },
  },
  {
    id: 48,
    name: "add_dispatch_repo_default_model",
    up: (db) => {
      // #20 cost-aware routing: a repo may pin its dispatch workers to an
      // economical model tier (e.g. haiku). NULL = the agent's catalog default.
      // Validated at the PATCH boundary (resolveModelForAgent + isSafeModel).
      if (
        hasTable(db, "dispatch_repos") &&
        !hasColumn(db, "dispatch_repos", "default_model")
      ) {
        db.exec(`ALTER TABLE dispatch_repos ADD COLUMN default_model TEXT`);
      }
    },
  },
  {
    id: 49,
    name: "add_session_budget_usd",
    up: (db) => {
      // #21 per-session cost budget: a lifetime USD cap for this session.
      // 80%/100% alerts + an opt-in fail-closed park at the cap (the tick
      // stops feeding it work; the user can still type). NULL = no budget.
      if (
        hasTable(db, "sessions") &&
        !hasColumn(db, "sessions", "budget_usd")
      ) {
        db.exec(`ALTER TABLE sessions ADD COLUMN budget_usd REAL`);
      }
    },
  },
  {
    id: 50,
    name: "add_judge_gate",
    up: (db) => {
      // #26 LLM-as-judge rubric gate: opt-in per repo (fail-closed default 0);
      // the verdict trio mirrors verify_status/verify_output/verify_sha —
      // SHA-pinned so a stale pass can never greenlight a newer push.
      if (
        hasTable(db, "dispatch_repos") &&
        !hasColumn(db, "dispatch_repos", "judge_gate")
      ) {
        db.exec(
          `ALTER TABLE dispatch_repos ADD COLUMN judge_gate INTEGER NOT NULL DEFAULT 0`
        );
      }
      // Column order matches schema.ts's issue_dispatches judge block, so a
      // fresh-start DB and a migrated DB agree.
      if (
        hasTable(db, "issue_dispatches") &&
        !hasColumn(db, "issue_dispatches", "judge_status")
      ) {
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_status TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_output TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_sha TEXT`);
        db.exec(`ALTER TABLE issue_dispatches ADD COLUMN judge_ran_at TEXT`);
      }
    },
  },
  {
    id: 51,
    name: "add_auth_tokens",
    up: (db) => {
      // #46/#49 per-device named revocable tokens with a SCOPE. We store only a
      // SHA-256 hash of the secret (never the plaintext), so a DB read can't
      // recover a usable token. `scope` is 'admin' (full control) or 'observer'
      // (read-only spectator: Live Wall stream + GETs, rejected by every mutation).
      // The legacy ~/.stoa/token stays valid as an implicit admin token (existing
      // shared URLs keep working); this table is ADDITIVE. `revoked_at` non-null →
      // the token fails auth immediately (revocation is checked live).
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_tokens (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'admin',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          revoked_at TEXT
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash)`
      );
    },
  },
  {
    id: 52,
    name: "add_checkpoints",
    up: (db) => {
      // #44 Checkpoint / time-travel timeline. A DURABLE metadata + lineage layer
      // over the git shadow-commit snapshots (refs/stoa/snap/<session>/<seq>) —
      // the snapshot stays the store of worktree BYTES; this row pins one by
      // (seq, snapshot_sha) and adds what git refs can't hold: a human label, the
      // transcript anchor (claude_session_id at capture — native fork branches at
      // the transcript TIP), a kind, and fork lineage. snapshot_sha is stored too,
      // so a rewind/fork target survives the ref's FIFO prune (MAX 20) while the
      // object lives; a row whose sha no longer resolves is shown "expired", never
      // a broken target. ON DELETE CASCADE reaps a deleted session's checkpoints;
      // parent_checkpoint_id is SET NULL so a fork's lineage survives deleting its
      // source checkpoint.
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          snapshot_sha TEXT NOT NULL,
          summary TEXT,
          transcript_session_id TEXT,
          kind TEXT NOT NULL DEFAULT 'manual',
          created_by TEXT NOT NULL DEFAULT 'manual',
          parent_checkpoint_id TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
        )
      `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, seq)`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id)`
      );
    },
  },
  {
    id: 53,
    name: "add_approval_mode_to_sessions",
    up: (db) => {
      // #27 OS-level sandbox launch tier. Replaces all-or-nothing auto_approve
      // with a tri-state: 'prompt' | 'sandboxed-auto' | 'full-bypass'. Backfill
      // from the existing boolean so behavior is UNCHANGED on upgrade
      // (auto_approve=1 → 'full-bypass' = today's yolo; 0 → 'prompt'). auto_approve
      // is KEPT and kept in sync (the ~4 badge read-sites still read it), so this
      // migration is purely additive.
      // hasTable guard: an upgrade fixture mid-migration may not have created
      // the sessions table (it predates the migration system), so don't ALTER a
      // table that isn't there (mirrors migrations 47/49).
      if (
        hasTable(db, "sessions") &&
        !hasColumn(db, "sessions", "approval_mode")
      ) {
        db.exec(`ALTER TABLE sessions ADD COLUMN approval_mode TEXT`);
        db.exec(
          `UPDATE sessions SET approval_mode = CASE WHEN auto_approve = 1 THEN 'full-bypass' ELSE 'prompt' END WHERE approval_mode IS NULL`
        );
      }
    },
  },
  {
    id: 54,
    name: "add_fleet_management_tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_runs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          goal TEXT NOT NULL,
          repo_id TEXT,
          project_id TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          budget_usd REAL,
          provider TEXT NOT NULL DEFAULT 'claude',
          model TEXT,
          max_concurrency INTEGER NOT NULL DEFAULT 1,
          review_policy TEXT NOT NULL DEFAULT 'four_agent',
          approval_state TEXT NOT NULL DEFAULT 'draft',
          settings_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE SET NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_tasks (
          id TEXT PRIMARY KEY,
          fleet_run_id TEXT NOT NULL,
          parent_task_id TEXT,
          title TEXT NOT NULL,
          description TEXT,
          status TEXT NOT NULL DEFAULT 'draft',
          task_type TEXT NOT NULL DEFAULT 'planning',
          sort_order INTEGER NOT NULL DEFAULT 0,
          file_claims_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_workers (
          id TEXT PRIMARY KEY,
          fleet_run_id TEXT NOT NULL,
          task_id TEXT,
          session_id TEXT,
          status TEXT NOT NULL DEFAULT 'waiting_for_operator',
          provider TEXT,
          model TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_heartbeat_at TEXT,
          ended_at TEXT,
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS fleet_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fleet_run_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          actor TEXT NOT NULL DEFAULT 'system',
          payload TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_fleet_runs_status ON fleet_runs(status);
        CREATE INDEX IF NOT EXISTS idx_fleet_runs_updated ON fleet_runs(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_fleet_tasks_run ON fleet_tasks(fleet_run_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_fleet_workers_run ON fleet_workers(fleet_run_id);
        CREATE INDEX IF NOT EXISTS idx_fleet_events_run ON fleet_events(fleet_run_id, id DESC);
      `);
    },
  },
  {
    id: 55,
    name: "add_fleet_plan_approval_and_artifacts",
    up: (db) => {
      ensureFleetRunApprovalColumns(db);
      ensureFleetArtifactRuntimeColumns(db);

      db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_artifacts (
          id TEXT PRIMARY KEY,
          fleet_run_id TEXT NOT NULL,
          task_id TEXT,
          plan_hash TEXT,
          artifact_type TEXT NOT NULL DEFAULT 'critic_finding',
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'warning',
          actor TEXT NOT NULL DEFAULT 'critic',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_fleet_artifacts_run
          ON fleet_artifacts(fleet_run_id, created_at DESC);
      `);
    },
  },
  {
    id: 56,
    name: "add_fleet_artifact_plan_hash",
    up: (db) => {
      ensureFleetRunApprovalColumns(db);
      ensureFleetArtifactRuntimeColumns(db);
      if (hasTable(db, "fleet_artifacts") && hasTable(db, "fleet_runs")) {
        db.exec(`
          UPDATE fleet_artifacts
          SET plan_hash = (
            SELECT fleet_runs.plan_hash
            FROM fleet_runs
            WHERE fleet_runs.id = fleet_artifacts.fleet_run_id
          )
          WHERE plan_hash IS NULL
            AND EXISTS (
              SELECT 1
              FROM fleet_runs
              WHERE fleet_runs.id = fleet_artifacts.fleet_run_id
                AND fleet_runs.plan_hash IS NOT NULL
            )
        `);
      }
    },
  },
  {
    id: 57,
    name: "add_fleet_scheduler",
    up: ensureFleetSchedulerSchema,
  },
  {
    id: 58,
    name: "add_fleet_automation_foundation",
    up: ensureFleetAutomationSchema,
  },
  {
    id: 59,
    name: "add_fleet_worker_report_runtime",
    up: ensureFleetReportRuntimeSchema,
  },
  {
    id: 60,
    name: "add_fleet_verification_runtime",
    up: ensureFleetVerificationSchema,
  },
  {
    id: 61,
    name: "add_fleet_task_review_and_fix_runtime",
    up: ensureFleetTaskReviewSchema,
  },
  {
    id: 62,
    name: "add_fleet_merge_runtime",
    up: ensureFleetMergeRuntimeSchema,
  },
  {
    id: 63,
    name: "add_fleet_lifecycle_hardening",
    up: ensureFleetLifecycleSchema,
  },
  {
    id: 64,
    name: "add_fleet_scoped_capabilities",
    up: ensureFleetCapabilitySchema,
  },
  {
    id: 65,
    name: "add_fleet_source_lineage",
    up: ensureFleetSourceLineageSchema,
  },
  {
    id: 66,
    name: "add_fleet_cost_and_resource_admission",
    up: ensureFleetCostResourceSchema,
  },
  {
    id: 67,
    name: "scope_fleet_runtime_usage_by_run",
    up: ensureFleetResourceUsageScopeSchema,
  },
  {
    id: 68,
    name: "add_fleet_rendered_status_and_interrupt_state",
    up: ensureFleetStatusAndInterruptSchema,
  },
  {
    id: 69,
    name: "backfill_fleet_interrupt_cause",
    up: backfillFleetInterruptCause,
  },
  {
    id: 70,
    name: "enforce_fleet_active_session_ownership",
    up: ensureFleetActiveSessionOwnership,
  },
  {
    id: 71,
    name: "backfill_fleet_durable_usage_totals",
    up: backfillFleetDurableUsageTotals,
  },
  {
    id: 72,
    name: "persist_fleet_auxiliary_providers",
    up: ensureFleetAuxiliaryProviderSchema,
  },
  {
    id: 73,
    name: "add_fleet_auxiliary_launch_retries",
    up: ensureFleetAuxiliaryRetrySchema,
  },
  {
    id: 74,
    name: "add_fleet_cost_interrupt_state",
    up: ensureFleetCostInterruptSchema,
  },
  {
    id: 75,
    name: "add_fleet_planner_risk_notes",
    up: ensureFleetPlannerRiskSchema,
  },
  {
    id: 76,
    name: "add_immutable_session_launch_profiles",
    up: ensureSessionLaunchProfileSchema,
  },
  {
    id: 77,
    name: "add_fleet_fairness_cursors",
    up: ensureFleetFairnessCursorSchema,
  },
  {
    id: 78,
    name: "add_fleet_scheduler_poll_cursor",
    up: ensureFleetSchedulerPollCursorSchema,
  },
  {
    id: 79,
    name: "add_fleet_session_ownership",
    up: ensureFleetSessionOwnershipSchema,
  },
  {
    id: 80,
    name: "backfill_fleet_owned_session_roles",
    up: ensureFleetOwnedSessionRoleSchema,
  },
  {
    id: 81,
    name: "bind_expected_fleet_merge_results",
    up: ensureFleetMergeProvenanceSchema,
  },
  {
    id: 82,
    name: "add_session_deletion_claims",
    up: ensureSessionDeletionClaimSchema,
  },
  {
    id: 83,
    name: "add_fleet_control_plane_poll_cursors",
    up: ensureFleetControlPlanePollCursorSchema,
  },
  {
    id: 84,
    name: "add_session_comments_table",
    up: (db) => {
      // Per-session human comments / annotations: hand-off notes, review
      // remarks attached to a specific session. Separate from the fleet-wide
      // Notes KB — these are scoped to one session's lifecycle.
      if (!hasTable(db, "session_comments")) {
        db.exec(`
          CREATE TABLE session_comments (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            author TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_session_comments_session ON session_comments(session_id)`
        );
      }
    },
  },
  {
    id: 85,
    name: "add_project_id_to_notes",
    up: (db) => {
      // Per-project wiki scoping: a note with project_id is visible only in
      // that project's wiki; NULL = fleet-wide (the original behavior).
      // Guard on hasTable: some test suites create fresh DBs that only run a
      // subset of migrations, so the notes table may not exist yet.
      if (hasTable(db, "notes")) {
        if (!hasColumn(db, "notes", "project_id")) {
          db.exec(`ALTER TABLE notes ADD COLUMN project_id TEXT DEFAULT NULL`);
        }
        db.exec(
          `CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id) WHERE project_id IS NOT NULL`
        );
      }
    },
  },
  {
    id: 86,
    name: "add_token_project_scope",
    up: (db) => {
      // Project-scoped tokens: restricts an observer token to specific projects.
      // A row in token_projects means "this token may access this project."
      // No rows = full fleet access (backward compatible).
      if (!hasTable(db, "token_projects")) {
        db.exec(`
          CREATE TABLE token_projects (
            token_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            PRIMARY KEY (token_id, project_id)
          )
        `);
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Get already applied migrations
  const applied = new Set(
    (db.prepare(`SELECT id FROM _migrations`).all() as { id: number }[]).map(
      (r) => r.id
    )
  );

  // Use INSERT OR IGNORE to handle concurrent workers
  const insertMigration = db.prepare(
    `INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)`
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    try {
      migration.up(db);
      const result = insertMigration.run(migration.id, migration.name);
      if (result.changes > 0) {
        console.log(`Migration ${migration.id}: ${migration.name} applied`);
      } else {
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (concurrent apply)`
        );
      }
    } catch (error) {
      // Migrations are written to be idempotent (hasColumn / hasTable / IF NOT
      // EXISTS), but a legacy or externally-modified DB can still have a column /
      // table the guard can't detect. A "duplicate column" / "already exists"
      // there means the schema is effectively present, so record it applied and
      // move on. ANY OTHER error is a genuine migration bug — re-throw it loud
      // rather than silently marking a half-applied migration done.
      const msg = error instanceof Error ? error.message : String(error);
      if (/duplicate column|already exists/i.test(msg)) {
        insertMigration.run(migration.id, migration.name);
        console.log(
          `Migration ${migration.id}: ${migration.name} skipped (schema already present)`
        );
      } else {
        console.error(
          `Migration ${migration.id}: ${migration.name} failed:`,
          error
        );
        throw error;
      }
    }
  }
}
