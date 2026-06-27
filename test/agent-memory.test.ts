/**
 * Agent-accessible shared memory — the service layer over a real in-memory SQLite
 * (real schema + migrations + queries, the `db` proxy mocked to point at it).
 * Locks set/get/list/delete, the upsert-by-key overwrite, list ordering, the
 * not-set → null read, and the key/value validation (the security-relevant caps).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return {
    ...actual,
    getDb: () => state.db,
    get db() {
      return state.db;
    },
  };
});

import {
  setMemory,
  getMemory,
  listMemory,
  deleteMemory,
  normalizeMemoryKey,
  validateMemoryValue,
  MemoryValidationError,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_VALUE_MAX_LENGTH,
} from "@/lib/agent-memory";

function db() {
  return state.db as InstanceType<typeof Database>;
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().prepare("DELETE FROM agent_memory").run();
});

describe("setMemory / getMemory", () => {
  it("stores and reads back a value by key", () => {
    const row = setMemory("contract", "the API returns { ok: true }");
    expect(row.key).toBe("contract");
    expect(row.value).toBe("the API returns { ok: true }");
    expect(getMemory("contract")?.value).toBe("the API returns { ok: true }");
  });

  it("returns null for a key no agent has written", () => {
    expect(getMemory("never-set")).toBeNull();
  });

  it("trims the key (so '  k  ' and 'k' are the same entry)", () => {
    setMemory("  spaced  ", "v");
    expect(getMemory("spaced")?.value).toBe("v");
  });

  it("allows an explicitly-empty value (a deliberately blank note)", () => {
    const row = setMemory("blank", "");
    expect(row.value).toBe("");
    expect(getMemory("blank")?.value).toBe("");
  });
});

describe("upsert by key", () => {
  it("overwrites the value and bumps updated_at on a repeat set", () => {
    setMemory("k", "first");
    const before = getMemory("k")!;
    // Force a later timestamp tick so updated_at is observably newer.
    db()
      .prepare(
        "UPDATE agent_memory SET updated_at = '2000-01-01 00:00:00' WHERE key = ?"
      )
      .run("k");
    setMemory("k", "second");
    const after = getMemory("k")!;
    expect(after.value).toBe("second");
    expect(after.updated_at).not.toBe("2000-01-01 00:00:00");
    // Exactly one row for the key (upsert, not insert).
    const n = db()
      .prepare("SELECT COUNT(*) AS n FROM agent_memory WHERE key = ?")
      .get("k") as { n: number };
    expect(n.n).toBe(1);
    expect(before.value).toBe("first");
  });
});

describe("listMemory", () => {
  it("lists entries most-recently-updated first", () => {
    setMemory("a", "1");
    setMemory("b", "2");
    db()
      .prepare(
        "UPDATE agent_memory SET updated_at = '2099-01-01 00:00:00' WHERE key = 'a'"
      )
      .run();
    const keys = listMemory().map((e) => e.key);
    expect(keys[0]).toBe("a"); // a was bumped to the newest
    expect(keys).toContain("b");
  });

  it("is empty when nothing is stored", () => {
    expect(listMemory()).toEqual([]);
  });
});

describe("deleteMemory", () => {
  it("removes a key and reports whether a row was deleted", () => {
    setMemory("gone", "soon");
    expect(deleteMemory("gone")).toBe(true);
    expect(getMemory("gone")).toBeNull();
    expect(deleteMemory("gone")).toBe(false); // already gone
  });
});

describe("validation (the security-relevant caps)", () => {
  it("normalizeMemoryKey rejects non-string / empty / whitespace / over-long", () => {
    for (const bad of [undefined, null, 42, "", "   "]) {
      expect(() => normalizeMemoryKey(bad)).toThrow(MemoryValidationError);
    }
    expect(() =>
      normalizeMemoryKey("x".repeat(MEMORY_KEY_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
    expect(normalizeMemoryKey("ok")).toBe("ok");
  });

  it("validateMemoryValue rejects non-string / over-long, allows empty", () => {
    for (const bad of [undefined, null, 42, {}]) {
      expect(() => validateMemoryValue(bad)).toThrow(MemoryValidationError);
    }
    expect(() =>
      validateMemoryValue("x".repeat(MEMORY_VALUE_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
    expect(validateMemoryValue("")).toBe("");
  });

  it("setMemory surfaces validation errors (a bad key never writes a row)", () => {
    expect(() => setMemory("", "v")).toThrow(MemoryValidationError);
    expect(
      db().prepare("SELECT COUNT(*) AS n FROM agent_memory").get()
    ).toEqual({
      n: 0,
    });
  });
});
