import { spawn, execFile, ChildProcess } from "child_process";
import { WebSocket } from "ws";
import { StreamParser } from "./stream-parser";
import { getDb, queries, type Session } from "../db";
import {
  isWindows,
  homeDir,
  expandHome,
  resolveBinary,
  killTreeArgs,
} from "../platform";
import type { ClaudeSessionOptions, ClientEvent } from "./types";

interface ManagedSession {
  process: ChildProcess | null;
  parser: StreamParser;
  clients: Set<WebSocket>;
  status: "idle" | "running" | "waiting" | "error";
}

export class ClaudeProcessManager {
  private sessions: Map<string, ManagedSession> = new Map();

  // Wire the "event" and "parse_error" handlers onto a parser. Used by both
  // registerClient (initial parser) and sendPrompt (reset parser per turn) so
  // parse-error broadcasting survives every conversation turn.
  private wireParser(sessionId: string, parser: StreamParser): void {
    parser.on("event", (event: ClientEvent) => {
      this.broadcastToSession(sessionId, event);
      this.handleEvent(sessionId, event);
    });

    parser.on("parse_error", (error) => {
      this.broadcastToSession(sessionId, {
        type: "error",
        sessionId,
        timestamp: new Date().toISOString(),
        data: { error: `Parse error: ${error.error}` },
      });
    });
  }

  // Register a WebSocket client for a session
  registerClient(sessionId: string, ws: WebSocket): void {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        process: null,
        parser: new StreamParser(sessionId),
        clients: new Set(),
        status: "idle",
      };

      // Set up parser event handlers
      this.wireParser(sessionId, session.parser);

