/**
 * Command Stoa — the in-process create_session executor.
 *
 * The plain-session subset of POST /api/sessions (no worktree, no fork, no
 * orchestration), run directly via the typed DB primitives. We do NOT self-fetch
 * the HTTP route: a server-to-self fetch would derive its origin from the request
 * Host header (an SSRF / outbound-exfil surface) and couple two route contracts
 * across an untyped JSON boundary. A direct typed call is both safer and
 * drift-proof (a createSession signature change fails the build).
 *
 * The working directory comes from the RESOLVED project the caller passes (looked
 * up server-side from projectId) — never from the agent/client. auto_approve is
 * hard-wired OFF: a chatbox-created session is never permission-bypassing.
 */

import { randomUUID } from "crypto";
import { getDb, queries, type Session } from "@/lib/db";
import { sessionKey } from "@/lib/providers/registry";
import { resolveModelForAgent } from "@/lib/model-catalog";
import type { CreateSessionParams } from "./actions";

/** The fields of the resolved project the executor needs (a Project subset). */
export interface ResolvedProject {
  id: string;
  working_directory: string;
  default_model: string | null;
}

export interface CreatedSession {
  id: string;
  name: string;
  /** The seed prompt to send as the first keystroke, if the proposal included
   * one. Not stored in the DB — returned to the client which delivers it via
   * the same mechanism the New Session dialog uses (first terminal input). */
  initialPrompt?: string;
}

/** Generate a unique "Session N" name — mirrors the private helper in
 * app/api/sessions/route.ts (the plain-session default name). */
function generateSessionName(db: ReturnType<typeof getDb>): string {
  const sessions = queries.getAllSessions(db).all() as Session[];
  const used = sessions
    .map((s) => {
      const m = s.name.match(/^Session (\d+)$/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter((n) => n > 0);
  return `Session ${used.length > 0 ? Math.max(...used) + 1 : 1}`;
}

/**
 * Create the session row for a validated proposal against the resolved project.
 * Returns the new session's id + name.
 */
export function executeCreateSession(
  params: CreateSessionParams,
  project: ResolvedProject
): CreatedSession {
  const db = getDb();
  const { agentType } = params;
  const model = resolveModelForAgent(
    agentType,
    params.model || project.default_model
  );
  const name = params.name?.trim() || generateSessionName(db);
  const id = randomUUID();
  const tmuxName = sessionKey({ kind: "agent", provider: agentType, id });

  queries.createSession(db).run(
    id,
    name,
    tmuxName,
    project.working_directory,
    null, // parentSessionId — not a fork
    model,
    null, // systemPrompt
    "sessions", // groupPath
    agentType,
    0, // auto_approve OFF — a chatbox-created session never bypasses permissions
    project.id
  );

  const session = queries.getSession(db).get(id) as Session;
  const result: CreatedSession = { id: session.id, name: session.name };
  if (params.initialPrompt) result.initialPrompt = params.initialPrompt;
  return result;
}
