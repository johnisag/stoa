/**
 * Offline command queue (#12). The pure replay POLICY (classify success/drop/retry,
 * attempt budget, queueable methods) and the replay ENGINE over an injected store +
 * fetch — exercised in Node with the in-memory store and a mock fetch, no browser.
 */
import { describe, it, expect, vi } from "vitest";
import {
  classifyReplay,
  exhausted,
  isReplayableUrl,
  drainQueue,
  MemoryOfflineQueueStore,
  OFFLINE_QUEUE_MAX_ATTEMPTS,
  type OfflineAction,
} from "@/lib/offline-queue";

function action(over: Partial<OfflineAction> = {}): OfflineAction {
  return {
    id: over.id ?? "id-1",
    url: "/api/sessions/s/queue",
    method: "POST",
    body: JSON.stringify({ text: "hi", clientId: over.id ?? "id-1" }),
    label: "hi",
    createdAt: over.createdAt ?? 1000,
    seq: over.seq ?? 0,
    attempts: over.attempts ?? 0,
    ...over,
  };
}

const resp = (status: number) => new Response(null, { status });

describe("classifyReplay", () => {
  it("2xx → success", () => {
    expect(classifyReplay({ ok: true, status: 200 })).toBe("success");
    expect(classifyReplay({ ok: true, status: 204 })).toBe("success");
  });
  it("a network error → retry (still offline / transient)", () => {
    expect(classifyReplay({ networkError: true })).toBe("retry");
  });
  it("408/429/5xx → retry (timeout, rate-limit, server-side)", () => {
    expect(classifyReplay({ ok: false, status: 408 })).toBe("retry");
    expect(classifyReplay({ ok: false, status: 429 })).toBe("retry");
    expect(classifyReplay({ ok: false, status: 500 })).toBe("retry");
    expect(classifyReplay({ ok: false, status: 503 })).toBe("retry");
  });
  it("other 4xx → drop (won't succeed on replay)", () => {
    expect(classifyReplay({ ok: false, status: 400 })).toBe("drop");
    expect(classifyReplay({ ok: false, status: 401 })).toBe("drop");
    expect(classifyReplay({ ok: false, status: 404 })).toBe("drop");
    expect(classifyReplay({ ok: false, status: 413 })).toBe("drop");
  });
});

describe("exhausted", () => {
  it("is true at the attempt cap", () => {
    expect(
      exhausted(action({ attempts: OFFLINE_QUEUE_MAX_ATTEMPTS - 1 }))
    ).toBe(false);
    expect(exhausted(action({ attempts: OFFLINE_QUEUE_MAX_ATTEMPTS }))).toBe(
      true
    );
  });
});

describe("isReplayableUrl", () => {
  it("accepts only same-origin root-relative paths", () => {
    expect(isReplayableUrl("/api/sessions/s/queue")).toBe(true);
    expect(isReplayableUrl("https://evil.com/x")).toBe(false); // absolute
    expect(isReplayableUrl("//evil.com/x")).toBe(false); // protocol-relative
    expect(isReplayableUrl("api/x")).toBe(false); // not rooted
  });
});

