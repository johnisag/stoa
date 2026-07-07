/**
 * MCP Config Auto-Generation
 *
 * Writes a .mcp.json file to the session's working directory so Claude
 * automatically picks up the orchestration tools with the session ID baked in.
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import { isWindows, resolveBinary } from "./platform";
import { CONDUCTOR_MARKER_FILE } from "./conductor-marker";

const STOA_URL = process.env.STOA_URL || "http://localhost:3011";

interface McpServerCommand {
  command: string;
  argsPrefix: string[];
}

function windowsNpxCliPath(): string | null {
  const candidates = new Set<string>();
  const npx = resolveBinary("npx");
  if (npx) {
    candidates.add(
      path.join(path.dirname(npx), "node_modules", "npm", "bin", "npx-cli.js")
    );
  }
  if (process.execPath) {
    candidates.add(
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npx-cli.js"
      )
    );
  }
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    candidates.add(path.join(path.dirname(npmExecPath), "npx-cli.js"));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function mcpServerCommand(): McpServerCommand {
  if (isWindows) {
    // Codex starts MCP servers with a direct child-process spawn. npm's Windows
    // shims (`npx.cmd`) are batch files, and cmd.exe would re-parse metachars in
    // checkout paths. Run npm's JS entrypoint under node so all paths stay argv.
    const npxCli = windowsNpxCliPath();
    if (npxCli)
      return {
        command: resolveBinary("node") || process.execPath || "node",
        argsPrefix: [npxCli],
      };
  }
  return { command: resolveBinary("npx") || "npx", argsPrefix: [] };
}

function hermesRegistrationIdentity(serverPath: string): string {
  const mcp = mcpServerCommand();
  return JSON.stringify({
    schemaVersion: 2,
    serverPath,
    command: mcp.command,
    args: [...mcp.argsPrefix, "tsx", serverPath],
  });
}

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
  const mcp = mcpServerCommand();
  config.mcpServers["stoa"] = {
    command: mcp.command,
    args: [...mcp.argsPrefix, "tsx", orchestrationServerPath],
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
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
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
  const mcp = mcpServerCommand();
  const set = (kv: string): string[] => ["-c", kv];
  return [
    ...set(`mcp_servers.stoa.command=${tomlString(mcp.command)}`),
    ...set(
      `mcp_servers.stoa.args=[${[...mcp.argsPrefix, "tsx", serverPath]
        .map(tomlString)
        .join(",")}]`
    ),
    ...set(`mcp_servers.stoa.env.STOA_URL=${tomlString(STOA_URL)}`),
    ...set(
      `mcp_servers.stoa.env.CONDUCTOR_SESSION_ID=${tomlString(sessionId)}`
    ),
  ];
}

/**
 * Render a string as a TOML value. Prefers a single-quoted LITERAL (keeps
 * Windows backslashes in a path intact — `'C:\x'` parses as-is). A literal
 * can't contain a single quote, so a value with one (e.g. a checkout under
 * `…/o'brien/…`) falls back to a double-quoted basic string with backslashes
 * and quotes escaped — which would otherwise emit invalid TOML and make Codex
 * launch without the stoa server.
 */
