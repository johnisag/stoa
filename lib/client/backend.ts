"use client";

/**
 * Client-side helpers for the active session backend.
 *
 * getActiveBackend() reports whether the server runs the native pty backend or
 * legacy tmux (cached after first fetch). buildSpawnForSession() produces the
 * structured spawn params the pty attach protocol needs from a Session.
 */

import { getProvider, buildAgentArgs } from "@/lib/providers";
import type { Session } from "@/lib/db";

let cached: "pty" | "tmux" | null = null;

export async function getActiveBackend(): Promise<"pty" | "tmux"> {
  if (cached) return cached;
  try {
    const res = await fetch("/api/backend");
    const data = await res.json();
    cached = data.backend === "pty" ? "pty" : "tmux";
  } catch {
    cached = "tmux";
  }
  return cached;
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
 */
export function buildSpawnForSession(
  session: Session,
  opts?: { initialPrompt?: string; parentSessionId?: string | null }
): SessionSpawn {
  const provider = getProvider(session.agent_type || "claude");
  const cwd = session.working_directory || "~";
  if (provider.id === "shell") {
    return { binary: "", args: [], cwd };
  }
  const { binary, args } = buildAgentArgs(session.agent_type || "claude", {
    sessionId: session.claude_session_id,
    parentSessionId: opts?.parentSessionId ?? null,
    autoApprove: session.auto_approve,
    model: session.model,
    initialPrompt: opts?.initialPrompt,
  });
  return { binary, args, cwd };
}
