/**
 * Per-device named revocable auth tokens with a scope (#46/#49).
 *
 * The legacy single `~/.stoa/token` (lib/auth.ts) still works as an implicit
 * ADMIN token — this is purely additive. A token here is a random secret; only its
 * SHA-256 HASH is stored, so a DB read can never recover a usable token. Two scopes:
 *   - `admin`    — full control (everything the master token can do).
 *   - `observer` — a read-only SPECTATOR: it may stream the Live Wall and read GET
 *                  endpoints, and is rejected by every mutating operation. The
 *                  ENFORCEMENT lives at the auth gate (server.ts) — this module only
 *                  mints/resolves/revokes; it never decides what a scope may reach.
 *
 * FAIL-CLOSED: resolveTokenScope returns `admin` ONLY for a stored scope that is
 * EXACTLY "admin"; any other value (including a corrupted/unknown one) resolves to
 * the least-privilege `observer`, so a data glitch can never escalate to admin.
 */
import { createHash, randomBytes } from "crypto";
import type Database from "better-sqlite3";
import { getDb, queries } from "./db";

export type TokenScope = "admin" | "observer";

/** The valid scopes a token can be minted with. */
export const TOKEN_SCOPES: readonly TokenScope[] = ["admin", "observer"];

/** Max token name length (a device label). */
export const TOKEN_NAME_MAX = 64;

/** A token row as surfaced to the settings UI — NEVER carries the hash/secret. */
export interface TokenInfo {
  id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** Thrown on invalid input (a route maps this to a 400). */
export class TokenValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenValidationError";
  }
}

/** SHA-256 hash (hex) of a token secret. The ONLY form we persist. Pure. */
export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Normalize + validate a device name. */
function normalizeName(raw: unknown): string {
  if (typeof raw !== "string")
    throw new TokenValidationError("name is required");
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) throw new TokenValidationError("name is required");
  if (name.length > TOKEN_NAME_MAX) {
    throw new TokenValidationError(`name exceeds ${TOKEN_NAME_MAX} characters`);
  }
  return name;
}

/** Validate a scope string into a TokenScope, else throw. */
export function validateScope(raw: unknown): TokenScope {
  if (raw === "admin" || raw === "observer") return raw;
  throw new TokenValidationError("scope must be 'admin' or 'observer'");
}

/**
 * Mint a new token: a random 256-bit secret stored ONLY as its hash. Returns the
 * plaintext secret ONCE (it can never be recovered afterwards) plus the public id
 * used to revoke it.
 */
export function createToken(
  rawName: unknown,
  rawScope: unknown,
  db: Database.Database = getDb()
): { id: string; token: string; name: string; scope: TokenScope } {
  const name = normalizeName(rawName);
  const scope = validateScope(rawScope);
  const id = randomBytes(9).toString("base64url"); // public row id (not a secret)
  const token = randomBytes(32).toString("base64url"); // the secret
  queries.createAuthToken(db).run(id, name, hashToken(token), scope);
  return { id, token, name, scope };
}

/**
 * Resolve a presented token secret to its scope, or null if it matches no live
 * (non-revoked) token. Stamps last-use. FAIL-CLOSED: only an exact stored "admin"
 * grants admin; anything else is downgraded to observer.
 */
export function resolveTokenScope(
  presented: string,
  db: Database.Database = getDb()
): TokenScope | null {
  if (typeof presented !== "string" || presented.length === 0) return null;
  const row = queries.resolveAuthToken(db).get(hashToken(presented)) as
    { id: string; scope: string } | undefined;
  if (!row) return null;
  try {
    queries.touchAuthToken(db).run(row.id);
  } catch {
    // last-use stamping is best-effort — never fail auth because of it.
  }
  return row.scope === "admin" ? "admin" : "observer";
}

/** The token list for the settings UI (no secrets). */
export function listTokens(db: Database.Database = getDb()): TokenInfo[] {
  return queries.listAuthTokens(db).all() as TokenInfo[];
}

/** Revoke a token by id. Returns true if a live token was revoked (idempotent). */
export function revokeToken(
  id: unknown,
  db: Database.Database = getDb()
): boolean {
  if (typeof id !== "string" || !id) return false;
  const info = queries.revokeAuthToken(db).run(id);
  return info.changes > 0;
}
