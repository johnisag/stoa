import type Database from "better-sqlite3";
import type { Session } from "./types";
import { ensureSessionLaunchProfileSchema } from "./session-launch-profile-schema";
import {
  fleetSessionProfile,
  type FleetSessionOwner,
  type FleetSessionOwnerType,
} from "../fleet/session-profile";

interface FleetSessionOwnerCandidate extends FleetSessionOwner {
  sessionId: string;
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
}

function hasColumns(
  db: Database.Database,
  table: string,
  columns: readonly string[]
): boolean {
  if (!hasTable(db, table)) return false;
  const present = new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
  return columns.every((column) => present.has(column));
}

function addCandidates(
  bySession: Map<string, FleetSessionOwnerCandidate>,
  rows: FleetSessionOwnerCandidate[]
): void {
  for (const row of rows) {
    if (!row.sessionId || !row.runId || !row.ownerId) continue;
    bySession.set(row.sessionId, row);
  }
}

function referencedFleetSessions(
  db: Database.Database
): FleetSessionOwnerCandidate[] {
  const bySession = new Map<string, FleetSessionOwnerCandidate>();

  // Least-specific evidence first; exact lifecycle tables below replace it.
  if (
    hasColumns(db, "fleet_cost_accounts", [
      "session_id",
      "fleet_run_id",
      "owner_type",
      "owner_id",
    ])
  ) {
    const rows = db
      .prepare(
        `SELECT session_id AS sessionId, fleet_run_id AS runId,
                owner_type AS ownerType, owner_id AS ownerId
         FROM fleet_cost_accounts
         WHERE session_id IS NOT NULL
           AND owner_type IN ('worker', 'planner', 'plan_review', 'task_review', 'fixer')`
      )
      .all() as FleetSessionOwnerCandidate[];
    addCandidates(bySession, rows);
  }
  if (
    hasColumns(db, "fleet_reviews", [
      "id",
      "reviewer_session_id",
      "fleet_run_id",
      "request_id",
    ])
  ) {
    addCandidates(
      bySession,
      db
        .prepare(
          `SELECT reviewer_session_id AS sessionId, fleet_run_id AS runId,
                  'plan_review' AS ownerType,
                  COALESCE(NULLIF(request_id, ''), id) AS ownerId
           FROM fleet_reviews WHERE reviewer_session_id <> ''`
        )
        .all() as FleetSessionOwnerCandidate[]
    );
  }
  if (
    hasColumns(db, "fleet_task_reviews", [
      "id",
      "reviewer_session_id",
      "fleet_run_id",
      "request_id",
    ])
  ) {
    addCandidates(
      bySession,
      db
        .prepare(
          `SELECT reviewer_session_id AS sessionId, fleet_run_id AS runId,
                  'task_review' AS ownerType,
                  COALESCE(NULLIF(request_id, ''), id) AS ownerId
           FROM fleet_task_reviews WHERE reviewer_session_id <> ''`
        )
        .all() as FleetSessionOwnerCandidate[]
    );
  }
  if (
    hasColumns(db, "fleet_task_fixes", [
      "id",
      "fixer_session_id",
      "fleet_run_id",
      "request_id",
    ])
  ) {
    addCandidates(
      bySession,
      db
        .prepare(
          `SELECT fixer_session_id AS sessionId, fleet_run_id AS runId,
                  'fixer' AS ownerType,
                  COALESCE(NULLIF(request_id, ''), id) AS ownerId
           FROM fleet_task_fixes
           WHERE fixer_session_id IS NOT NULL AND fixer_session_id <> ''`
        )
        .all() as FleetSessionOwnerCandidate[]
    );
  }
  if (hasColumns(db, "fleet_runs", ["id", "settings_json"])) {
    addCandidates(
      bySession,
      db
        .prepare(
          `SELECT json_extract(settings_json, '$.planner.sessionId') AS sessionId,
                  id AS runId, 'planner' AS ownerType,
                  COALESCE(json_extract(settings_json, '$.planner.requestId'), id) AS ownerId
           FROM fleet_runs
           WHERE json_valid(settings_json)
             AND json_type(settings_json, '$.planner.sessionId') = 'text'`
        )
        .all() as FleetSessionOwnerCandidate[]
    );
  }
  // A worker's durable worker row and ownership key are authoritative over any
  // partially activated cost account left by a crash.
  if (hasColumns(db, "fleet_workers", ["session_id", "fleet_run_id", "id"])) {
    addCandidates(
      bySession,
      db
        .prepare(
          `SELECT session_id AS sessionId, fleet_run_id AS runId,
                  'worker' AS ownerType, id AS ownerId
           FROM fleet_workers WHERE session_id IS NOT NULL`
        )
        .all() as FleetSessionOwnerCandidate[]
    );
  }
  return [...bySession.values()];
}

function installFleetOwnedSessionRoles(db: Database.Database): void {
  if (!hasTable(db, "sessions")) return;
  const candidates = referencedFleetSessions(db);
  if (candidates.length === 0) return;

  // Migration 76 made launch profiles immutable. Temporarily remove only the
  // update trigger while converting legacy Fleet rows, then reinstall and
  // validate the complete profile schema below.
  db.exec(`DROP TRIGGER IF EXISTS trg_sessions_launch_profile_immutable`);
  const read = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const update = db.prepare(
    `UPDATE sessions
     SET session_role = ?, launch_profile_json = ?, launch_profile_hash = ?
     WHERE id = ? AND COALESCE(session_role, 'interactive') = 'interactive'
       AND launch_profile_json IS NULL AND launch_profile_hash IS NULL`
  );
  for (const owner of candidates) {
    const session = read.get(owner.sessionId) as Session | undefined;
    if (!session || (session.session_role ?? "interactive") !== "interactive") {
      continue;
    }
    const binding = fleetSessionProfile({
      runId: owner.runId,
      ownerType: owner.ownerType as FleetSessionOwnerType,
      ownerId: owner.ownerId,
      sessionId: session.id,
      backendKey: session.tmux_name ?? null,
      provider: session.agent_type || "claude",
      model: session.model?.trim() || null,
      approvalMode: session.approval_mode ?? null,
      workingDirectory: session.working_directory,
      conductorSessionId: session.conductor_session_id ?? null,
      worktreePath: session.worktree_path ?? null,
      branchName: session.branch_name ?? null,
      baseBranch: session.base_branch ?? null,
      fleetOwnershipKey: session.fleet_ownership_key ?? null,
      workerTask: session.worker_task ?? null,
    });
    update.run(
      binding.role,
      binding.profileJson,
      binding.profileHash,
      session.id
    );
  }
}

/** Backfill pre-role Fleet rows without exposing them during restart, then let
 * the shared launch-profile installer validate and restore immutability. */
export function ensureFleetOwnedSessionRoleSchema(db: Database.Database): void {
  if (
    !hasColumns(db, "sessions", [
      "session_role",
      "launch_profile_json",
      "launch_profile_hash",
      "tmux_name",
      "agent_type",
      "model",
      "approval_mode",
      "working_directory",
      "conductor_session_id",
      "worktree_path",
      "branch_name",
      "base_branch",
      "fleet_ownership_key",
      "worker_task",
    ])
  ) {
    return;
  }
  const run = () => {
    installFleetOwnedSessionRoles(db);
    ensureSessionLaunchProfileSchema(db);
  };
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
}
