/**
 * Roadmap #50 — orphan cleanup on session hard-delete.
 *
 * channel_messages and schedules carry NO foreign key on session_id (the schema
 * deliberately keeps schedules un-cascaded — the tick disables an orphan as an
 * app-level fallback — and channel_messages has no FK at all). So there is NO
 * ON DELETE CASCADE covering them: this file first PROVES that (deleting a
 * session leaves the child rows behind unless code removes them), then locks
 * that deleteChannelMessagesForSession / deleteSchedulesForSession do the
 * removal the DELETE /api/sessions/[id] route now calls.
 *
 * Runs on the CI matrix, so it also guards against a platform where
 * better-sqlite3's foreign_keys default differed.
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
  sendChannelMessage,
  deleteChannelMessagesForSession,
  peekInbox,
} from "@/lib/channels";
import { createSchedule, deleteSchedulesForSession } from "@/lib/scheduler";

function db() {
  return state.db as InstanceType<typeof Database>;
}

function addSession(id: string) {
  db().prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run(id, id);
}

function countChannels(sessionId: string): number {
  return (
    db()
      .prepare(
        "SELECT COUNT(*) AS n FROM channel_messages WHERE from_session_id = ? OR to_session_id = ?"
      )
      .get(sessionId, sessionId) as { n: number }
  ).n;
}

function countSchedules(sessionId: string): number {
  return (
    db()
      .prepare("SELECT COUNT(*) AS n FROM schedules WHERE session_id = ?")
      .get(sessionId) as { n: number }
  ).n;
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().prepare("DELETE FROM channel_messages").run();
  db().prepare("DELETE FROM schedules").run();
  db().prepare("DELETE FROM sessions").run();
  addSession("alice");
  addSession("bob");
});

describe("no FK cascade covers channel_messages / schedules", () => {
  it("deleting a session leaves its channel + schedule rows behind (no cascade)", () => {
    sendChannelMessage({ from: "bob", to: "alice", body: "hi" });
    createSchedule({
      sessionId: "alice",
      prompt: "run tests",
      recurrence: "daily",
    });
    // Delete the session directly, the way the route does — WITHOUT the explicit
    // cleanup helpers. If a cascade existed, these would drop to 0.
    db().prepare("DELETE FROM sessions WHERE id = ?").run("alice");
    expect(countChannels("alice")).toBe(1); // orphaned, not cascaded
    expect(countSchedules("alice")).toBe(1); // orphaned, not cascaded
  });
});

describe("deleteChannelMessagesForSession", () => {
  it("removes every message the session SENT or RECEIVED", () => {
    addSession("carol");
    sendChannelMessage({ from: "bob", to: "alice", body: "to-alice" }); // alice recv
    sendChannelMessage({ from: "alice", to: "bob", body: "from-alice" }); // alice sent
    sendChannelMessage({ from: "bob", to: "carol", body: "unrelated" }); // neither

    const removed = deleteChannelMessagesForSession("alice");
    expect(removed).toBe(2);
    expect(countChannels("alice")).toBe(0);
    // The unrelated bob→carol message survives.
    expect(peekInbox("carol")).toHaveLength(1);
  });

  it("is a 0-change no-op for a session with no messages", () => {
    expect(deleteChannelMessagesForSession("bob")).toBe(0);
  });
});

describe("deleteSchedulesForSession", () => {
  it("removes every schedule targeting the session, leaves others", () => {
    createSchedule({ sessionId: "alice", prompt: "a1" });
    createSchedule({ sessionId: "alice", prompt: "a2", recurrence: "hourly" });
    createSchedule({ sessionId: "bob", prompt: "b1" });

    const removed = deleteSchedulesForSession("alice");
    expect(removed).toBe(2);
    expect(countSchedules("alice")).toBe(0);
    expect(countSchedules("bob")).toBe(1);
  });

  it("is a 0-change no-op for a session with no schedules", () => {
    expect(deleteSchedulesForSession("bob")).toBe(0);
  });
});
