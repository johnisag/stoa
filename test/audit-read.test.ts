import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { queries, readAuditEvents, countAuditEvents } from "@/lib/db/queries";
import type { AuditQuery } from "@/lib/audit/query";

// Exercises the built SQL against a real SQLite (in-memory): filters, the IN list,
// newest-first ordering, and pagination — the pure builder tests can't catch a
// bad column name or ORDER BY.

const state = { db: null as unknown as Database.Database };
const db = () => state.db;

const add = (
  key: string,
  type: string,
  createdAt: number,
  payload: string | null = null
) => queries.appendSessionEvent(db()).run(key, type, payload, createdAt);

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  state.db = mem;
});

beforeEach(() => {
  db().exec("DELETE FROM session_events");
  // Two sessions, interleaved in time.
  add("claude-a", "session_create", 100);
  add("claude-a", "input_text", 300, '{"length":5}');
  add("claude-a", "input_enter", 400);
  add("claude-b", "session_create", 200);
  add("claude-b", "session_kill", 500);
});

const q = (over: Partial<AuditQuery>): AuditQuery => ({
  limit: 100,
  offset: 0,
  ...over,
});

describe("readAuditEvents", () => {
  it("fleet read returns all events, NEWEST first", () => {
    const rows = readAuditEvents(db(), q({}));
    expect(rows.map((r) => r.created_at)).toEqual([500, 400, 300, 200, 100]);
  });

  it("scopes to one session key", () => {
    const rows = readAuditEvents(db(), q({ sessionKey: "claude-a" }));
    expect(rows.map((r) => r.event_type)).toEqual([
      "input_enter",
      "input_text",
      "session_create",
    ]);
  });

  it("filters by an IN list of event types", () => {
    const rows = readAuditEvents(
      db(),
      q({ types: ["session_create", "session_kill"] })
    );
    expect(rows.map((r) => r.created_at)).toEqual([500, 200, 100]);
  });

  it("bounds by since/until inclusively", () => {
    const rows = readAuditEvents(db(), q({ since: 200, until: 400 }));
    expect(rows.map((r) => r.created_at)).toEqual([400, 300, 200]);
  });

  it("paginates with limit/offset over the newest-first order", () => {
    expect(
      readAuditEvents(db(), q({ limit: 2 })).map((r) => r.created_at)
    ).toEqual([500, 400]);
    expect(
      readAuditEvents(db(), q({ limit: 2, offset: 2 })).map((r) => r.created_at)
    ).toEqual([300, 200]);
  });

  it("preserves the payload column", () => {
    const [enter, text] = readAuditEvents(db(), q({ sessionKey: "claude-a" }));
    expect(enter.payload).toBeNull();
    expect(text.payload).toBe('{"length":5}');
  });

  it("payloadCap truncates the returned payload (bounds bulk-export memory)", () => {
    db().exec("DELETE FROM session_events");
    const long = JSON.stringify({ text: "x".repeat(500) });
    add("claude-a", "input_text", 100, long);
    const [full] = readAuditEvents(db(), q({ sessionKey: "claude-a" }));
    expect(full.payload).toBe(long); // no cap → full payload
    const [capped] = readAuditEvents(
      db(),
      q({ sessionKey: "claude-a", payloadCap: 32 })
    );
    expect(capped.payload).toHaveLength(32);
    expect(long.startsWith(capped.payload as string)).toBe(true);
    // a NULL payload survives the substr as NULL
    add("claude-a", "input_enter", 200);
    const [enter] = readAuditEvents(
      db(),
      q({ sessionKey: "claude-a", types: ["input_enter"], payloadCap: 32 })
    );
    expect(enter.payload).toBeNull();
  });
});

describe("countAuditEvents", () => {
  it("counts the FILTERED total, ignoring limit/offset", () => {
    expect(countAuditEvents(db(), q({ limit: 1 }))).toBe(5);
    expect(
      countAuditEvents(db(), q({ sessionKey: "claude-a", limit: 1 }))
    ).toBe(3);
    expect(
      countAuditEvents(db(), q({ types: ["session_create"], offset: 99 }))
    ).toBe(2);
  });
});
