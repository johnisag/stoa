// @vitest-environment jsdom
/**
 * #39 Screen Wake Lock (hooks/useWakeLock.ts).
 *
 * Three layers, matching the hook's structure:
 * 1. `decideWakeLock` — the full pure decision matrix.
 * 2. `createWakeLockController` — request/release mechanics against an
 *    INJECTED plain-object wake-lock API (feature detection, swallowed
 *    NotAllowedError, the in-flight-flip race, UA auto-release tracking).
 * 3. `useWakeLock` — renderHook wiring with a mocked `navigator.wakeLock`
 *    (mount/unmount, active flips, visibilitychange re-acquire, and the
 *    no-API silent no-op).
 *
 * No real Wake Lock API anywhere — everything is plain objects, so this runs
 * identically on all three OSes.
 */
import { describe, it, expect, vi, afterEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  decideWakeLock,
  createWakeLockController,
  useWakeLock,
  type WakeLockApiLike,
  type WakeLockDecision,
  type WakeLockSentinelLike,
} from "@/hooks/useWakeLock";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface FakeSentinel extends WakeLockSentinelLike {
  release: Mock<() => Promise<void>>;
  /** Simulate the UA auto-releasing the lock (tab hidden, battery saver). */
  fireRelease: () => void;
}

function makeSentinel(opts?: { releaseRejects?: boolean }): FakeSentinel {
  const listeners: Array<() => void> = [];
  return {
    release: vi.fn(() =>
      opts?.releaseRejects
        ? Promise.reject(new Error("already released"))
        : Promise.resolve()
    ),
    addEventListener: (_type: "release", listener: () => void) => {
      listeners.push(listener);
    },
    fireRelease: () => {
      for (const l of listeners) l();
    },
  };
}

function makeApi() {
  const sentinels: FakeSentinel[] = [];
  const request: Mock<(type: "screen") => Promise<WakeLockSentinelLike>> =
    vi.fn(async (_type: "screen") => {
      const s = makeSentinel();
      sentinels.push(s);
      return s;
    });
  const api: WakeLockApiLike = { request };
  return { api, sentinels, request };
}

