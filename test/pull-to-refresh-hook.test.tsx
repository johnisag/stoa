// @vitest-environment jsdom
/**
 * #41 round-2 regression: the usePullToRefresh HOOK effect that fires the
 * refetch must always collapse the "refreshing" indicator — even when the
 * refetch never settles (offline → React Query pauses it), rejects, or throws
 * synchronously — and must fire the refetch exactly once per arm→release.
 * These paths live in the hook effect, not the pure reducer, so they need a
 * rendered hook to exercise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  usePullToRefresh,
  PULL_SETTLE_TIMEOUT_MS,
} from "@/hooks/usePullToRefresh";

function scrollRefAtTop() {
  return { current: { scrollTop: 0 } as HTMLElement };
}

// Minimal fake touch events (the hook reads touches[0].clientY only).
const START = { touches: [{ clientY: 0 }] } as unknown as React.TouchEvent;
// delta 200 / resistance 2 = 100 → clamped 96 → past the 64px threshold → armed
const MOVE = { touches: [{ clientY: 200 }] } as unknown as React.TouchEvent;

function render(onRefresh: () => Promise<unknown> | void) {
  return renderHook(() =>
    usePullToRefresh({ enabled: true, onRefresh, scrollRef: scrollRefAtTop() })
  );
}

async function pullAndRelease(result: {
  current: ReturnType<typeof usePullToRefresh>;
}) {
  await act(async () => {
    result.current.bind.onTouchStart(START);
  });
  await act(async () => {
    result.current.bind.onTouchMove(MOVE);
  });
  await act(async () => {
    result.current.bind.onTouchEnd();
  });
}

describe("usePullToRefresh hook effect (#41)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires the refetch exactly once per arm→release", async () => {
    const onRefresh = vi.fn(() => Promise.resolve());
    const { result } = render(onRefresh);
    await pullAndRelease(result);
    // Flush the microtask that invokes onRefresh.
    await act(async () => {});
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("collapses via the timeout when the refetch never settles (offline pause)", async () => {
    const onRefresh = vi.fn(() => new Promise<void>(() => {})); // never settles
    const { result } = render(onRefresh);
    await pullAndRelease(result);
    await act(async () => {}); // let the effect kick off the pending refetch
    expect(result.current.isRefreshing).toBe(true); // still spinning
    // The bounded timeout must collapse it even though the refetch is pending.
    await act(async () => {
      vi.advanceTimersByTime(PULL_SETTLE_TIMEOUT_MS);
    });
    expect(result.current.isRefreshing).toBe(false);
  });

  it("collapses when the refetch rejects (no wedged indicator)", async () => {
    const onRefresh = vi.fn(() => Promise.reject(new Error("network")));
    const { result } = render(onRefresh);
    await pullAndRelease(result);
    await act(async () => {});
    expect(result.current.isRefreshing).toBe(false);
  });

  it("collapses when a synchronous callback throws", async () => {
    const onRefresh = vi.fn(() => {
      throw new Error("sync boom");
    });
    const { result } = render(onRefresh);
    await pullAndRelease(result);
    await act(async () => {});
    expect(result.current.isRefreshing).toBe(false);
  });
});