describe("drainQueue", () => {
  it("replays oldest-first and removes each on success", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "b", createdAt: 2000 }));
    await store.put(action({ id: "a", createdAt: 1000 }));
    const seen: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      void url;
      return resp(200);
    }) as unknown as typeof fetch;

    const res = await drainQueue(store, fetchMock, (act) => seen.push(act.id));
    expect(seen).toEqual(["a", "b"]); // FIFO by createdAt
    expect(res).toEqual({ sent: 2, dropped: 0, retried: 0 });
    expect(await store.getAll()).toEqual([]); // all removed
  });

  it("breaks createdAt ties by seq (same-millisecond sends keep send order)", async () => {
    const store = new MemoryOfflineQueueStore();
    // Same createdAt; inserted out of seq order — must replay in seq order.
    await store.put(action({ id: "second", createdAt: 1000, seq: 2 }));
    await store.put(action({ id: "first", createdAt: 1000, seq: 1 }));
    const seen: string[] = [];
    const fetchMock = vi.fn(async () => resp(200)) as unknown as typeof fetch;
    await drainQueue(store, fetchMock, (a) => seen.push(a.id));
    expect(seen).toEqual(["first", "second"]);
  });

  it("drops an action whose url is not same-origin (tampered/corrupted), without fetching", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "evil", url: "https://evil.com/steal" }));
    const fetchMock = vi.fn(async () => resp(200)) as unknown as typeof fetch;
    const res = await drainQueue(store, fetchMock);
    expect(res.dropped).toBe(1);
    expect(
      (fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls
    ).toHaveLength(0); // never fetched the off-origin URL
    expect(await store.getAll()).toEqual([]);
  });

  it("drops a stale 4xx and keeps draining", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "bad", createdAt: 1000 }));
    await store.put(action({ id: "good", createdAt: 2000 }));
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init;
      return resp(fetchMock.mock.calls.length === 1 ? 400 : 200);
    }) as unknown as typeof fetch & { mock: { calls: unknown[] } };

    const res = await drainQueue(store, fetchMock);
    expect(res.dropped).toBe(1);
    expect(res.sent).toBe(1);
    expect(await store.getAll()).toEqual([]);
  });

  it("on a server 5xx, bumps attempts and KEEPS the action (no early stop)", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "a", createdAt: 1000, attempts: 1 }));
    await store.put(action({ id: "b", createdAt: 2000, attempts: 0 }));
    const fetchMock = vi.fn(async () => resp(500)) as unknown as typeof fetch;

    const res = await drainQueue(store, fetchMock);
    expect(res.retried).toBe(2); // a 5xx is server-up, so it tries every action
    const kept = (await store.getAll()).sort(
      (x, y) => x.createdAt - y.createdAt
    );
    expect(kept.map((a) => [a.id, a.attempts])).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("on a NETWORK error, bumps the first then stops draining (still offline)", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "a", createdAt: 1000 }));
    await store.put(action({ id: "b", createdAt: 2000 }));
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;

    const res = await drainQueue(store, fetchMock);
    expect(res).toEqual({ sent: 0, dropped: 0, retried: 1 }); // only the first tried
    expect(
      (fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls
    ).toHaveLength(1);
    const kept = await store.getAll();
    expect(kept.map((a) => a.id)).toEqual(["a", "b"]); // both still queued
    expect(kept.find((a) => a.id === "a")!.attempts).toBe(1);
  });

  it("drops an action that exhausts its retry budget", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(
      action({ id: "a", attempts: OFFLINE_QUEUE_MAX_ATTEMPTS - 1 })
    );
    const fetchMock = vi.fn(async () => resp(503)) as unknown as typeof fetch;

    const res = await drainQueue(store, fetchMock);
    expect(res.dropped).toBe(1); // bumped to the cap → dropped, not kept
    expect(await store.getAll()).toEqual([]);
  });

  it("never throws when a store op fails — leaves that action queued, keeps going", async () => {
    const store = new MemoryOfflineQueueStore();
    await store.put(action({ id: "a", createdAt: 1000 }));
    await store.put(action({ id: "b", createdAt: 2000 }));
    // remove("a") blows up (e.g. an aborted IDB transaction); "b" must still send.
    const orig = store.remove.bind(store);
    store.remove = async (id: string) => {
      if (id === "a") throw new Error("tx aborted");
      return orig(id);
    };
    const fetchMock = vi.fn(async () => resp(200)) as unknown as typeof fetch;

    const res = await drainQueue(store, fetchMock); // must not reject
    expect(res.sent).toBe(1); // only "b" counted (a's remove failed → not counted)
    const kept = await store.getAll();
    expect(kept.map((x) => x.id)).toEqual(["a"]); // "a" stays queued for next time
  });

  it("is a no-op on an empty store", async () => {
    const store = new MemoryOfflineQueueStore();
    const fetchMock = vi.fn() as unknown as typeof fetch;
    expect(await drainQueue(store, fetchMock)).toEqual({
      sent: 0,
      dropped: 0,
      retried: 0,
    });
    expect(
      (fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls
    ).toHaveLength(0);
  });
});
