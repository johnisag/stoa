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

function installFleetMergeProvenanceSchema(db: Database.Database): void {
  if (!hasTable(db, "fleet_merge_operations")) return;
  if (!hasColumn(db, "fleet_merge_operations", "expected_result_head_sha")) {
    db.exec(
      `ALTER TABLE fleet_merge_operations
       ADD COLUMN expected_result_head_sha TEXT`
    );
  }

  const invalid = db
    .prepare(
      `SELECT id FROM fleet_merge_operations
       WHERE expected_result_head_sha IS NOT NULL AND (
         length(expected_result_head_sha) NOT IN (40, 64)
         OR expected_result_head_sha <> lower(expected_result_head_sha)
         OR expected_result_head_sha GLOB '*[^0-9a-f]*'
       )
       LIMIT 1`
    )
    .get() as { id: string } | undefined;
  if (invalid) {
    throw new Error(
      `invalid expected Fleet merge result for operation ${invalid.id}`
    );
  }

  db.exec(`
    DROP TRIGGER IF EXISTS trg_fleet_merge_expected_result_insert_valid;
    DROP TRIGGER IF EXISTS trg_fleet_merge_expected_result_update_valid;
    DROP TRIGGER IF EXISTS trg_fleet_merge_expected_result_immutable;

    CREATE TRIGGER trg_fleet_merge_expected_result_insert_valid
    BEFORE INSERT ON fleet_merge_operations
    WHEN NEW.expected_result_head_sha IS NOT NULL AND (
      length(NEW.expected_result_head_sha) NOT IN (40, 64)
      OR NEW.expected_result_head_sha <> lower(NEW.expected_result_head_sha)
      OR NEW.expected_result_head_sha GLOB '*[^0-9a-f]*'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid expected Fleet merge result');
    END;

    CREATE TRIGGER trg_fleet_merge_expected_result_update_valid
    BEFORE UPDATE OF expected_result_head_sha ON fleet_merge_operations
    WHEN NEW.expected_result_head_sha IS NOT NULL AND (
      length(NEW.expected_result_head_sha) NOT IN (40, 64)
      OR NEW.expected_result_head_sha <> lower(NEW.expected_result_head_sha)
      OR NEW.expected_result_head_sha GLOB '*[^0-9a-f]*'
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid expected Fleet merge result');
    END;

    CREATE TRIGGER trg_fleet_merge_expected_result_immutable
    BEFORE UPDATE OF expected_result_head_sha ON fleet_merge_operations
    WHEN OLD.expected_result_head_sha IS NOT NULL
      AND OLD.expected_result_head_sha IS NOT NEW.expected_result_head_sha
    BEGIN
      SELECT RAISE(ABORT, 'expected Fleet merge result is immutable');
    END;
  `);
}

/** Install the durable exact-result binding used before a task merge moves its
 * Fleet-owned integration branch. Replaying repairs dropped triggers. */
export function ensureFleetMergeProvenanceSchema(db: Database.Database): void {
  if (db.inTransaction) {
    installFleetMergeProvenanceSchema(db);
    return;
  }
  db.transaction(() => installFleetMergeProvenanceSchema(db)).immediate();
}
