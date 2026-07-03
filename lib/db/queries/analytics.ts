import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const analyticsQueries = {
  // Audit / event ledger (append-only)
  appendSessionEvent: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO session_events (session_key, event_type, payload, created_at)
       VALUES (?, ?, ?, ?)`
    ),

  getSessionEvents: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_events WHERE session_key = ? ORDER BY id ASC`
    ),

  // Window-bounded event read for analytics — projects only the columns the
  // engine reads (NOT payload, which can hold large input/paste bodies) and
  // orders by created_at so the idx_session_events_created range scan is used
  // directly. Keeps a busy 90-day window from materializing MBs of payload text.
  getSessionEventsSince: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT session_key, event_type, created_at FROM session_events
       WHERE created_at >= ? ORDER BY created_at ASC, id ASC`
    ),

  getSessionEventsByType: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_events WHERE session_key = ? AND event_type = ? ORDER BY id ASC`
    ),

  countSessionEvents: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM session_events WHERE session_key = ?`
    ),

  // Persisted token/cost samples (#15). Upsert is idempotent per (session_key,
  // day): re-sampling the same session the same UTC day overwrites that day's row
  // with the latest cumulative numbers (never appends a duplicate).
  upsertCostSample: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO session_costs
         (session_key, day, session_id, agent_type, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_key, day) DO UPDATE SET
         session_id = excluded.session_id,
         agent_type = excluded.agent_type,
         model = excluded.model,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_write_tokens = excluded.cache_write_tokens,
         cost_usd = excluded.cost_usd,
         updated_at = datetime('now')`
    ),

  // Cost samples on/after a UTC day (the idx_session_costs_day range scan), for
  // the spend-history endpoint. Ordered by day so the caller folds in order.
  getCostSamplesSince: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM session_costs WHERE day >= ? ORDER BY day ASC, session_key ASC`
    ),

  // Bounded retention: drop samples older than the cutoff day so the table can't
  // grow without limit on a long-lived install (the read side is windowed anyway).
  deleteCostSamplesBefore: (db: Database.Database) =>
    getStmt(db, `DELETE FROM session_costs WHERE day < ?`),

  // Best-of-N
  createBonRun: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO best_of_n_runs (id, task, base_branch, n, project_id)
       VALUES (?, ?, ?, ?, ?)`
    ),

  getBonRun: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM best_of_n_runs WHERE id = ?`),

  listBonRuns: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM best_of_n_runs ORDER BY created_at DESC LIMIT 50`
    ),

  listBonRunsByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM best_of_n_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 50`
    ),

  updateBonRunStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE best_of_n_runs
       SET status = ?, winner_session_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    ),

  createBonCandidate: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO best_of_n_candidates
         (id, run_id, session_id, worktree_path, branch_name, candidate_index)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),

  getBonCandidatesByRun: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT bc.*, s.worker_status, s.status AS session_status
       FROM best_of_n_candidates bc
       LEFT JOIN sessions s ON s.id = bc.session_id
       WHERE bc.run_id = ?
       ORDER BY bc.candidate_index`
    ),

  updateBonCandidateDiff: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE best_of_n_candidates
       SET diff = ?, updated_at = datetime('now')
       WHERE id = ?`
    ),

  markBonWinner: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE best_of_n_candidates
       SET is_winner = CASE WHEN id = ? THEN 1 ELSE 0 END,
           updated_at = datetime('now')
       WHERE run_id = ?`
    ),

  // ── Warm worktree pool ──
  insertWarmWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO warm_worktrees (id, repo_id, worktree_path, branch_name, status)
       VALUES (?, ?, ?, ?, 'warming')`
    ),

  markWarmWorktreeReady: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE warm_worktrees SET status = 'ready' WHERE id = ? AND status = 'warming'`
    ),

  // Atomically claim the oldest ready warm worktree for a repo. Returns the row or
  // undefined (no ready entry). The DELETE is intentional: claimed worktrees are
  // consumed and removed from the pool — the dispatcher owns the path from here.
  claimWarmWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `DELETE FROM warm_worktrees
       WHERE id = (
         SELECT id FROM warm_worktrees
         WHERE repo_id = ? AND status = 'ready'
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING id, worktree_path, branch_name`
    ),

  countWarmWorktrees: (db: Database.Database) =>
    getStmt(db, `SELECT COUNT(*) as n FROM warm_worktrees WHERE repo_id = ?`),

  deleteWarmWorktree: (db: Database.Database) =>
    getStmt(db, `DELETE FROM warm_worktrees WHERE id = ?`),

  // Returns all 'warming' rows — used at startup to evict entries that were left
  // mid-creation by a crash (their worktrees are partially set up and unusable).
  listWarmingWorktrees: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, worktree_path FROM warm_worktrees WHERE status = 'warming'`
    ),

  listReadyWarmWorktreesForRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, worktree_path FROM warm_worktrees WHERE repo_id = ? AND status IN ('warming','ready')`
    ),

  // Like listWarmingWorktrees but also returns the source repo_path (via JOIN)
  // so evictStale can pass the correct projectPath to deleteWorktree.
  listStaleWarmWorktreesWithRepo: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT ww.id, ww.worktree_path, dr.repo_path
       FROM warm_worktrees ww
       LEFT JOIN dispatch_repos dr ON ww.repo_id = dr.id
       WHERE ww.status = 'warming'`
    ),

  getDispatchRepoBySlug: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dispatch_repos WHERE repo_slug = ?`),

  // Playbooks (#13) — named prompt recipes; pinned ones auto-prepend per project.
  // A session picker sees the project's own playbooks + the global ones (project_id
  // NULL); pinned auto-recall is project-scoped only. Newest first, stable by id.
  listPlaybooksForProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM playbooks WHERE project_id = ? OR project_id IS NULL
       ORDER BY created_at DESC, id DESC`
    ),
  listGlobalPlaybooks: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM playbooks WHERE project_id IS NULL
       ORDER BY created_at DESC, id DESC`
    ),
  listPinnedPlaybooks: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM playbooks WHERE project_id = ? AND pinned = 1
       ORDER BY created_at ASC, id ASC`
    ),
  getPlaybook: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM playbooks WHERE id = ?`),
  createPlaybook: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO playbooks (id, name, body, project_id, pinned)
       VALUES (?, ?, ?, ?, ?)`
    ),
  updatePlaybook: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE playbooks SET name = ?, body = ?, pinned = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    ),
  deletePlaybook: (db: Database.Database) =>
    getStmt(db, `DELETE FROM playbooks WHERE id = ?`),
};
