/**
 * Inter-agent channels — the service layer over a real in-memory SQLite (real
 * schema + migrations + queries, the `db` proxy mocked). Locks: send + recipient
 * validation, the order-independent pair key, the consuming inbox (read-once),
 * the non-consuming peek + thread, the single-oldest delivery pick + claimDelivery,
 * and the validation caps.
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
  peekInbox,
  consumeInbox,
  listThread,
  nextUnreadMessage,
  claimDelivery,
  channelPairKey,
  validateChannelBody,
  ChannelValidationError,
  CHANNEL_BODY_MAX_LENGTH,
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
  addSession("alice");
  addSession("bob");
});

describe("channelPairKey", () => {
  it("is order-independent", () => {
    expect(channelPairKey("a", "b")).toBe(channelPairKey("b", "a"));
    expect(channelPairKey("bob", "alice")).toBe("alice__bob");
  });
});

describe("validateChannelBody", () => {
  it("rejects empty / non-string / over-long, accepts a normal body", () => {
    expect(() => validateChannelBody("")).toThrow(ChannelValidationError);
    expect(() => validateChannelBody("   ")).toThrow(ChannelValidationError);
    expect(() => validateChannelBody(42)).toThrow(ChannelValidationError);
    expect(() =>
      validateChannelBody("x".repeat(CHANNEL_BODY_MAX_LENGTH + 1))
    ).toThrow(/exceeds/);
    expect(validateChannelBody("  hi  ")).toBe("hi");
  });
});

describe("sendChannelMessage", () => {
  it("stores a message with the sorted pair key", () => {
    const m = sendChannelMessage({ from: "bob", to: "alice", body: "hello" });
    expect(m.from_session_id).toBe("bob");
    expect(m.to_session_id).toBe("alice");
    expect(m.pair_key).toBe("alice__bob");
    expect(m.body).toBe("hello");
    expect(m.read_at).toBeNull();
    expect(m.delivered_at).toBeNull();
  });

  it("rejects a self-send", () => {
    expect(() =>
      sendChannelMessage({ from: "alice", to: "alice", body: "x" })
    ).toThrow(/yourself/);
  });

  it("rejects an unknown recipient", () => {
    expect(() =>
      sendChannelMessage({ from: "alice", to: "ghost", body: "x" })
    ).toThrow(/no session with id/);
  });

  it("rejects an unknown sender (no phantom from)", () => {
    expect(() =>
      sendChannelMessage({ from: "ghost", to: "alice", body: "x" })
    ).toThrow(/no session with id/);
  });

  it("requires non-empty from/to", () => {
    expect(() =>
      sendChannelMessage({ from: "", to: "alice", body: "x" })
    ).toThrow(/from is required/);
    expect(() =>
      sendChannelMessage({ from: "alice", to: "", body: "x" })
    ).toThrow(/to is required/);
  });
});

describe("inbox: peek (non-consuming) vs consume (read-once)", () => {
  it("peekInbox lists unread oldest-first without consuming", () => {
    sendChannelMessage({ from: "bob", to: "alice", body: "first" });
    sendChannelMessage({ from: "bob", to: "alice", body: "second" });
    expect(peekInbox("alice").map((m) => m.body)).toEqual(["first", "second"]);
    // Still unread after a peek.
    expect(peekInbox("alice")).toHaveLength(2);
  });

  it("consumeInbox returns unread then marks them read", () => {
    sendChannelMessage({ from: "bob", to: "alice", body: "first" });
    sendChannelMessage({ from: "bob", to: "alice", body: "second" });
    expect(consumeInbox("alice").map((m) => m.body)).toEqual([
      "first",
      "second",
    ]);
    // Consumed → a second read is empty.
    expect(consumeInbox("alice")).toHaveLength(0);
    expect(peekInbox("alice")).toHaveLength(0);
  });

  it("only the recipient sees a message", () => {
    sendChannelMessage({ from: "bob", to: "alice", body: "for alice" });
    expect(peekInbox("bob")).toHaveLength(0);
    expect(peekInbox("alice")).toHaveLength(1);
  });
});

describe("delivery pick + claimDelivery (the opt-in push path)", () => {
  it("nextUnreadMessage returns the single oldest unread, then nothing after delivery", () => {
    const a = sendChannelMessage({ from: "bob", to: "alice", body: "1" });
    sendChannelMessage({ from: "bob", to: "alice", body: "2" });
    const first = nextUnreadMessage("alice");
    expect(first?.id).toBe(a.id);
    expect(claimDelivery(a.id)).toBe(true);
    // Delivered ⇒ read; the next pick is message "2".
    expect(nextUnreadMessage("alice")?.body).toBe("2");
    const row = db()
      .prepare("SELECT * FROM channel_messages WHERE id = ?")
      .get(a.id) as { delivered_at: string | null; read_at: string | null };
    expect(row.delivered_at).not.toBeNull();
    expect(row.read_at).not.toBeNull();
  });

  it("a consumed message is not re-delivered", () => {
    sendChannelMessage({ from: "bob", to: "alice", body: "1" });
    consumeInbox("alice"); // pull marks read
    expect(nextUnreadMessage("alice")).toBeNull();
  });

  it("claimDelivery is idempotent (single winner) and loses to a prior pull", () => {
    const a = sendChannelMessage({ from: "bob", to: "alice", body: "1" });
    expect(claimDelivery(a.id)).toBe(true); // first claim wins
    const after1 = db()
      .prepare(
        "SELECT delivered_at, read_at FROM channel_messages WHERE id = ?"
      )
      .get(a.id) as { delivered_at: string; read_at: string };
    // A second claim must LOSE (changes === 0) and not re-stamp delivered_at.
    expect(claimDelivery(a.id)).toBe(false);
    const after2 = db()
      .prepare("SELECT delivered_at FROM channel_messages WHERE id = ?")
      .get(a.id) as { delivered_at: string };
    expect(after2.delivered_at).toBe(after1.delivered_at);

    // A message already consumed by a pull is NOT later claimed by the push.
    const b = sendChannelMessage({ from: "bob", to: "alice", body: "2" });
    consumeInbox("alice"); // pull marks b read
    expect(claimDelivery(b.id)).toBe(false); // push loses the race
    const bRow = db()
      .prepare("SELECT delivered_at FROM channel_messages WHERE id = ?")
      .get(b.id) as { delivered_at: string | null };
    expect(bRow.delivered_at).toBeNull();
  });
});

describe("listThread", () => {
  it("returns both directions oldest-first, scoped to the pair", () => {
    sendChannelMessage({ from: "alice", to: "bob", body: "a→b 1" });
    sendChannelMessage({ from: "bob", to: "alice", body: "b→a 1" });
    addSession("carol");
    sendChannelMessage({
      from: "alice",
      to: "carol",
      body: "a→c (other thread)",
    });
    const thread = listThread("alice", "bob").map((m) => m.body);
    expect(thread).toEqual(["a→b 1", "b→a 1"]);
  });
});
