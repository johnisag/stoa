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

  listFleetTasksForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_tasks
       WHERE fleet_run_id = ?
       ORDER BY sort_order ASC, created_at ASC`
    ),

  listFleetWorkersForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_workers
       WHERE fleet_run_id = ?
       ORDER BY created_at ASC`
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
};
