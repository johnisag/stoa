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
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).some((row) => row.name === column);
}

function installFleetSessionOwnershipSchema(db: Database.Database): void {
  if (
    hasTable(db, "sessions") &&
    !hasColumn(db, "sessions", "fleet_ownership_key")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fleet_ownership_key TEXT`);
  }
  if (
    hasTable(db, "fleet_workers") &&
    !hasColumn(db, "fleet_workers", "session_ownership_key")
  ) {
    db.exec(`ALTER TABLE fleet_workers ADD COLUMN session_ownership_key TEXT`);
  }
  if (!hasTable(db, "sessions") || !hasTable(db, "fleet_workers")) return;

  const invalidSession = db
    .prepare(
      `SELECT id FROM sessions
       WHERE fleet_ownership_key IS NOT NULL
         AND (
           length(fleet_ownership_key) <> 64
           OR fleet_ownership_key <> lower(fleet_ownership_key)
           OR fleet_ownership_key GLOB '*[^0-9a-f]*'
         )
       LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (invalidSession) {
    throw new Error(
      `invalid Fleet session ownership for session ${invalidSession.id}`
    );
  }
  const invalidWorker = db
    .prepare(
      `SELECT id FROM fleet_workers
       WHERE session_ownership_key IS NOT NULL
         AND (
           length(session_ownership_key) <> 64
           OR session_ownership_key <> lower(session_ownership_key)
           OR session_ownership_key GLOB '*[^0-9a-f]*'
         )
       LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (invalidWorker) {
    throw new Error(
      `invalid Fleet worker session ownership for worker ${invalidWorker.id}`
    );
  }

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_fleet_ownership
      ON sessions(fleet_ownership_key) WHERE fleet_ownership_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_workers_session_ownership
      ON fleet_workers(session_ownership_key)
      WHERE session_ownership_key IS NOT NULL;

    DROP TRIGGER IF EXISTS trg_sessions_fleet_ownership_insert_valid;
    DROP TRIGGER IF EXISTS trg_sessions_fleet_ownership_immutable;
    DROP TRIGGER IF EXISTS trg_fleet_workers_session_ownership_insert_valid;
    DROP TRIGGER IF EXISTS trg_fleet_workers_session_ownership_immutable;

    CREATE TRIGGER trg_fleet_workers_session_ownership_insert_valid
    BEFORE INSERT ON fleet_workers
    WHEN NEW.session_ownership_key IS NOT NULL AND (
      length(NEW.session_ownership_key) <> 64
      OR NEW.session_ownership_key <> lower(NEW.session_ownership_key)
      OR NEW.session_ownership_key GLOB '*[^0-9a-f]*'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Fleet worker session ownership key');
    END;

    CREATE TRIGGER trg_fleet_workers_session_ownership_immutable
    BEFORE UPDATE OF session_ownership_key ON fleet_workers
    WHEN OLD.session_ownership_key IS NOT NEW.session_ownership_key
    BEGIN
      SELECT RAISE(ABORT, 'Fleet worker session ownership key is immutable');
    END;

    CREATE TRIGGER trg_sessions_fleet_ownership_insert_valid
    BEFORE INSERT ON sessions
    WHEN NEW.fleet_ownership_key IS NOT NULL AND (
      length(NEW.fleet_ownership_key) <> 64
      OR NEW.fleet_ownership_key <> lower(NEW.fleet_ownership_key)
      OR NEW.fleet_ownership_key GLOB '*[^0-9a-f]*'
      OR NOT EXISTS (
        SELECT 1 FROM fleet_workers
        WHERE session_ownership_key = NEW.fleet_ownership_key
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid Fleet session ownership key');
    END;

    CREATE TRIGGER trg_sessions_fleet_ownership_immutable
    BEFORE UPDATE OF fleet_ownership_key ON sessions
    WHEN OLD.fleet_ownership_key IS NOT NEW.fleet_ownership_key
    BEGIN
      SELECT RAISE(ABORT, 'Fleet session ownership key is immutable');
    END;
  `);
}

/** Install the exact Fleet worker/session ownership columns, indexes, and
 * enforcing triggers atomically. Replaying repairs dropped indexes/triggers. */
export function ensureFleetSessionOwnershipSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installFleetSessionOwnershipSchema(db);
    return;
  }
  db.transaction(() => installFleetSessionOwnershipSchema(db)).immediate();
}
