/**
 * Conductor session-id marker.
 *
 * The orchestration MCP server (mcp/orchestration-server.ts) needs to know which
 * conductor session it belongs to. Claude and Codex bake CONDUCTOR_SESSION_ID
 * into the server's MCP config env. Hermes can't: it filters arbitrary env vars
 * out of MCP child processes for security (tools/mcp_tool.py `_build_safe_env`
 * only passes a safe allowlist + the config-declared `--env`), and it has no
 * project-local MCP config — only one global server entry. So for Hermes the id
 * is delivered via a marker file in the conductor's working directory, which the
 * stdio MCP server inherits as its cwd.
 *
 * This module is intentionally dependency-light (fs + path only) so the
 * standalone MCP server can import it under `npx tsx` without pulling in the
 * rest of lib/.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";

export const CONDUCTOR_MARKER_FILE = ".stoa-conductor";

/**
 * Resolve the conductor session id for an orchestration MCP server. Prefers the
 * env var (Claude/Codex), falling back to the marker file in `cwd` (Hermes).
 * Returns "" when neither is present.
 */
export function resolveConductorSessionId(
  cwd: string,
  env: Record<string, string | undefined> = process.env
): string {
  const fromEnv = (env.CONDUCTOR_SESSION_ID || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const markerPath = path.join(cwd, CONDUCTOR_MARKER_FILE);
    if (existsSync(markerPath)) return readFileSync(markerPath, "utf-8").trim();
  } catch {
    // Unreadable marker — fall through to the empty default.
  }
  return "";
}

/**
 * Choose the conductor id for a spawn_worker-style call. The Stoa-baked id (from
 * env/marker via resolveConductorSessionId) is AUTHORITATIVE — newer agents
 * (e.g. Claude Code) sometimes pass their OWN provider session id as
 * `conductorId`, which isn't a Stoa session and trips the worker's FOREIGN KEY.
 * So a baked id always wins; the agent-supplied arg is only a fallback for
 * manual/edge setups with no baked id. Returns null when neither is present.
 */
export function pickConductorId(
  argId: string | null | undefined,
  bakedId: string | null | undefined
): string | null {
  return (bakedId || "").trim() || (argId || "").trim() || null;
}
