import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const workflowsKbQueries = {
  // Saved workflows (visual builder)
  createSavedWorkflow: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO saved_workflows (id, name, builder_doc, history) VALUES (?, ?, ?, ?)`
    ),

  getSavedWorkflow: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM saved_workflows WHERE id = ?`),

  getAllSavedWorkflows: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM saved_workflows ORDER BY updated_at DESC, name ASC`
    ),

  updateSavedWorkflow: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE saved_workflows SET name = ?, builder_doc = ?, history = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteSavedWorkflow: (db: Database.Database) =>
    getStmt(db, `DELETE FROM saved_workflows WHERE id = ?`),

  // Agent-accessible shared memory (fleet-wide key→value scratchpad)
  upsertAgentMemory: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO agent_memory (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ),

  getAgentMemory: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM agent_memory WHERE key = ?`),

  listAgentMemory: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM agent_memory ORDER BY updated_at DESC, key ASC LIMIT ?`
    ),

  deleteAgentMemory: (db: Database.Database) =>
    getStmt(db, `DELETE FROM agent_memory WHERE key = ?`),

  // Notes / shared knowledge base
  createNote: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO notes (id, title, content, pinned) VALUES (?, ?, ?, ?)`
    ),

  getNote: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM notes WHERE id = ?`),

  listNotes: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC, created_at DESC LIMIT ?`
    ),

  updateNote: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE notes SET title = ?, content = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteNote: (db: Database.Database) =>
    getStmt(db, `DELETE FROM notes WHERE id = ?`),
};
