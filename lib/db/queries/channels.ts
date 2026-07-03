import type Database from "better-sqlite3";
import { getStmt } from "./_shared";

export const channelsQueries = {
  // Inter-agent channels (append-only 1:1 messages between sessions)
  createChannelMessage: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO channel_messages (id, pair_key, from_session_id, to_session_id, body)
       VALUES (?, ?, ?, ?, ?)`
    ),

  getChannelMessage: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM channel_messages WHERE id = ?`),

  // Unread inbox for a recipient, oldest first (the order to read/deliver in).
  // rowid is the tiebreak: created_at has 1-second granularity, so same-second
  // messages must fall back to insertion order (rowid), never the random UUID id.
  listChannelInbox: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM channel_messages
       WHERE to_session_id = ? AND read_at IS NULL
       ORDER BY created_at ASC, rowid ASC LIMIT ?`
    ),

  // The single oldest unread message for a recipient (the opt-in delivery picks
  // this — one message in flight at a time).
  nextChannelInbox: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM channel_messages
       WHERE to_session_id = ? AND read_at IS NULL
       ORDER BY created_at ASC, rowid ASC LIMIT 1`
    ),

  // The full conversation between a pair (both directions), oldest first.
  listChannelThread: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM channel_messages
       WHERE pair_key = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`
    ),

  // Consume on pull: mark one unread message read. Guards read_at IS NULL so a
  // re-read can't move the timestamp.
  markChannelRead: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE channel_messages SET read_at = datetime('now')
       WHERE id = ? AND read_at IS NULL`
    ),

  // The DISTINCT recipients with at least one unread message — the opt-in push
  // tick reads this ONCE per tick instead of probing every live session's inbox,
  // then picks the oldest unread per recipient. Ordered for determinism.
  listPendingChannelRecipients: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT DISTINCT to_session_id FROM channel_messages
       WHERE read_at IS NULL ORDER BY to_session_id ASC`
    ),

  // Orphan cleanup on session hard-delete: remove every message the session sent
  // OR received. channel_messages has no FK cascade, so a delete must run this.
  // (Bind the same session id to both placeholders.)
  deleteChannelMessagesForSession: (db: Database.Database) =>
    getStmt(
      db,
      `DELETE FROM channel_messages
       WHERE from_session_id = ? OR to_session_id = ?`
    ),

  // Scheduler (fire a prompt into a session on a cadence)
  createSchedule: (db: Database.Database) =>
    getStmt(
      db,
      `INSERT INTO schedules (id, name, session_id, prompt, recurrence, next_run_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),

  getSchedule: (db: Database.Database) =>
    getStmt(db, `SELECT * FROM schedules WHERE id = ?`),

  listSchedules: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM schedules ORDER BY enabled DESC, next_run_at ASC LIMIT ?`
    ),

  // Count a session's ENABLED schedules — caps how many can flood one session.
  countEnabledSchedulesForSession: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT COUNT(*) AS n FROM schedules WHERE session_id = ? AND enabled = 1`
    ),

  // Due, enabled schedules (the tick fires these), oldest-due first.
  listDueSchedules: (db: Database.Database) =>
    getStmt(
      db,
      `SELECT * FROM schedules
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC LIMIT ?`
    ),

  // Advance a recurring schedule after a fire: stamp last_run_at + the new
  // next_run_at. (A one-shot is disabled via setScheduleEnabled instead.)
  advanceSchedule: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE schedules
       SET last_run_at = ?, next_run_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    ),

  setScheduleEnabled: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE schedules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`
    ),

  // Mark a one-shot fired: stamp last_run_at and disable it (it won't fire again).
  markScheduleFiredOnce: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE schedules
       SET last_run_at = ?, enabled = 0, updated_at = datetime('now')
       WHERE id = ?`
    ),

  deleteSchedule: (db: Database.Database) =>
    getStmt(db, `DELETE FROM schedules WHERE id = ?`),

  // Orphan cleanup on session hard-delete: remove every schedule targeting the
  // session. schedules has no FK on session_id (the tick otherwise disables an
  // orphan as a fallback), so a hard delete must run this to avoid dead rows.
  deleteSchedulesForSession: (db: Database.Database) =>
    getStmt(db, `DELETE FROM schedules WHERE session_id = ?`),

  // Opt-in push: record the terminal delivery and consume the message in one step.
  // Idempotent AND loses to a pull: `read_at IS NULL` means a message already
  // consumed via channel_inbox between the push's select and its paste won't be
  // re-stamped as delivered (keeps the pulled/pushed state coherent); the
  // delivered_at guard likewise stops a re-fire from re-stamping the push time.
  markChannelDelivered: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE channel_messages
       SET delivered_at = datetime('now'),
           read_at = datetime('now')
       WHERE id = ? AND delivered_at IS NULL AND read_at IS NULL`
    ),

  // Un-claim a message the push CLAIMED but then failed to paste, so the next
  // tick re-delivers it (restores at-least-once when a transient paste error —
  // e.g. the pane died mid-tick — would otherwise silently drop it). Guarded on
  // `delivered_at IS NOT NULL` so it only reverts a PUSH-claimed row and can
  // never un-consume a message a PULL already read (pull sets read_at only).
  resetChannelDelivery: (db: Database.Database) =>
    getStmt(
      db,
      `UPDATE channel_messages
       SET delivered_at = NULL, read_at = NULL
       WHERE id = ? AND delivered_at IS NOT NULL`
    ),
};
