import { spawn, ChildProcess } from "child_process";
import { WebSocket } from "ws";
import { StreamParser } from "./stream-parser";
import { getDb, queries, type Session } from "../db";
import { isWindows, homeDir, expandHome, resolveBinary } from "../platform";
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
    queries
      .createMessage(db)
      .run(
        sessionId,
        "user",
        JSON.stringify([{ type: "text", text: prompt }]),
        null
      );

    // Build Claude CLI command
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    // Add model if specified
    if (options.model) {
      args.push("--model", options.model);
    }

    // Handle session continuity
    const dbSession = queries.getSession(db).get(sessionId) as
      | Session
      | undefined;

    if (dbSession?.claude_session_id) {
      // Resume existing Claude session
      args.push("--resume", dbSession.claude_session_id);
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
      // On Windows inherit the full process env; on POSIX prepend Homebrew paths.
      env: isWindows
        ? process.env
        : {
            ...process.env,
            PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH}`,
          },
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

    claudeProcess.on("error", (err) => {
      console.error(`Claude spawn error [${sessionId}]:`, err);
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
    if (session?.process) {
      session.process.kill("SIGTERM");
    }
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
          queries.updateSessionClaudeId(db).run(claudeSessionId, sessionId);
        }
        break;
      }

      case "text": {
        // Store assistant message
        if (event.data.role === "assistant") {
          queries
            .createMessage(db)
            .run(
              sessionId,
              "assistant",
              JSON.stringify(event.data.content),
              null
            );
        }
        break;
      }

      case "complete": {
        // Update session timestamp
        queries.updateSessionStatus(db).run("idle", sessionId);
        break;
      }

      case "error": {
        queries.updateSessionStatus(db).run("error", sessionId);
        break;
      }
    }
  }

  // Update session status in database
  private updateDbStatus(sessionId: string, status: string): void {
    const db = getDb();
    queries.updateSessionStatus(db).run(status, sessionId);
  }
}
