import { NextRequest, NextResponse } from "next/server";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getSessionBackend } from "@/lib/session-backend";
import { lastAssistantText } from "@/lib/summarize";
import {
  claudeProjectDirName,
  findClaudeProjectDir,
  expandHome,
  homeDir,
} from "@/lib/platform";

const backend = getSessionBackend();

const UUID_JSONL =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

// Resolve the Claude session id the same robust way the claude-session route
// does: prefer the live env, fall back to the id persisted in the DB, then to
// the most recent on-disk JSONL. getEnv is always null on the pty/host backend
// (can't read a child's env), so the fallbacks are what make this work on Windows.
async function resolveClaudeSessionId(
  tmuxSession: string,
  session: Session,
  cwdExpanded: string
): Promise<string | null> {
  const envId = await backend.getEnv(tmuxSession, "CLAUDE_SESSION_ID");
  if (envId && envId !== "null") return envId;
  if (session.claude_session_id) return session.claude_session_id;
  return findMostRecentSessionId(cwdExpanded);
}

// Most recent UUID-named transcript in the project dir (skips agent-* sidechain
// files). Mirrors the claude-session route's on-disk fallback.
function findMostRecentSessionId(cwdExpanded: string): string | null {
  const projectDir = findClaudeProjectDir(cwdExpanded);
  if (!projectDir || !existsSync(projectDir)) return null;

  try {
    let mostRecent: string | null = null;
    let mostRecentTime = 0;
    for (const file of readdirSync(projectDir)) {
      if (file.startsWith("agent-")) continue;
      if (!UUID_JSONL.test(file)) continue;
      const stat = statSync(join(projectDir, file));
      if (stat.mtimeMs > mostRecentTime) {
        mostRecentTime = stat.mtimeMs;
        mostRecent = file.replace(".jsonl", "");
      }
    }
    return mostRecent;
  } catch {
    return null;
  }
}

// Read Claude's session JSONL and return the LAST assistant turn's raw markdown.
// Parsing the lines into entries here keeps lastAssistantText pure (and tested).
function readLastReply(
  cwdExpanded: string,
  claudeSessionId: string
): string | null {
  const projectDir =
    findClaudeProjectDir(cwdExpanded) ||
    join(homedir(), ".claude", "projects", claudeProjectDirName(cwdExpanded));
  const jsonlPath = join(projectDir, `${claudeSessionId}.jsonl`);

  if (!existsSync(jsonlPath)) {
    console.log(`[last-reply] JSONL not found: ${jsonlPath}`);
    return null;
  }

  try {
    const content = readFileSync(jsonlPath, "utf-8");
    const entries: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip a malformed line
      }
    }
    return lastAssistantText(entries);
  } catch (error) {
    console.error(`[last-reply] Error reading JSONL:`, error);
    return null;
  }
}

// GET /api/sessions/[id]/last-reply - The agent's last reply as raw markdown.
// Claude-only: reads the transcript JSONL (where the agent's own markdown lives,
// unlike the hard-wrapped terminal render) and returns the last assistant turn.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // The transcript JSONL only exists for Claude sessions; other agents have no
    // structured reply to copy. Be explicit so the UI can toast a clear reason.
    if (session.agent_type !== "claude") {
      return NextResponse.json(
        { error: "Copy last reply is only available for Claude sessions" },
        { status: 400 }
      );
    }

    // Authoritative backend key (honors a renamed session's tmux_name), same as
    // the send-keys/summarize routes — sessionKey() alone would miss the live
    // pane after a rename and fall back to a stale working_directory.
    const tmuxSessionName = backendKeyForSession(session);

    const cwd =
      (await backend.getPanePath(tmuxSessionName)) || session.working_directory;
    const cwdExpanded = cwd ? expandHome(cwd) : homeDir();

    const claudeSessionId = await resolveClaudeSessionId(
      tmuxSessionName,
      session,
      cwdExpanded
    );
    if (!claudeSessionId) {
      return NextResponse.json(
        { error: "No Claude transcript found for this session" },
        { status: 400 }
      );
    }

    const reply = readLastReply(cwdExpanded, claudeSessionId);
    if (!reply) {
      return NextResponse.json(
        { error: "No agent reply found yet" },
        { status: 400 }
      );
    }

    return NextResponse.json({ reply });
  } catch (error) {
    console.error("Error reading last reply:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
