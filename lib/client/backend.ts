"use client";

/**
 * Client-side helpers for the active session backend.
 *
 * getActiveBackend() reports whether the server runs the native pty backend or
 * legacy tmux (cached after first fetch). buildSpawnForSession() produces the
 * structured spawn params the pty attach protocol needs from a Session.
 */

import {
  getProvider,
  buildAgentArgs,
  parseMcpLaunchArgs,
} from "@/lib/providers";
import { resolveModelForAgent } from "@/lib/model-catalog";
import { resolveNativeForkParentId } from "@/lib/fork";
import type { Session } from "@/lib/db";

let cached: "pty" | "tmux" | null = null;

export async function getActiveBackend(): Promise<"pty" | "tmux"> {
  if (cached) return cached;
  try {
    const res = await fetch("/api/backend");
    // A non-2xx that still returns JSON would otherwise be read as a "successful"
    // probe and cached for the page lifetime — defeating the contract below. Treat
    // it as a transient failure (falls to the catch, returns the fallback uncached).
    if (!res.ok) throw new Error("backend probe failed");
    const data = await res.json();
    // Only cache on a successful probe; a transient failure must not lock the
    // client to the fallback for the page lifetime.
    cached = data.backend === "pty" ? "pty" : "tmux";
    return cached;
  } catch {
    // One-shot fallback — do NOT write `cached`, so the next call re-probes.
    return "tmux";
  }
}

export interface SessionSpawn {
  binary: string;
  args: string[];
  cwd: string;
}

/**
 * Build pty spawn params for a session. Used for (re)attach — where the session
 * may already be running (server treats spawn as create-if-missing) or may need
 * respawning after a server restart. Omits the initial prompt by default so a
 * re-attach doesn't resend it; pass initialPrompt for a first launch.
 *
 * Pass `allSessions` so a NATIVE fork that re-attaches BEFORE its first turn (no
 * own claude_session_id yet) still resumes its parent's conversation
 * (`--resume <parent> --fork-session`) instead of respawning blank — via the SAME
 * resolveNativeForkParentId the first-launch path uses, so they can't drift. An
 * explicit `parentSessionId` (incl. null) overrides the self-resolution.
 */
export function buildSpawnForSession(
  session: Session,
  opts?: {
    initialPrompt?: string;
    parentSessionId?: string | null;
    allSessions?: Session[];
  }
): SessionSpawn {
  const provider = getProvider(session.agent_type || "claude");
  const cwd = session.working_directory || "~";
  if (provider.id === "shell") {
    return { binary: "", args: [], cwd };
  }
  const parentSessionId =
    opts?.parentSessionId !== undefined
      ? opts.parentSessionId
      : opts?.allSessions
        ? resolveNativeForkParentId(session, opts.allSessions)
        : null;
  const { binary, args } = buildAgentArgs(session.agent_type || "claude", {
    sessionId: session.claude_session_id,
    parentSessionId,
    autoApprove: session.auto_approve,
    // Resolve so a legacy row holding a foreign/non-catalog model can't reach
    // `--model <bogus>` on a fresh respawn (every other spawn site resolves too).
    model: resolveModelForAgent(session.agent_type || "claude", session.model),
    // Replay the conductor's persisted MCP wiring (e.g. Codex's
    // `-c mcp_servers.stoa.*`) — the pty server treats spawn as create-if-missing,
    // so without this a Codex conductor respawned on re-attach (after a server
    // restart) silently loses its stoa MCP server. Mirrors the server spawn path.
    extraArgs: parseMcpLaunchArgs(session.mcp_launch_args),
    initialPrompt: opts?.initialPrompt,
  });
  return { binary, args, cwd };
}
