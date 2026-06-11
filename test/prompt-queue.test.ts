import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueuePrompt,
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
});
