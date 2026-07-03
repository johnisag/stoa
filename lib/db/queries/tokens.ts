import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

// #46/#49 per-device named revocable auth tokens. Only the SHA-256 HASH of a
// token's secret is ever stored, so a DB read can't recover a usable token.
// Resolution looks up by hash AND requires revoked_at IS NULL, so a revoked token
// fails auth immediately (revocation is checked live, not cached).
export const tokensQueries = {
  createAuthToken: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO auth_tokens (id, name, token_hash, scope) VALUES (?, ?, ?, ?)`
    ),

  // Resolve a presented token by its hash — only NON-revoked rows match.
  resolveAuthToken: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, scope FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL`
    ),

  // Stamp last-use (best-effort; never on the auth hot-path's critical result).
  touchAuthToken: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE auth_tokens SET last_used_at = datetime('now') WHERE id = ?`
    ),

  // The settings list — NEVER selects token_hash (it must not leave the DB layer).
  listAuthTokens: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT id, name, scope, created_at, last_used_at, revoked_at
       FROM auth_tokens ORDER BY created_at DESC`
    ),

  // Revoke (idempotent — a second revoke changes 0 rows).
  revokeAuthToken: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE auth_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`
    ),
};
