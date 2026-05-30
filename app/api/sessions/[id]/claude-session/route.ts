import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";

// GET: Check tmux environment for Claude session ID
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tmuxSession = `claude-${id}`;

  try {
    // Check tmux environment for CLAUDE_SESSION_ID
    const backend = getSessionBackend();
    const sessionId = await backend.getEnv(tmuxSession, "CLAUDE_SESSION_ID");

    if (sessionId !== null) {
      if (sessionId && sessionId !== "null") {
        // Update database with the session ID
        const stmt = db.prepare(
          "UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?"
        );
        stmt.run(sessionId, id);

        return NextResponse.json({ claude_session_id: sessionId });
      }
    }

    return NextResponse.json({ claude_session_id: null });
  } catch (error) {
    console.error("Error getting Claude session ID:", error);
    return NextResponse.json({ claude_session_id: null });
  }
}