function tomlString(v: string): string {
  if (!v.includes("'")) return `'${v}'`;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

/**
 * Remove the conductor marker on session delete — but ONLY this session's own
 * marker. Without cleanup the `.stoa-conductor` file outlives its session, so a
 * later plain Hermes session in the SAME dir (Hermes registers stoa globally)
 * inherits the dead conductor's id. But a conductor with orchestration + NO
 * worktree writes the marker into the SHARED project dir, so deleting a sibling
 * session in that dir must NOT wipe the live conductor's marker — hence the
 * content==sessionId ownership check. Best-effort.
 */
export function removeConductorMarker(
  workingDirectory: string,
  sessionId: string
): void {
  try {
    const markerPath = path.join(workingDirectory, CONDUCTOR_MARKER_FILE);
    if (!existsSync(markerPath)) return;
    if (readFileSync(markerPath, "utf-8").trim() === sessionId)
      rmSync(markerPath, { force: true });
  } catch {
    // Best-effort — a leftover marker is only consulted by Hermes conductors.
  }
}

/** argv for `hermes mcp add` registering the stoa stdio server (command + args
 * only — no per-session env; the id comes from the cwd marker). */
export function buildHermesRegisterArgs(serverPath: string): string[] {
  const mcp = mcpServerCommand();
  return [
    "mcp",
    "add",
    "stoa",
    "--command",
    mcp.command,
    "--args",
    ...mcp.argsPrefix,
    "tsx",
    serverPath,
  ];
}

/** Where we record the exact Hermes registration last written, so we can tell a
 * fresh install from a STALE one (Stoa moved, npx/cmd path changed, or schema
 * changed) — `hermes mcp list` only shows the name, not the full config. */
const HERMES_PATH_MARKER = path.join(
  os.homedir(),
  ".stoa",
  "hermes-stoa-server-path"
);

function readRegisteredHermesIdentity(): string | null {
  try {
    if (existsSync(HERMES_PATH_MARKER))
      return readFileSync(HERMES_PATH_MARKER, "utf-8").trim();
  } catch {
    // ignore
  }
  return null;
}

function writeRegisteredHermesIdentity(identity: string): void {
  try {
    mkdirSync(path.dirname(HERMES_PATH_MARKER), { recursive: true });
    writeFileSync(HERMES_PATH_MARKER, identity + "\n");
  } catch {
    // ignore — worst case we re-register once next time
  }
}

/**
 * Decide what to do about the global `stoa` Hermes registration (pure, so it's
 * unit-testable). Skip only when it's listed AND matches the current registration
 * identity; otherwise (re)register, removing a stale entry first. Without the
 * remove-first, a moved Stoa checkout or changed MCP launcher would keep pointing
 * Hermes conductors at a dead path/command and orchestration would silently no-op.
 */
export function planHermesRegistration(
  stoaListed: boolean,
  recordedIdentity: string | null,
  currentIdentity: string
): { skip: boolean; removeFirst: boolean } {
  if (stoaListed && recordedIdentity === currentIdentity)
    return { skip: true, removeFirst: false };
  return { skip: false, removeFirst: stoaListed };
}

/**
 * Register the stoa MCP server in Hermes' GLOBAL config (command/args only, no
 * per-session data) so a Hermes conductor exposes spawn_worker. Idempotent and
 * SELF-CORRECTING: skips when already registered at the current path, but
 * re-points a stale registration if Stoa moved. `hermes mcp add` is interactive
 * ("Enable all N tools?") and discovery-first (it spawns the server to list
 * tools), so we auto-confirm via stdin. Every shell-out is bounded by a timeout
 * + SIGKILL so a slow/hung MCP discovery can't block the session-create request.
 * Best-effort — never throws (orchestration must not block create).
 */
export function ensureHermesMcpRegistered(): void {
  try {
    const hermes = resolveBinary("hermes") || "hermes";
    const serverPath = getOrchestrationServerPath();
    const identity = hermesRegistrationIdentity(serverPath);
    const list = execFileSync(hermes, ["mcp", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    const stoaListed = /(^|\s)stoa(\s|$)/m.test(list);
    const plan = planHermesRegistration(
      stoaListed,
      readRegisteredHermesIdentity(),
      identity
    );
    if (plan.skip) return;
    if (plan.removeFirst) {
      try {
        execFileSync(hermes, ["mcp", "remove", "stoa"], {
          stdio: "ignore",
          timeout: 10000,
          killSignal: "SIGKILL",
          windowsHide: true,
        });
      } catch {
        // ignore — the add below overwrites anyway on most Hermes versions
      }
    }
    execFileSync(hermes, buildHermesRegisterArgs(serverPath), {
      input: "y\n", // auto-accept the "Enable all tools?" prompt
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 20000,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    writeRegisteredHermesIdentity(identity);
  } catch {
    // Hermes missing / not configured / add failed / timed out — leave it.
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
