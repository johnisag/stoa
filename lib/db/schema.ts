import type Database from "better-sqlite3";
import { ensureSessionLaunchProfileSchema } from "./session-launch-profile-schema";

const SAFE_FLEET_AUTOMATION_POLICY_JSON =
  '{"version":1,"automaticPlanning":false,"automaticPlanApproval":false,"automaticStart":false,"automaticFixes":false,"maxAutomaticFixRounds":0,"automaticMerge":false,"mergeTarget":"github_pr","allowSensitivePaths":false,"allowUnconfinedAgents":false,"plannerTaskCap":8,"cleanupPolicy":"preserve","retentionDays":null}';

interface SchemaColumnRepair {
  name: string;
  ddl: string;
}

function hasTable(db: Database.Database, table: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .all(table) as { name: string }[];
  return rows.length > 0;
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

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: SchemaColumnRepair
): void {
  if (!hasColumn(db, table, column.name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
  }
}

function repairPartialFleetManagementSchema(db: Database.Database): void {
  if (hasTable(db, "fleet_runs")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "name", ddl: "name TEXT NOT NULL DEFAULT ''" },
      { name: "goal", ddl: "goal TEXT NOT NULL DEFAULT ''" },
      { name: "repo_id", ddl: "repo_id TEXT" },
      { name: "project_id", ddl: "project_id TEXT" },
      { name: "source_kind", ddl: "source_kind TEXT" },
      { name: "source_id", ddl: "source_id TEXT" },
      { name: "source_name", ddl: "source_name TEXT" },
      { name: "status", ddl: "status TEXT NOT NULL DEFAULT 'draft'" },
      { name: "budget_usd", ddl: "budget_usd REAL" },
      { name: "provider", ddl: "provider TEXT NOT NULL DEFAULT 'claude'" },
      { name: "model", ddl: "model TEXT" },
      {
        name: "max_concurrency",
        ddl: "max_concurrency INTEGER NOT NULL DEFAULT 1",
      },
      {
        name: "review_policy",
        ddl: "review_policy TEXT NOT NULL DEFAULT 'four_agent'",
      },
      {
        name: "approval_state",
        ddl: "approval_state TEXT NOT NULL DEFAULT 'draft'",
      },
      { name: "plan_hash", ddl: "plan_hash TEXT" },
      { name: "approved_plan_hash", ddl: "approved_plan_hash TEXT" },
      { name: "approved_by", ddl: "approved_by TEXT" },
      { name: "approved_at", ddl: "approved_at TEXT" },
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
      { name: "archived_at", ddl: "archived_at TEXT" },
      { name: "archived_by", ddl: "archived_by TEXT" },
      { name: "retention_days", ddl: "retention_days INTEGER" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "ended_at", ddl: "ended_at TEXT" },
      {
        name: "settings_json",
        ddl: "settings_json TEXT NOT NULL DEFAULT '{}'",
      },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_runs", column);
    }
    db.exec(`
      UPDATE fleet_runs
      SET created_at = datetime('now')
      WHERE created_at IS NULL OR created_at = '';

      UPDATE fleet_runs
      SET updated_at = created_at
      WHERE updated_at IS NULL OR updated_at = '';
    `);
  }

  if (hasTable(db, "fleet_tasks")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "parent_task_id", ddl: "parent_task_id TEXT" },
      { name: "title", ddl: "title TEXT NOT NULL DEFAULT ''" },
      { name: "description", ddl: "description TEXT" },
      { name: "status", ddl: "status TEXT NOT NULL DEFAULT 'draft'" },
      { name: "task_type", ddl: "task_type TEXT NOT NULL DEFAULT 'planning'" },
      { name: "sort_order", ddl: "sort_order INTEGER NOT NULL DEFAULT 0" },
      {
        name: "file_claims_json",
        ddl: "file_claims_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "source_ref", ddl: "source_ref TEXT" },
      { name: "source_step_id", ddl: "source_step_id TEXT" },
      { name: "source_issue_id", ddl: "source_issue_id TEXT" },
      { name: "source_issue_number", ddl: "source_issue_number INTEGER" },
      { name: "priority", ddl: "priority INTEGER NOT NULL DEFAULT 0" },
      { name: "agent_type", ddl: "agent_type TEXT" },
      { name: "model", ddl: "model TEXT" },
      { name: "working_directory", ddl: "working_directory TEXT" },
      { name: "base_branch", ddl: "base_branch TEXT" },
      { name: "branch_name", ddl: "branch_name TEXT" },
      { name: "worktree_path", ddl: "worktree_path TEXT" },
      { name: "base_sha", ddl: "base_sha TEXT" },
      { name: "head_sha", ddl: "head_sha TEXT" },
      {
        name: "actual_file_claims_json",
        ddl: "actual_file_claims_json TEXT NOT NULL DEFAULT '[]'",
      },
      { name: "report_artifact_id", ddl: "report_artifact_id TEXT" },
      { name: "diff_artifact_id", ddl: "diff_artifact_id TEXT" },
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
      { name: "review_status", ddl: "review_status TEXT" },
      { name: "review_head_sha", ddl: "review_head_sha TEXT" },
      {
        name: "review_verification_hash",
        ddl: "review_verification_hash TEXT",
      },
      { name: "review_completed_at", ddl: "review_completed_at TEXT" },
      { name: "fix_rounds", ddl: "fix_rounds INTEGER NOT NULL DEFAULT 0" },
      { name: "active_fix_id", ddl: "active_fix_id TEXT" },
      { name: "fixer_session_id", ddl: "fixer_session_id TEXT" },
      { name: "fix_error", ddl: "fix_error TEXT" },
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
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_tasks", column);
    }
  }

  if (hasTable(db, "fleet_workers")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "task_id", ddl: "task_id TEXT" },
      { name: "session_id", ddl: "session_id TEXT" },
      {
        name: "status",
        ddl: "status TEXT NOT NULL DEFAULT 'waiting_for_operator'",
      },
      { name: "provider", ddl: "provider TEXT" },
      { name: "model", ddl: "model TEXT" },
      { name: "attempt", ddl: "attempt INTEGER NOT NULL DEFAULT 1" },
      { name: "spawn_request_id", ddl: "spawn_request_id TEXT" },
      { name: "worktree_path", ddl: "worktree_path TEXT" },
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
      { name: "lease_owner", ddl: "lease_owner TEXT" },
      { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
      {
        name: "reservation_usd",
        ddl: "reservation_usd REAL NOT NULL DEFAULT 0",
      },
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
      { name: "rendered_status", ddl: "rendered_status TEXT" },
      {
        name: "rendered_status_summary",
        ddl: "rendered_status_summary TEXT",
      },
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
      { name: "terminal_cause", ddl: "terminal_cause TEXT" },
      { name: "failure_code", ddl: "failure_code TEXT" },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
      { name: "last_heartbeat_at", ddl: "last_heartbeat_at TEXT" },
      { name: "ended_at", ddl: "ended_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_workers", column);
    }
  }

  if (hasTable(db, "fleet_artifacts")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "task_id", ddl: "task_id TEXT" },
      { name: "worker_id", ddl: "worker_id TEXT" },
      { name: "attempt", ddl: "attempt INTEGER" },
      { name: "plan_hash", ddl: "plan_hash TEXT" },
      { name: "base_sha", ddl: "base_sha TEXT" },
      { name: "head_sha", ddl: "head_sha TEXT" },
      { name: "content_hash", ddl: "content_hash TEXT" },
      {
        name: "metadata_json",
        ddl: "metadata_json TEXT NOT NULL DEFAULT '{}'",
      },
      { name: "byte_count", ddl: "byte_count INTEGER NOT NULL DEFAULT 0" },
      {
        name: "artifact_type",
        ddl: "artifact_type TEXT NOT NULL DEFAULT 'critic_finding'",
      },
      { name: "title", ddl: "title TEXT NOT NULL DEFAULT ''" },
      { name: "body", ddl: "body TEXT NOT NULL DEFAULT ''" },
      { name: "severity", ddl: "severity TEXT NOT NULL DEFAULT 'warning'" },
      { name: "actor", ddl: "actor TEXT NOT NULL DEFAULT 'critic'" },
      { name: "body_pruned_at", ddl: "body_pruned_at TEXT" },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_artifacts", column);
    }
    db.exec(`
      UPDATE fleet_artifacts
      SET created_at = datetime('now')
      WHERE created_at IS NULL OR created_at = '';
    `);
  }

  if (hasTable(db, "fleet_action_authorizations")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      { name: "action", ddl: "action TEXT NOT NULL DEFAULT 'planning'" },
      { name: "status", ddl: "status TEXT NOT NULL DEFAULT 'authorized'" },
      { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
      { name: "plan_hash", ddl: "plan_hash TEXT" },
      { name: "execution_hash", ddl: "execution_hash TEXT" },
      { name: "base_sha", ddl: "base_sha TEXT" },
      {
        name: "granted_by",
        ddl: "granted_by TEXT NOT NULL DEFAULT 'operator'",
      },
      { name: "granted_at", ddl: "granted_at TEXT NOT NULL DEFAULT ''" },
      { name: "consumed_by", ddl: "consumed_by TEXT" },
      { name: "consumed_at", ddl: "consumed_at TEXT" },
      {
        name: "attempt_count",
        ddl: "attempt_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "last_error", ddl: "last_error TEXT" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
    ]) {
      addColumnIfMissing(db, "fleet_action_authorizations", column);
    }
  }

  if (hasTable(db, "fleet_reviews")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
      {
        name: "subject_type",
        ddl: "subject_type TEXT NOT NULL DEFAULT 'plan'",
      },
      { name: "subject_hash", ddl: "subject_hash TEXT NOT NULL DEFAULT ''" },
      { name: "policy_hash", ddl: "policy_hash TEXT NOT NULL DEFAULT ''" },
      {
        name: "execution_hash",
        ddl: "execution_hash TEXT NOT NULL DEFAULT ''",
      },
      { name: "base_sha", ddl: "base_sha TEXT NOT NULL DEFAULT ''" },
      { name: "lens", ddl: "lens TEXT NOT NULL DEFAULT ''" },
      { name: "provider", ddl: "provider TEXT" },
      { name: "model", ddl: "model TEXT" },
      {
        name: "launch_failure_count",
        ddl: "launch_failure_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "retry_not_before", ddl: "retry_not_before TEXT" },
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
      addColumnIfMissing(db, "fleet_reviews", column);
    }
  }

  if (hasTable(db, "fleet_verifications")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      {
        name: "fleet_run_id",
        ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''",
      },
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
  }

  if (hasTable(db, "fleet_task_reviews")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
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
      { name: "provider", ddl: "provider TEXT" },
      { name: "model", ddl: "model TEXT" },
      {
        name: "launch_failure_count",
        ddl: "launch_failure_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "retry_not_before", ddl: "retry_not_before TEXT" },
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
      { name: "id", ddl: "id TEXT" },
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
      { name: "provider", ddl: "provider TEXT" },
      { name: "model", ddl: "model TEXT" },
      {
        name: "launch_failure_count",
        ddl: "launch_failure_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "retry_not_before", ddl: "retry_not_before TEXT" },
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

  if (hasTable(db, "fleet_merge_operations")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
      { name: "operation_key", ddl: "operation_key TEXT NOT NULL DEFAULT ''" },
      { name: "fleet_run_id", ddl: "fleet_run_id TEXT NOT NULL DEFAULT ''" },
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
  }

  if (hasTable(db, "fleet_cleanup_actions")) {
    for (const column of [
      { name: "id", ddl: "id TEXT" },
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
      {
        name: "attempt_count",
        ddl: "attempt_count INTEGER NOT NULL DEFAULT 0",
      },
      { name: "lease_owner", ddl: "lease_owner TEXT" },
      { name: "lease_expires_at", ddl: "lease_expires_at TEXT" },
      { name: "error", ddl: "error TEXT" },
      {
        name: "metadata_json",
        ddl: "metadata_json TEXT NOT NULL DEFAULT '{}'",
      },
      { name: "created_at", ddl: "created_at TEXT NOT NULL DEFAULT ''" },
      { name: "updated_at", ddl: "updated_at TEXT NOT NULL DEFAULT ''" },
      { name: "started_at", ddl: "started_at TEXT" },
      { name: "completed_at", ddl: "completed_at TEXT" },
    ]) {
      addColumnIfMissing(db, "fleet_cleanup_actions", column);
    }
  }
}

export function createSchema(db: Database.Database): void {
  repairPartialFleetManagementSchema(db);

  db.exec(`
    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'idle',
      working_directory TEXT NOT NULL DEFAULT '~',
      parent_session_id TEXT,
      claude_session_id TEXT,
      model TEXT DEFAULT 'sonnet',
      system_prompt TEXT,
      group_path TEXT NOT NULL DEFAULT 'sessions',
      agent_type TEXT NOT NULL DEFAULT 'claude',
      -- Orchestration columns (migration 3, 4, 6, 7, 9)
      worktree_path TEXT,
      branch_name TEXT,
      base_branch TEXT,
      dev_server_port INTEGER,
      pr_url TEXT,
      pr_number INTEGER,
      pr_status TEXT,
      conductor_session_id TEXT REFERENCES sessions(id),
      worker_task TEXT,
      worker_status TEXT,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      -- #27 tri-state launch tier (mirrors migration 53). NULL → the launch
      -- resolver derives it from auto_approve (fail-closed).
      approval_mode TEXT,
      project_id TEXT REFERENCES projects(id),
      tmux_name TEXT,
      worktree_paths TEXT,
      mcp_launch_args TEXT,
      -- Internal one-shot sessions (for example the managed Fleet supervisor)
      -- have an immutable, non-generic launch identity. Ordinary user sessions
      -- keep the default role and no profile.
      session_role TEXT NOT NULL DEFAULT 'interactive',
      launch_profile_json TEXT,
      launch_profile_hash TEXT,
      -- JSON TokenUsage of the parent's cumulative usage at fork time (#1): a
      -- native Claude fork inherits the parent's transcript, so the cost path nets
      -- this baseline out. NULL for non-forks. (migration 44)
      fork_cost_baseline TEXT,
      -- #19 outcome-based verify badge (migration 47): the last turn-boundary
      -- verify verdict (running/pass/fail/error), its bounded failing-step
      -- output tail, and when it ran. Turn-scoped — cleared when a new turn starts.
      verify_status TEXT,
      verify_output TEXT,
      verify_ran_at TEXT,
      -- #21 (migration 49): a lifetime USD budget cap for this session (80/100%
      -- alerts + opt-in fail-closed park at the cap). NULL = no budget.
      budget_usd REAL,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
    );

    -- Groups table for organizing sessions
    CREATE TABLE IF NOT EXISTS groups (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expanded INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Default group
    INSERT OR IGNORE INTO groups (path, name, sort_order) VALUES ('sessions', 'Sessions', 0);

    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Tool calls table (linked to messages)
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      tool_result TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Dev servers table
    CREATE TABLE IF NOT EXISTS dev_servers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'node',
      name TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'stopped',
      pid INTEGER,
      container_id TEXT,
      ports TEXT NOT NULL DEFAULT '[]',
      working_directory TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Projects table (replaces groups)
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'claude',
      default_model TEXT NOT NULL DEFAULT 'sonnet',
      initial_prompt TEXT,
      -- #19 (migration 47): the project's verify command (typecheck/test/build),
      -- run at each session turn boundary for the verify badge. Stoa's no-shell
      -- grammar (parseVerifySteps): steps chained with &&, no shell metachars.
      verify_command TEXT,
      expanded INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_uncategorized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Project dev servers (configuration templates)
    CREATE TABLE IF NOT EXISTS project_dev_servers (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'node',
      command TEXT NOT NULL,
      port INTEGER,
      port_env_var TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Project startup commands (#14b): run on new-session boot to warm the
    -- worktree beyond npm install (build, codegen, db migrate). Safe-exec only:
    -- tokenizeCommand-validated at the API, spawned as argv (never a shell string).
    CREATE TABLE IF NOT EXISTS project_startup_commands (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Project repositories (for multi-repo git support)
    CREATE TABLE IF NOT EXISTS project_repositories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    -- Dispatch: tracked repos for GitHub-issue → agent-fleet ingestion
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
      review_gate INTEGER NOT NULL DEFAULT 0,
      ci_autofix INTEGER NOT NULL DEFAULT 0,
      merge_train INTEGER NOT NULL DEFAULT 0,
      verify_gate INTEGER NOT NULL DEFAULT 0,
      verify_command TEXT,
      -- #26 LLM-as-judge rubric gate (migration 50): opt-in binary rubric judge
      -- over each PR diff, gating auto-merge alongside review/verify.
      judge_gate INTEGER NOT NULL DEFAULT 0,
      -- #20 cost-aware routing (migration 48): pin this repo's dispatch workers
      -- to an economical catalog model (e.g. haiku). NULL = agent default.
      default_model TEXT,
      -- Autonomous maintainer (opt-in, default off): on a cadence, a survey agent
      -- proposes its OWN backlog against the goal. Proposals are NEVER auto-
      -- dispatched (the issue_dispatches.maintainer_proposed fence) — they wait for
      -- one-tap Approve. cadence is 'hourly'|'daily'|'weekly' (recurrence.ts).
      maintainer_survey_enabled INTEGER NOT NULL DEFAULT 0,
      maintainer_survey_goal TEXT,
      maintainer_survey_cadence TEXT,
      maintainer_survey_last_at TEXT,
      project_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    );

    -- Dispatch: one row per ingested issue (a pending candidate or a live worker)
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
      scheduled_at TEXT,
      reviewer_session_id TEXT,
      review_decision TEXT,
      -- PR head SHA the cached panel verdict is pinned to. Set when a complete
      -- verdict is cached; cleared on re-review / retry. Auto-merge passes this to
      -- gh --match-head-commit so a push after approval cannot merge unreviewed code.
      review_sha TEXT,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      fixer_session_id TEXT,
      auto_merge INTEGER NOT NULL DEFAULT 0,
      ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
      ci_fixer_session_id TEXT,
      rebase_rounds INTEGER NOT NULL DEFAULT 0,
      rebase_fixer_session_id TEXT,
      verify_status TEXT,
      verify_output TEXT,
      verify_sha TEXT,
      verify_ran_at TEXT,
      -- #26 (migration 50): the rubric judge's SHA-pinned verdict trio.
      judge_status TEXT,
      judge_output TEXT,
      judge_sha TEXT,
      judge_ran_at TEXT,
      file_claims TEXT,
      -- Intake source: 'github' (a real issue, issue_number > 0) or 'local' (a
      -- freeform task typed into Stoa, issue_number 0 + task_body). The reconciler
      -- drains both identically; only the worker prompt + the dedupe index differ.
      source TEXT NOT NULL DEFAULT 'github',
      task_body TEXT,
      -- Recurrence for a scheduled LOCAL task ('hourly'|'daily'|'weekly'); null =
      -- one-shot. On promotion the reconciler re-arms the next occurrence.
      recurrence TEXT,
      -- 1 = proposed by the autonomous maintainer survey. The fail-closed fence:
      -- the auto-dispatch loop excludes these, so a maintainer proposal is NEVER
      -- auto-shipped (even on an auto-mode repo) — it waits for one-tap Approve.
      maintainer_proposed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );

    -- Append-only audit / event ledger (one row per recorded session event).
    -- Independent of the sessions row (no FK) ON PURPOSE: the trail must outlive
    -- a deleted session — that's the audit-moat value AND the analytics substrate.
    -- session_key is the BACKEND key (e.g. "claude-<uuid>"), not sessions.id.
    -- created_at is epoch MILLIS (integer) for cheap ordering + duration math.
    CREATE TABLE IF NOT EXISTS session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    -- Session "go to auto": enrol a running session's PR into the dispatch
    -- ceremony (critic panel → fix loop → CI auto-fix → auto-merge). One per
    -- session (UNIQUE). The PR/worktree/branch live on the session row; this
    -- mirrors only the review/CI progress fields of issue_dispatches.
    CREATE TABLE IF NOT EXISTS session_ceremonies (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      step TEXT NOT NULL DEFAULT 'queued',
      seed_prompt TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      reviewer_session_id TEXT,
      review_decision TEXT,
      review_sha TEXT,
      auto_merge INTEGER NOT NULL DEFAULT 0,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      fixer_session_id TEXT,
      ci_fix_rounds INTEGER NOT NULL DEFAULT 0,
      ci_fixer_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Fleet memory: per-repo ledger of blocking critic findings. Injected (recent
    -- N) into every new worker's prompt so the fleet stops repeating mistakes.
    CREATE TABLE IF NOT EXISTS repo_lessons (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      lens TEXT,
      text TEXT NOT NULL,
      -- 'auto' = captured from a blocking critic finding; 'manual' = an
      -- operator-curated rule (survives "forget findings"). Both are injected.
      source TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE
    );

    -- Project Playbooks + auto-recalled Knowledge (#13). A playbook is a named,
    -- reusable prompt snippet. Two uses from one row: SELECT it as a recipe (its body
    -- seeds a new session's prompt), or set pinned=1 with a project so its body is
    -- AUTO-prepended to every session in that project (curated per-project knowledge).
    -- project_id NULL = a global recipe available everywhere (can't be pinned).
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
    CREATE INDEX IF NOT EXISTS idx_playbooks_project ON playbooks(project_id);

    -- Agent-accessible shared memory: a fleet-wide key→value scratchpad any agent
    -- can read/write via the orchestration MCP server (memory_* tools) or the
    -- /api/memory route — the SAME shared surface a human UI would call.
    -- Use it to coordinate across worktrees ("the interface contract is X",
    -- "don't touch file Y", a discovered gotcha). Distinct from repo_lessons
    -- (Dispatch-only critic findings): this is general, agent-writable, pull-based
    -- (an agent reads a key on demand — never auto-injected into a terminal).
    CREATE TABLE IF NOT EXISTS agent_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Notes / shared knowledge base: persistent markdown docs any agent or human
    -- can read/write (the SAME /api/notes route the UI uses + notes_* MCP tools).
    -- "Notes = things to read" (vs the Dispatch board = things to do). Fleet-shared
    -- + pinnable; a handoff/scratchpad doc for cross-worktree coordination.
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Inter-agent channels: persistent 1:1 messages between two sessions, an
    -- append-only log read/written via the SAME /api/channels route the channel_*
    -- MCP tools call. pair_key is the order-independent thread id (sorted
    -- "a__b") so both directions group into one conversation. read_at is set when
    -- the recipient consumes the message (a channel_inbox pull, or an opt-in
    -- turn-boundary terminal delivery); delivered_at records that opt-in push
    -- specifically. Distinct from agent_memory (key→value) / notes (docs): this is
    -- directed, point-to-point coordination between sibling workers.
    CREATE TABLE IF NOT EXISTS channel_messages (
      id TEXT PRIMARY KEY,
      pair_key TEXT NOT NULL,
      from_session_id TEXT NOT NULL,
      to_session_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT,
      read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_messages_inbox
      ON channel_messages (to_session_id, read_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
      ON channel_messages (pair_key, created_at);

    -- General-purpose scheduler: fire a prompt into a session on a cadence (once
    -- at a time, or hourly/daily/weekly), the basis for "AI coding while you
    -- sleep" — a nightly test run, a scheduled summary, a periodic nudge. At the
    -- due time the server ENQUEUES the prompt into the target session's prompt
    -- queue, so it's delivered by the SAME safe turn-boundary path a typed-ahead
    -- prompt uses (no new injection surface). Distinct from a Dispatch scheduled
    -- LOCAL task (a GitHub-issue→PR run): this just sends text to a live session.
    -- No FK on session_id (like channel_messages): the scheduler tick disables a
    -- schedule whose target session is gone (app-level lifecycle, keeping it
    -- visible/recoverable) rather than cascade-deleting it out from under the user.
    CREATE TABLE IF NOT EXISTS schedules (
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
    );
    CREATE INDEX IF NOT EXISTS idx_schedules_due
      ON schedules (enabled, next_run_at);

    -- Persisted token/cost samples (#15): cost was recomputed from the live
    -- transcript per request, so analytics had no history and a sample died with
    -- the session (deletion / transcript scroll-off). One row per (session_key,
    -- day) = the session's cumulative usage as last sampled that UTC day, upserted
    -- idempotently. session_key is the canonical backend key (tmux_name, else
    -- {provider}-{id}) — matching session_events.session_key — so same-named pty
    -- sessions don't collide. Best-effort: written when costs are computed (cost
    -- badge / opt-in STOA_AUTO_COST_SAMPLE tick), never on a hot path.
    CREATE TABLE IF NOT EXISTS session_costs (
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
    );
    CREATE INDEX IF NOT EXISTS idx_session_costs_day
      ON session_costs (day);

    -- Saved visual-builder workflows (spec + canvas positions, as JSON)
    CREATE TABLE IF NOT EXISTS saved_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      builder_doc TEXT NOT NULL DEFAULT '{}',
      history TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Best-of-N: run N parallel agent sessions on the same task in isolated
    -- worktrees, compare their diffs, and pick one winner. Loser sessions and
    -- worktrees are cleaned up on pick.
    CREATE TABLE IF NOT EXISTS best_of_n_runs (
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
    );

    CREATE TABLE IF NOT EXISTS best_of_n_candidates (
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
    );

    -- Fleet Management (Phase 1): durable draft runs and read-only graph data.
    -- No scheduler or worker launch path is wired in this phase.
    CREATE TABLE IF NOT EXISTS fleet_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      goal TEXT NOT NULL,
      repo_id TEXT,
      project_id TEXT,
      source_kind TEXT,
      source_id TEXT,
      source_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      budget_usd REAL,
      budget_tokens INTEGER,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      review_policy TEXT NOT NULL DEFAULT 'four_agent',
      approval_state TEXT NOT NULL DEFAULT 'draft',
      plan_hash TEXT,
      approved_plan_hash TEXT,
      approved_by TEXT,
      approved_at TEXT,
      desired_state TEXT NOT NULL DEFAULT 'draft',
      automation_policy_version INTEGER NOT NULL DEFAULT 1,
      automation_policy_json TEXT NOT NULL DEFAULT '${SAFE_FLEET_AUTOMATION_POLICY_JSON}',
      automation_policy_hash TEXT,
      automation_granted_by TEXT,
      automation_granted_at TEXT,
      automation_base_sha TEXT,
      automation_last_error TEXT,
      merge_requested_at TEXT,
      merge_requested_by TEXT,
      merge_request_kind TEXT,
      merge_target TEXT,
      integration_state TEXT NOT NULL DEFAULT 'idle',
      integration_branch TEXT,
      integration_worktree TEXT,
      integration_base_sha TEXT,
      integration_head_sha TEXT,
      integration_pr_number INTEGER,
      integration_pr_url TEXT,
      integration_pr_head_sha TEXT,
      integration_merge_sha TEXT,
      integration_error TEXT,
      integration_updated_at TEXT,
      conductor_session_id TEXT,
      scheduler_epoch INTEGER NOT NULL DEFAULT 0,
      recovery_required INTEGER NOT NULL DEFAULT 0,
      reserved_budget_usd REAL NOT NULL DEFAULT 0,
      spent_budget_usd REAL NOT NULL DEFAULT 0,
      reserved_budget_tokens INTEGER NOT NULL DEFAULT 0,
      spent_budget_tokens INTEGER NOT NULL DEFAULT 0,
      cost_confidence TEXT NOT NULL DEFAULT 'unknown',
      budget_stop_mode TEXT NOT NULL DEFAULT 'pause-new',
      budget_warning_threshold REAL NOT NULL DEFAULT 0.8,
      budget_warning_emitted_at TEXT,
      budget_hard_limit_at TEXT,
      budget_interrupt_deadline_at TEXT,
      managed_supervisor_poll_cursor INTEGER NOT NULL DEFAULT 0,
      scheduler_poll_cursor INTEGER NOT NULL DEFAULT 0,
      provider_caps_json TEXT NOT NULL DEFAULT '{}',
      resource_limits_json TEXT NOT NULL DEFAULT '{}',
      default_max_attempts INTEGER NOT NULL DEFAULT 2,
      pause_mode TEXT,
      pause_reason TEXT,
      cancel_mode TEXT,
      archived_at TEXT,
      archived_by TEXT,
      retention_days INTEGER,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      ended_at TEXT,
      FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE SET NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
      FOREIGN KEY (conductor_session_id) REFERENCES sessions(id) ON DELETE SET NULL
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
      source_ref TEXT,
      source_step_id TEXT,
      source_issue_id TEXT,
      source_issue_number INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      agent_type TEXT,
      model TEXT,
      working_directory TEXT,
      base_branch TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      base_sha TEXT,
      head_sha TEXT,
      actual_file_claims_json TEXT NOT NULL DEFAULT '[]',
      report_artifact_id TEXT,
      diff_artifact_id TEXT,
      verification_id TEXT,
      verification_status TEXT,
      verification_spec_hash TEXT,
      verified_head_sha TEXT,
      verification_artifact_id TEXT,
      verification_started_at TEXT,
      verification_completed_at TEXT,
      review_status TEXT,
      review_head_sha TEXT,
      review_verification_hash TEXT,
      review_completed_at TEXT,
      fix_rounds INTEGER NOT NULL DEFAULT 0,
      active_fix_id TEXT,
      fixer_session_id TEXT,
      fix_error TEXT,
      integration_state TEXT NOT NULL DEFAULT 'pending',
      integration_operation_id TEXT,
      integrated_head_sha TEXT,
      integrated_at TEXT,
      retry_not_before TEXT,
      provider_failure_count INTEGER NOT NULL DEFAULT 0,
      provider_state TEXT NOT NULL DEFAULT 'ready',
      provider_last_error TEXT,
      provider_backoff_event_at TEXT,
      max_attempts INTEGER NOT NULL DEFAULT 2,
      current_attempt INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_expires_at TEXT,
      scheduler_epoch INTEGER NOT NULL DEFAULT 0,
      spawn_request_id TEXT,
      acceptance_criteria TEXT,
      risk_notes_json TEXT NOT NULL DEFAULT '[]',
      verify_command TEXT,
      approved_task_hash TEXT,
      approval_state TEXT NOT NULL DEFAULT 'draft',
      failure_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      ended_at TEXT,
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
      spawn_request_id TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      base_sha TEXT,
      head_sha TEXT,
      report_path TEXT,
      report_nonce_hash TEXT,
      report_state TEXT NOT NULL DEFAULT 'legacy',
      report_status TEXT,
      report_submitted_at TEXT,
      report_collected_at TEXT,
      report_bytes INTEGER NOT NULL DEFAULT 0,
      actual_claims_json TEXT NOT NULL DEFAULT '[]',
      diff_summary_json TEXT,
      report_poll_count INTEGER NOT NULL DEFAULT 0,
      report_last_polled_at TEXT,
      report_next_poll_at TEXT,
      report_error TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      reservation_usd REAL NOT NULL DEFAULT 0,
      reservation_tokens INTEGER NOT NULL DEFAULT 0,
      reservation_confidence TEXT NOT NULL DEFAULT 'unknown',
      reservation_basis TEXT,
      actual_cost_usd REAL,
      actual_tokens INTEGER,
      cost_confidence TEXT NOT NULL DEFAULT 'unknown',
      cost_reconciled_at TEXT,
      interrupt_requested_at TEXT,
      interrupt_deadline_at TEXT,
      interrupt_notice_state TEXT NOT NULL DEFAULT 'unattempted',
      interrupt_stop_state TEXT NOT NULL DEFAULT 'unattempted',
      interrupt_cause TEXT,
      rendered_status TEXT,
      rendered_status_summary TEXT,
      rendered_status_summary_redacted INTEGER NOT NULL DEFAULT 0,
      rendered_status_replacement_count INTEGER NOT NULL DEFAULT 0,
      rendered_status_stability_count INTEGER NOT NULL DEFAULT 0,
      rendered_status_last_captured_at TEXT,
      rendered_status_next_capture_at TEXT,
      rendered_status_error TEXT,
      terminal_cause TEXT,
      failure_code TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_heartbeat_at TEXT,
      ended_at TEXT,
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS fleet_task_dependencies (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      dependency_type TEXT NOT NULL DEFAULT 'blocks',
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on_task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE,
      UNIQUE (fleet_run_id, task_id, depends_on_task_id, dependency_type)
    );

    CREATE TABLE IF NOT EXISTS fleet_task_claims (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      path TEXT NOT NULL,
      claim_type TEXT NOT NULL DEFAULT 'exclusive',
      confidence REAL NOT NULL DEFAULT 1.0,
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE CASCADE
    );

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
      sample_attempt_cursor INTEGER NOT NULL DEFAULT 0,
      fallback_recovery_cursor INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS fleet_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fleet_artifacts (
      id TEXT PRIMARY KEY,
      fleet_run_id TEXT NOT NULL,
      task_id TEXT,
      worker_id TEXT,
      attempt INTEGER,
      plan_hash TEXT,
      base_sha TEXT,
      head_sha TEXT,
      content_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      byte_count INTEGER NOT NULL DEFAULT 0,
      artifact_type TEXT NOT NULL DEFAULT 'critic_finding',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      actor TEXT NOT NULL DEFAULT 'critic',
      body_pruned_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fleet_run_id) REFERENCES fleet_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES fleet_tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (worker_id) REFERENCES fleet_workers(id) ON DELETE SET NULL
    );

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
      provider TEXT,
      model TEXT,
      launch_failure_count INTEGER NOT NULL DEFAULT 0,
      retry_not_before TEXT,
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
    );

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
      provider TEXT,
      model TEXT,
      launch_failure_count INTEGER NOT NULL DEFAULT 0,
      retry_not_before TEXT,
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
      provider TEXT,
      model TEXT,
      launch_failure_count INTEGER NOT NULL DEFAULT 0,
      retry_not_before TEXT,
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
    );

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
    );

    -- Scoped server capabilities for direct Fleet MCP actions. Only the token's
    -- SHA-256 digest is durable. There is intentionally no run FK: fleet:create
    -- reserves its exact run id before the run exists, and audit must survive
    -- lifecycle cleanup.
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
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_repo_lessons_repo ON repo_lessons(repo_id);
    CREATE INDEX IF NOT EXISTS idx_saved_workflows_updated ON saved_workflows(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_events_key ON session_events(session_key);
    CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type);
    CREATE INDEX IF NOT EXISTS idx_session_events_key_type_id ON session_events(session_key, event_type, id);
    CREATE INDEX IF NOT EXISTS idx_session_events_created ON session_events(created_at);
    -- Dedupe real GitHub issues only (number > 0); local tasks use issue_number 0
    -- and must NOT collide, so they're excluded from the uniqueness via a partial index.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_repo_issue ON issue_dispatches(repo_id, issue_number) WHERE issue_number > 0;
    CREATE INDEX IF NOT EXISTS idx_dispatch_status ON issue_dispatches(status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_repo ON issue_dispatches(repo_id);
    CREATE INDEX IF NOT EXISTS idx_dispatch_repo_status ON issue_dispatches(repo_id, status);
    CREATE INDEX IF NOT EXISTS idx_dispatch_dispatched_at ON issue_dispatches(dispatched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_ceremonies_step ON session_ceremonies(step);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_path);
    CREATE INDEX IF NOT EXISTS idx_sessions_conductor ON sessions(conductor_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session_timestamp ON tool_calls(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_message_timestamp ON tool_calls(message_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_project_dev_servers_project ON project_dev_servers(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_startup_commands_project ON project_startup_commands(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_repositories_project ON project_repositories(project_id);
    CREATE INDEX IF NOT EXISTS idx_dev_servers_project ON dev_servers(project_id);
    CREATE INDEX IF NOT EXISTS idx_bon_runs_project ON best_of_n_runs(project_id);
    CREATE INDEX IF NOT EXISTS idx_bon_candidates_run ON best_of_n_candidates(run_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_runs_status ON fleet_runs(status);
    CREATE INDEX IF NOT EXISTS idx_fleet_runs_updated ON fleet_runs(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fleet_runs_source ON fleet_runs(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_run ON fleet_tasks(fleet_run_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_source ON fleet_tasks(fleet_run_id, source_step_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_source_issue ON fleet_tasks(source_issue_id) WHERE source_issue_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_schedule ON fleet_tasks(fleet_run_id, status, priority DESC, sort_order);
    CREATE INDEX IF NOT EXISTS idx_fleet_tasks_retry ON fleet_tasks(fleet_run_id, status, retry_not_before);
    CREATE INDEX IF NOT EXISTS idx_fleet_dependencies_task ON fleet_task_dependencies(fleet_run_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_dependencies_upstream ON fleet_task_dependencies(fleet_run_id, depends_on_task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_claims_path ON fleet_task_claims(fleet_run_id, path);
    CREATE INDEX IF NOT EXISTS idx_fleet_resource_leases_active ON fleet_resource_leases(resource_type, resource_key, status);
    CREATE INDEX IF NOT EXISTS idx_fleet_resource_leases_worker ON fleet_resource_leases(worker_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_cost_accounts_session ON fleet_cost_accounts(fleet_run_id, session_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_interrupt ON fleet_cost_accounts(fleet_run_id, interrupt_deadline_at, owner_type) WHERE terminal_at IS NULL AND reservation_released_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_fleet_cost_accounts_history ON fleet_cost_accounts(provider, model, task_id, terminal_at);
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
      ON fleet_provider_cooldowns(blocked_until, provider);
    CREATE INDEX IF NOT EXISTS idx_fleet_workers_run ON fleet_workers(fleet_run_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_workers_status ON fleet_workers(fleet_run_id, status);
    CREATE INDEX IF NOT EXISTS idx_fleet_workers_rendered_status_due
      ON fleet_workers(status, rendered_status_next_capture_at, id);
    CREATE INDEX IF NOT EXISTS idx_fleet_workers_session ON fleet_workers(session_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_workers_report_poll ON fleet_workers(report_state, report_next_poll_at) WHERE report_state = 'pending';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_spawn_request ON fleet_workers(spawn_request_id) WHERE spawn_request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_one_active_task
      ON fleet_workers(fleet_run_id, task_id)
      WHERE status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending');
    CREATE INDEX IF NOT EXISTS idx_fleet_events_run ON fleet_events(fleet_run_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_fleet_artifacts_run ON fleet_artifacts(fleet_run_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_artifacts_worker_attempt_type
      ON fleet_artifacts(worker_id, attempt, artifact_type)
      WHERE worker_id IS NOT NULL AND attempt IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_fleet_verifications_status
      ON fleet_verifications(status, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_verifications_task
      ON fleet_verifications(task_id, attempt, head_sha, spec_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_task_reviews_exact_lens
      ON fleet_task_reviews(
        task_id, attempt, head_sha, verification_id,
        verification_evidence_hash, policy_hash, lens
      );
    CREATE INDEX IF NOT EXISTS idx_fleet_task_reviews_active
      ON fleet_task_reviews(state, fleet_run_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_task_reviews_launch_retry
      ON fleet_task_reviews(state, retry_not_before);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_task_fixes_round
      ON fleet_task_fixes(task_id, attempt, old_head_sha, round, policy_hash);
    CREATE INDEX IF NOT EXISTS idx_fleet_task_fixes_active
      ON fleet_task_fixes(state, fleet_run_id, task_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_task_fixes_launch_retry
      ON fleet_task_fixes(state, retry_not_before);
    CREATE INDEX IF NOT EXISTS idx_fleet_action_authorizations_run
      ON fleet_action_authorizations(fleet_run_id, action, status);
    CREATE INDEX IF NOT EXISTS idx_fleet_reviews_subject
      ON fleet_reviews(fleet_run_id, subject_type, subject_hash);
    CREATE INDEX IF NOT EXISTS idx_fleet_reviews_launch_retry
      ON fleet_reviews(state, retry_not_before);
    CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_queue
      ON fleet_merge_operations(state, lease_expires_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_merge_operations_key
      ON fleet_merge_operations(operation_key);
    CREATE INDEX IF NOT EXISTS idx_fleet_merge_operations_run
      ON fleet_merge_operations(fleet_run_id, created_at, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_key
      ON fleet_cleanup_actions(action_key) WHERE action_key <> '';
    CREATE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_queue
      ON fleet_cleanup_actions(state, lease_expires_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_fleet_cleanup_actions_run
      ON fleet_cleanup_actions(fleet_run_id, created_at, id);
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
    END;

    -- Warm worktree pool: one pre-warmed worktree per dispatch repo so dispatchOne()
    -- can claim an already-set-up worktree instead of waiting for git+npm on demand.
    -- status: warming → ready → (deleted on claim). ON DELETE CASCADE keeps it tidy
    -- when a repo is removed without the pool needing a separate cleanup sweep.
    CREATE TABLE IF NOT EXISTS warm_worktrees (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'warming',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (repo_id) REFERENCES dispatch_repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_warm_worktrees_repo_status ON warm_worktrees(repo_id, status);

    -- #46/#49 per-device named revocable tokens with a scope. Only a SHA-256 hash
    -- of the secret is stored (never plaintext). scope: 'admin' (full) | 'observer'
    -- (read-only spectator). The legacy ~/.stoa/token stays an implicit admin token.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);

    -- #44 Checkpoint / time-travel timeline. Durable metadata pinning a git
    -- shadow-commit snapshot (seq + sha) with a label, transcript anchor
    -- (claude_session_id at capture), kind, and fork lineage. See migration 52.
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
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_parent ON checkpoints(parent_checkpoint_id);

    -- Default Uncategorized project
    INSERT OR IGNORE INTO projects (id, name, working_directory, is_uncategorized, sort_order)
    VALUES ('uncategorized', 'Uncategorized', '~', 1, 999999);
  `);

  // createSchema also runs before migrations when opening an existing database.
  // Keep repair atomic with migration 76 so no process observes half-installed
  // profile columns or a dropped enforcement trigger.
  ensureSessionLaunchProfileSchema(db);
}
