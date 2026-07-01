import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createSchema } from "@/lib/db/schema";
import { runMigrations } from "@/lib/db/migrations";
import { COMMAND_AUDIT_KEY } from "@/lib/command/audit";

// Drive the real route handlers against a real in-memory DB — only getDb() is
// swapped for the test database; queries/readers/backend-key logic stay real.
const holder = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getDb: () => holder.db };
});

import { queries } from "@/lib/db";
import { GET as sessionEvents } from "@/app/api/sessions/[id]/events/route";
import { GET as fleetAudit } from "@/app/api/audit/route";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reqOf = (url: string): any => ({ url });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const db = () => holder.db;
const addEvent = (
  key: string,
  type: string,
  createdAt: number,
  payload: string | null = null
) => queries.appendSessionEvent(db()).run(key, type, payload, createdAt);

beforeAll(() => {
  const mem = new Database(":memory:");
  createSchema(mem);
  runMigrations(mem);
  holder.db = mem;
});

beforeEach(() => {
  db().exec(
    "DELETE FROM session_events; DELETE FROM sessions; DELETE FROM projects;"
  );
  queries
    .createProject(db())
    .run("proj1", "grid", "~/work/grid", "claude", "sonnet", null, 1);
  // Session "sess-a" has tmux_name "claude-a", so its backend key is exactly "claude-a".
  queries
    .createSession(db())
    .run(
      "sess-a",
      "My Agent",
      "claude-a",
      "~/work/grid",
      null,
      "opus",
      null,
      "/",
      "claude",
      0,
      "proj1"
    );
  addEvent("claude-a", "session_create", 100);
  addEvent("claude-a", "input_text", 300, '{"length":5}');
  addEvent("claude-a", "input_enter", 400);
  addEvent("claude-ghost", "session_kill", 500); // no session row (deleted)
  addEvent(COMMAND_AUDIT_KEY, "command_executed", 600);
});

describe("GET /api/sessions/[id]/events", () => {
  it("404s for a missing session", async () => {
    const res = await sessionEvents(reqOf("http://x/e"), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("returns that session's events newest-first with the filtered total", async () => {
    const res = await sessionEvents(reqOf("http://x/e"), ctx("sess-a"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(
      body.events.map((e: { created_at: number }) => e.created_at)
    ).toEqual([400, 300, 100]);
  });

  it("applies a types filter", async () => {
    const res = await sessionEvents(
      reqOf("http://x/e?types=input_enter"),
      ctx("sess-a")
    );
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_type).toBe("input_enter");
  });

  it("types present but all invalid → empty, no SQL error", async () => {
    const res = await sessionEvents(
      reqOf("http://x/e?types=bogus"),
      ctx("sess-a")
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("format=csv streams a download with the escaped rows", async () => {
    const res = await sessionEvents(
      reqOf("http://x/e?format=csv"),
      ctx("sess-a")
    );
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = await res.text();
    expect(text.split("\r\n")[0]).toContain("event_type,payload");
    expect(text).toContain("claude-a");
  });
});

describe("GET /api/audit (fleet)", () => {
  it("returns all events enriched with the session name", async () => {
    const res = await fleetAudit(reqOf("http://x/api/audit"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(5);
    const byKey = Object.fromEntries(
      body.events.map(
        (e: { session_key: string; session_name: string | null }) => [
          e.session_key,
          e.session_name,
        ]
      )
    );
    expect(byKey["claude-a"]).toBe("My Agent"); // enriched
    expect(byKey[COMMAND_AUDIT_KEY]).toBe("Command Stoa"); // synthetic key labelled
    expect(byKey["claude-ghost"]).toBeNull(); // deleted session → no name
  });

  it("?session=<id> scopes to that session's backend key", async () => {
    const res = await fleetAudit(reqOf("http://x/api/audit?session=sess-a"));
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(
      body.events.every(
        (e: { session_key: string }) => e.session_key === "claude-a"
      )
    ).toBe(true);
  });

  it("?session=<missing> → 404", async () => {
    const res = await fleetAudit(reqOf("http://x/api/audit?session=ghost"));
    expect(res.status).toBe(404);
  });

  it("format=csv streams a fleet download", async () => {
    const res = await fleetAudit(reqOf("http://x/api/audit?format=csv"));
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("Command Stoa");
  });
});
