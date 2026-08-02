/**
 * Conductor session-id marker.
 *
 * The orchestration MCP server (mcp/orchestration-server.ts) needs to know which
 * conductor session it belongs to. Provider configs map a Stoa-injected,
 * per-agent-process environment value into CONDUCTOR_SESSION_ID. The marker file
 * remains a compatibility fallback for older Hermes registrations only.
 *
 * This module is intentionally dependency-light (fs + path only) so the
 * standalone MCP server can import it without pulling in the rest of lib/.
 */
import { existsSync, readFileSync } from "fs";
import path from "path";

export const CONDUCTOR_MARKER_FILE = ".stoa-conductor";
// Internal fail-closed state: a binding was present but could not resolve to a
// session id. `pickConductorId` treats it as authoritative invalidity, so an
// agent-supplied id cannot bypass a broken provider interpolation.
export const INVALID_CONDUCTOR_SESSION_ID = "\0stoa-invalid-binding";

function isUnresolvedPlaceholder(value: string): boolean {
  return (
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value) ||
    /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
  );
}

/** Parse the deliberately tiny on-disk marker format. Multiple lines are
 * ambiguous (and could route tools to the wrong conductor), so reject them. */
export function parseConductorMarker(source: string): string {
  const trimmed = source.trim();
  if (
    !trimmed ||
    trimmed.length > 256 ||
    trimmed.includes("\n") ||
    trimmed.includes("\r") ||
    isUnresolvedPlaceholder(trimmed)
  ) {
    return "";
  }
  return trimmed;
}

/**
 * Resolve the conductor session id for an orchestration MCP server. Prefers the
 * mapped env var, then Stoa's direct process binding, and finally the legacy cwd
 * marker. Returns "" only when no binding is present.
 */
export function resolveConductorSessionId(
  cwd: string,
  env: Record<string, string | undefined> = process.env
): string {
  const hasMappedBinding = Object.prototype.hasOwnProperty.call(
    env,
    "CONDUCTOR_SESSION_ID"
  );
  const fromEnv = (env.CONDUCTOR_SESSION_ID || "").trim();
  const directFromStoa = (env.STOA_CONDUCTOR_SESSION_ID || "").trim();
  // Provider interpolation failures must not turn the literal placeholder into
  // a conductor id. Some providers also inherit Stoa's direct process binding;
  // accept that only when it resolves cleanly, otherwise remain fail-closed.
  if (isUnresolvedPlaceholder(fromEnv)) {
    return directFromStoa
      ? parseConductorMarker(directFromStoa) || INVALID_CONDUCTOR_SESSION_ID
      : INVALID_CONDUCTOR_SESSION_ID;
  }
  if (fromEnv)
    return parseConductorMarker(fromEnv) || INVALID_CONDUCTOR_SESSION_ID;
  if (hasMappedBinding) {
    return directFromStoa
      ? parseConductorMarker(directFromStoa) || INVALID_CONDUCTOR_SESSION_ID
      : INVALID_CONDUCTOR_SESSION_ID;
  }
  if (directFromStoa)
    return parseConductorMarker(directFromStoa) || INVALID_CONDUCTOR_SESSION_ID;
  try {
    const markerPath = path.join(cwd, CONDUCTOR_MARKER_FILE);
    if (existsSync(markerPath)) {
      return (
        parseConductorMarker(readFileSync(markerPath, "utf-8")) ||
        INVALID_CONDUCTOR_SESSION_ID
      );
    }
  } catch {
    return INVALID_CONDUCTOR_SESSION_ID;
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
  if ((bakedId || "").trim() === INVALID_CONDUCTOR_SESSION_ID) return null;
  return (bakedId || "").trim() || (argId || "").trim() || null;
}
