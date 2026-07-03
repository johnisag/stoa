/**
 * Shared security helpers for App Router API routes.
 *
 * These are deliberately small, pure, and unit-testable so they can be applied
 * surgically without pulling in heavy auth middleware. They cover:
 *   - localhost/origin gating for sensitive routes
 *   - JSON body parsing that returns 400 instead of 500
 *   - numeric clamping / string length guards
 *   - path sandboxing to registered project/repo roots
 *   - simple shell-command tokenization for dev-server argv construction
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as path from "path";
import { expandHome, homeDir, isWindows } from "./platform";
import { getDb, queries } from "./db";

// ── localhost / origin gating ──

/** Host values we treat as "local" for the trivial route-level bind. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostFromHeader(host: string | null): string | null {
  if (!host) return null;
  // IPv6 bracket form ([::1] or [::1]:3011) — return the address inside brackets.
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end > 0) return host.slice(1, end) || null;
    return null;
  }
  const colons = host.split(":").length - 1;
  // A single colon is host:port (IPv4 or a hostname) — strip the port.
  if (colons === 1) return host.split(":")[0] || null;
  // Bare IPv6 (no brackets, no port) has more than one colon — return as-is.
  if (colons > 1) return host;
  // No colon — a bare hostname/IP.
  return host || null;
}

/** HTTP header server.ts sets from the real TCP remote address. */
export const REMOTE_ADDR_HEADER = "x-stoa-remote-addr";

/**
 * The trustworthy client IP. Next 16's custom server does NOT populate
 * NextRequest.ip, so server.ts injects the connection's `req.socket.remoteAddress`
 * as `x-stoa-remote-addr`, OVERWRITING any client-supplied copy — so this is not
 * spoofable. Falls back to request.ip for runtimes that set it (and unit tests).
 */
function connectionIp(request: NextRequest): string | null {
  const header = request.headers.get(REMOTE_ADDR_HEADER);
  if (header) return header.trim() || null;
  const ip = (request as unknown as { ip?: string | null }).ip;
  return ip || null;
}

// #46/#49 auth scope. server.ts's auth gate injects the resolved scope here,
// OVERWRITING any client-supplied copy (so it's unspoofable, same as the remote-addr
// header). The coarse gate already denies an observer any non-GET request; this
// header lets an admin-only READ route (e.g. the token list) additionally require
// admin. server.ts sets "admin" explicitly on the auth-off / trusted-loopback /
// master-token paths, so admin never depends on the default below.
export const SCOPE_HEADER = "x-stoa-scope";

/** The caller's auth scope as injected by the server auth gate. FAIL-CLOSED: only
 * an exact "admin" header grants admin; anything else — including an ABSENT header
 * (a route somehow reached without the gate) — is the least-privilege observer, so
 * the resolver can never fail open on its own. */
export function requestScope(request: NextRequest): "admin" | "observer" {
  return request.headers.get(SCOPE_HEADER) === "admin" ? "admin" : "observer";
}

/** 403 if the caller is a read-only observer, else null. For admin-only routes the
 * coarse method gate doesn't already cover (an admin-only GET). */
export function requireAdmin(request: NextRequest): NextResponse | null {
  if (requestScope(request) === "admin") return null;
  return NextResponse.json({ error: "admin token required" }, { status: 403 });
}

function looksLocal(request: NextRequest): boolean {
  // The connection IP is the only trustworthy signal. When it is present and NOT
  // loopback, reject immediately — a remote client can spoof Host/Origin/Referer
  // but cannot spoof the TCP remote address.
  const ip = connectionIp(request);
  if (ip) {
    const lower = ip.toLowerCase();
    if (
      lower === "127.0.0.1" ||
      lower === "::1" ||
      lower === "localhost" ||
      lower.startsWith("::ffff:127.")
    ) {
      return true;
    }
    return false;
  }

  // Some runtimes (edge/middleware) don't surface request.ip. Fall back to the
  // Host header and Origin/Referer as a best-effort signal only when there is no
  // connection IP to contradict it.
  const host = hostFromHeader(request.headers.get("host"));
  if (host && LOCAL_HOSTS.has(host.toLowerCase())) return true;

  for (const header of [
    request.headers.get("origin"),
    request.headers.get("referer"),
  ]) {
    if (!header) continue;
    try {
      const h = new URL(header).hostname.toLowerCase();
      if (LOCAL_HOSTS.has(h)) return true;
    } catch {
      // malformed URL — ignore
    }
  }

  return false;
}

