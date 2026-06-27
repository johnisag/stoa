import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueuePrompt,
  enqueuePromptIdempotent,
  SEEN_CLIENT_IDS_MAX,
  listQueue,
  peekPrompt,
  dequeuePrompt,
  clearQueue,
  hasAnyQueued,
  removeAt,
  moveUp,
  moveDown,
} from "../lib/prompt-queue";

// The module holds process-global state; isolate each test with distinct ids
// and a clear in beforeEach.
beforeEach(() => {
  clearQueue("a");
  clearQueue("b");
});

describe("prompt-queue", () => {
  it("enqueues in FIFO order and lists a copy", () => {
    enqueuePrompt("a", "first");
    const q = enqueuePrompt("a", "second");
    expect(q).toEqual(["first", "second"]);
    expect(listQueue("a")).toEqual(["first", "second"]);
    // listQueue returns a copy — mutating it doesn't affect the queue
    listQueue("a").push("nope");
    expect(listQueue("a")).toEqual(["first", "second"]);
  });

  it("peeks without removing; dequeues FIFO and prunes when empty", () => {
    enqueuePrompt("a", "one");
    enqueuePrompt("a", "two");
    expect(peekPrompt("a")).toBe("one");
    expect(listQueue("a")).toHaveLength(2); // peek didn't remove
    expect(dequeuePrompt("a")).toBe("one");
    expect(dequeuePrompt("a")).toBe("two");
    expect(dequeuePrompt("a")).toBeNull();
    expect(peekPrompt("a")).toBeNull();
    expect(hasAnyQueued()).toBe(false); // pruned on empty
  });

  it("isolates queues per session", () => {
    enqueuePrompt("a", "for-a");
    enqueuePrompt("b", "for-b");
    expect(dequeuePrompt("a")).toBe("for-a");
    expect(listQueue("b")).toEqual(["for-b"]);
  });

  it("clear empties a session's queue", () => {
    enqueuePrompt("a", "x");
    clearQueue("a");
    expect(listQueue("a")).toEqual([]);
    expect(hasAnyQueued()).toBe(false);
  });

  it("hasAnyQueued reflects pending work", () => {
    expect(hasAnyQueued()).toBe(false);
    enqueuePrompt("a", "x");
    expect(hasAnyQueued()).toBe(true);
  });

  describe("removeAt", () => {
    it("drops the item at the index and returns the rest", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      enqueuePrompt("a", "three");
      expect(removeAt("a", 1)).toEqual(["one", "three"]);
      expect(listQueue("a")).toEqual(["one", "three"]);
    });

    it("is a no-op for an out-of-range index", () => {
      enqueuePrompt("a", "one");
      expect(removeAt("a", 5)).toEqual(["one"]);
      expect(removeAt("a", -1)).toEqual(["one"]);
      expect(listQueue("a")).toEqual(["one"]);
    });

    it("prunes the queue when the last item is removed", () => {
      enqueuePrompt("a", "only");
      expect(removeAt("a", 0)).toEqual([]);
      expect(hasAnyQueued()).toBe(false);
    });

    it("returns an empty array for an unknown session", () => {
      expect(removeAt("missing", 0)).toEqual([]);
    });
  });

  describe("moveUp", () => {
    it("swaps an item with the one before it", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      enqueuePrompt("a", "three");
      expect(moveUp("a", 2)).toEqual(["one", "three", "two"]);
      expect(moveUp("a", 1)).toEqual(["three", "one", "two"]);
      expect(listQueue("a")).toEqual(["three", "one", "two"]);
    });

    it("is a no-op for the first item", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      expect(moveUp("a", 0)).toEqual(["one", "two"]);
      expect(listQueue("a")).toEqual(["one", "two"]);
    });

    it("is a no-op for an out-of-range index or unknown session", () => {
      enqueuePrompt("a", "one");
      expect(moveUp("a", 9)).toEqual(["one"]);
      expect(moveUp("missing", 1)).toEqual([]);
    });
  });

  describe("moveDown", () => {
    it("swaps an item with the one after it", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      enqueuePrompt("a", "three");
      expect(moveDown("a", 0)).toEqual(["two", "one", "three"]);
      expect(moveDown("a", 1)).toEqual(["two", "three", "one"]);
      expect(listQueue("a")).toEqual(["two", "three", "one"]);
    });

    it("is a no-op for the last item", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      expect(moveDown("a", 1)).toEqual(["one", "two"]);
      expect(listQueue("a")).toEqual(["one", "two"]);
    });

    it("is a no-op for an out-of-range index or unknown session", () => {
      enqueuePrompt("a", "one");
      expect(moveDown("a", -1)).toEqual(["one"]);
      expect(moveDown("missing", 0)).toEqual([]);
    });
  });

  // The ticker dispatches item 0 mid-session, so a stale client can target the
  // wrong index. `expectedText` makes the op no-op when the queue shifted.
  describe("expectedText race guard", () => {
    it("removeAt no-ops (keeps the queue) when the text at index doesn't match", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      enqueuePrompt("a", "three");
      // Client thought index 1 was "two", but the queue shifted to [two, three].
      expect(removeAt("a", 1, "two")).toEqual(["one", "three"]); // matches → removes
      expect(removeAt("a", 0, "STALE")).toEqual(["one", "three"]); // mismatch → no-op
      expect(listQueue("a")).toEqual(["one", "three"]);
    });

    it("removeAt still removes when the text matches", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      expect(removeAt("a", 0, "one")).toEqual(["two"]);
    });

    it("moveUp / moveDown no-op on a text mismatch", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      expect(moveUp("a", 1, "STALE")).toEqual(["one", "two"]); // no swap
      expect(moveDown("a", 0, "STALE")).toEqual(["one", "two"]); // no swap
      expect(moveUp("a", 1, "two")).toEqual(["two", "one"]); // match → swaps
    });

    it("an absent expectedText (undefined) addresses purely by index, as before", () => {
      enqueuePrompt("a", "one");
      enqueuePrompt("a", "two");
      expect(removeAt("a", 0)).toEqual(["two"]);
    });
  });

  // Offline-replay idempotency (#12): a queued action replayed twice (its first POST
  // landed but the response was lost) must enqueue ONCE.
  describe("enqueuePromptIdempotent", () => {
    it("with no clientId, appends on every call (same as enqueuePrompt)", () => {
      enqueuePromptIdempotent("a", "x");
      enqueuePromptIdempotent("a", "x");
      expect(listQueue("a")).toEqual(["x", "x"]);
    });

    // NB: the seen-id set is process-global and not reset between tests, so each
    // test below uses its OWN clientIds (a real replay reuses an id by design).
    it("a duplicate clientId is a no-op (returns the queue unchanged)", () => {
      const first = enqueuePromptIdempotent("a", "hello", "cid-dup");
      expect(first).toEqual(["hello"]);
      const second = enqueuePromptIdempotent("a", "hello", "cid-dup"); // replay
      expect(second).toEqual(["hello"]); // not ["hello","hello"]
      expect(listQueue("a")).toEqual(["hello"]);
    });

    it("distinct clientIds each enqueue (two genuine sends, even same text)", () => {
      enqueuePromptIdempotent("a", "same", "cid-sendA");
      enqueuePromptIdempotent("a", "same", "cid-sendB");
      expect(listQueue("a")).toEqual(["same", "same"]);
    });

    it("dedupe is scoped PER SESSION — the same id in a different session still enqueues", () => {
      enqueuePromptIdempotent("a", "x", "cid-shared");
      // Same id, DIFFERENT session → a distinct (session,id) key → enqueues.
      enqueuePromptIdempotent("b", "x", "cid-shared");
      expect(listQueue("a")).toEqual(["x"]);
      expect(listQueue("b")).toEqual(["x"]);
      // But a replay within the SAME session is still a no-op.
      enqueuePromptIdempotent("a", "x", "cid-shared");
      expect(listQueue("a")).toEqual(["x"]);
    });

    it("ages ids out FIFO past the cap — a long-evicted id can enqueue again", () => {
      // Fill the ring with > cap distinct ids, then replay the very first: it was
      // evicted, so it appends again (the dedupe window is bounded by design).
      const firstId = "evict-0";
      enqueuePromptIdempotent("a", "first", firstId);
      for (let i = 1; i <= SEEN_CLIENT_IDS_MAX; i++) {
        enqueuePromptIdempotent("a", "x", `evict-${i}`);
      }
      const before = listQueue("a").length;
      enqueuePromptIdempotent("a", "first-again", firstId); // evicted → enqueues
      expect(listQueue("a").length).toBe(before + 1);
      // A still-recent id remains deduped.
      const recent = `evict-${SEEN_CLIENT_IDS_MAX}`;
      const len = listQueue("a").length;
      enqueuePromptIdempotent("a", "dupe", recent);
      expect(listQueue("a").length).toBe(len); // no-op
    });
  });
});
