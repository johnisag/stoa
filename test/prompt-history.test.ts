import { describe, it, expect } from "vitest";
import {
  HISTORY_CAP,
  historyStorageKey,
  addToHistory,
  searchHistory,
  getHistory,
  recordPrompt,
  type HistoryStorage,
} from "@/lib/prompt-history";

// In-memory stand-in for localStorage so the helpers are testable on all OSes
// without a DOM. Matches the slice of Storage the helpers actually call.
function mockStorage(initial: Record<string, string> = {}): HistoryStorage & {
  store: Record<string, string>;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
  };
}

describe("historyStorageKey", () => {
  it("namespaces by session id", () => {
    expect(historyStorageKey("abc")).toBe("stoa-prompt-history:abc");
    expect(historyStorageKey("s1")).not.toBe(historyStorageKey("s2"));
  });
});

describe("addToHistory", () => {
  it("pushes onto the front, newest-first", () => {
    let h: string[] = [];
    h = addToHistory(h, "first");
    h = addToHistory(h, "second");
    expect(h).toEqual(["second", "first"]);
  });

  it("caps a giant entry so it can't blow the storage quota", () => {
    const huge = "x".repeat(50_000);
    const [stored] = addToHistory([], huge);
    expect(stored.length).toBe(4000); // MAX_ENTRY_CHARS
  });

  it("trims and ignores a blank/whitespace-only prompt", () => {
    const h = ["a"];
    expect(addToHistory(h, "   ")).toBe(h); // same reference, unchanged
    expect(addToHistory(h, "")).toBe(h);
    expect(addToHistory([], "  hi  ")).toEqual(["hi"]); // trimmed on the way in
  });

  it("collapses a consecutive duplicate of the newest entry", () => {
    let h = addToHistory([], "build it");
    h = addToHistory(h, "build it"); // re-fire the same prompt
    expect(h).toEqual(["build it"]);
    // A non-consecutive repeat is allowed (it moved to the front).
    h = addToHistory(h, "other");
    h = addToHistory(h, "build it");
    expect(h).toEqual(["build it", "other", "build it"]);
  });

  it("does not mutate the input array", () => {
    const input = ["a", "b"];
    const snapshot = [...input];
    addToHistory(input, "c");
    expect(input).toEqual(snapshot);
  });

  it("caps the list newest-first, dropping the oldest", () => {
    let h: string[] = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) h = addToHistory(h, `p${i}`);
    expect(h.length).toBe(HISTORY_CAP);
    expect(h[0]).toBe(`p${HISTORY_CAP + 4}`); // newest kept
    expect(h).not.toContain("p0"); // oldest dropped
  });

  it("honors a custom cap", () => {
    let h: string[] = [];
    for (let i = 0; i < 5; i++) h = addToHistory(h, `p${i}`, 2);
    expect(h).toEqual(["p4", "p3"]);
  });
});

describe("searchHistory", () => {
  const list = ["fix the build", "add a login form", "refactor the parser"];

  it("returns the list unchanged for an empty/whitespace query", () => {
    expect(searchHistory(list, "")).toEqual(list);
    expect(searchHistory(list, "   ")).toEqual(list);
    // It's a copy, not the same reference (callers may hold it in state).
    expect(searchHistory(list, "")).not.toBe(list);
  });

  it("fuzzy-filters and drops non-matches", () => {
    const r = searchHistory(list, "login");
    expect(r).toEqual(["add a login form"]);
    expect(searchHistory(list, "zzzzz")).toEqual([]);
  });

  it("ranks the best match first", () => {
    // "build" is a tight contiguous run in the first entry; it should win.
    expect(searchHistory(list, "build")[0]).toBe("fix the build");
  });

  it("keeps original order for equal-scoring ties (stable, newest-first)", () => {
    const dupes = ["alpha one", "alpha two", "alpha three"];
    // "alpha" scores identically in all three; the input (newest-first) order holds.
    expect(searchHistory(dupes, "alpha")).toEqual(dupes);
  });
});

describe("getHistory / recordPrompt", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(getHistory(mockStorage(), "s1")).toEqual([]);
  });

  it("records a prompt and reads it back, newest-first", () => {
    const s = mockStorage();
    recordPrompt(s, "s1", "first");
    const list = recordPrompt(s, "s1", "second");
    expect(list).toEqual(["second", "first"]);
    expect(getHistory(s, "s1")).toEqual(["second", "first"]);
  });

  it("does not record a blank prompt", () => {
    const s = mockStorage();
    expect(recordPrompt(s, "s1", "   ")).toEqual([]);
    expect(getHistory(s, "s1")).toEqual([]);
  });

  it("collapses a consecutive duplicate across persisted reads", () => {
    const s = mockStorage();
    recordPrompt(s, "s1", "build it");
    expect(recordPrompt(s, "s1", "build it")).toEqual(["build it"]);
  });

  it("keeps sessions independent", () => {
    const s = mockStorage();
    recordPrompt(s, "s1", "a");
    expect(getHistory(s, "s2")).toEqual([]);
    expect(getHistory(s, "s1")).toEqual(["a"]);
  });

  it("falls back to empty on corrupt or wrong-shaped JSON", () => {
    expect(
      getHistory(mockStorage({ [historyStorageKey("s1")]: "{" }), "s1")
    ).toEqual([]);
    expect(
      getHistory(mockStorage({ [historyStorageKey("s1")]: '{"x":1}' }), "s1")
    ).toEqual([]);
  });

  it("drops non-string entries from a hand-edited value", () => {
    const s = mockStorage({
      [historyStorageKey("s1")]: JSON.stringify(["a", 5, null]),
    });
    expect(getHistory(s, "s1")).toEqual(["a"]);
  });

  it("does not throw when storage write fails", () => {
    const failing: HistoryStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    // Returned list still reflects the push even though the write failed.
    expect(recordPrompt(failing, "s1", "hi")).toEqual(["hi"]);
  });
});
