import { describe, it, expect } from "vitest";
import {
  RECENTS_CAP,
  RECENTS_KEY,
  PINS_KEY,
  getRecents,
  recordRecent,
  getPins,
  togglePin,
  rankWithRecents,
  type PaletteStorage,
} from "@/lib/palette-recents";
import { fuzzyScore } from "@/lib/session-search";

// In-memory stand-in for localStorage so the helpers are testable on all OSes
// without a DOM. Matches the slice of Storage the helpers actually call.
function mockStorage(initial: Record<string, string> = {}): PaletteStorage & {
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

describe("recordRecent / getRecents", () => {
  it("returns an empty list when nothing is stored", () => {
    expect(getRecents(mockStorage())).toEqual([]);
  });

  it("records selections MRU-first and persists them", () => {
    const s = mockStorage();
    recordRecent(s, "a");
    recordRecent(s, "b");
    const list = recordRecent(s, "c");
    expect(list).toEqual(["c", "b", "a"]);
    expect(getRecents(s)).toEqual(["c", "b", "a"]);
  });

  it("dedupes a re-selected id (moves it to the front, no double entry)", () => {
    const s = mockStorage();
    recordRecent(s, "a");
    recordRecent(s, "b");
    expect(recordRecent(s, "a")).toEqual(["a", "b"]);
  });

  it("caps the list at RECENTS_CAP, dropping the oldest", () => {
    const s = mockStorage();
    for (let i = 0; i < RECENTS_CAP + 5; i++) recordRecent(s, `id${i}`);
    const list = getRecents(s);
    expect(list.length).toBe(RECENTS_CAP);
    expect(list[0]).toBe(`id${RECENTS_CAP + 4}`); // newest kept
    expect(list).not.toContain("id0"); // oldest dropped
  });

  it("honors a custom cap", () => {
    const s = mockStorage();
    recordRecent(s, "a", 2);
    recordRecent(s, "b", 2);
    expect(recordRecent(s, "c", 2)).toEqual(["c", "b"]);
  });

  it("ignores a blank id", () => {
    const s = mockStorage();
    recordRecent(s, "a");
    expect(recordRecent(s, "")).toEqual(["a"]);
    expect(getRecents(s)).toEqual(["a"]);
  });

  it("degrades to empty on corrupt or wrong-shaped JSON (never throws)", () => {
    expect(getRecents(mockStorage({ [RECENTS_KEY]: "{" }))).toEqual([]);
    expect(getRecents(mockStorage({ [RECENTS_KEY]: '{"x":1}' }))).toEqual([]);
    expect(getRecents(mockStorage({ [RECENTS_KEY]: "42" }))).toEqual([]);
    // Recording on top of a corrupt value starts fresh instead of throwing.
    const s = mockStorage({ [RECENTS_KEY]: "not json" });
    expect(recordRecent(s, "a")).toEqual(["a"]);
  });

  it("drops non-string entries from a hand-edited value", () => {
    const s = mockStorage({ [RECENTS_KEY]: JSON.stringify(["a", 5, null]) });
    expect(getRecents(s)).toEqual(["a"]);
  });

  it("does not throw when storage access fails", () => {
    const failing: PaletteStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    // Returned list still reflects the push even though the write failed.
    expect(recordRecent(failing, "a")).toEqual(["a"]);
    expect(getRecents(failing)).toEqual([]);
  });
});

describe("togglePin / getPins", () => {
  it("pins, then unpins, persisting each state", () => {
    const s = mockStorage();
    expect(togglePin(s, "a")).toEqual(["a"]);
    expect(togglePin(s, "b")).toEqual(["a", "b"]);
    expect(getPins(s)).toEqual(["a", "b"]);
    expect(togglePin(s, "a")).toEqual(["b"]); // toggle off
    expect(getPins(s)).toEqual(["b"]);
  });

  it("keeps pins and recents in independent keys", () => {
    const s = mockStorage();
    recordRecent(s, "r1");
    togglePin(s, "p1");
    expect(getRecents(s)).toEqual(["r1"]);
    expect(getPins(s)).toEqual(["p1"]);
    expect(s.store[RECENTS_KEY]).toBeDefined();
    expect(s.store[PINS_KEY]).toBeDefined();
  });

  it("degrades to empty on corrupt JSON and still toggles (never throws)", () => {
    const s = mockStorage({ [PINS_KEY]: "[[[" });
    expect(getPins(s)).toEqual([]);
    expect(togglePin(s, "a")).toEqual(["a"]);
  });

  it("does not throw when storage write fails", () => {
    const failing: PaletteStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(togglePin(failing, "a")).toEqual(["a"]);
  });
});

describe("rankWithRecents", () => {
  const items = [
    { id: "s1", name: "alpha" },
    { id: "s2", name: "beta" },
    { id: "s3", name: "gamma" },
    { id: "s4", name: "delta" },
  ];

  it("returns input order untouched with no recents and no pins", () => {
    expect(rankWithRecents(items, [], []).map((x) => x.id)).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("floats recents up in MRU order, rest keep input order", () => {
    const ranked = rankWithRecents(items, ["s3", "s2"], []);
    expect(ranked.map((x) => x.id)).toEqual(["s3", "s2", "s1", "s4"]);
  });

  it("sorts pinned first, then recents, then the rest", () => {
    const ranked = rankWithRecents(items, ["s3"], ["s4"]);
    expect(ranked.map((x) => x.id)).toEqual(["s4", "s3", "s1", "s2"]);
  });

  it("orders within the pinned group by MRU then input order", () => {
    // s2 and s4 are both pinned; s4 was used more recently, so it leads.
    const ranked = rankWithRecents(items, ["s4"], ["s2", "s4"]);
    expect(ranked.map((x) => x.id)).toEqual(["s4", "s2", "s1", "s3"]);
  });

  it("ignores stale ids pointing at sessions no longer in the list", () => {
    const ranked = rankWithRecents(items, ["gone1", "s2"], ["gone2"]);
    expect(ranked.map((x) => x.id)).toEqual(["s2", "s1", "s3", "s4"]);
  });

  it("does not mutate the input array", () => {
    const input = [...items];
    rankWithRecents(input, ["s3"], ["s4"]);
    expect(input).toEqual(items);
  });

  it("QUERY ACTIVE: fuzzy score stays king — pins/recents do not reorder", () => {
    // "beta" is the tight match for query "bet"; even though s3/s4 are pinned
    // and recent, the scored order must win.
    const scoreFn = (item: { id: string; name: string }) =>
      fuzzyScore("bet", item.name);
    const ranked = rankWithRecents(items, ["s4", "s3"], ["s3"], scoreFn);
    expect(ranked[0].id).toBe("s2");
  });

  it("QUERY ACTIVE: an already-fuzzy-ranked list passes through unchanged", () => {
    // Pre-sorted best-first (as searchSessions returns); a stable re-sort by
    // the same score must be an order-preserving no-op, ties included.
    const presorted = [
      { id: "a", score: 10 },
      { id: "b", score: 5 },
      { id: "c", score: 5 },
      { id: "d", score: 1 },
    ];
    const ranked = rankWithRecents(
      presorted,
      ["d", "c"], // recents would reorder if they (wrongly) applied
      ["d"],
      (item) => item.score
    );
    expect(ranked.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("QUERY ACTIVE: null scores rank last, keeping their relative order", () => {
    const ranked = rankWithRecents(
      [
        { id: "x", score: null },
        { id: "y", score: 3 },
        { id: "z", score: null },
      ],
      [],
      [],
      (item) => item.score
    );
    expect(ranked.map((x) => x.id)).toEqual(["y", "x", "z"]);
  });
});