/**
 * Returns a 403 response if the request does not appear to come from localhost.
 * This is a lightweight, best-effort defense for the most destructive routes.
 * It is NOT a substitute for real auth when exposing Stoa to a network.
 */
export function requireLocalhost(
  request: NextRequest
): { ok: true } | { ok: false; response: Response } {
  if (!looksLocal(request)) {
    const body = JSON.stringify({
      error: "This endpoint is only available from localhost.",
    });
    return {
      ok: false,
      response: new Response(body, {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
  return { ok: true };
}

// ── safe JSON body parsing ──

/**
 * Parse a route's JSON body, returning a clear 400 on malformed input instead of
 * letting the exception bubble up as a generic 500.
 */
export async function parseJsonBody<T = unknown>(
  request: Request
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  try {
    const data = await request.json();
    return { ok: true, data: data as T };
  } catch {
    const body = JSON.stringify({ error: "Invalid JSON body" });
    return {
      ok: false,
      response: new Response(body, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }
}

// ── numeric / string guards ──

export function clampInteger(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number
): number {
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return defaultValue;
    return Math.max(min, Math.min(max, parsed));
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, Math.floor(value)));
  }
  return defaultValue;
}

/** Reject strings that are obviously not a plain integer in the allowed range. */
export function parseBoundedInt(
  value: unknown,
  min: number,
  max: number,
  defaultValue: number
): number {
  return clampInteger(value, min, max, defaultValue);
}

export const SESSION_NAME_MAX_LENGTH = 200;
export const SYSTEM_PROMPT_MAX_LENGTH = 50_000;
export const MESSAGE_CONTENT_MAX_LENGTH = 100_000;
export const DISPATCH_SPEC_MAX_LENGTH = 10_000;
export const ISSUE_TITLE_MAX_LENGTH = 256;
export const ISSUE_BODY_MAX_LENGTH = 65_536;
export const SEND_KEYS_MAX_LENGTH = 10_000;
export const UPLOAD_TEMP_MAX_BYTES = 5 * 1024 * 1024;

const SESSION_NAME_BAD_CHARS = /[\x00-\x1f\x7f]/g;

export function sanitizeSessionName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(SESSION_NAME_BAD_CHARS, "");
  if (!trimmed) return null;
  return trimmed.slice(0, SESSION_NAME_MAX_LENGTH);
}

export function sanitizeGroupPath(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (!trimmed) return null;
  // Only allow simple dotted/grouped paths: alphanumerics, dashes, dots, slashes.
  if (!/^[\w\-.\/]+$/.test(trimmed)) return null;
  // Reject path-traversal components so a group path can't escape its container.
  for (const segment of trimmed.split("/")) {
    if (segment === "." || segment === "..") return null;
  }
  return trimmed.slice(0, 200);
}

// ── path sandboxing ──

function normalizeForSandbox(p: string): string {
  // Normalize Windows-style separators to the current platform's separator so
  // cross-platform sandbox comparisons work (tests feed Windows paths on POSIX).
  const normalized = isWindows ? p : p.replace(/\\/g, "/");
  const resolved = path.resolve(expandHome(normalized));
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isUnderRoot(input: string, root: string): boolean {
  const nInput = normalizeForSandbox(input);
  const nRoot = normalizeForSandbox(root);
  if (nInput === nRoot) return true;
  return nInput.startsWith(nRoot + path.sep);
}

/**
 * Build the set of filesystem roots that API routes are allowed to touch.
 * Includes registered projects, project repositories, dispatch repos, and
 * Stoa-managed directories (worktrees, temp dirs, clones).
 */
export function getAllowedPathRoots(): string[] {
  const roots = new Set<string>();

  try {
    const db = getDb();
    const projects = queries.getAllProjects(db).all() as Array<{
      working_directory: string;
    }>;
    for (const p of projects) {
      if (p.working_directory) roots.add(expandHome(p.working_directory));
    }

    const repos = queries.getAllProjectRepositories(db).all() as Array<{
      path: string;
    }>;
    for (const r of repos) {
      if (r.path) roots.add(expandHome(r.path));
    }

    const dispatchRepos = queries.getAllDispatchRepos(db).all() as Array<{
      repo_path: string;
    }>;
    for (const r of dispatchRepos) {
      if (r.repo_path) roots.add(expandHome(r.repo_path));
    }

    const sessions = queries.getAllSessions(db).all() as Array<{
      working_directory: string;
      worktree_path: string | null;
    }>;
    for (const s of sessions) {
      if (s.working_directory) roots.add(expandHome(s.working_directory));
      if (s.worktree_path) roots.add(expandHome(s.worktree_path));
    }
  } catch {
    // If the DB isn't ready, fall back to the Stoa-managed dirs only.
  }

  // Always allow Stoa's own managed dirs.
  roots.add(path.join(homeDir(), ".stoa"));

  return Array.from(roots);
}

export interface SandboxResult {
  allowed: boolean;
  resolved: string;
}

/**
 * Resolve `inputPath` and verify it lives under one of the allowed roots.
 * Returns { allowed: true, resolved } on success. On failure `resolved` is still
 * the resolved path so callers can log it safely.
 */
export function resolveSandboxedPath(
  inputPath: string,
  roots: string[]
): SandboxResult {
  const resolved = path.resolve(expandHome(inputPath));
  for (const root of roots) {
    if (isUnderRoot(resolved, root)) return { allowed: true, resolved };
  }
  return { allowed: false, resolved };
}

/**
 * Like resolveSandboxedPath, but also allows paths that are under the user's
 * home directory. Used for project-creation/discovery flows where the user has
 * not yet registered a project root.
 */
export function resolveSandboxedPathOrHome(
  inputPath: string,
  roots: string[]
): SandboxResult {
  const resolved = path.resolve(expandHome(inputPath));
  const h = homeDir();
  if (isUnderRoot(resolved, h)) return { allowed: true, resolved };
  for (const root of roots) {
    if (isUnderRoot(resolved, root)) return { allowed: true, resolved };
  }
  return { allowed: false, resolved };
}

// ── shell-command tokenization ──

export class UnsafeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCommandError";
  }
}

/**
 * Tokenize a simple command line into an argv array suitable for `spawn(file,
 * args, { shell: false })`. Supports plain tokens and single/double-quoted
 * strings with basic escaping. Rejects shell metacharacters and command
 * chaining (`;`, `|`, `&&`, `||`, `$()`, backticks, redirects, etc.).
 *
 * This is intentionally conservative: if a command uses syntax we don't
 * understand, we refuse it rather than risk mis-parsing.
 */
export function tokenizeCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new UnsafeCommandError("Empty command");

  const tokens: string[] = [];
  let i = 0;

  while (i < trimmed.length) {
    // Skip whitespace between tokens.
    while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
    if (i >= trimmed.length) break;

    const ch = trimmed[i];
    let token = "";

    if (ch === '"') {
      i++; // opening quote
      while (i < trimmed.length && trimmed[i] !== '"') {
        if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
          const next = trimmed[i + 1];
          if (next === '"' || next === "\\" || next === "$" || next === "`") {
            token += next;
            i += 2;
            continue;
          }
        }
        token += trimmed[i];
        i++;
      }
      if (i >= trimmed.length || trimmed[i] !== '"') {
        throw new UnsafeCommandError("Unterminated double quote in command");
      }
      i++; // closing quote
    } else if (ch === "'") {
      i++; // opening quote
      while (i < trimmed.length && trimmed[i] !== "'") {
        token += trimmed[i];
        i++;
      }
      if (i >= trimmed.length || trimmed[i] !== "'") {
        throw new UnsafeCommandError("Unterminated single quote in command");
      }
      i++; // closing quote
    } else {
      while (i < trimmed.length && !/\s/.test(trimmed[i])) {
        const c = trimmed[i];
        if (c === '"' || c === "'") break; // start a quoted token next loop
        if (c === "\\" && i + 1 < trimmed.length) {
          const next = trimmed[i + 1];
          // Only backslash-escape quotes. Otherwise treat backslash as a literal
          // path separator (Windows) or normal character, so paths like
          // C:\Users\foo\.bin\npm.cmd are preserved rather than mangled.
          if (next === '"' || next === "'") {
            token += next;
            i += 2;
            continue;
          }
        }
        // Reject shell metacharacters outside quotes.
        if (
          c === ";" ||
          c === "|" ||
          c === "&" ||
          c === ">" ||
          c === "<" ||
          c === "(" ||
          c === ")" ||
          c === "{" ||
          c === "}" ||
          c === "$" ||
          c === "`" ||
          c === "#" ||
          c === "*" ||
          c === "?" ||
          c === "[" ||
          c === "]" ||
          c === "~"
        ) {
          throw new UnsafeCommandError(
            `Shell metacharacter not allowed in command: ${c}`
          );
        }
        token += c;
        i++;
      }
    }

    tokens.push(token);
  }

  if (tokens.length === 0) throw new UnsafeCommandError("Empty command");
  return tokens;
}

