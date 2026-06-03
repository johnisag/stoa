/**
 * MCP Config Auto-Generation
 *
 * Writes a .mcp.json file to the session's working directory so Claude
 * automatically picks up the orchestration tools with the session ID baked in.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";

const STOA_URL = process.env.STOA_URL || "http://localhost:3011";

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
  const orchestrationServerPath = path.join(
    process.cwd(),
    "mcp",
    "orchestration-server.ts"
  );

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