      this.sessions.set(sessionId, session);
    }

    session.clients.add(ws);

    // Send current status
    ws.send(
      JSON.stringify({
        type: "status",
        sessionId,
        timestamp: new Date().toISOString(),
        data: { status: session.status },
      })
    );
  }

  // Unregister a WebSocket client
  unregisterClient(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.clients.delete(ws);

      // Clean up if no clients remain and process not running
      if (session.clients.size === 0 && !session.process) {
        this.sessions.delete(sessionId);
      }
    }
  }

  // Send a prompt to Claude
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options: ClaudeSessionOptions = {}
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (session.process) {
      throw new Error(`Session ${sessionId} already has a running process`);
    }

    // Store user message in database
    const db = getDb();
    try {
      await queries
        .createMessage(db)
        .run(
          sessionId,
          "user",
          this.safeStringify([{ type: "text", text: prompt }]),
          null
        );
    } catch (err) {
      console.error(`Failed to store user message for ${sessionId}:`, err);
      throw new Error(`Could not record prompt: ${(err as Error).message}`);
    }

    // Build Claude CLI command
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    // Add model if specified
    if (options.model) {
      args.push("--model", options.model);
    }

    // Handle session continuity: explicit options take precedence, then DB value.
    const dbSession = queries.getSession(db).get(sessionId) as
      | Session
      | undefined;
    const resumeId = options.claudeSessionId ?? dbSession?.claude_session_id;
    if (resumeId && options.resume !== false) {
      args.push("--resume", resumeId);
    }

    // Add system prompt if specified
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }

    // Add the prompt
    args.push(prompt);

    // Spawn Claude process
    const cwd =
      options.workingDirectory ||
      (dbSession?.working_directory
        ? expandHome(dbSession.working_directory)
        : undefined) ||
      homeDir();

    console.log(`Spawning Claude for session ${sessionId}:`, args.join(" "));
    console.log(`CWD: ${cwd}`);

    // Reset parser for new conversation turn. Re-wire BOTH "event" and
    // "parse_error" handlers (registerClient attaches both on the initial
    // parser) so parse errors keep broadcasting on subsequent turns.
    session.parser = new StreamParser(sessionId);
    this.wireParser(sessionId, session.parser);

    // Find claude binary path (resolves claude.cmd on Windows)
    const claudePath = resolveBinary("claude") || "claude";

    // On Windows a .cmd/.bat shim can't be spawned directly; route it through
    // cmd.exe WITHOUT shell:true so Node still quotes each argv entry (the
    // prompt may contain spaces/quotes/&|<>^ — shell:true would mangle/inject it).
    let spawnFile = claudePath;
    let spawnArgs = args;
    if (isWindows && /\.(cmd|bat)$/i.test(claudePath)) {
      spawnFile = process.env.ComSpec || "cmd.exe";
      spawnArgs = ["/c", claudePath, ...args];
    }

    const claudeProcess = spawn(spawnFile, spawnArgs, {
      cwd,
      // Inherit the user's PATH; resolve required binaries with resolveBinary().
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: isWindows,
    });

    session.process = claudeProcess;
    session.status = "running";
    this.updateDbStatus(sessionId, "running");

    this.broadcastToSession(sessionId, {
      type: "status",
      sessionId,
      timestamp: new Date().toISOString(),
      data: { status: "running" },
    });

    // Handle stdout (stream-json output)
    claudeProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log(`Claude stdout [${sessionId}]:`, text.substring(0, 200));
      session.parser.write(text);
    });

    // Handle stderr (errors and other output)
    claudeProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      console.error(`Claude stderr [${sessionId}]:`, text);
    });

    // Handle process exit
    claudeProcess.on("close", (code) => {
      console.log(
        `Claude process exited for session ${sessionId} with code ${code}`
      );

      session.parser.end();
      session.process = null;
      session.status = code === 0 ? "idle" : "error";

      this.updateDbStatus(sessionId, session.status);

      this.broadcastToSession(sessionId, {
        type: "status",
        sessionId,
        timestamp: new Date().toISOString(),
        data: { status: session.status, exitCode: code || 0 },
      });
    });

    claudeProcess.on("error", (err) => {
      console.error(`Claude process error for session ${sessionId}:`, err);

      session.process = null;
      session.status = "error";

      this.updateDbStatus(sessionId, "error");

      this.broadcastToSession(sessionId, {
        type: "error",
        sessionId,
        timestamp: new Date().toISOString(),
        data: { error: err.message },
      });
    });
  }

  // Cancel a running Claude process
  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.process) return;

    // On Windows session.process is the cmd.exe wrapper (claude is a .cmd shim), so a
    // plain kill stops ONLY cmd.exe and orphans the claude/node child tree. The shared
    // killTreeArgs helper yields `taskkill /T /F` (whole tree, forced) on Windows and
    // null on POSIX (where a plain SIGTERM reaps the group).
    const pid = session.process.pid;
    const argv = pid ? killTreeArgs(pid, isWindows) : null;
    if (!argv) {
      session.process.kill(isWindows ? undefined : "SIGTERM");
      return;
    }
    execFile(argv[0], argv.slice(1), { windowsHide: true }, (err) => {
      // Fall back to a direct kill if taskkill isn't available.
      if (err) session.process?.kill();
    });
  }

  // Get session status
  getSessionStatus(
    sessionId: string
  ): "idle" | "running" | "waiting" | "error" | null {
    return this.sessions.get(sessionId)?.status ?? null;
  }

  // Broadcast event to all clients of a session
  private broadcastToSession(sessionId: string, event: ClientEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.log(`No session found for broadcast: ${sessionId}`);
      return;
    }

    console.log(
      `Broadcasting to ${session.clients.size} clients for session ${sessionId}`
    );
    const message = JSON.stringify(event);
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
        console.log(`Sent message to client`);
      } else {
        console.log(`Client not open, state: ${client.readyState}`);
      }
    }
  }

  // Handle events for persistence
  private handleEvent(sessionId: string, event: ClientEvent): void {
    const db = getDb();

    switch (event.type) {
      case "init": {
        // Store Claude's session ID for future --resume
        const claudeSessionId = event.data.claudeSessionId;
        if (claudeSessionId) {
          try {
            queries.updateSessionClaudeId(db).run(claudeSessionId, sessionId);
          } catch (err) {
            console.error(
              `Failed to update claude_session_id for ${sessionId}:`,
              err
            );
          }
        }
        break;
      }

      case "text": {
        // Store assistant message
        if (event.data.role === "assistant") {
          try {
            queries
              .createMessage(db)
              .run(
                sessionId,
                "assistant",
                this.safeStringify(event.data.content),
                null
              );
          } catch (err) {
            console.error(
              `Failed to store assistant message for ${sessionId}:`,
              err
            );
          }
        }
        break;
      }

      case "complete": {
        // Update session timestamp
        this.safeUpdateStatus(sessionId, "idle");
        break;
      }

      case "error": {
        this.safeUpdateStatus(sessionId, "error");
        break;
      }
    }
  }

  // Update session status in database
  private updateDbStatus(sessionId: string, status: string): void {
    this.safeUpdateStatus(sessionId, status);
  }

  private safeUpdateStatus(sessionId: string, status: string): void {
    try {
      const db = getDb();
      queries.updateSessionStatus(db).run(status, sessionId);
    } catch (err) {
      console.error(`Failed to update status for ${sessionId}:`, err);
    }
  }

  /** JSON.stringify with a safe fallback so externally sourced objects can't
   *  crash an event handler (circular refs, BigInt, etc.). */
  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch (err) {
      console.error("safeStringify failed:", err);
      return "null";
    }
  }
}
