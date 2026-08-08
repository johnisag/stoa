import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

/** A human comment on a session (annotation / hand-off note). */
export interface SessionCommentRow {
  id: string;
  session_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export const sessionCommentsQueries = {
  createSessionComment: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO session_comments (id, session_id, author, body) VALUES (?, ?, ?, ?)`
    ),

  getSessionComment: (db: Database.Database) =>
    getStmt<unknown[], SessionCommentRow>(
      db,
      `SELECT * FROM session_comments WHERE id = ?`
    ),

  listSessionComments: (db: Database.Database) =>
    getStmt<unknown[], SessionCommentRow>(
      db,
      `SELECT * FROM session_comments WHERE session_id = ? ORDER BY created_at ASC, id ASC`
    ),

  updateSessionComment: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_comments SET body = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSessionComment: (db: Database.Database) =>
    getStmt(db, `DELETE FROM session_comments WHERE id = ?`),
};
