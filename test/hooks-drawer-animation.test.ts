// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDrawerAnimation } from "@/hooks/useDrawerAnimation";

describe("useDrawerAnimation", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const rafs: FrameRequestCallback[] = [];

  beforeEach(() => {
    rafs.length = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafs.push(cb);
      return rafs.length;
    };
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  function flushRafs() {
    while (rafs.length) {
      const cb = rafs.shift()!;
      cb(performance.now());
    }
  }

  it("sets isAnimatingIn after the double rAF chain completes", () => {
    const { result } = renderHook(({ open }) => useDrawerAnimation(open), {
      initialProps: { open: true },
    });

    expect(result.current.isAnimatingIn).toBe(false);
    act(() => flushRafs());
    expect(result.current.isAnimatingIn).toBe(true);
  });

  it("does not set isAnimatingIn if open flips false before the inner rAF fires", () => {
    const { result, rerender } = renderHook(
      ({ open }) => useDrawerAnimation(open),
      { initialProps: { open: true } }
    );

    // Flush the outer rAF only.
    act(() => {
      while (rafs.length) {
        const cb = rafs.shift()!;
        cb(performance.now());
        break;
      }
    });

    rerender({ open: false });
    act(() => flushRafs());
    expect(result.current.isAnimatingIn).toBe(false);
  });

  it("does not set state after the component unmounts", () => {
    const { result, unmount } = renderHook(
      ({ open }) => useDrawerAnimation(open),
      { initialProps: { open: true } }
    );

    unmount();
    act(() => flushRafs());
    expect(result.current.isAnimatingIn).toBe(false);
  });
});
