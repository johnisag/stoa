import { describe, it, expect, afterEach } from "vitest";
import {
  createStatGatedCache,
  transcriptCacheEnabled,
  type StatGatedIO,
} from "@/lib/transcript-cache";

// A fake filesystem: a mutable stat + a load that count their calls, so we can
// assert exactly when the cache re-reads vs serves. No real I/O — runs on all OSes.
function fakeIO() {
  const files = new Map<
    string,
    { mtimeMs: number; size: number; value: string }
  >();
  const calls = { stat: 0, load: 0 };
  const io: StatGatedIO<string> = {
    async stat(path) {
      calls.stat++;
      const f = files.get(path);
      return f ? { mtimeMs: f.mtimeMs, size: f.size } : null;
    },
    async load(path) {
      calls.load++;
      const f = files.get(path);
      return f ? f.value : null;
    },
  };
  return { files, calls, io };
}

describe("createStatGatedCache", () => {
  it("loads on the first get, then serves from cache while stat is unchanged", async () => {
    const { files, calls, io } = fakeIO();
    files.set("/t.jsonl", { mtimeMs: 1, size: 10, value: "A" });
    const cache = createStatGatedCache<string>();

    expect(await cache.get("/t.jsonl", io)).toBe("A");
    expect(await cache.get("/t.jsonl", io)).toBe("A");
    expect(calls.load).toBe(1); // second get is a HIT — no re-load/parse
    expect(calls.stat).toBe(2); // but always re-stats (cheap) to validate freshness
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it("invalidates when SIZE grows (an append)", async () => {
    const { files, calls, io } = fakeIO();
    files.set("/t.jsonl", { mtimeMs: 1, size: 10, value: "A" });
    const cache = createStatGatedCache<string>();
    await cache.get("/t.jsonl", io);
    files.set("/t.jsonl", { mtimeMs: 1, size: 20, value: "B" }); // grew, same mtime
    expect(await cache.get("/t.jsonl", io)).toBe("B");
    expect(calls.load).toBe(2);
  });

  it("invalidates when SIZE SHRINKS (a /compact truncation) even at the same mtime", async () => {
    const { files, calls, io } = fakeIO();
    files.set("/t.jsonl", { mtimeMs: 5, size: 100, value: "BIG" });
    const cache = createStatGatedCache<string>();
    await cache.get("/t.jsonl", io);
    files.set("/t.jsonl", { mtimeMs: 5, size: 12, value: "small" }); // truncated
    expect(await cache.get("/t.jsonl", io)).toBe("small");
    expect(calls.load).toBe(2);
  });

  it("invalidates when MTIME changes at the same size", async () => {
    const { files, calls, io } = fakeIO();
    files.set("/t.jsonl", { mtimeMs: 1, size: 10, value: "A" });
    const cache = createStatGatedCache<string>();
    await cache.get("/t.jsonl", io);
    files.set("/t.jsonl", { mtimeMs: 2, size: 10, value: "B" });
    expect(await cache.get("/t.jsonl", io)).toBe("B");
    expect(calls.load).toBe(2);
  });

  it("returns null and forgets the entry when the file disappears", async () => {
    const { files, io } = fakeIO();
    files.set("/t.jsonl", { mtimeMs: 1, size: 10, value: "A" });
    const cache = createStatGatedCache<string>();
    await cache.get("/t.jsonl", io);
    expect(cache.stats().size).toBe(1);
    files.delete("/t.jsonl"); // stat → null
    expect(await cache.get("/t.jsonl", io)).toBeNull();
    expect(cache.stats().size).toBe(0); // stale entry evicted
  });

  it("never caches a null load (present but unreadable → retried each time)", async () => {
    let loadCalls = 0;
    const io: StatGatedIO<string> = {
      stat: async () => ({ mtimeMs: 1, size: 10 }),
      load: async () => {
        loadCalls++;
        return null;
      },
    };
    const cache = createStatGatedCache<string>();
    expect(await cache.get("/x", io)).toBeNull();
    expect(await cache.get("/x", io)).toBeNull();
    expect(cache.stats().size).toBe(0);
    expect(loadCalls).toBe(2);
  });

  it("LRU-evicts the least-recently-used beyond max; a hit refreshes recency", async () => {
    const { files, io } = fakeIO();
    for (const p of ["/a", "/b", "/c"])
      files.set(p, { mtimeMs: 1, size: 1, value: p });
    const cache = createStatGatedCache<string>({ max: 2 });
    await cache.get("/a", io); // [a]
    await cache.get("/b", io); // [a,b]
    await cache.get("/a", io); // HIT → touch → [b,a]
    await cache.get("/c", io); // insert c → evict oldest (b) → [a,c]
    expect(cache.stats().size).toBe(2);

    const missesBefore = cache.stats().misses;
    await cache.get("/a", io); // still cached (was touched) → hit
    await cache.get("/b", io); // was evicted → miss + reload
    expect(cache.stats().misses).toBe(missesBefore + 1);
  });

  it("invalidate() drops one entry; reset() clears everything + counters", async () => {
    const { files, io } = fakeIO();
    files.set("/a", { mtimeMs: 1, size: 1, value: "A" });
    const cache = createStatGatedCache<string>();
    await cache.get("/a", io);
    cache.invalidate("/a");
    expect(cache.stats().size).toBe(0);
    await cache.get("/a", io);
    cache.reset();
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0 });
  });

  it("coalesces concurrent misses on the same path into ONE load", async () => {
    let loadCalls = 0;
    let release: () => void = () => {};
    const io: StatGatedIO<string> = {
      stat: async () => ({ mtimeMs: 1, size: 1 }),
      load: () => {
        loadCalls++;
        return new Promise<string>((r) => {
          release = () => r("V");
        });
      },
    };
    const cache = createStatGatedCache<string>();
    const a = cache.get("/p", io);
    const b = cache.get("/p", io);
    // Let both gets reach the load/join point, then resolve the single in-flight read.
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await a).toBe("V");
    expect(await b).toBe("V");
    expect(loadCalls).toBe(1); // single-flight — one read despite two callers
    expect(cache.stats().misses).toBe(1); // counted once, not twice
  });

  it("a floor of max=1 still works (never grows past one entry)", async () => {
    const { files, io } = fakeIO();
    for (const p of ["/a", "/b"])
      files.set(p, { mtimeMs: 1, size: 1, value: p });
    const cache = createStatGatedCache<string>({ max: 0 }); // clamped to 1
    await cache.get("/a", io);
    await cache.get("/b", io);
    expect(cache.stats().size).toBe(1);
  });
});

describe("transcriptCacheEnabled", () => {
  const prev = process.env.STOA_TRANSCRIPT_CACHE;
  afterEach(() => {
    if (prev === undefined) delete process.env.STOA_TRANSCRIPT_CACHE;
    else process.env.STOA_TRANSCRIPT_CACHE = prev;
  });
  it("is on by default and off only for =0", () => {
    delete process.env.STOA_TRANSCRIPT_CACHE;
    expect(transcriptCacheEnabled()).toBe(true);
    process.env.STOA_TRANSCRIPT_CACHE = "1";
    expect(transcriptCacheEnabled()).toBe(true);
    process.env.STOA_TRANSCRIPT_CACHE = "0";
    expect(transcriptCacheEnabled()).toBe(false);
  });
});