/** Drain the microtask queue (the controller resolves in a few ticks). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// 1. decideWakeLock — the pure matrix
// ---------------------------------------------------------------------------

describe("decideWakeLock", () => {
  const matrix: Array<
    [active: boolean, visible: boolean, hasLock: boolean, WakeLockDecision]
  > = [
    // watching + visible → we want the lock
    [true, true, false, "acquire"],
    [true, true, true, "hold"],
    // hidden tab → never hold a lock (the UA drops it anyway; stay in sync)
    [true, false, true, "release"],
    [true, false, false, "hold"],
    // not watching → never hold a lock
    [false, true, true, "release"],
    [false, true, false, "hold"],
    [false, false, true, "release"],
    [false, false, false, "hold"],
  ];

  it.each(matrix)(
    "active=%s visible=%s hasLock=%s → %s",
    (active, visible, hasLock, expected) => {
      expect(decideWakeLock({ active, visible, hasLock })).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 2. createWakeLockController — mechanics with an injected API
// ---------------------------------------------------------------------------

describe("createWakeLockController", () => {
  it("acquires a screen lock when active and visible", async () => {
    const { api, request } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("screen");
    expect(c.hasLock()).toBe(true);
  });

  it("holds (no duplicate request) when already locked", async () => {
    const { api, request } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    await c.sync(true, true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(c.hasLock()).toBe(true);
  });

  it("releases when no longer active", async () => {
    const { api, sentinels } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    await c.sync(false, true);
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(c.hasLock()).toBe(false);
  });

  it("releases when the document goes hidden", async () => {
    const { api, sentinels } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    await c.sync(true, false);
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(c.hasLock()).toBe(false);
  });

  it("is a silent no-op without the API (feature detection)", async () => {
    const c = createWakeLockController(() => undefined);
    await expect(c.sync(true, true)).resolves.toBeUndefined();
    expect(c.hasLock()).toBe(false);
    await expect(c.sync(false, false)).resolves.toBeUndefined();
  });

  it("swallows a throwing wakeLock getter", async () => {
    const c = createWakeLockController(() => {
      throw new Error("cross-origin navigator");
    });
    await expect(c.sync(true, true)).resolves.toBeUndefined();
    expect(c.hasLock()).toBe(false);
  });

  it("swallows request() rejection (NotAllowedError on battery saver)", async () => {
    const err = new DOMException("battery saver", "NotAllowedError");
    const api: WakeLockApiLike = {
      request: vi.fn(() => Promise.reject(err)),
    };
    const c = createWakeLockController(() => api);
    await expect(c.sync(true, true)).resolves.toBeUndefined();
    expect(c.hasLock()).toBe(false);
    // ...and the queue is not wedged: a later sync still tries again.
    await c.sync(true, true);
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("swallows release() rejection", async () => {
    const sentinel = makeSentinel({ releaseRejects: true });
    const api: WakeLockApiLike = {
      request: vi.fn(async (_type: "screen") => sentinel),
    };
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    await expect(c.sync(false, false)).resolves.toBeUndefined();
    expect(c.hasLock()).toBe(false);
  });

  it("re-acquires after the UA auto-releases the sentinel", async () => {
    const { api, sentinels, request } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true);
    expect(c.hasLock()).toBe(true);
    // UA drops the lock (e.g. battery saver kicked in) — sentinel fires
    // "release" without us calling release().
    sentinels[0].fireRelease();
    expect(c.hasLock()).toBe(false);
    // The next sync (e.g. visibilitychange) re-acquires instead of "holding".
    await c.sync(true, true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(c.hasLock()).toBe(true);
  });

  it("drops a sentinel that resolves AFTER the state flipped inactive (in-flight race)", async () => {
    const sentinel = makeSentinel();
    let resolveRequest: (s: WakeLockSentinelLike) => void = () => {};
    const api: WakeLockApiLike = {
      request: vi.fn(
        () =>
          new Promise<WakeLockSentinelLike>((resolve) => {
            resolveRequest = resolve;
          })
      ),
    };
    const c = createWakeLockController(() => api);
    const first = c.sync(true, true); // request now in flight
    await flush();
    const second = c.sync(false, false); // flips inactive before it resolves
    resolveRequest(sentinel);
    await first;
    await second;
    // The late sentinel must be released immediately, never kept.
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    expect(c.hasLock()).toBe(false);
  });

  it("ignores a STALE sentinel's release event after a newer lock exists", async () => {
    const { api, sentinels } = makeApi();
    const c = createWakeLockController(() => api);
    await c.sync(true, true); // sentinel #1
    await c.sync(false, false); // released
    await c.sync(true, true); // sentinel #2
    expect(sentinels).toHaveLength(2);
    // A late "release" event from the OLD sentinel must not clobber the new lock.
    sentinels[0].fireRelease();
    expect(c.hasLock()).toBe(true);
  });

  it("tolerates a sentinel without addEventListener (older impls)", async () => {
    const api: WakeLockApiLike = {
      request: vi.fn(async (_type: "screen") => ({
        release: () => Promise.resolve(),
      })),
    };
    const c = createWakeLockController(() => api);
    await expect(c.sync(true, true)).resolves.toBeUndefined();
    expect(c.hasLock()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. useWakeLock — hook wiring with a mocked navigator.wakeLock
// ---------------------------------------------------------------------------

describe("useWakeLock (hook wiring)", () => {
  function installWakeLock() {
    const fake = makeApi();
    Object.defineProperty(navigator, "wakeLock", {
      value: fake.api,
      configurable: true,
    });
    return fake;
  }

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    // Restore jsdom's own prototype accessors.
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    delete (document as { visibilityState?: unknown }).visibilityState;
  });

  it("acquires on mount when active, releases on unmount", async () => {
    const { request, sentinels } = installWakeLock();
    const { unmount } = renderHook(({ a }) => useWakeLock(a), {
      initialProps: { a: true },
    });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
  });

  it("does not acquire while inactive; acquires when active flips true; releases when it flips back", async () => {
    const { request, sentinels } = installWakeLock();
    const { rerender } = renderHook(({ a }) => useWakeLock(a), {
      initialProps: { a: false },
    });
    await flush();
    expect(request).not.toHaveBeenCalled();

    rerender({ a: true });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    rerender({ a: false });
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases on tab-hide and re-acquires on visibilitychange back", async () => {
    const { request, sentinels } = installWakeLock();
    renderHook(() => useWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await flush();
    expect(sentinels[0].release).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);

    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not acquire on mount while the document is hidden, acquires once visible", async () => {
    const { request } = installWakeLock();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    renderHook(() => useWakeLock(true));
    await flush();
    expect(request).not.toHaveBeenCalled();

    setVisibility("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("is a silent no-op when navigator.wakeLock is absent", async () => {
    // jsdom's navigator has no wakeLock — exactly the no-API browser case.
    expect((navigator as { wakeLock?: unknown }).wakeLock).toBeUndefined();
    const { unmount } = renderHook(() => useWakeLock(true));
    await flush();
    setVisibility("hidden");
    setVisibility("visible");
    await flush();
    expect(() => unmount()).not.toThrow();
  });
});