/**
 * Escape a single argv token for insertion into a POSIX shell script. Simple
 * tokens are returned unchanged; anything needing escaping is wrapped in single
 * quotes with embedded single quotes handled safely.
 */
export function shellEscape(arg: string): string {
  if (arg === "") return "''";
  if (/^[a-zA-Z0-9_./:@\-]+$/.test(arg)) return arg;
  const escaped = arg.replace(/'/g, "'\"'\"'");
  return `'${escaped}'`;
}

// ── GitHub label validation ──

const GITHUB_LABEL_MAX_LENGTH = 50;

export function validateGitHubLabels(
  labels: unknown[]
): { ok: true; labels: string[] } | { ok: false; reason: string } {
  const out: string[] = [];
  if (!Array.isArray(labels))
    return { ok: false, reason: "labels must be an array" };
  for (const l of labels) {
    if (typeof l !== "string")
      return { ok: false, reason: "each label must be a string" };
    const trimmed = l.trim();
    if (!trimmed) return { ok: false, reason: "empty label" };
    if (trimmed.length > GITHUB_LABEL_MAX_LENGTH) {
      return {
        ok: false,
        reason: `label too long: ${trimmed.slice(0, 20)}...`,
      };
    }
    // GitHub label characters: alphanumerics, hyphen, underscore, dot, plus.
    if (!/^[\w\-.+]+$/.test(trimmed)) {
      return { ok: false, reason: `invalid label characters: ${trimmed}` };
    }
    out.push(trimmed);
  }
  return { ok: true, labels: out };
}

