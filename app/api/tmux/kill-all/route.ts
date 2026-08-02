import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import {
  backendKeyForSession,
  getManagedSessionPattern,
} from "@/lib/providers/registry";
import { requireLocalhost } from "@/lib/api-security";
import { isInteractiveSessionRole } from "@/lib/session-role";

// POST /api/tmux/kill-all - Kill all Stoa tmux sessions and remove from database
export async function POST(request: NextRequest) {
  const auth = requireLocalhost(request);
  if (!auth.ok) return auth.response;

  try {
    const db = getDb();
    const backend = getSessionBackend();

    const dbSessions = queries.getAllSessions(db).all() as Session[];
    const genericSessions = dbSessions.filter(isInteractiveSessionRole);
    const protectedBackendKeys = new Set(
      dbSessions
        .filter((session) => !isInteractiveSessionRole(session))
        .map(backendKeyForSession)
    );

    // Get all backend sessions. Server-owned keys are excluded before any kill:
    // their owner must settle process + accounting state through its own API.
    const sessions = await backend.list();

    // Match Stoa-managed session names ({provider}-{uuid}) via the registry
    // pattern so this stays in sync with the supported provider list.
    const managedPattern = getManagedSessionPattern();
    const tmuxSessions = sessions.filter(
      (s) => s && managedPattern.test(s) && !protectedBackendKeys.has(s)
    );

    // Kill each tmux session
    const killed: string[] = [];
    for (const session of tmuxSessions) {
      try {
        await backend.kill(session);
        killed.push(session);
      } catch {
        // Session might already be dead, continue
      }
    }

    // Delete only ordinary user sessions. Internal rows are durable ownership
    // records and must survive this generic emergency action.
    let deletedFromDb = 0;
    for (const session of genericSessions) {
      try {
        deletedFromDb += queries.deleteSession(db).run(session.id).changes;
      } catch {
        // Continue on error
      }
    }

    return NextResponse.json({
      killed: killed.length,
      sessions: killed,
      deletedFromDb,
    });
  } catch (error) {
    console.error("Error killing tmux sessions:", error);
    return NextResponse.json(
      { error: "Failed to kill sessions" },
      { status: 500 }
    );
  }
}
