import { describe, it, expect } from "vitest";
import {
  SNIPPETS_STORAGE_KEY,
  DEFAULT_SNIPPETS,
  getStoredSnippets,
  saveSnippets,
  addSnippet,
  removeSnippet,
  type SnippetStorage,
  type Snippet,
} from "@/lib/snippets";

// In-memory stand-in for localStorage so the helpers are testable on all OSes
// without a DOM. Matches the slice of Storage the helpers actually call.
function mockStorage(initial: Record<string, string> = {}): SnippetStorage & {
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

describe("getStoredSnippets", () => {
  it("seeds and persists the defaults on the first read", () => {
    const s = mockStorage();
    const snippets = getStoredSnippets(s);
    expect(snippets).toEqual(DEFAULT_SNIPPETS);
    expect(JSON.parse(s.store[SNIPPETS_STORAGE_KEY])).toEqual(DEFAULT_SNIPPETS);
  });

  it("reads back a previously stored list", () => {
    const saved: Snippet[] = [{ id: "1", name: "Hi", content: "hello" }];
    const s = mockStorage({ [SNIPPETS_STORAGE_KEY]: JSON.stringify(saved) });
    expect(getStoredSnippets(s)).toEqual(saved);
  });

  it("falls back to the defaults on corrupt or wrong-shaped JSON", () => {
    expect(
      getStoredSnippets(mockStorage({ [SNIPPETS_STORAGE_KEY]: "{" }))
    ).toEqual(DEFAULT_SNIPPETS);
    expect(
      getStoredSnippets(mockStorage({ [SNIPPETS_STORAGE_KEY]: '{"x":1}' }))
    ).toEqual(DEFAULT_SNIPPETS);
  });

  it("drops malformed entries from a hand-edited list", () => {
    const s = mockStorage({
      [SNIPPETS_STORAGE_KEY]: JSON.stringify([
        { id: "1", name: "ok", content: "good" },
        { id: "2", name: "missing content" },
        "not an object",
        null,
      ]),
    });
    expect(getStoredSnippets(s)).toEqual([
      { id: "1", name: "ok", content: "good" },
    ]);
  });
});

describe("addSnippet", () => {
  it("appends a trimmed snippet and persists it", () => {
    const s = mockStorage();
    const next = addSnippet(s, [], "  Build  ", "  npm run build  ");
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe("Build");
    expect(next[0].content).toBe("npm run build");
    expect(JSON.parse(s.store[SNIPPETS_STORAGE_KEY])).toEqual(next);
  });

  it("rejects a blank name or content without mutating the list", () => {
    const s = mockStorage();
    const start: Snippet[] = [{ id: "1", name: "Hi", content: "hello" }];
    expect(addSnippet(s, start, "   ", "x")).toBe(start);
    expect(addSnippet(s, start, "x", "   ")).toBe(start);
  });
});

describe("removeSnippet", () => {
  it("removes by id and persists the remainder", () => {
    const s = mockStorage();
    const start: Snippet[] = [
      { id: "1", name: "a", content: "a" },
      { id: "2", name: "b", content: "b" },
    ];
    const next = removeSnippet(s, start, "1");
    expect(next).toEqual([{ id: "2", name: "b", content: "b" }]);
    expect(JSON.parse(s.store[SNIPPETS_STORAGE_KEY])).toEqual(next);
  });
});

describe("saveSnippets", () => {
  it("does not throw when the storage write fails", () => {
    const failing: SnippetStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => saveSnippets(failing, DEFAULT_SNIPPETS)).not.toThrow();
    expect(addSnippet(failing, [], "Build", "npm run build")).toHaveLength(1);
  });
});

describe("storage key", () => {
  it("is the same shared key the mobile toolbar used (do not fork)", () => {
    expect(SNIPPETS_STORAGE_KEY).toBe("terminal-snippets");
  });
});
