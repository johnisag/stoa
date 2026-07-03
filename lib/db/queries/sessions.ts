import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const sessionsQueries = {
  // Sessions
  createSession: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO sessions (id, name, tmux_name, working_directory, parent_session_id, model, system_prompt, group_path, agent_type, auto_approve, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getSession: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions WHERE id = ?`),

  getAllSessions: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions ORDER BY updated_at DESC`),

  updateSessionStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionClaudeId: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionName: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET name = ?, tmux_name = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSession: (db: Database.Database) =>
    getStmt(db, `DELETE FROM sessions WHERE id = ?`),

  // Survey worker sessions (the autonomous maintainer): named `stoa-survey-<id>`.
  // At startup every one is an orphan — the in-memory surveyRuns map that tracked
  // them is wiped by a restart — so the sweep reclaims them. ('-' is a literal in
  // LIKE; only % and _ are wildcards.)
  listSurveySessions: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM sessions WHERE name LIKE 'stoa-survey-%'`),

  updateSessionWorktree: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET worktree_path = ?, branch_name = ?, base_branch = ?, dev_server_port = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Multi-repo workspace: store the JSON array of child worktree paths this
  // session created, so deleting the session can tear all of them down.
  setSessionWorktreePaths: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET worktree_paths = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionMcpArgs: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET mcp_launch_args = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // #1: stamp a native fork's parent-usage-at-fork-time baseline (JSON TokenUsage),
  // netted out by the cost path so the fork's inherited transcript isn't counted.
  updateSessionForkBaseline: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET fork_cost_baseline = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionPR: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET pr_url = ?, pr_number = ?, pr_status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateSessionGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getSessionsByGroup: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE group_path = ? ORDER BY updated_at DESC`
    ),

  moveSessionsToGroup: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET group_path = ?, updated_at = datetime('now') WHERE group_path = ?`
    ),

  updateSessionProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET project_id = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  getSessionsByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM sessions WHERE project_id = ? ORDER BY updated_at DESC`
    ),
};
