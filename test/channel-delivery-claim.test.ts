/**
 * Roadmap #50 — regression for the channel PUSH double-deliver race.
 *
 * The opt-in terminal push (server.ts) picked the oldest unread with a
 * NON-consuming SELECT (nextUnreadMessage), PASTED it, and only THEN stamped it
 * delivered. Two concurrent delivery attempts that peek the SAME pending message
 * off one snapshot — before either marks — both saw it as unread and both pasted
 * it into the recipient's terminal (a double-deliver). The after-the-fact
 * markDelivered is atomic, but by then both had already pasted.
 *
 * The fix: `claimDelivery(id)` atomically stamps the row (delivered_at/read_at)
 * WHERE it is still pending and returns `changes === 1` — only the ONE winner
 * that flips the row gets to paste; a concurrent loser gets `false` and skips.
 * `resetDelivery(id)` un-claims a row whose paste later failed so the next tick
 * re-delivers it (at-least-once is preserved without reopening the race).
 *
 * The first test models the two concurrent deliverers exactly as server.ts does
 * (both decide off one snapshot). It contrasts the OLD decision (peek-then-paste,
 * inlined as the control) with the NEW decision (claim-then-paste, the real API):
 * the control double-delivers, the fix delivers once. It FAILS against a
 * peek-based claim and passes once the claim is the atomic UPDATE.
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
  nextUnreadMessage,
  claimDelivery,
  resetDelivery,
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

describe("claimDelivery — atomic claim gates the terminal paste", () => {
  it("two concurrent deliverers off one snapshot deliver the message ONCE (no double-deliver)", () => {
    const m = sendChannelMessage({ from: "bob", to: "alice", body: "once" });

    // ── Control: the OLD decision, peek-then-paste. BOTH deliverers peek the
    // pending message off the SAME snapshot (nothing marked yet), so both would
    // paste. This is what the race looked like; it double-delivers.
    const oldPeekA = nextUnreadMessage("alice");
    const oldPeekB = nextUnreadMessage("alice");
    const oldPastes = [oldPeekA, oldPeekB].filter((x) => x !== null).length;
    expect(oldPastes).toBe(2); // the bug: both would paste

    // Re-arm the row for the real API run (the control above didn't mark it).
    db()
      .prepare(
        "UPDATE channel_messages SET delivered_at = NULL, read_at = NULL WHERE id = ?"
      )
      .run(m.id);

    // ── Fix: the NEW decision, claim-then-paste. Each deliverer claims BEFORE
    // pasting; only the winner (changes === 1) pastes.
    const claimedA = claimDelivery(m.id);
    const claimedB = claimDelivery(m.id);
    const newPastes = [claimedA, claimedB].filter(Boolean).length;

    expect(newPastes).toBe(1); // exactly one delivery
    expect(claimedA).toBe(true);
    expect(claimedB).toBe(false);

    // The row is stamped delivered + read exactly once.
    const row = db()
      .prepare(
        "SELECT delivered_at, read_at FROM channel_messages WHERE id = ?"
      )
      .get(m.id) as { delivered_at: string | null; read_at: string | null };
    expect(row.delivered_at).not.toBeNull();
    expect(row.read_at).not.toBeNull();
  });

  it("a claim LOSES to a prior pull (already consumed → not re-delivered)", () => {
    const m = sendChannelMessage({ from: "bob", to: "alice", body: "pulled" });
    // Simulate a channel_inbox pull consuming it first.
    db()
      .prepare(
        "UPDATE channel_messages SET read_at = datetime('now') WHERE id = ?"
      )
      .run(m.id);
    // The push must not re-stamp / re-deliver a message already read by a pull.
    expect(claimDelivery(m.id)).toBe(false);
    const row = db()
      .prepare("SELECT delivered_at FROM channel_messages WHERE id = ?")
      .get(m.id) as { delivered_at: string | null };
    expect(row.delivered_at).toBeNull();
  });

  it("claiming an unknown id is a no-op false (never throws)", () => {
    expect(claimDelivery("does-not-exist")).toBe(false);
  });

  it("resetDelivery re-arms a claimed-but-failed message so the next tick re-delivers", () => {
    const m = sendChannelMessage({ from: "bob", to: "alice", body: "retry" });
    // Tick 1: claim wins, then the paste FAILS (pane died mid-tick) → un-claim.
    expect(claimDelivery(m.id)).toBe(true);
    resetDelivery(m.id);
    // The message is pending again — visible to the push scan AND re-claimable.
    expect(nextUnreadMessage("alice")?.id).toBe(m.id);
    // Tick 2: re-claim succeeds and (on a good paste) it stays consumed.
    expect(claimDelivery(m.id)).toBe(true);
    const row = db()
      .prepare(
        "SELECT delivered_at, read_at FROM channel_messages WHERE id = ?"
      )
      .get(m.id) as { delivered_at: string | null; read_at: string | null };
    expect(row.delivered_at).not.toBeNull();
    expect(row.read_at).not.toBeNull();
  });

  it("resetDelivery never un-consumes a message a PULL already read", () => {
    const m = sendChannelMessage({ from: "bob", to: "alice", body: "pulled" });
    // A pull consumes it (sets read_at only; delivered_at stays NULL).
    db()
      .prepare(
        "UPDATE channel_messages SET read_at = datetime('now') WHERE id = ?"
      )
      .run(m.id);
    // A stray reset must NOT resurrect a pulled message (delivered_at IS NULL guard).
    resetDelivery(m.id);
    expect(nextUnreadMessage("alice")).toBeNull();
  });
});
