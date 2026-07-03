/**
 * Per-device named revocable auth tokens (#46/#49). Security contract: only a
 * SHA-256 hash of the secret is stored; resolution is fail-closed (only an exact
 * stored "admin" grants admin); revocation is live; the list never leaks a secret.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries } from "@/lib/db/queries";
import {
  hashToken,
  createToken,
  resolveTokenScope,
  listTokens,
  revokeToken,
  validateScope,
  TokenValidationError,
} from "@/lib/tokens";

function db() {
  const d = new Database(":memory:");
  createSchema(d); // fresh-start schema (auth_tokens included) …
  runMigrations(d); // … then migrations (idempotent) — mirrors the real init.
  return d;
}

describe("hashToken", () => {
  it("is a deterministic 64-hex SHA-256 that differs per secret", () => {
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("validateScope", () => {
  it("accepts admin/observer, rejects anything else", () => {
    expect(validateScope("admin")).toBe("admin");
    expect(validateScope("observer")).toBe("observer");
    for (const bad of ["Admin", "root", "", null, 1, "observer "]) {
      expect(() => validateScope(bad)).toThrow(TokenValidationError);
    }
  });
});

describe("createToken", () => {
  it("mints a secret, stores only its HASH, and never persists plaintext", () => {
    const d = db();
    const { id, token, scope } = createToken("Phone", "observer", d);
    expect(scope).toBe("observer");
    expect(token.length).toBeGreaterThan(20);
    // The stored row holds the hash, NOT the token.
    const row = d
      .prepare(`SELECT token_hash FROM auth_tokens WHERE id = ?`)
      .get(id) as { token_hash: string };
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toContain(token);
  });

  it("validates the name and scope", () => {
    const d = db();
    expect(() => createToken("", "admin", d)).toThrow(/name is required/);
    expect(() => createToken("x".repeat(65), "admin", d)).toThrow(/exceeds/);
    expect(() => createToken("ok", "superuser", d)).toThrow(/scope/);
  });
});

describe("resolveTokenScope", () => {
  it("resolves a live token to its scope and stamps last_used_at", () => {
    const d = db();
    const admin = createToken("Laptop", "admin", d);
    const obs = createToken("TV", "observer", d);
    expect(resolveTokenScope(admin.token, d)).toBe("admin");
    expect(resolveTokenScope(obs.token, d)).toBe("observer");
    const row = d
      .prepare(`SELECT last_used_at FROM auth_tokens WHERE id = ?`)
      .get(admin.id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
  });

  it("returns null for an unknown or empty token", () => {
    const d = db();
    createToken("x", "admin", d);
    expect(resolveTokenScope("not-a-real-token", d)).toBeNull();
    expect(resolveTokenScope("", d)).toBeNull();
  });

  it("FAILS CLOSED: a corrupted/unknown stored scope resolves to observer, never admin", () => {
    const d = db();
    // Insert a row directly with a bogus scope, as a data glitch might.
    const hash = hashToken("secret-xyz");
    queries
      .createAuthToken(d)
      .run("id1", "glitch", hash, "superadmin" as never);
    expect(resolveTokenScope("secret-xyz", d)).toBe("observer");
  });

  it("a REVOKED token resolves to null immediately (live revocation)", () => {
    const d = db();
    const t = createToken("Old Phone", "admin", d);
    expect(resolveTokenScope(t.token, d)).toBe("admin");
    expect(revokeToken(t.id, d)).toBe(true);
    expect(resolveTokenScope(t.token, d)).toBeNull();
  });
});

describe("listTokens / revokeToken", () => {
  it("lists tokens without ever exposing a hash or secret", () => {
    const d = db();
    const t = createToken("Phone", "observer", d);
    const list = listTokens(d);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: t.id,
      name: "Phone",
      scope: "observer",
    });
    expect(JSON.stringify(list)).not.toContain(t.token);
    expect(JSON.stringify(list)).not.toContain("token_hash");
    expect(JSON.stringify(list)).not.toContain(hashToken(t.token));
  });

  it("revoke is idempotent (a second revoke changes nothing)", () => {
    const d = db();
    const t = createToken("x", "admin", d);
    expect(revokeToken(t.id, d)).toBe(true);
    expect(revokeToken(t.id, d)).toBe(false);
    expect(revokeToken("no-such-id", d)).toBe(false);
    expect(revokeToken("", d)).toBe(false);
  });
});
