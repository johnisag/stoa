import type Database from "better-sqlite3";

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
}

function hasColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  return (
    db
      .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .all() as Array<{ name: string }>
  ).some((entry) => entry.name === column);
}

function installSessionDeletionClaimSchema(db: Database.Database): void {
  if (!hasTable(db, "sessions")) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_deletion_claims (
      conductor_session_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'claimed'
        CHECK (state IN ('claimed', 'deleted')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS session_deletion_claim_members (
      claim_conductor_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE,
      disposition TEXT NOT NULL CHECK (disposition IN ('delete', 'detach')),
      session_role TEXT NOT NULL,
      conductor_session_id TEXT,
      parent_session_id TEXT,
      tmux_name TEXT,
      agent_type TEXT,
      backend_key TEXT NOT NULL,
      worktree_path TEXT,
      PRIMARY KEY (claim_conductor_session_id, session_id),
      FOREIGN KEY (claim_conductor_session_id)
        REFERENCES session_deletion_claims(conductor_session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_deletion_claim_members_claim
      ON session_deletion_claim_members(claim_conductor_session_id, disposition, session_id);

    DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_insert_guard;
    DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_attach_guard;
    DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_member_update_guard;
    DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_member_delete_guard;

    CREATE TRIGGER trg_sessions_deletion_claim_insert_guard
    BEFORE INSERT ON sessions
    WHEN EXISTS (
      SELECT 1 FROM session_deletion_claim_members
      WHERE session_id = NEW.id
    ) OR (
      NEW.conductor_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session_deletion_claim_members
        WHERE session_id = NEW.conductor_session_id
      )
    ) OR (
      NEW.parent_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session_deletion_claim_members
        WHERE session_id = NEW.parent_session_id
      )
    ) OR EXISTS (
      SELECT 1 FROM session_deletion_claim_members
      WHERE disposition = 'delete'
        AND backend_key = CASE
          WHEN NEW.tmux_name IS NOT NULL AND NEW.tmux_name <> ''
            THEN NEW.tmux_name
          WHEN NEW.agent_type IN (
            'claude', 'codex', 'hermes', 'kilo', 'kimi', 'shell'
          )
            THEN NEW.agent_type || '-' || NEW.id
          ELSE 'claude-' || NEW.id
        END
    )
    BEGIN
      SELECT RAISE(ABORT, 'session deletion is in progress');
    END;

    CREATE TRIGGER trg_sessions_deletion_claim_attach_guard
    BEFORE UPDATE OF
      id, conductor_session_id, parent_session_id, tmux_name, agent_type
    ON sessions
    WHEN EXISTS (
      SELECT 1 FROM session_deletion_claim_members
      WHERE session_id = NEW.id AND NEW.id IS NOT OLD.id
    ) OR (
      OLD.conductor_session_id IS NOT NEW.conductor_session_id
      AND NEW.conductor_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session_deletion_claim_members
        WHERE session_id = NEW.conductor_session_id
      )
    ) OR (
      OLD.parent_session_id IS NOT NEW.parent_session_id
      AND NEW.parent_session_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session_deletion_claim_members
        WHERE session_id = NEW.parent_session_id
      )
    ) OR (
      CASE
        WHEN OLD.tmux_name IS NOT NULL AND OLD.tmux_name <> ''
          THEN OLD.tmux_name
        WHEN OLD.agent_type IN (
          'claude', 'codex', 'hermes', 'kilo', 'kimi', 'shell'
        )
          THEN OLD.agent_type || '-' || OLD.id
        ELSE 'claude-' || OLD.id
      END
      IS NOT
      CASE
        WHEN NEW.tmux_name IS NOT NULL AND NEW.tmux_name <> ''
          THEN NEW.tmux_name
        WHEN NEW.agent_type IN (
          'claude', 'codex', 'hermes', 'kilo', 'kimi', 'shell'
        )
          THEN NEW.agent_type || '-' || NEW.id
        ELSE 'claude-' || NEW.id
      END
      AND EXISTS (
        SELECT 1 FROM session_deletion_claim_members
        WHERE disposition = 'delete'
          AND backend_key = CASE
            WHEN NEW.tmux_name IS NOT NULL AND NEW.tmux_name <> ''
              THEN NEW.tmux_name
            WHEN NEW.agent_type IN (
              'claude', 'codex', 'hermes', 'kilo', 'kimi', 'shell'
            )
              THEN NEW.agent_type || '-' || NEW.id
            ELSE 'claude-' || NEW.id
          END
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'session deletion is in progress');
    END;

    -- Freeze every field used to identify, stop, detach, or clean up a claimed
    -- session. Status/usage writes remain legal while a backend stop is pending.
    CREATE TRIGGER trg_sessions_deletion_claim_member_update_guard
    BEFORE UPDATE OF
      id, session_role, conductor_session_id, parent_session_id,
      tmux_name, agent_type, working_directory, worktree_path,
      worktree_paths, dev_server_port
    ON sessions
    WHEN EXISTS (
      SELECT 1
      FROM session_deletion_claim_members AS member
      JOIN session_deletion_claims AS claim
        ON claim.conductor_session_id = member.claim_conductor_session_id
      WHERE member.session_id = OLD.id AND claim.state = 'claimed'
    ) AND (
      OLD.id IS NOT NEW.id
      OR OLD.session_role IS NOT NEW.session_role
      OR OLD.conductor_session_id IS NOT NEW.conductor_session_id
      OR OLD.parent_session_id IS NOT NEW.parent_session_id
      OR OLD.tmux_name IS NOT NEW.tmux_name
      OR OLD.agent_type IS NOT NEW.agent_type
      OR OLD.working_directory IS NOT NEW.working_directory
      OR OLD.worktree_path IS NOT NEW.worktree_path
      OR OLD.worktree_paths IS NOT NEW.worktree_paths
      OR OLD.dev_server_port IS NOT NEW.dev_server_port
    )
    BEGIN
      SELECT RAISE(ABORT, 'session deletion is in progress');
    END;

    CREATE TRIGGER trg_sessions_deletion_claim_member_delete_guard
    BEFORE DELETE ON sessions
    WHEN EXISTS (
      SELECT 1
      FROM session_deletion_claim_members AS member
      JOIN session_deletion_claims AS claim
        ON claim.conductor_session_id = member.claim_conductor_session_id
      WHERE member.session_id = OLD.id AND claim.state = 'claimed'
    )
    BEGIN
      SELECT RAISE(ABORT, 'session deletion is in progress');
    END;
  `);

  const sessionColumns = new Set(
    (
      db.prepare(`PRAGMA table_info("sessions")`).all() as Array<{
        name: string;
      }>
    ).map((entry) => entry.name)
  );
  if (
    ![
      "id",
      "conductor_session_id",
      "parent_session_id",
      "tmux_name",
      "agent_type",
    ].every((column) => sessionColumns.has(column))
  ) {
    db.exec(`
      DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_insert_guard;
      DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_attach_guard;
    `);
  }
  if (
    ![
      "id",
      "session_role",
      "conductor_session_id",
      "parent_session_id",
      "tmux_name",
      "agent_type",
      "working_directory",
      "worktree_path",
      "worktree_paths",
      "dev_server_port",
    ].every((column) => sessionColumns.has(column))
  ) {
    db.exec(
      `DROP TRIGGER IF EXISTS trg_sessions_deletion_claim_member_update_guard`
    );
  }

  // Migration 82 may already have run in a developer database while this
  // unreleased claim schema was being hardened. Repair that intermediate shape
  // in place so the terminal fence is available without dropping its claims.
  if (!hasColumn(db, "session_deletion_claim_members", "backend_key")) {
    db.exec(
      "ALTER TABLE session_deletion_claim_members ADD COLUMN backend_key TEXT"
    );
    db.exec(`
      UPDATE session_deletion_claim_members
      SET backend_key = CASE
        WHEN tmux_name IS NOT NULL AND tmux_name <> '' THEN tmux_name
        WHEN agent_type IN ('claude', 'codex', 'hermes', 'kilo', 'kimi', 'shell')
          THEN agent_type || '-' || session_id
        ELSE 'claude-' || session_id
      END
      WHERE backend_key IS NULL
    `);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_deletion_claim_members_backend
      ON session_deletion_claim_members(backend_key, disposition)
  `);
}

/** Install the durable pre-kill claim and its relationship fence atomically.
 * Replaying this at startup repairs trigger definitions without exposing a
 * trigger-free write window to another SQLite connection. */
export function ensureSessionDeletionClaimSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installSessionDeletionClaimSchema(db);
    return;
  }
  db.transaction(() => installSessionDeletionClaimSchema(db)).immediate();
}
