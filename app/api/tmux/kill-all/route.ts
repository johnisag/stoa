import { NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";

// POST /api/tmux/kill-all - Kill all Stoa tmux sessions and remove from database
export async function POST() {
  try {
    const db = getDb();
    const backend = getSessionBackend();

    // Get all tmux sessions
    const sessions = await backend.list();

    const tmuxSessions = sessions.filter(
      (s) => s && /^(claude|codex|opencode|gemini|aider|cursor)-/.test(s)
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

    // Delete ALL sessions from database
    const dbSessions = queries.getAllSessions(db).all() as Session[];
    for (const session of dbSessions) {
      try {
        queries.deleteSession(db).run(session.id);
      } catch {
        // Continue on error
      }
    }

    return NextResponse.json({
      killed: killed.length,
      sessions: killed,
      deletedFromDb: dbSessions.length,
    });
  } catch (error) {
    console.error("Error killing tmux sessions:", error);
    return NextResponse.json(
      { error: "Failed to kill sessions" },
      { status: 500 }
    );
  }
}
