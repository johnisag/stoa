import type Database from "better-sqlite3";

// Prepared statement cache keyed by Database instance so statements are released
// when the database is garbage-collected. A WeakMap prevents unbounded growth
// when many in-memory DB instances are opened (e.g. tests). Shared by every domain
// query module (#54) + the audit helpers, so there is ONE cache per db.
const stmtCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();

export function getStmt<
  BindParameters extends unknown[] = unknown[],
  Result = unknown,
>(
  db: Database.Database,
  sql: string
): Database.Statement<BindParameters, Result> {
  let dbCache = stmtCache.get(db);
  if (!dbCache) {
    dbCache = new Map<string, Database.Statement>();
    stmtCache.set(db, dbCache);
  }
  let stmt = dbCache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    dbCache.set(sql, stmt);
  }
  return stmt as Database.Statement<BindParameters, Result>;
}
