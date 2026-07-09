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

  listFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_workers
       WHERE fleet_run_id = ?
       ORDER BY created_at ASC`
    ),

  countFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM fleet_workers WHERE fleet_run_id = ?`
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