// ── MIME / upload validation ──

const ALLOWED_UPLOAD_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function validateUploadMimeType(
  mimeType: unknown
): { ok: true; ext: string } | { ok: false; reason: string } {
  if (typeof mimeType !== "string" || !mimeType) {
    return { ok: true, ext: "png" }; // default to png when absent
  }
  const normalized = mimeType.toLowerCase().trim();
  const ext = ALLOWED_UPLOAD_MIME_TYPES[normalized];
  if (!ext) return { ok: false, reason: "Unsupported MIME type" };
  return { ok: true, ext };
}

// ── rate limiting (simple in-memory per-IP) ──

interface RateBucket {
  count: number;
  windowStart: number;
}

const RATE_LIMITS = new Map<string, RateBucket>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 60;

function getClientIp(request: NextRequest): string {
  // Use the connection IP only (server-injected from req.socket.remoteAddress).
  // X-Forwarded-For is client-supplied and trivially spoofed, so trusting it
  // would let a remote caller bypass per-client rate limits.
  return connectionIp(request) ?? "unknown";
}

export function checkRateLimit(request: NextRequest): {
  allowed: boolean;
  retryAfter?: number;
} {
  const ip = getClientIp(request);
  const now = Date.now();
  // Prune stale buckets so the in-memory map doesn't grow unboundedly.
  for (const [key, bucket] of RATE_LIMITS.entries()) {
    if (now - bucket.windowStart > RATE_WINDOW_MS) RATE_LIMITS.delete(key);
  }
  const bucket = RATE_LIMITS.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    RATE_LIMITS.set(ip, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (bucket.count >= RATE_MAX_REQUESTS) {
    const retryAfter = Math.ceil(
      (bucket.windowStart + RATE_WINDOW_MS - now) / 1000
    );
    return { allowed: false, retryAfter };
  }
  bucket.count++;
  return { allowed: true };
}
