import type { Session } from "@/lib/db";
import { sessionKey } from "@/lib/providers/registry";
import {
  managedSupervisorClaudeArgs,
  managedSupervisorProfileHash,
  MANAGED_SUPERVISOR_GROUP_PATH,
  MANAGED_SUPERVISOR_SESSION_ROLE,
  parseManagedSupervisorProfileJson,
  type ManagedSupervisorBrokerProfile,
} from "./supervisor-broker";

export interface ManagedSupervisorCostIdentity {
  fleet_run_id: string;
  session_id: string | null;
  session_key: string;
  owner_type: string;
  owner_id: string;
  provider: string;
  model: string | null;
}

export interface ManagedSupervisorSessionIdentityInput {
  session: Session | null | undefined;
  runId: string;
  requestId: string;
  sessionId: string;
  account?: ManagedSupervisorCostIdentity | null;
  expectedProfileHash?: string | null;
  expectedModel?: string | null;
}

export type ManagedSupervisorSessionIdentityResult =
  | {
      ok: true;
      backendKey: string;
      profile: ManagedSupervisorBrokerProfile;
    }
  | { ok: false; error: string };

export function managedSupervisorSessionTask(
  runId: string,
  requestId: string
): string {
  return `[Stoa Fleet] Managed advisory supervisor request ${requestId} for run ${runId}. Claude print mode has no tools, MCP, lifecycle authority, repository worktree, or generic respawn profile.`;
}

function exactSuffix(values: readonly string[], suffix: readonly string[]) {
  return (
    values.length >= suffix.length &&
    suffix.every(
      (value, index) => value === values[values.length - suffix.length + index]
    )
  );
}

/** Validate the complete persisted identity needed to observe or stop a managed
 * supervisor. The fallback reconciler has no settings state to trust, and the
 * normal reconciler can pass its additional expected hash/model bindings. */
export function validateManagedSupervisorSessionIdentity(
  input: ManagedSupervisorSessionIdentityInput
): ManagedSupervisorSessionIdentityResult {
  const session = input.session;
  if (!session || session.id !== input.sessionId) {
    return {
      ok: false,
      error: "managed supervisor session identity is missing",
    };
  }

  const backendKey = sessionKey({
    kind: "agent",
    provider: "claude",
    id: input.sessionId,
  });
  const profileJson = session.launch_profile_json;
  const profileHash = session.launch_profile_hash;
  let profile: ManagedSupervisorBrokerProfile | null = null;
  try {
    profile = profileJson
      ? parseManagedSupervisorProfileJson(profileJson)
      : null;
  } catch {
    profile = null;
  }

  const model = session.model;
  const account = input.account;
  const expectedAccountKey = account?.session_id
    ? backendKey
    : `pending:supervisor:${input.requestId}`;
  if (
    session.session_role !== MANAGED_SUPERVISOR_SESSION_ROLE ||
    !profileJson ||
    !profileHash ||
    !profile ||
    managedSupervisorProfileHash(profileJson) !== profileHash ||
    (input.expectedProfileHash != null &&
      profileHash !== input.expectedProfileHash) ||
    profile.backendKey !== backendKey ||
    session.tmux_name !== backendKey ||
    session.tmux_name !== profile.backendKey ||
    session.working_directory !== profile.workingDirectory ||
    profile.groupPath !== MANAGED_SUPERVISOR_GROUP_PATH ||
    session.group_path !== profile.groupPath ||
    profile.projectId !== null ||
    session.project_id !== null ||
    session.worker_task !==
      managedSupervisorSessionTask(input.runId, input.requestId) ||
    session.agent_type !== "claude" ||
    typeof model !== "string" ||
    model.length === 0 ||
    (input.expectedModel != null && model !== input.expectedModel) ||
    !exactSuffix(profile.providerArgs, managedSupervisorClaudeArgs(model)) ||
    Boolean(session.auto_approve) ||
    session.approval_mode !== "prompt" ||
    session.conductor_session_id !== null ||
    session.mcp_launch_args !== null ||
    session.parent_session_id !== null ||
    session.claude_session_id !== null ||
    session.system_prompt !== null ||
    session.worktree_path !== null ||
    session.branch_name !== null ||
    session.base_branch !== null ||
    (session.worktree_paths ?? null) !== null ||
    (account != null &&
      (account.fleet_run_id !== input.runId ||
        account.owner_type !== "supervisor" ||
        account.owner_id !== input.requestId ||
        (account.session_id != null &&
          account.session_id !== input.sessionId) ||
        account.session_key !== expectedAccountKey ||
        account.provider !== "claude" ||
        account.model !== model))
  ) {
    return {
      ok: false,
      error: "managed supervisor immutable session profile does not match",
    };
  }
  return { ok: true, backendKey, profile };
}
