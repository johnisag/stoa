import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Session } from "@/lib/db";
import { isValidProviderId, sessionKey } from "@/lib/providers/registry";

export const FLEET_SESSION_ROLES = {
  worker: "fleet_worker",
  planner: "fleet_planner",
  plan_review: "fleet_plan_reviewer",
  task_review: "fleet_task_reviewer",
  fixer: "fleet_task_fixer",
} as const;

export type FleetSessionOwnerType = keyof typeof FLEET_SESSION_ROLES;
export type FleetOwnedSessionRole =
  (typeof FLEET_SESSION_ROLES)[FleetSessionOwnerType];

export interface FleetSessionOwner {
  runId: string;
  ownerType: FleetSessionOwnerType;
  ownerId: string;
}

interface FleetSessionProfileInput extends FleetSessionOwner {
  sessionId: string;
  backendKey: string | null;
  provider: string;
  model: string | null;
  approvalMode: string | null;
  workingDirectory: string;
  conductorSessionId: string | null;
  worktreePath: string | null;
  branchName: string | null;
  baseBranch: string | null;
  fleetOwnershipKey: string | null;
  workerTask: string | null;
}

export interface FleetSessionProfileBinding {
  role: FleetOwnedSessionRole;
  profileJson: string;
  profileHash: string;
}

export interface FleetSessionProfileExpectation extends FleetSessionOwner {
  sessionId: string;
}

export type FleetSessionProfileLookup =
  | { kind: "valid"; session: Session }
  | { kind: "missing" | "invalid" | "ambiguous"; error: string };

function detachedProfileConductorId(session: Session): string | null {
  if (session.conductor_session_id != null || !session.launch_profile_json) {
    return null;
  }
  try {
    const profile = JSON.parse(session.launch_profile_json) as unknown;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return null;
    }
    const conductorSessionId = (profile as { conductorSessionId?: unknown })
      .conductorSessionId;
    return typeof conductorSessionId === "string" && conductorSessionId !== ""
      ? conductorSessionId
      : null;
  } catch {
    return null;
  }
}

/**
 * Build the durable, owner-specific profile for a Fleet agent session. The
 * profile intentionally contains only launch identity (the prompt is hashed),
 * so generic session surfaces cannot recreate authority from mutable UI fields.
 */
export function fleetSessionProfile(
  input: FleetSessionProfileInput
): FleetSessionProfileBinding {
  const role = FLEET_SESSION_ROLES[input.ownerType];
  const profileJson = JSON.stringify({
    version: 1,
    role,
    fleetRunId: input.runId,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    backendKey: input.backendKey,
    provider: input.provider,
    model: input.model,
    approvalMode: input.approvalMode,
    workingDirectory: input.workingDirectory,
    conductorSessionId: input.conductorSessionId,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    fleetOwnershipKey: input.fleetOwnershipKey,
    workerTaskHash:
      input.workerTask == null
        ? null
        : createHash("sha256").update(input.workerTask, "utf8").digest("hex"),
  });
  return {
    role,
    profileJson,
    profileHash: createHash("sha256").update(profileJson, "utf8").digest("hex"),
  };
}

/**
 * Validate the complete immutable identity of one server-owned Fleet session.
 *
 * Merely checking a session id, prompt fragment, branch, or provider is not an
 * ownership proof: every one of those values can collide with an unrelated
 * session. The owner tuple is therefore supplied by the durable Fleet row and
 * the canonical profile is rebuilt from the session's immutable launch fields.
 * Both the exact JSON and its SHA-256 must match before a reconciler may observe,
 * adopt, stop, or otherwise operate on the session.
 */
export function fleetSessionProfileError(
  session: Session | null | undefined,
  expected: FleetSessionProfileExpectation
): string | null {
  if (!session || session.id !== expected.sessionId) {
    return "Fleet session identity is missing";
  }
  if (
    !isValidProviderId(session.agent_type) ||
    session.agent_type === "shell"
  ) {
    return "Fleet session launch provider is invalid";
  }
  const backendKey = sessionKey({
    kind: "agent",
    provider: session.agent_type,
    id: session.id,
  });
  const binding = fleetSessionProfile({
    ...expected,
    backendKey,
    provider: session.agent_type,
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
  const matches = (candidate: FleetSessionProfileBinding): boolean =>
    session.session_role === candidate.role &&
    session.tmux_name === backendKey &&
    session.launch_profile_json === candidate.profileJson &&
    session.launch_profile_hash === candidate.profileHash;
  if (matches(binding)) return null;

  // Deleting an interactive conductor preserves its Fleet children and clears
  // only their live FK. The original conductor remains immutable provenance in
  // the launch profile. Accept exactly that one-way non-null -> null detach;
  // every other launch field, the canonical JSON, and its SHA-256 still match.
  const originalConductorSessionId = detachedProfileConductorId(session);
  if (
    originalConductorSessionId == null ||
    !matches(
      fleetSessionProfile({
        ...expected,
        backendKey,
        provider: session.agent_type,
        model: session.model?.trim() || null,
        approvalMode: session.approval_mode ?? null,
        workingDirectory: session.working_directory,
        conductorSessionId: originalConductorSessionId,
        worktreePath: session.worktree_path ?? null,
        branchName: session.branch_name ?? null,
        baseBranch: session.base_branch ?? null,
        fleetOwnershipKey: session.fleet_ownership_key ?? null,
        workerTask: session.worker_task ?? null,
      })
    )
  ) {
    return "Fleet session immutable launch profile does not match its owner";
  }
  return null;
}

/**
 * Find the sole session carrying an exact Fleet owner tuple. This is used only
 * for the narrow crash gap after session creation and before its id is written
 * to the lifecycle row. Prompt, branch, and path searches are deliberately not
 * fallbacks: a decoy must result in no adoption, and duplicate owner profiles
 * are an ambiguous condition that fails closed.
 */
export function findFleetSessionByOwner(
  db: Database.Database,
  owner: FleetSessionOwner
): FleetSessionProfileLookup {
  const safeProfile =
    "CASE WHEN launch_profile_json IS NOT NULL AND json_valid(launch_profile_json) " +
    "THEN launch_profile_json ELSE '{}' END";
  const sessions = db
    .prepare(
      `SELECT * FROM sessions
       WHERE json_extract(${safeProfile}, '$.fleetRunId') = ?
         AND json_extract(${safeProfile}, '$.ownerType') = ?
         AND json_extract(${safeProfile}, '$.ownerId') = ?
       ORDER BY id`
    )
    .all(owner.runId, owner.ownerType, owner.ownerId) as Session[];
  if (sessions.length === 0) {
    return {
      kind: "missing",
      error: "Fleet session owner profile was not found",
    };
  }
  if (sessions.length !== 1) {
    return {
      kind: "ambiguous",
      error: "multiple sessions claim one Fleet owner profile",
    };
  }
  const session = sessions[0];
  const error = fleetSessionProfileError(session, {
    ...owner,
    sessionId: session.id,
  });
  return error ? { kind: "invalid", error } : { kind: "valid", session };
}
