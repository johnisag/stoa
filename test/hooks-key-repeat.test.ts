// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useKeyRepeat } from "@/hooks/useKeyRepeat";

describe("useKeyRepeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(navigator, { vibrate: vi.fn() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the latest onKeyPress callback while a repeat is active", () => {
    const first = vi.fn();
    const second = vi.fn();

    const { result, rerender } = renderHook(
      ({ onKeyPress }: { onKeyPress: () => void }) => useKeyRepeat(onKeyPress),
      { initialProps: { onKeyPress: first } }
    );

    act(() => result.current.startRepeat());
    expect(first).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(500));
    act(() => vi.advanceTimersByTime(150));
    expect(first).toHaveBeenCalledTimes(2);

    rerender({ onKeyPress: second });

    act(() => vi.advanceTimersByTime(150));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);

    act(() => result.current.stopRepeat());
  });
});
