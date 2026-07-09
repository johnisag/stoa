import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const fleetQueries = {
  createFleetRun: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_runs (
        id,
        name,
        goal,
        repo_id,
        project_id,
        budget_usd,
        provider,
        model,
        max_concurrency,
        review_policy,
        settings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  listFleetRuns: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT
        r.id,
        r.name,
        substr(r.goal, 1, 600) AS goal,
        r.repo_id,
        r.project_id,
        r.status,
        r.budget_usd,
        substr(r.provider, 1, 40) AS provider,
        substr(r.model, 1, 120) AS model,
        r.max_concurrency,
        r.review_policy,
        r.approval_state,
        r.plan_hash,
        r.approved_plan_hash,
        r.approved_by,
        r.approved_at,
        r.settings_json,
        r.created_at,
        r.updated_at,
        (SELECT COUNT(*) FROM fleet_tasks t WHERE t.fleet_run_id = r.id) AS task_count,
        (SELECT COUNT(*) FROM fleet_workers w WHERE w.fleet_run_id = r.id) AS worker_count
       FROM fleet_runs r
       ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
       LIMIT ?`
    ),

  getFleetRun: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM fleet_runs WHERE id = ?`),

  createFleetTask: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_tasks (
        id,
        fleet_run_id,
        parent_task_id,
        title,
        description,
        status,
        task_type,
        sort_order,
        file_claims_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  deleteFleetTasksForRun: (db: Database.Database) =>
    getStmt(db, `DELETE FROM fleet_tasks WHERE fleet_run_id = ?`),

  listFleetTasksForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_tasks
       WHERE fleet_run_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    ),

  getFleetTaskForRun: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM fleet_tasks WHERE fleet_run_id = ? AND id = ?`),

  updateFleetTaskStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_tasks
       SET status = ?, updated_at = datetime('now')
       WHERE id = ?
         AND fleet_run_id = ?`
    ),

  cancelOpenFleetTasksForRun: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_tasks
       SET status = 'canceled', updated_at = datetime('now')
       WHERE fleet_run_id = ?
         AND status IN ('draft', 'queued', 'running', 'blocked')`
    ),

  listFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_workers
       WHERE fleet_run_id = ?
       ORDER BY created_at ASC`
    ),

  getFleetWorker: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM fleet_workers WHERE id = ?`),

  countFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM fleet_workers WHERE fleet_run_id = ?`
    ),

  countActiveFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n
       FROM fleet_workers
       WHERE fleet_run_id = ?
          AND status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ),

  countFleetWorkersCreatedTodayForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE r.repo_id = ?
         AND date(w.created_at) = date('now')`
    ),

  countActiveFleetWorkersForRepoExcludingRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE r.repo_id = ?
         AND r.id != ?
          AND w.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ),

  countActiveFleetWorkersForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       WHERE r.repo_id = ?
         AND w.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ),

  listLiveFleetClaimsForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT t.file_claims_json
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       JOIN fleet_tasks t ON t.id = w.task_id
       WHERE r.repo_id = ?
         AND w.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ),

  listLiveFleetClaimsForRepoExcludingRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT t.file_claims_json
       FROM fleet_workers w
       JOIN fleet_runs r ON r.id = w.fleet_run_id
       JOIN fleet_tasks t ON t.id = w.task_id
       WHERE r.repo_id = ?
         AND r.id != ?
         AND w.status IN ('leasing', 'spawning', 'running', 'waiting_for_operator', 'cleanup_pending')`
    ),

  sumFleetWorkerCostForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COALESCE(SUM(COALESCE(c.cost_usd, 0)), 0) AS n
       FROM fleet_workers w
       JOIN session_costs c ON c.session_id = w.session_id
       WHERE w.fleet_run_id = ?`
    ),

  updateFleetRunStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_runs
       SET status = ?, settings_json = ?, updated_at = datetime('now')
       WHERE id = ?`
    ),

  startFleetRunForScheduling: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_runs
       SET status = 'running', settings_json = ?, updated_at = datetime('now')
       WHERE id = ?
         AND status IN ('planned', 'running')
         AND approval_state = 'approved'`
    ),

  createFleetWorkerLease: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_workers (
        id,
        fleet_run_id,
        task_id,
        session_id,
        status,
        provider,
        model,
        attempt,
        lease_token,
        lease_expires_at,
        spawn_error
      ) VALUES (?, ?, ?, NULL, 'leasing', ?, ?, ?, ?, ?, NULL)`
    ),

  markFleetWorkerSpawning: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'spawning',
           lease_expires_at = ?,
           last_heartbeat_at = datetime('now')
       WHERE id = ?
          AND lease_token = ?
         AND status = 'leasing'`
    ),

  markFleetWorkerRunning: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'running',
           session_id = ?,
           lease_token = NULL,
           lease_expires_at = NULL,
           spawn_error = NULL,
           last_heartbeat_at = datetime('now')
        WHERE id = ?
          AND lease_token IS ?
          AND status IN ('leasing', 'spawning')`
    ),

  linkFleetWorkerSession: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET session_id = ?,
           last_heartbeat_at = datetime('now')
       WHERE id = ?
         AND lease_token = ?
         AND status = 'spawning'`
    ),

  markFleetWorkerFailed: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'failed',
           lease_token = NULL,
           lease_expires_at = NULL,
           spawn_error = ?,
           ended_at = datetime('now')
       WHERE id = ?`
    ),

  markFleetWorkerCanceled: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'canceled',
           lease_token = NULL,
           lease_expires_at = NULL,
           spawn_error = ?,
           ended_at = COALESCE(ended_at, datetime('now'))
       WHERE id = ?`
    ),

  markFleetWorkerCanceledForRun: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'canceled',
           lease_token = NULL,
            lease_expires_at = NULL,
            ended_at = COALESCE(ended_at, datetime('now'))
       WHERE fleet_run_id = ?
         AND status IN ('leasing', 'spawning', 'running', 'waiting_for_operator')`
    ),

  markFleetWorkerCleanupPendingForSession: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_workers
       SET status = 'cleanup_pending',
           spawn_error = ?,
           lease_token = NULL,
           lease_expires_at = NULL
       WHERE session_id = ?`
    ),

  updateFleetRunPlanState: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_runs
       SET status = 'draft',
           approval_state = 'needs_approval',
           plan_hash = ?,
           approved_plan_hash = NULL,
           approved_by = NULL,
           approved_at = NULL,
           settings_json = ?,
           updated_at = datetime('now')
       WHERE id = ?
         AND status = 'draft'
         AND approval_state IN ('draft', 'needs_approval')`
    ),

  approveFleetRunPlan: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_runs
       SET status = 'planned',
           approval_state = 'approved',
           approved_plan_hash = plan_hash,
           approved_by = ?,
           approved_at = ?,
           settings_json = ?,
           updated_at = ?
       WHERE id = ?
         AND plan_hash = ?
         AND status = 'draft'
         AND approval_state = 'needs_approval'
         AND NOT EXISTS (
           SELECT 1
           FROM fleet_workers
           WHERE fleet_workers.fleet_run_id = fleet_runs.id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM fleet_artifacts
           WHERE fleet_artifacts.fleet_run_id = fleet_runs.id
             AND (
               fleet_artifacts.plan_hash = fleet_runs.plan_hash
               OR fleet_artifacts.plan_hash IS NULL
             )
             AND fleet_artifacts.severity = 'blocker'
         )`
    ),

  createFleetEvent: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_events (fleet_run_id, event_type, actor, payload)
       VALUES (?, ?, ?, ?)`
    ),

  listFleetEventsForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_events
       WHERE fleet_run_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ),

  createFleetArtifact: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_artifacts (
        id,
        fleet_run_id,
        task_id,
        plan_hash,
        artifact_type,
        title,
        body,
        severity,
        actor,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ),

  countFleetBlockerArtifactsForPlan: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n
       FROM fleet_artifacts
       WHERE fleet_run_id = ?
         AND (plan_hash = ? OR plan_hash IS NULL)
         AND severity = 'blocker'`
    ),

  clearFleetArtifactTaskLinksForRun: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_artifacts SET task_id = NULL WHERE fleet_run_id = ?`
    ),

  listFleetArtifactsForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_artifacts
       WHERE fleet_run_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    ),
};
