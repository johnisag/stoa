import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

interface CheckpointRow {
  id: string;
  session_id: string;
  seq: number;
  snapshot_sha: string;
  summary: string | null;
  transcript_session_id: string | null;
  kind: string;
  created_by: string;
  parent_checkpoint_id: string | null;
  created_at: string;
}

// #44 Checkpoint timeline. Durable rows pinning a git shadow-commit snapshot
// (seq + sha) with a label / transcript anchor / kind / fork lineage. The git
// snapshot stays the store of worktree bytes; these rows survive the ref's FIFO
// prune so the timeline (and fork lineage) is durable.
export const checkpointsQueries = {
  createCheckpoint: (db: Database.Database) =>
    getStmt<
      [
        string,
        string,
        number,
        string,
        string | null,
        string | null,
        string,
        string,
        string | null,
      ]
    >(
      db,
      `INSERT INTO checkpoints
         (id, session_id, seq, snapshot_sha, summary, transcript_session_id, kind, created_by, parent_checkpoint_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getCheckpoint: (db: Database.Database) =>
    getStmt<[string], CheckpointRow>(
      db,
      `SELECT * FROM checkpoints WHERE id = ?`
    ),

  // The newest checkpoint pinning a given snapshot seq (for fork lineage — when
  // you fork from a snapshot that also happens to be a labeled checkpoint).
  getCheckpointBySeq: (db: Database.Database) =>
    getStmt<[string, number], CheckpointRow>(
      db,
      `SELECT * FROM checkpoints WHERE session_id = ? AND seq = ? ORDER BY created_at DESC LIMIT 1`
    ),

  // Newest-first — the order the timeline renders (most recent checkpoint on top).
  listCheckpoints: (db: Database.Database) =>
    getStmt<[string], CheckpointRow>(
      db,
      `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY seq DESC, created_at DESC`
    ),
};
