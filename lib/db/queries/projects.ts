import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const projectsQueries = {
  // Groups
  getAllGroups: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups ORDER BY sort_order ASC, name ASC`),

  getGroup: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM groups WHERE path = ?`),

  createGroup: (db: Database.Database) =>
    getStmt(db, `INSERT INTO groups (path, name, sort_order) VALUES (?, ?, ?)`),

  updateGroupName: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET name = ? WHERE path = ?`),

  updateGroupExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET expanded = ? WHERE path = ?`),

  updateGroupOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE groups SET sort_order = ? WHERE path = ?`),

  deleteGroup: (db: Database.Database) =>
    getStmt(db, `DELETE FROM groups WHERE path = ?`),

  // Projects
  createProject: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO projects (id, name, working_directory, agent_type, default_model, initial_prompt, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),

  getProject: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM projects WHERE id = ?`),

  getAllProjects: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM projects ORDER BY is_uncategorized ASC, sort_order ASC, name ASC`
    ),

  updateProject: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE projects SET name = ?, working_directory = ?, agent_type = ?, default_model = ?, initial_prompt = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // #19 verify badge
  updateProjectVerifyCommand: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE projects SET verify_command = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // verify_ran_at is stamped only on COMPLETION (setSessionVerifyResult) — a
  // 'running' row has no ran-at yet.
  setSessionVerifyRunning: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET verify_status = 'running', verify_output = NULL, verify_ran_at = NULL WHERE id = ?`
    ),

  setSessionVerifyResult: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET verify_status = ?, verify_output = ?, verify_ran_at = datetime('now') WHERE id = ?`
    ),

  clearSessionVerify: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE sessions SET verify_status = NULL, verify_output = NULL, verify_ran_at = NULL WHERE id = ?`
    ),

  // #21: a session's lifetime USD budget cap (NULL = no budget).
  setSessionBudget: (db: Database.Database) =>
    getStmt(db, `UPDATE sessions SET budget_usd = ? WHERE id = ?`),

  updateProjectExpanded: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET expanded = ? WHERE id = ?`),

  updateProjectOrder: (db: Database.Database) =>
    getStmt(db, `UPDATE projects SET sort_order = ? WHERE id = ?`),

  deleteProject: (db: Database.Database) =>
    getStmt(db, `DELETE FROM projects WHERE id = ? AND is_uncategorized = 0`),

  // Project dev servers
  createProjectDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO project_dev_servers (id, project_id, name, type, command, port, port_env_var, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getProjectDevServer: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_dev_servers WHERE id = ?`),

  getProjectDevServers: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM project_dev_servers WHERE project_id = ? ORDER BY sort_order ASC`
    ),

  updateProjectDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE project_dev_servers SET name = ?, type = ?, command = ?, port = ?, port_env_var = ?, sort_order = ? WHERE id = ?`
    ),

  deleteProjectDevServer: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_dev_servers WHERE id = ?`),

  deleteProjectDevServers: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_dev_servers WHERE project_id = ?`),

  // Project startup commands (#14b)
  createProjectStartupCommand: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO project_startup_commands (id, project_id, name, command, sort_order)
       VALUES (?, ?, ?, ?, ?)`
    ),

  getProjectStartupCommand: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_startup_commands WHERE id = ?`),

  getProjectStartupCommands: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM project_startup_commands WHERE project_id = ? ORDER BY sort_order ASC`
    ),

  updateProjectStartupCommand: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE project_startup_commands SET name = ?, command = ?, sort_order = ? WHERE id = ?`
    ),

  deleteProjectStartupCommand: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_startup_commands WHERE id = ?`),

  // Project repositories
  createProjectRepository: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO project_repositories (id, project_id, name, path, is_primary, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),

  getProjectRepository: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_repositories WHERE id = ?`),

  getProjectRepositories: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM project_repositories WHERE project_id = ? ORDER BY sort_order ASC`
    ),

  getAllProjectRepositories: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM project_repositories ORDER BY sort_order ASC`),

  updateProjectRepository: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE project_repositories SET name = ?, path = ?, is_primary = ?, sort_order = ? WHERE id = ?`
    ),

  deleteProjectRepository: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_repositories WHERE id = ?`),

  deleteProjectRepositories: (db: Database.Database) =>
    getStmt(db, `DELETE FROM project_repositories WHERE project_id = ?`),
};
