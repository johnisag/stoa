import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const infraQueries = {
  // Dev servers
  createDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO dev_servers (id, project_id, type, name, command, status, pid, container_id, ports, working_directory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),

  getDevServer: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dev_servers WHERE id = ?`),

  getAllDevServers: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM dev_servers ORDER BY created_at DESC`),

  getDevServersByProject: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM dev_servers WHERE project_id = ? ORDER BY created_at DESC`
    ),

  updateDevServerStatus: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateDevServerPid: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET pid = ?, status = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  updateDevServer: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE dev_servers SET status = ?, pid = ?, container_id = ?, ports = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  deleteDevServer: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dev_servers WHERE id = ?`),

  deleteDevServersByProject: (db: Database.Database) =>
    getStmt(db, `DELETE FROM dev_servers WHERE project_id = ?`),

  // Web Push subscriptions (closed-tab notifications)
  upsertPushSubscription: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
    ),

  deletePushSubscription: (db: Database.Database) =>
    getStmt(db, `DELETE FROM push_subscriptions WHERE endpoint = ?`),

  getAllPushSubscriptions: (db: Database.Database) =>
    getStmt(db, `SELECT endpoint, p256dh, auth FROM push_subscriptions`),

  countPushSubscriptions: (db: Database.Database) =>
    getStmt(db, `SELECT COUNT(*) AS n FROM push_subscriptions`),
};
