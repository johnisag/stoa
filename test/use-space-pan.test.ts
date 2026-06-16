// @vitest-environment jsdom
/**
 * useSpacePan — hook tests.
 *
 * Locks the "hold Space to pan" contract: held state flips on Space keydown/keyup,
 * is suppressed while typing in an input/textarea/contenteditable, prevents the
 * page-scroll default while held, releases on blur, and binds nothing when disabled.
 */
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSpacePan } from "@/hooks/useSpacePan";

function spaceDown(target?: EventTarget) {
  const e = new KeyboardEvent("keydown", {
    key: " ",
    code: "Space",
    cancelable: true,
  });
  if (target) Object.defineProperty(e, "target", { value: target });
  window.dispatchEvent(e);
  return e;
}

function spaceUp() {
  window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useSpacePan", () => {
  it("flips held true on Space down and false on Space up", () => {
    const { result } = renderHook(() => useSpacePan(true));
    expect(result.current).toBe(false);
    act(() => {
      spaceDown();
    });
    expect(result.current).toBe(true);
    act(() => {
      spaceUp();
    });
    expect(result.current).toBe(false);
  });

  it("preventDefault on the held Space keydown (suppress page-scroll)", () => {
    renderHook(() => useSpacePan(true));
    let e!: KeyboardEvent;
    act(() => {
      e = spaceDown();
    });
    expect(e.defaultPrevented).toBe(true);
  });

  it("ignores Space typed in an input/textarea (never hijacks the task field)", () => {
    const { result } = renderHook(() => useSpacePan(true));
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      spaceDown(input);
    });
    expect(result.current).toBe(false);
  });

  it("does nothing when disabled", () => {
    const { result } = renderHook(() => useSpacePan(false));
    act(() => {
      spaceDown();
    });
    expect(result.current).toBe(false);
  });

  it("releases the held flag on window blur (alt-tab safety)", () => {
    const { result } = renderHook(() => useSpacePan(true));
    act(() => {
      spaceDown();
    });
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current).toBe(false);
  });

  it("drops a stuck held flag when it becomes disabled", () => {
    const { result, rerender } = renderHook(
      ({ on }: { on: boolean }) => useSpacePan(on),
      { initialProps: { on: true } }
    );
    act(() => {
      spaceDown();
    });
    expect(result.current).toBe(true);
    rerender({ on: false });
    expect(result.current).toBe(false);
  });
});
