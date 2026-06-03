/**
 * MCP Config Auto-Generation
 *
 * Writes a .mcp.json file to the session's working directory so Claude
 * automatically picks up the orchestration tools with the session ID baked in.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { resolveBinary } from "./platform";
import { CONDUCTOR_MARKER_FILE } from "./conductor-marker";

const STOA_URL = process.env.STOA_URL || "http://localhost:3011";

/** Absolute path to the orchestration MCP server entrypoint (server cwd-based). */
function getOrchestrationServerPath(): string {
  return path.join(process.cwd(), "mcp", "orchestration-server.ts");
}

interface McpConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  >;
}

/**
 * Write or update .mcp.json in the working directory with orchestration server config
 */
export function ensureMcpConfig(
  workingDirectory: string,
  sessionId: string
): void {
  const configPath = path.join(workingDirectory, ".mcp.json");
  const orchestrationServerPath = getOrchestrationServerPath();

  let config: McpConfig = { mcpServers: {} };

  // Read existing config if present
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
      // Only adopt a plain object — an array/null/primitive would survive
      // JSON.parse but then silently drop our `stoa` server on stringify
      // (e.g. JSON.stringify([]) === "[]"), breaking orchestration.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as McpConfig;
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
      }
    } catch {
      // Invalid JSON, start fresh
      config = { mcpServers: {} };
    }
  }

  // Add/update stoa orchestration server
  config.mcpServers["stoa"] = {
    command: "npx",
    args: ["tsx", orchestrationServerPath],
    env: {
      STOA_URL,
      CONDUCTOR_SESSION_ID: sessionId,
    },
  };

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  // Keep the generated .mcp.json out of the user's repo — it's machine-specific
  // (absolute paths + this session's id). This is the opt-in replacement for the
  // auto-creation that was removed precisely because it littered repos.
  ensureGitExcluded(workingDirectory, ".mcp.json");
}

/**
 * Add `entry` to the repo's LOCAL git exclude (`.git/info/exclude`) — untracked,
 * so it never shows in the user's `git status` and never touches their tracked
 * `.gitignore`. Resolves the common git dir so it works inside git worktrees
 * too. Best-effort: a non-git dir or missing `git` is silently skipped (the file
 * simply isn't excluded — no error).
 */
function ensureGitExcluded(workingDirectory: string, entry: string): void {
  try {
    const commonDir = execFileSync(
      "git",
      [
        "-C",
        workingDirectory,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (!commonDir) return;

    const excludePath = path.join(commonDir, "info", "exclude");
    const existing = existsSync(excludePath)
      ? readFileSync(excludePath, "utf-8")
      : "";
    if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;

    mkdirSync(path.dirname(excludePath), { recursive: true });
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(excludePath, existing + sep + entry + "\n");
  } catch {
    // Not a git repo / git unavailable — nothing to exclude.
  }
}

/**
 * Build the Codex launch flags that wire the stoa MCP server into a Codex
 * CONDUCTOR session.
 *
 * Codex has no project-local config file — only global `~/.codex/config.toml`
 * or per-launch `-c key=value` overrides — so we inline a COMPLETE server
 * definition with `-c mcp_servers.stoa.*`. This is session-scoped (nothing is
 * written to the user's global config, unlike `codex mcp add`) and bakes THIS
 * conductor's CONDUCTOR_SESSION_ID directly into the server's env.
 *
 * Values are parsed as TOML; single-quoted literals keep Windows backslashes in
 * the absolute server path intact (a double-quoted TOML string would treat `\m`
 * as an invalid escape). Returned as clean argv tokens — the pty path passes
 * them through verbatim and the tmux path shell-quotes them.
 */
export function buildCodexOrchestrationArgs(sessionId: string): string[] {
  const serverPath = getOrchestrationServerPath();
  const set = (kv: string): string[] => ["-c", kv];
  return [
    ...set(`mcp_servers.stoa.command='npx'`),
    ...set(`mcp_servers.stoa.args=['tsx','${serverPath}']`),
    ...set(`mcp_servers.stoa.env.STOA_URL='${STOA_URL}'`),
    ...set(`mcp_servers.stoa.env.CONDUCTOR_SESSION_ID='${sessionId}'`),
  ];
}

/**
 * Write the conductor marker file (`.stoa-conductor`, containing the session id)
 * into the working dir, and git-exclude it. This is how a HERMES conductor's
 * session id reaches the stoa MCP server: Hermes strips arbitrary env vars from
 * MCP children and has no project-local config, but the stdio MCP server
 * inherits the conductor's cwd, so it reads the id from this file. Best-effort:
 * a write failure is the caller's to log (orchestration never blocks create).
 */
export function writeConductorMarker(
  workingDirectory: string,
  sessionId: string
): void {
  writeFileSync(
    path.join(workingDirectory, CONDUCTOR_MARKER_FILE),
    sessionId + "\n"
  );
  ensureGitExcluded(workingDirectory, CONDUCTOR_MARKER_FILE);
}

/** argv for `hermes mcp add` registering the stoa stdio server (command + args
 * only — no per-session env; the id comes from the cwd marker). */
export function buildHermesRegisterArgs(serverPath: string): string[] {
  return [
    "mcp",
    "add",
    "stoa",
    "--command",
    "npx",
    "--args",
    "tsx",
    serverPath,
  ];
}

/**
 * Register the stoa MCP server in Hermes' GLOBAL config ONCE (command/args only,
 * no per-session data) so a Hermes conductor exposes spawn_worker. Idempotent:
 * skips if `stoa` is already listed. `hermes mcp add` is interactive ("Enable
 * all N tools?") and discovery-first (it spawns the server to list tools), so we
 * auto-confirm via stdin and rely on the running Stoa server. Best-effort —
 * never throws (orchestration must not block session create).
 */
export function ensureHermesMcpRegistered(): void {
  try {
    const hermes = resolveBinary("hermes") || "hermes";
    const list = execFileSync(hermes, ["mcp", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (/(^|\s)stoa(\s|$)/m.test(list)) return; // already registered
    execFileSync(
      hermes,
      buildHermesRegisterArgs(getOrchestrationServerPath()),
      {
        input: "y\n", // auto-accept the "Enable all tools?" prompt
        stdio: ["pipe", "ignore", "ignore"],
      }
    );
  } catch {
    // Hermes missing / not configured / add failed — leave it unregistered.
  }
}

/**
 * Check if .mcp.json exists and has stoa configured
 */
export function hasMcpConfig(workingDirectory: string): boolean {
  const configPath = path.join(workingDirectory, ".mcp.json");
  if (!existsSync(configPath)) return false;

  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    return !!config.mcpServers?.["stoa"];
  } catch {
    return false;
  }
}
