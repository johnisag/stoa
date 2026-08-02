import type Database from "better-sqlite3";
import {
  insertFleetArtifact,
  insertFleetEvent,
} from "@/lib/fleet/durable-write";
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
      `SELECT * FROM (
       SELECT
        r.id,
        r.name,
        substr(r.goal, 1, 600) AS goal,
        r.repo_id,
        r.project_id,
        r.source_kind,
        r.source_id,
        r.source_name,
        r.status,
        r.budget_usd,
        r.budget_tokens,
        substr(r.provider, 1, 40) AS provider,
        substr(r.model, 1, 120) AS model,
        r.max_concurrency,
        r.review_policy,
        r.approval_state,
        r.plan_hash,
        r.approved_plan_hash,
        r.approved_by,
        r.approved_at,
        r.desired_state,
        r.automation_policy_version,
        r.automation_policy_json,
        r.automation_policy_hash,
        r.automation_granted_by,
        r.automation_granted_at,
        r.automation_base_sha,
        r.automation_last_error,
        r.merge_requested_at,
        r.merge_requested_by,
        r.merge_request_kind,
        r.merge_target,
        r.integration_state,
        r.integration_branch,
        r.integration_worktree,
        r.integration_base_sha,
        r.integration_head_sha,
        r.integration_pr_number,
        r.integration_pr_url,
        r.integration_pr_head_sha,
        r.integration_merge_sha,
        r.integration_error,
        r.integration_updated_at,
        r.archived_at,
        r.archived_by,
        r.retention_days,
        r.scheduler_epoch,
        r.recovery_required,
        r.reserved_budget_usd,
        r.spent_budget_usd,
        r.reserved_budget_tokens,
        r.spent_budget_tokens,
        r.cost_confidence,
        r.budget_stop_mode,
        r.budget_warning_threshold,
        r.budget_warning_emitted_at,
        r.budget_hard_limit_at,
        r.budget_interrupt_deadline_at,
        r.provider_caps_json,
        r.resource_limits_json,
        r.default_max_attempts,
        r.pause_mode,
        r.pause_reason,
        r.cancel_mode,
        r.settings_json,
        r.created_at,
        r.updated_at,
        (SELECT COUNT(*) FROM fleet_tasks t WHERE t.fleet_run_id = r.id) AS task_count,
        (SELECT COUNT(*) FROM fleet_workers w WHERE w.fleet_run_id = r.id) AS worker_count,
        CASE WHEN
          r.archived_at IS NULL AND
          r.status NOT IN ('completed', 'failed', 'canceled')
        THEN (
            CASE WHEN
              r.approval_state = 'blocked' OR
              (
                r.approval_state = 'needs_approval' AND
                r.plan_hash IS NOT NULL AND
                COALESCE(json_extract(r.settings_json, '$.planner.state'), 'idle')
                  NOT IN ('starting', 'running', 'finalizing', 'cleanup_pending') AND
                (
                  EXISTS (
                    SELECT 1 FROM fleet_artifacts approval_blocker
                    WHERE approval_blocker.fleet_run_id = r.id
                      AND approval_blocker.severity = 'blocker'
                      AND (
                        approval_blocker.plan_hash = r.plan_hash OR
                        approval_blocker.plan_hash IS NULL
                      )
                  ) OR r.review_policy = 'manual' OR
                  (
                    COALESCE(json_extract(
                      r.automation_policy_json,
                      '$.automaticPlanApproval'
                    ), 0) = 0 AND
                    EXISTS (
                      SELECT 1 FROM fleet_reviews plan_review
                      WHERE plan_review.fleet_run_id = r.id
                        AND plan_review.subject_type = 'plan'
                        AND plan_review.subject_hash = r.plan_hash
                        AND plan_review.policy_hash = r.automation_policy_hash
                        AND plan_review.base_sha = r.automation_base_sha
                        AND plan_review.state = 'clean'
                        AND plan_review.verdict = 'clean'
                        AND plan_review.lens IN (
                          'correctness_security',
                          'conventions_cross_platform',
                          'simplicity_ux',
                          'adversarial_red_team'
                        )
                      GROUP BY plan_review.execution_hash
                      HAVING COUNT(DISTINCT plan_review.lens) = 4
                        AND COUNT(DISTINCT plan_review.reviewer_session_id) = 4
                    )
                  )
                )
              ) OR
              r.automation_last_error IS NOT NULL OR
              json_extract(r.settings_json, '$.planner.state') = 'failed' OR
              r.pause_reason = 'budget_exhausted' OR
              r.budget_hard_limit_at IS NOT NULL OR
              r.budget_warning_emitted_at IS NOT NULL OR
              r.recovery_required = 1 OR
              r.integration_error IS NOT NULL OR
              r.integration_state = 'awaiting_operator'
            THEN 1 ELSE 0 END +
            (SELECT COUNT(*) FROM fleet_tasks t
             WHERE t.fleet_run_id = r.id AND (
               t.status IN ('waiting_for_operator', 'failed', 'blocked',
                            'needs_inspection', 'needs_followup') OR
               t.verification_status IN ('fail', 'error') OR
               t.review_status = 'changes_requested' OR
               t.provider_state IN ('backoff', 'failed') OR
               t.retry_not_before IS NOT NULL
             )) +
            (SELECT COUNT(*) FROM fleet_workers w
             WHERE w.fleet_run_id = r.id AND (
               w.status IN ('waiting_for_operator', 'failed', 'dead', 'cleanup_pending') OR
               w.rendered_status IN ('waiting', 'error', 'dead') OR
               w.rendered_status_error IS NOT NULL
             ))
          )
        ELSE 0 END AS attention_count,
        CASE WHEN
          r.archived_at IS NULL AND
          r.merge_requested_at IS NULL AND
          r.approval_state = 'approved' AND
          r.plan_hash IS NOT NULL AND r.approved_plan_hash = r.plan_hash AND
          r.desired_state = 'running' AND r.recovery_required = 0 AND
          r.status IN ('running', 'reviewing', 'merging') AND (
            (r.merge_request_kind = 'manual' AND
             r.integration_state = 'ready_to_finalize' AND
             r.integration_base_sha = r.automation_base_sha AND
             LENGTH(r.integration_head_sha) IN (40, 64) AND
             r.integration_head_sha NOT GLOB '*[^0-9a-f]*') OR
            (r.merge_request_kind IS NULL AND
             COALESCE(json_extract(r.automation_policy_json, '$.automaticMerge'), 0) = 0 AND
             EXISTS (
               SELECT 1 FROM fleet_tasks t
               WHERE t.fleet_run_id = r.id
                 AND t.task_type NOT IN ('explore', 'review', 'milestone', 'planning')
             ) AND NOT EXISTS (
               SELECT 1 FROM fleet_tasks t
               WHERE t.fleet_run_id = r.id AND (
                 (t.task_type IN ('explore', 'review', 'milestone', 'planning') AND
                   t.status NOT IN ('completed', 'skipped')) OR
                 (t.task_type NOT IN ('explore', 'review', 'milestone', 'planning') AND
                   t.status <> 'ready_to_merge')
               )
             ))
          ) THEN 1 ELSE 0 END AS awaiting_manual_merge
       FROM fleet_runs r
       WHERE (
         r.archived_at IS NULL
         AND r.status NOT IN ('completed', 'failed', 'canceled')
       ) OR r.id IN (
         SELECT history.id
         FROM fleet_runs history
         WHERE history.archived_at IS NOT NULL
           OR history.status IN ('completed', 'failed', 'canceled')
         ORDER BY history.updated_at DESC, history.created_at DESC, history.id DESC
         LIMIT ?
       )
       ) prioritized_fleet_runs
       ORDER BY
         CASE
           WHEN attention_count > 0 OR awaiting_manual_merge = 1 THEN 0
           WHEN archived_at IS NULL
             AND status NOT IN ('completed', 'failed', 'canceled') THEN 1
           ELSE 2
         END,
         updated_at DESC, created_at DESC, id DESC`
    ),

  getFleetRun: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM fleet_runs WHERE id = ?`),

  setFleetRunAutomationIntent: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_runs
       SET desired_state = ?,
           automation_policy_version = ?,
           automation_policy_json = ?,
           automation_policy_hash = ?,
           automation_granted_by = ?,
           automation_granted_at = ?,
           automation_last_error = NULL,
           updated_at = ?
       WHERE id = ? AND automation_policy_hash IS NULL`
    ),

  createFleetActionAuthorization: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT OR IGNORE INTO fleet_action_authorizations (
        id,
        fleet_run_id,
        action,
        status,
        policy_hash,
        granted_by,
        granted_at,
        updated_at
      ) VALUES (?, ?, ?, 'authorized', ?, ?, ?, ?)`
    ),

  listFleetAutomationCandidates: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_runs
       WHERE automation_policy_hash IS NOT NULL
         AND (
           desired_state IN ('planned', 'running') OR
           (review_policy <> 'manual' AND status = 'draft'
             AND approval_state = 'needs_approval' AND plan_hash IS NOT NULL)
         )
         AND status NOT IN ('completed', 'failed', 'canceled')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`
    ),

  listFleetReviewsForContract: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_reviews
       WHERE fleet_run_id = ?
         AND subject_type = 'plan'
         AND subject_hash = ?
         AND policy_hash = ?
         AND execution_hash = ?
         AND base_sha = ?
         AND (
           (state = 'clean' AND verdict = 'clean') OR
           (state = 'changes_requested' AND verdict = 'changes_requested')
         )
       ORDER BY created_at ASC, id ASC`
    ),

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

  deleteFleetTaskDependenciesForRun: (db: Database.Database) =>
    getStmt(db, `DELETE FROM fleet_task_dependencies WHERE fleet_run_id = ?`),

  deleteFleetTaskClaimsForRun: (db: Database.Database) =>
    getStmt(db, `DELETE FROM fleet_task_claims WHERE fleet_run_id = ?`),

  createFleetTaskDependency: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_task_dependencies
      (id, fleet_run_id, task_id, depends_on_task_id, dependency_type)
      VALUES (?, ?, ?, ?, ?)`
    ),

  createFleetTaskClaim: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO fleet_task_claims
      (id, fleet_run_id, task_id, path, claim_type, confidence)
      VALUES (?, ?, ?, ?, ?, ?)`
    ),

  approveFleetTasksForRun: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE fleet_tasks
      SET status = CASE WHEN task_type = 'milestone' THEN 'completed' ELSE 'ready' END,
          approval_state = 'approved', approved_task_hash = ?, updated_at = ?
      WHERE fleet_run_id = ? AND status = 'draft'`
    ),

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

  listFleetVerificationsForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_verifications
       WHERE fleet_run_id = ?
       ORDER BY created_at ASC, id ASC`
    ),

  listFleetVerificationCandidates: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT
         t.id AS task_id,
         t.fleet_run_id,
         t.current_attempt,
         t.verify_command,
         t.base_sha AS task_base_sha,
         t.head_sha AS task_head_sha,
         t.worktree_path AS task_worktree_path,
         t.actual_file_claims_json,
         t.report_artifact_id,
         t.approved_task_hash,
         r.approved_plan_hash,
         w.id AS worker_id,
         w.attempt AS worker_attempt,
         w.base_sha AS worker_base_sha,
         w.head_sha AS worker_head_sha,
         w.worktree_path AS worker_worktree_path,
         w.report_state,
         w.report_status
       FROM fleet_tasks t
       JOIN fleet_runs r ON r.id = t.fleet_run_id
       LEFT JOIN fleet_workers w ON w.id = (
         SELECT candidate.id
         FROM fleet_workers candidate
         WHERE candidate.fleet_run_id = t.fleet_run_id
           AND candidate.task_id = t.id
           AND candidate.attempt = t.current_attempt
         ORDER BY candidate.report_collected_at DESC, candidate.created_at DESC,
                  candidate.id DESC
         LIMIT 1
       )
       WHERE t.status = 'verifying'
         AND r.recovery_required = 0
       ORDER BY t.updated_at ASC, t.sort_order ASC, t.id ASC
       LIMIT ?`
    ),

  createFleetVerification: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT OR IGNORE INTO fleet_verifications
       (id, fleet_run_id, task_id, worker_id, attempt, base_sha, head_sha,
        spec_hash, command, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ),

  getFleetVerificationByIdentity: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_verifications
       WHERE task_id = ? AND attempt = ? AND head_sha = ? AND spec_hash = ?`
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
           automation_base_sha = COALESCE(automation_base_sha, ?),
           approved_by = ?,
           approved_at = ?,
           settings_json = ?,
           updated_at = ?
       WHERE id = ?
         AND plan_hash = ?
         AND automation_policy_hash = ?
         AND (automation_base_sha IS NULL OR LOWER(automation_base_sha) = ?)
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

  createFleetEvent: (db: Database.Database) => ({
    run: (
      runId: string,
      eventType: string,
      actor: string,
      payload: string | null,
      options: { controlPlane?: boolean; createdAt?: string } = {}
    ) =>
      insertFleetEvent(db, {
        runId,
        eventType,
        actor,
        payload,
        createdAt: options.createdAt,
        controlPlane: options.controlPlane,
      }),
  }),

  listFleetEventsForRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM fleet_events
       WHERE fleet_run_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ),

  createFleetArtifact: (db: Database.Database) => ({
    run: (
      id: string,
      runId: string,
      taskId: string | null,
      planHash: string | null,
      artifactType: string,
      title: string,
      body: string,
      severity: string,
      actor: string
    ) =>
      insertFleetArtifact(db, {
        id,
        runId,
        taskId,
        planHash,
        artifactType,
        title,
        body,
        severity,
        actor,
      }),
  }),

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
      `SELECT id, fleet_run_id, task_id, worker_id, attempt, plan_hash,
              base_sha, head_sha, content_hash, metadata_json, byte_count,
              artifact_type, title, '' AS body, severity, actor,
              body_pruned_at, created_at
       FROM fleet_artifacts
       WHERE fleet_run_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    ),
};
