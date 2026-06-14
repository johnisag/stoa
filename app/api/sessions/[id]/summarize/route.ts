import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { getDb, queries, type Session } from "@/lib/db";
import { sessionKey, backendKeyForSession } from "@/lib/providers/registry";
import { randomUUID } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getSessionBackend } from "@/lib/session-backend";
import { buildAgentArgs, claudeProvider } from "@/lib/providers";
import { resolveModelForAgent } from "@/lib/model-catalog";
import {
  parseClaudeTranscript,
  buildSummaryPrompt,
  sanitizeDigest,
} from "@/lib/summarize";
import {
  claudeProjectDirName,
  findClaudeProjectDir,
  expandHome,
  homeDir,
  resolveBinary,
  isWindows,
} from "@/lib/platform";

const backend = getSessionBackend();

// Get Claude session ID from tmux environment
async function getClaudeSessionId(tmuxSession: string): Promise<string | null> {
  const sessionId = await backend.getEnv(tmuxSession, "CLAUDE_SESSION_ID");
  return sessionId && sessionId !== "null" ? sessionId : null;
}

// Encode path for Claude's project directory format (cross-platform).
function encodeProjectPath(cwd: string): string {
  return claudeProjectDirName(cwd);
}

// Read and parse Claude session JSONL file
function readClaudeSessionHistory(
  cwd: string,
  claudeSessionId: string
): string | null {
  const projectDir =
    findClaudeProjectDir(cwd) ||
    join(homedir(), ".claude", "projects", encodeProjectPath(cwd));
  const jsonlPath = join(projectDir, `${claudeSessionId}.jsonl`);

  if (!existsSync(jsonlPath)) {
    console.log(`[summarize] JSONL not found: ${jsonlPath}`);
    return null;
  }

  try {
    // Parsing (JSONL -> "User:/Assistant:" transcript) is a pure helper so it is
    // unit-tested and shared with the read-only GET digest.
    const content = readFileSync(jsonlPath, "utf-8");
    return parseClaudeTranscript(content);
  } catch (error) {
    console.error(`[summarize] Error reading JSONL:`, error);
    return null;
  }
}

// Fallback: Capture recent tmux scrollback (last 500 lines)
async function captureScrollback(sessionName: string): Promise<string> {
  return backend.capture(sessionName, { lines: 500 });
}

// Get the actual working directory from tmux pane
async function getTmuxCwd(sessionName: string): Promise<string | null> {
  return backend.getPanePath(sessionName);
}

// Generate summary using Claude CLI with stdin
async function generateSummary(conversation: string): Promise<string> {
  const prompt = buildSummaryPrompt();

  return new Promise((resolve, reject) => {
    const claude = spawn(resolveBinary("claude") || "claude", ["-p", prompt], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWindows,
      windowsHide: isWindows,
    });

    let stdout = "";
    let stderr = "";

    claude.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    claude.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    claude.on("close", (code) => {
      if (code === 0) {
        // sanitizeDigest strips control chars (keeping newlines) so the text is
        // safe to render and, later, to re-inject into a prompt.
        resolve(sanitizeDigest(stdout));
      } else {
        console.error("Claude CLI failed:", stderr);
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });

    claude.on("error", (err) => {
      reject(err);
    });

    // Write conversation to stdin
    claude.stdin.write(conversation);
    claude.stdin.end();
  });
}

