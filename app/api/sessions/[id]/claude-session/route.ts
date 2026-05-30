import { NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";
import { db, queries, type Session } from "@/lib/db";
import { getSessionBackend } from "@/lib/session-backend";
import { expandHome, findClaudeProjectDir } from "@/lib/platform";

// Fallback: derive the most recent Claude session id from on-disk JSONL files.
// The pty/host backend can't read a child process env, so getEnv is always null
// there — without this fallback the id never resolves on Windows.
function getClaudeSessionIdFromFiles(workingDirectory: string): string | null {
  const projectDir = findClaudeProjectDir(expandHome(workingDirectory));
  if (!projectDir || !fs.existsSync(projectDir)) {
    return null;
  }

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

  try {
    const files = fs.readdirSync(projectDir);
    let mostRecent: string | null = null;
    let mostRecentTime = 0;

    for (const file of files) {
      if (file.startsWith("agent-")) continue;
      if (!uuidPattern.test(file)) continue;

      const stat = fs.statSync(path.join(projectDir, file));
      if (stat.mtimeMs > mostRecentTime) {
        mostRecentTime = stat.mtimeMs;
        mostRecent = file.replace(".jsonl", "");
      }
    }

    if (mostRecent && Date.now() - mostRecentTime < 5 * 60 * 1000) {
      return mostRecent;
    }

    return null;
  } catch {
    return null;
  }
}

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
    const envId = await backend.getEnv(tmuxSession, "CLAUDE_SESSION_ID");

    let sessionId = envId && envId !== "null" ? envId : null;

    // Fallback: getEnv is always null on the pty/host backend (can't read child
    // env), so resolve the most recent session id from on-disk JSONL files.
    if (!sessionId) {
      const session = queries.getSession(db).get(id) as Session | undefined;
      if (session?.working_directory) {
        sessionId = getClaudeSessionIdFromFiles(session.working_directory);
      }
    }

    if (sessionId) {
      // Update database with the session ID
      const stmt = db.prepare(
        "UPDATE sessions SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?"
      );
      stmt.run(sessionId, id);

      return NextResponse.json({ claude_session_id: sessionId });
    }

    return NextResponse.json({ claude_session_id: null });
  } catch (error) {
    console.error("Error getting Claude session ID:", error);
    return NextResponse.json({ claude_session_id: null });
  }
}
