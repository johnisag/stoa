import type Database from "better-sqlite3";
import type { Session } from "@/lib/db";
import {
  fleetSessionProfile,
  type FleetSessionOwner,
} from "@/lib/fleet/session-profile";
import type { ProviderId } from "@/lib/providers/registry";

interface FleetSessionFixtureInput extends FleetSessionOwner {
  sessionId: string;
  provider: Exclude<ProviderId, "shell">;
  model: string | null;
  approvalMode: string;
  workingDirectory: string;
  workerTask: string;
  worktreePath: string | null;
  branchName: string | null;
  baseBranch: string | null;
  conductorSessionId?: string | null;
  fleetOwnershipKey?: string | null;
}

/** Insert the same canonical owner-bound session shape that spawnWorker writes. */
export function insertFleetOwnedSession(
  db: Database.Database,
  input: FleetSessionFixtureInput
): Session {
  const backendKey = `${input.provider}-${input.sessionId}`;
  const profile = fleetSessionProfile({
    ...input,
    backendKey,
    conductorSessionId: input.conductorSessionId ?? null,
    fleetOwnershipKey: input.fleetOwnershipKey ?? null,
  });
  db.prepare(
    `INSERT INTO sessions (
       id, name, tmux_name, status, working_directory, model, group_path,
       agent_type, project_id, auto_approve, worker_task, worker_status,
       worktree_path, branch_name, base_branch, conductor_session_id,
       fleet_ownership_key, approval_mode, session_role,
       launch_profile_json, launch_profile_hash
     ) VALUES (?, ?, ?, 'running', ?, ?, 'sessions', ?, 'uncategorized', 1,
       ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.sessionId,
    input.sessionId,
    backendKey,
    input.workingDirectory,
    input.model,
    input.provider,
    input.workerTask,
    input.worktreePath,
    input.branchName,
    input.baseBranch,
    input.conductorSessionId ?? null,
    input.fleetOwnershipKey ?? null,
    input.approvalMode,
    profile.role,
    profile.profileJson,
    profile.profileHash
  );
  return db
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(input.sessionId) as Session;
}
