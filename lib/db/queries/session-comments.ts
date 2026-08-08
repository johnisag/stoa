import type Database from "better-sqlite3";
import type { SessionCommentRow } from "../types";
import { getStmt } from "./_shared";

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
      `SELECT * FROM session_comments WHERE session_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`
    ),

  /** Update a comment's body, scoped to the session id (prevents cross-session IDOR). */
  updateSessionComment: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE session_comments SET body = ?, updated_at = datetime('now') WHERE id = ? AND session_id = ?`
    ),

  /** Delete a comment, scoped to the session id. */
  deleteSessionComment: (db: Database.Database) =>
    getStmt(db, `DELETE FROM session_comments WHERE id = ? AND session_id = ?`),

  /** Delete ALL comments for a session (used on session deletion cleanup). */
  deleteSessionCommentsForSession: (db: Database.Database) =>
    getStmt(db, `DELETE FROM session_comments WHERE session_id = ?`),
};
