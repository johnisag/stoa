import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

/** A row in the token_projects join table. */
export interface TokenProjectRow {
  token_id: string;
  project_id: string;
}

export const tokenProjectsQueries = {
  /** List project ids a token is scoped to (empty = full fleet access). */
  listTokenProjects: (db: Database.Database) =>
    getStmt<[string], TokenProjectRow>(
      db,
      `SELECT project_id FROM token_projects WHERE token_id = ?`
    ),

  /** Add a project scope to a token (idempotent via PRIMARY KEY). */
  addTokenProject: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT OR IGNORE INTO token_projects (token_id, project_id) VALUES (?, ?)`
    ),

  /** Remove a project scope from a token. */
  removeTokenProject: (db: Database.Database) =>
    getStmt(
      db,
      `DELETE FROM token_projects WHERE token_id = ? AND project_id = ?`
    ),

  /** Remove ALL project scopes for a token (used on token revocation). */
  clearTokenProjects: (db: Database.Database) =>
    getStmt(db, `DELETE FROM token_projects WHERE token_id = ?`),
};
