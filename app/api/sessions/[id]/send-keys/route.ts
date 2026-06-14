import { NextRequest, NextResponse } from "next/server";
import path from "path";
import os from "os";
import { getDb, queries, type Session } from "@/lib/db";
import { backendKeyForSession } from "@/lib/providers/registry";
import { getSessionBackend } from "@/lib/session-backend";
import { appendFileSync } from "fs";
import { parseJsonBody, SEND_KEYS_MAX_LENGTH } from "@/lib/api-security";

// Log to file for debugging
const LOG_FILE = path.join(os.tmpdir(), "stoa-send-keys.log");
function log(msg: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  console.log(`[send-keys] ${msg}`);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

// Reject C0 control characters except tab and newline, which are intentional
// terminal input. Keeps backspace/escape/bell from being injected as keystrokes.
function hasDisallowedControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10) return true;
    if (code === 127) return true;
  }
  return false;
}

// POST /api/sessions/[id]/send-keys - Send text to a tmux session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseJsonBody<{
    text?: string;
    pressEnter?: boolean;
  }>(request);
  if (!parsed.ok) return parsed.response;

  try {
    const { id } = await params;
    const { text, pressEnter = true } = parsed.data;

    log(`=== START send-keys for session ${id} ===`);
    log(`Text length: ${text?.length || 0}, pressEnter: ${pressEnter}`);

    if (!text) {
      log("ERROR: No text provided");
      return NextResponse.json({ error: "No text provided" }, { status: 400 });
    }

    if (text.length > SEND_KEYS_MAX_LENGTH) {
      log(`ERROR: Text too long (${text.length})`);
      return NextResponse.json(
        { error: `Text exceeds maximum length of ${SEND_KEYS_MAX_LENGTH}` },
        { status: 400 }
      );
    }

    if (hasDisallowedControlChars(text)) {
      log("ERROR: Text contains disallowed control characters");
      return NextResponse.json(
        { error: "Text contains disallowed control characters" },
        { status: 400 }
      );
    }

    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      log(`ERROR: Session ${id} not found in DB`);
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Authoritative backend key (honors a renamed session's tmux_name), same as
    // the DELETE/respond routes — sessionKey() alone would 400 after a rename.
    const tmuxSessionName = backendKeyForSession(session);
    log(`Tmux session name: ${tmuxSessionName}`);

    const backend = getSessionBackend();

    // Check if tmux session exists
    if (!(await backend.exists(tmuxSessionName))) {
      log(`ERROR: Tmux session ${tmuxSessionName} not running`);
      return NextResponse.json(
        { error: "Tmux session not running" },
        { status: 400 }
      );
    }
    log(`Tmux session exists`);

    await backend.pasteText(tmuxSessionName, text, { enter: pressEnter });

    log(`=== SUCCESS ===`);
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`ERROR: ${msg}`);
    console.error("Error sending keys:", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