// Wait for Claude prompt to appear in tmux session
async function waitForClaudeReady(
  sessionName: string,
  maxAttempts = 30
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const stdout = await backend.capture(sessionName);
      // Look for Claude's status line which appears when UI is ready
      if (stdout.includes("⏵⏵") || stdout.includes("accept edits")) {
        return true;
      }
    } catch {
      // Ignore errors, keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Send text to tmux session using load-buffer + paste-buffer
async function sendToTmux(
  sessionName: string,
  text: string,
  pressEnter = true
): Promise<void> {
  await backend.pasteText(sessionName, text, { enter: pressEnter });
}

// Read the session's conversation: Claude's JSONL when available, else the
// terminal scrollback. Shared by the POST (fork) and GET (read-only) handlers.
async function readConversation(
  session: Session,
  tmuxSessionName: string,
  cwdExpanded: string
): Promise<string | null> {
  // Try to get full conversation from Claude's JSONL (only for Claude sessions)
  let conversation: string | null = null;
  if (session.agent_type === "claude") {
    const claudeSessionId = await getClaudeSessionId(tmuxSessionName);
    if (claudeSessionId && cwdExpanded) {
      console.log(`[summarize] Found Claude session ID: ${claudeSessionId}`);
      conversation = readClaudeSessionHistory(cwdExpanded, claudeSessionId);
      if (conversation) {
        console.log(`[summarize] Read ${conversation.length} chars from JSONL`);
      }
    }
  }

  // Fallback to terminal scrollback for non-Claude or if JSONL not available
  if (!conversation) {
    console.log(
      `[summarize] Using terminal scrollback for ${session.agent_type}`
    );
    conversation = await captureScrollback(tmuxSessionName);
  }

  return conversation;
}

// GET /api/sessions/[id]/summarize - Read-only digest of what the agent did.
// Returns the generated summary WITHOUT forking or touching the session, so you
// can catch up on a long autonomous run without scrolling the whole transcript.
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

    // Use the session's live backend key (its tmux_name) so a renamed session
    // still resolves to the running pty/tmux — a bare {provider}-{id} key would
    // miss it after a rename and degrade the digest to working_directory-only.
    const tmuxSessionName = backendKeyForSession(session);

    const cwd =
      (await getTmuxCwd(tmuxSessionName)) || session.working_directory;
    const cwdExpanded = cwd ? expandHome(cwd) : homeDir();

    const conversation = await readConversation(
      session,
      tmuxSessionName,
      cwdExpanded
    );

    if (!conversation || conversation.trim().length < 100) {
      return NextResponse.json(
        { error: "No conversation found to summarize" },
        { status: 400 }
      );
    }

    const summary = await generateSummary(conversation);

    return NextResponse.json({ summary });
  } catch (error) {
    console.error("Error generating digest:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// POST /api/sessions/[id]/summarize - Summarize and create fresh session
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const { createFork = true, sendContext = true } = body;

    const db = getDb();
    const session = queries.getSession(db).get(id) as Session | undefined;

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Use the session's live backend key (its tmux_name) so a renamed session
    // still resolves to the running pty/tmux. A bare {provider}-{id} key would
    // miss the live session after a rename.
    const tmuxSessionName = backendKeyForSession(session);

    // Get actual working directory from tmux
    const cwd =
      (await getTmuxCwd(tmuxSessionName)) || session.working_directory;
    const cwdExpanded = cwd ? expandHome(cwd) : homeDir();

    // Read the conversation (Claude JSONL, else terminal scrollback).
    const conversation = await readConversation(
      session,
      tmuxSessionName,
      cwdExpanded
    );

    if (!conversation || conversation.trim().length < 100) {
      return NextResponse.json(
        { error: "No conversation found to summarize" },
        { status: 400 }
      );
    }

    // Generate summary
    const summary = await generateSummary(conversation);

    // Create a new session with the summary as context
    let newSession: Session | null = null;
    if (createFork) {
      const newId = randomUUID();
      const newName = `${session.name} (fresh)`;
      const agentType = session.agent_type || "claude";
      const tmuxName = sessionKey({
        kind: "agent",
        provider: agentType,
        id: newId,
      });

      // Create new session in DB (using cwd already fetched above)
      queries.createSession(db).run(
        newId,
        newName,
        tmuxName,
        cwd,
        null, // no parent - fresh start
        session.model,
        `Continue from previous session. Here's a summary of the work so far:\n\n${summary}`,
        session.group_path,
        agentType,
        session.auto_approve ? 1 : 0,
        session.project_id || "uncategorized"
      );

      newSession = queries.getSession(db).get(newId) as Session;
      const newTmuxSession = tmuxName;

      // Start the fresh session through the provider seam so it honors the
      // session's stored model (this is a fresh launch, so --model is passed;
      // resolveModelForAgent guards a non-Claude stored model). Hand-rolling the
      // flags here is what made this path silently ignore the model picker.
      const autoApprove = Boolean(session.auto_approve);
      const spawnModel = resolveModelForAgent("claude", session.model);
      const isRoot = process.getuid?.() === 0;
      const envPrefix = autoApprove && isRoot ? "IS_SANDBOX=1 " : "";
      const claudeFlags = claudeProvider.buildFlags({
        autoApprove,
        model: spawnModel,
      });
      const claudeCmd = `${envPrefix}claude ${claudeFlags.join(" ")}`.trim();
      // Structured argv for the pty backend (no IS_SANDBOX/env prefix — that's a
      // POSIX-root sandbox concern handled by the tmux command path).
      const { args: claudeArgs } = buildAgentArgs("claude", {
        autoApprove,
        model: spawnModel,
      });

      console.log(
        `[summarize] Creating session: ${newTmuxSession} (${claudeCmd})`
      );
      await backend.create({
        name: newTmuxSession,
        cwd: cwdExpanded,
        command: claudeCmd,
        binary: "claude",
        args: claudeArgs,
      });
      console.log(`[summarize] Tmux session created: ${newTmuxSession}`);

      // Give Claude a moment to start up before polling
      await new Promise((r) => setTimeout(r, 2000));

      // Wait for Claude to be ready and send context
      if (sendContext) {
        console.log(`[summarize] Waiting for Claude to be ready...`);
        const ready = await waitForClaudeReady(newTmuxSession);
        console.log(`[summarize] Claude ready: ${ready}`);
        if (ready) {
          const contextMessage = `Here's a summary of the previous session to continue from:\n\n${summary}\n\nPlease acknowledge you've received this context and are ready to continue.`;
          console.log(
            `[summarize] Sending context message (${contextMessage.length} chars)`
          );
          await sendToTmux(newTmuxSession, contextMessage, true);
          console.log(`[summarize] Context sent!`);
        } else {
          console.log(
            `[summarize] WARNING: Claude not ready, skipping context send`
          );
        }
      }
    }

    return NextResponse.json({
      summary,
      newSession,
    });
  } catch (error) {
    console.error("Error summarizing session:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
