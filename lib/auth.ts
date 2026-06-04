/**
 * Auth + origin allowlist for the custom server (server.ts).
 *
 * Model (Jupyter / code-server style): a single shared token gates access.
 * Loopback is trusted by default so local dev is frictionless; remote access
 * (LAN / Tailscale) needs the token. The browser carries it as a same-origin
 * HttpOnly cookie, so once a `?token=` URL is opened every fetch AND WebSocket
 * upgrade is authenticated automatically.
 *
 * WebSocket upgrades ALSO get an Origin allowlist check (always, even on
 * loopback) to stop cross-site WebSocket hijacking — a malicious page in the
 * user's browser must not be able to open a socket to their terminals.
 *
 * The decision functions are pure (take primitives, return a verdict) so the
 * security logic is unit-testable; server.ts just gathers request fields.
 */
import { randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

export const COOKIE_NAME = "stoa_token";

const TOKEN_PATH = path.join(os.homedir(), ".stoa", "token");

let cachedToken: string | null | undefined; // undefined = not loaded, null = auth off

/**
 * The server's auth token, or null when auth is disabled (STOA_AUTH=off).
 * Resolution: STOA_AUTH=off → null; STOA_TOKEN env → that; else load (or
 * generate + persist to ~/.stoa/token, 0600). Cached for the process.
 */
export function getServerToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  if ((process.env.STOA_AUTH || "").toLowerCase() === "off") {
    cachedToken = null;
    return cachedToken;
  }

  const fromEnv = process.env.STOA_TOKEN?.trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }

  if (existsSync(TOKEN_PATH)) {
    let raw: string;
    try {
      raw = readFileSync(TOKEN_PATH, "utf-8");
    } catch (err) {
      // A transient read error must NOT rotate the token (it would invalidate
      // existing tokenized URLs). Use an ephemeral token this run; leave the
      // file intact for the next start.
      console.error(
        "Could not read Stoa token file; using an ephemeral token:",
        err
      );
      cachedToken = randomBytes(32).toString("base64url");
      return cachedToken;
    }
    const t = raw.trim();
    if (t) {
      cachedToken = t;
      return cachedToken;
    }
    // empty/corrupt file → fall through and regenerate
  }

  const generated = randomBytes(32).toString("base64url");
  cachedToken = generated;
  try {
    mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, generated + "\n", { mode: 0o600 });
  } catch (err) {
    console.error("Failed to persist Stoa auth token:", err);
  }
  return cachedToken;
}

/** True when auth is disabled (STOA_AUTH=off). */
export function isAuthDisabled(): boolean {
  return getServerToken() === null;
}

/** Trust loopback (no token needed locally) unless STOA_REQUIRE_AUTH=1. */
export function trustLoopback(): boolean {
  return process.env.STOA_REQUIRE_AUTH !== "1";
}

/** Extra allowed WS origins (reverse-proxy domains), from STOA_ALLOWED_ORIGINS. */
export function configuredAllowedOrigins(): string[] {
  return (process.env.STOA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Set-Cookie value for the auth cookie (HttpOnly, SameSite=Lax, 1y). */
export function buildAuthCookie(token: string, secure: boolean): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=31536000",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// ── pure helpers ──

/** Loopback address? Handles IPv4 127/8, IPv6 ::1, and IPv4-mapped forms. */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  return (
    a === "127.0.0.1" ||
    a === "::1" ||
    a === "localhost" ||
    a === "::ffff:127.0.0.1" ||
    a.startsWith("127.") ||
    a.startsWith("::ffff:127.")
  );
}

/** Parse a Cookie header into a name→value map (values URL-decoded). */
export function parseCookies(
  header: string | undefined | null
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** Constant-time string compare (length-guarded). */
export function safeEqual(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function bearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1].trim() : null;
}

/**
 * Is a WebSocket Origin allowed for this Host? No Origin (non-browser client)
 * is allowed — the token still gates those. A browser Origin must be same-host
 * as the server, or explicitly allow-listed. Anything else is a cross-site
 * attempt and is rejected (CSWSH defense).
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  host: string | undefined | null,
  allowedOrigins: string[]
): boolean {
  if (!origin) return true; // not a browser cross-site request
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false; // malformed Origin
  }
  if (host && originHost === host) return true; // same-origin
  for (const allowed of allowedOrigins) {
    if (origin === allowed) return true;
    try {
      if (new URL(allowed).host === originHost) return true;
    } catch {
      if (allowed === originHost) return true; // bare host entry
    }
  }
  return false;
}

export type HttpAuthDecision =
  | { type: "allow" }
  | { type: "bootstrap"; token: string } // valid ?token= → set cookie + redirect
  | { type: "deny" };

/** Decide HTTP access: loopback-trusted, else token via Bearer/cookie/query. */
export function decideHttpAuth(opts: {
  serverToken: string | null;
  remoteAddr?: string | null;
  trustLoopback: boolean;
  authHeader?: string | null;
  cookieHeader?: string | null;
  queryToken?: string | null;
}): HttpAuthDecision {
  const { serverToken } = opts;
  if (serverToken === null) return { type: "allow" }; // auth disabled
  if (opts.trustLoopback && isLoopbackAddress(opts.remoteAddr))
    return { type: "allow" };

  const b = bearer(opts.authHeader);
  if (b && safeEqual(b, serverToken)) return { type: "allow" };

  const cookieTok = parseCookies(opts.cookieHeader)[COOKIE_NAME];
  if (cookieTok && safeEqual(cookieTok, serverToken)) return { type: "allow" };

  if (opts.queryToken && safeEqual(opts.queryToken, serverToken))
    return { type: "bootstrap", token: serverToken };

  return { type: "deny" };
}

export type WsAuthDecision =
  | { type: "allow" }
  | { type: "deny"; reason: "origin" | "token" };

/** Decide WS upgrade: Origin allowlist ALWAYS, then the same token check. */
export function decideWsAuth(opts: {
  serverToken: string | null;
  origin?: string | null;
  host?: string | null;
  allowedOrigins: string[];
  remoteAddr?: string | null;
  trustLoopback: boolean;
  authHeader?: string | null;
  cookieHeader?: string | null;
  queryToken?: string | null;
}): WsAuthDecision {
  // CSWSH defense runs regardless of token/loopback.
  if (!isOriginAllowed(opts.origin, opts.host, opts.allowedOrigins)) {
    return { type: "deny", reason: "origin" };
  }
  if (opts.serverToken === null) return { type: "allow" };
  if (opts.trustLoopback && isLoopbackAddress(opts.remoteAddr))
    return { type: "allow" };

  const b = bearer(opts.authHeader);
  if (b && safeEqual(b, opts.serverToken)) return { type: "allow" };

  const cookieTok = parseCookies(opts.cookieHeader)[COOKIE_NAME];
  if (cookieTok && safeEqual(cookieTok, opts.serverToken))
    return { type: "allow" };

  if (opts.queryToken && safeEqual(opts.queryToken, opts.serverToken))
    return { type: "allow" };

  return { type: "deny", reason: "token" };
}
