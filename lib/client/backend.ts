"use client";

/**
 * Client-side helpers for the active session backend.
 *
 * getActiveBackend() reports whether the server runs the native pty backend or
 * legacy tmux (cached after first fetch). buildSpawnForSession() produces the
 * structured spawn params the pty attach protocol needs from a Session.
 */

import {
  buildAgentArgsForSession,
  sessionLaunchEnv,
} from "@/lib/session-launch";
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

/** Ask the server-owned tmux backend to create a session, then return its exact
 * backend key for the terminal's attach-only command. */
export async function launchTmuxSession(
  sessionId: string,
  initialPrompt?: string
): Promise<string> {
  const response = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/launch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initialPrompt }),
    }
  );
  const data = (await response.json().catch(() => null)) as {
    error?: unknown;
    sessionName?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      typeof data?.error === "string" ? data.error : "Failed to launch session"
    );
  }
  if (typeof data?.sessionName !== "string" || !data.sessionName) {
    throw new Error("Session launch returned an invalid backend key");
  }
  return data.sessionName;
}

export interface SessionSpawn {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
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
  const cwd = session.working_directory || "~";
  // Route through the single chokepoint (lib/session-launch): the shell
  // short-circuit, the injection-defense model clamp, the MCP-arg parse, and the
  // native-fork parent resolution all live there so no launch path can drift or
  // skip the clamp. A shell session yields an empty argv.
  const { binary, args } = buildAgentArgsForSession(session, opts);
  return { binary, args, cwd, env: sessionLaunchEnv(session) };
}
