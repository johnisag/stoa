/**
 * Roadmap #50 — the SELECT DISTINCT pending-recipients scan.
 *
 * The opt-in push tick used to probe every live session's inbox
 * (nextUnreadMessage per session per tick). sessionsWithPendingDelivery()
 * replaces that with ONE `SELECT DISTINCT to_session_id ... WHERE read_at IS
 * NULL` — behavior-identical (the tick then intersects with the live snapshot
 * and picks the oldest unread per recipient) but a single query. This locks:
 *   - only recipients with an UNREAD message appear,
 *   - each recipient appears ONCE regardless of how many unread it has,
 *   - a fully-consumed recipient drops out,
 *   - the result is ordered deterministically.
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
  consumeInbox,
  claimDelivery,
  nextUnreadMessage,
  sessionsWithPendingDelivery,
} from "@/lib/channels";

function db() {
  return state.db as InstanceType<typeof Database>;
}

function addSession(id: string) {
  db().prepare("INSERT INTO sessions (id, name) VALUES (?, ?)").run(id, id);
}

beforeAll(() => {
  const d = new Database(":memory:");
  createSchema(d);
  runMigrations(d);
  state.db = d;
});

beforeEach(() => {
  db().prepare("DELETE FROM channel_messages").run();
  db().prepare("DELETE FROM sessions").run();
  for (const id of ["alice", "bob", "carol", "sender"]) addSession(id);
});

describe("sessionsWithPendingDelivery", () => {
  it("is empty when nothing is pending", () => {
    expect(sessionsWithPendingDelivery()).toEqual([]);
  });

  it("lists each recipient with unread exactly once, sorted", () => {
    sendChannelMessage({ from: "sender", to: "carol", body: "1" });
    sendChannelMessage({ from: "sender", to: "alice", body: "2" });
    sendChannelMessage({ from: "sender", to: "alice", body: "3" }); // alice x2
    expect(sessionsWithPendingDelivery()).toEqual(["alice", "carol"]);
  });

  it("drops a recipient once its inbox is fully consumed (pull)", () => {
    sendChannelMessage({ from: "sender", to: "alice", body: "1" });
    sendChannelMessage({ from: "sender", to: "bob", body: "2" });
    expect(sessionsWithPendingDelivery()).toEqual(["alice", "bob"]);
    consumeInbox("alice"); // pull marks alice's read
    expect(sessionsWithPendingDelivery()).toEqual(["bob"]);
  });

  it("drops a recipient once its only message is claimed for push", () => {
    const m = sendChannelMessage({ from: "sender", to: "alice", body: "1" });
    expect(sessionsWithPendingDelivery()).toEqual(["alice"]);
    expect(claimDelivery(m.id)).toBe(true);
    expect(sessionsWithPendingDelivery()).toEqual([]);
  });

  it("mirrors the per-recipient nextUnreadMessage pick (behavior-identical scan)", () => {
    // Every recipient the DISTINCT scan reports must have a next unread; every
    // recipient NOT reported must have none — the property the tick relies on.
    sendChannelMessage({ from: "sender", to: "alice", body: "1" });
    consumeInbox("bob"); // bob has nothing
    const pending = new Set(sessionsWithPendingDelivery());
    expect(pending.has("alice")).toBe(true);
    expect(nextUnreadMessage("alice")).not.toBeNull();
    expect(pending.has("bob")).toBe(false);
    expect(nextUnreadMessage("bob")).toBeNull();
  });
});
