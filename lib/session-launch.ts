/**
 * Single chokepoint for turning a persisted `Session` row into agent launch argv
 * (#32). Historically several Session-shaped callers assembled the launch options
 * independently — the shell short-circuit, the injection-defense model clamp, the
 * MCP-arg parse, and the native-fork parent resolution — and any one of them could
 * drift or forget a step. This module funnels ALL of that into ONE resolver so the
 * pieces can't diverge and, crucially, so the model clamp is NON-BYPASSABLE.
 *
 * SECURITY: the model clamp here is ONE layer of a LAYERED defense — it is not
 * the sole guarantee, so don't rely on it alone.
 *   - STATIC agents (claude/codex): `resolveModelForAgent` drops a legacy /
 *     foreign / injection-shaped model to the STATIC-catalog value (or the
 *     agent's default) HERE, so it can never reach `--model`.
 *   - FREE-TEXT agents (Hermes/Kilo/Kimi): a legitimate model is forwarded
 *     VERBATIM (the whole point of a free-text agent), so this clamp does NOT
 *     neutralize it. What keeps THAT safe lives at the BOUNDARIES: the session
 *     create route rejects a non-`isSafeModel` model and the model is immutable
 *     afterward, and every launch uses a shell-less pty argv (one discrete
 *     token) or shell-quoted tmux flags — so a metacharacter can't inject.
 * Routing every Session→argv path through here is what keeps the static-agent
 * clamp and the MCP/fork resolution from DRIFTING; the free-text injection
 * defense is the write-boundary gate + shell-less argv, not this function alone.
 *
 * Pure (no I/O) so it can be unit-tested and shared by the client (pty re-attach in
 * lib/client/backend.ts + components/Pane) and the first-launch path (app/page.tsx).
 * Depends only on other pure modules — never on a server-only value import — so it
 * stays safe to pull into a "use client" component.
 */

import {
  buildAgentArgs,
  parseMcpLaunchArgs,
  getProvider,
  type BuildFlagsOptions,
  type AgentSpawn,
  type AgentType,
} from "./providers";
import { resolveModelForAgent } from "./model-catalog";
import { resolveNativeForkParentId } from "./fork";
import type { Session } from "./db";

/** Per-call overrides layered on top of what the Session row itself dictates. */
export interface SessionLaunchOptions {
  /** First-launch prompt to send. Omitted on a re-attach so it isn't resent. */
  initialPrompt?: string;
  /**
   * Explicit native-fork parent id. `undefined` = self-resolve from `allSessions`
   * (a not-yet-started native fork resumes its parent); an explicit value —
   * including `null` — overrides that self-resolution.
   */
  parentSessionId?: string | null;
  /** Session list used to self-resolve a native fork's parent id when needed. */
  allSessions?: Session[];
}

/**
 * The single Session→options resolver. Applies, in ONE place and always:
 *   - the shell short-circuit (returns `null` — a plain shell has no agent argv),
 *   - the injection-defense model clamp (`resolveModelForAgent`),
 *   - the conductor MCP-arg parse (`parseMcpLaunchArgs`),
 *   - the native-fork parent resolution (`resolveNativeForkParentId`).
 *
 * Returns the resolved agent type alongside the `BuildFlagsOptions` so a caller
 * that also needs the tmux path (`provider.buildFlags`) uses the SAME clamped
 * options as the pty path. Returns `null` for a shell session so callers emit an
 * empty spawn without duplicating the short-circuit.
 */
export function resolveSessionLaunchOptions(
  session: Session,
  opts?: SessionLaunchOptions
): { agentType: AgentType; options: BuildFlagsOptions } | null {
  const agentType: AgentType = session.agent_type || "claude";
  if (getProvider(agentType).id === "shell") return null;

  const parentSessionId =
    opts?.parentSessionId !== undefined
      ? opts.parentSessionId
      : opts?.allSessions
        ? resolveNativeForkParentId(session, opts.allSessions)
        : null;

  const options: BuildFlagsOptions = {
    sessionId: session.claude_session_id,
    parentSessionId,
    autoApprove: session.auto_approve,
    // Static-agent clamp: a legacy/foreign model is dropped to the safe catalog
    // value here. A free-text agent (hermes/kilo/kimi) forwards its model
    // VERBATIM — kept safe not by this clamp but by the write-boundary
    // isSafeModel gate (model immutable after create) + shell-less argv / tmux
    // quoting (see the module header).
    model: resolveModelForAgent(agentType, session.model),
    // Replay the conductor's persisted MCP wiring (e.g. Codex's
    // `-c mcp_servers.stoa.*`). Parsed via the shared helper so no launch path
    // drifts — the bug that lost a conductor's MCP wiring on re-attach was exactly
    // two spawn sites parsing this differently.
    extraArgs: parseMcpLaunchArgs(session.mcp_launch_args),
    initialPrompt: opts?.initialPrompt,
  };

  return { agentType, options };
}

/**
 * Build the pty spawn argv for a Session, routed through the single resolver so the
 * model clamp always fires. Returns an empty spawn for a shell session. This is the
 * argv-array (shell-less) path; the tmux path in app/page.tsx consumes the SAME
 * resolved options via `resolveSessionLaunchOptions`.
 */
export function buildAgentArgsForSession(
  session: Session,
  opts?: SessionLaunchOptions
): AgentSpawn {
  const resolved = resolveSessionLaunchOptions(session, opts);
  if (!resolved) return { binary: "", args: [] };
  return buildAgentArgs(resolved.agentType, resolved.options);
}
