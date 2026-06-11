import { describe, it, expect } from "vitest";
import {
  viewedStorageKey,
  getViewedFiles,
  isFileViewed,
  toggleFileViewed,
  type ViewedStorage,
} from "@/lib/diff-viewed";

// In-memory stand-in for localStorage so the helpers are testable on all OSes
// without a DOM. Matches the slice of Storage the helpers actually call.
function mockStorage(initial: Record<string, string> = {}): ViewedStorage & {
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

describe("viewedStorageKey", () => {
  it("namespaces by session id", () => {
    expect(viewedStorageKey("abc")).toBe("stoa-diff-viewed:abc");
    expect(viewedStorageKey("s1")).not.toBe(viewedStorageKey("s2"));
  });
});

describe("getViewedFiles", () => {
  it("returns an empty set when nothing is stored", () => {
    expect(getViewedFiles(mockStorage(), "s1").size).toBe(0);
  });

  it("reads back a previously stored array", () => {
    const s = mockStorage({
      [viewedStorageKey("s1")]: JSON.stringify(["a.ts", "b/c.ts"]),
    });
    const set = getViewedFiles(s, "s1");
    expect(set.has("a.ts")).toBe(true);
    expect(set.has("b/c.ts")).toBe(true);
    expect(set.size).toBe(2);
  });

  it("falls back to empty on corrupt or wrong-shaped JSON", () => {
    expect(
      getViewedFiles(mockStorage({ [viewedStorageKey("s1")]: "{" }), "s1").size
    ).toBe(0);
    expect(
      getViewedFiles(mockStorage({ [viewedStorageKey("s1")]: '{"x":1}' }), "s1")
        .size
    ).toBe(0);
  });

  it("drops non-string entries from a hand-edited value", () => {
    const s = mockStorage({
      [viewedStorageKey("s1")]: JSON.stringify(["a.ts", 5, null]),
    });
    const set = getViewedFiles(s, "s1");
    expect([...set]).toEqual(["a.ts"]);
  });
});

describe("toggleFileViewed", () => {
  it("adds a path on first toggle and persists it", () => {
    const s = mockStorage();
    const set = toggleFileViewed(s, "s1", "a.ts");
    expect(set.has("a.ts")).toBe(true);
    // Persisted under the session key.
    expect(JSON.parse(s.store[viewedStorageKey("s1")])).toEqual(["a.ts"]);
    // A fresh read sees it too.
    expect(isFileViewed(s, "s1", "a.ts")).toBe(true);
  });

  it("removes a path on second toggle", () => {
    const s = mockStorage();
    toggleFileViewed(s, "s1", "a.ts");
    const set = toggleFileViewed(s, "s1", "a.ts");
    expect(set.has("a.ts")).toBe(false);
    expect(isFileViewed(s, "s1", "a.ts")).toBe(false);
    expect(JSON.parse(s.store[viewedStorageKey("s1")])).toEqual([]);
  });

  it("keeps sessions independent", () => {
    const s = mockStorage();
    toggleFileViewed(s, "s1", "a.ts");
    expect(isFileViewed(s, "s2", "a.ts")).toBe(false);
    expect(isFileViewed(s, "s1", "a.ts")).toBe(true);
  });

  it("does not throw when storage write fails", () => {
    const failing: ViewedStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    // Returned set still reflects the intended toggle even though the write failed.
    const set = toggleFileViewed(failing, "s1", "a.ts");
    expect(set.has("a.ts")).toBe(true);
  });
});
