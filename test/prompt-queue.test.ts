import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueuePrompt,
  listQueue,
  peekPrompt,
  dequeuePrompt,
  clearQueue,
  hasAnyQueued,
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
});
