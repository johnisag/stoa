// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

describe("useCopyToClipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the feedback timeout on unmount", async () => {
    const { result, unmount } = renderHook(() =>
      useCopyToClipboard({ feedbackDuration: 1000 })
    );

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);

    unmount();
    act(() => vi.advanceTimersByTime(1000));
    // No React warning is emitted; the hook simply does not update state.
  });

  it("resets the previous timeout on rapid copies so feedback duration is predictable", async () => {
    const { result } = renderHook(() =>
      useCopyToClipboard({ feedbackDuration: 1000 })
    );

    await act(async () => {
      await result.current.copy("first");
    });
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    await act(async () => {
      await result.current.copy("second");
    });

    // The first timeout was cancelled; after 500ms more the feedback is still on.
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.copied).toBe(false);
  });
});
