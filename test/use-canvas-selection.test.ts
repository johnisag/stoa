// @vitest-environment jsdom
/**
 * useCanvasSelection — React hook tests.
 *
 * Locks the workflow-builder canvas selection semantics that were extracted
 * verbatim from WorkflowBuilder: single-select replace, shift/add toggle,
 * keep-selection primary move, null clears — the extracted selection store doc
 * mutations use to re-select fresh nodes.
 */
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCanvasSelection } from "@/hooks/useCanvasSelection";

describe("useCanvasSelection", () => {
  it("starts empty with no primary", () => {
    const { result } = renderHook(() => useCanvasSelection());
    expect([...result.current.selectedIds]).toEqual([]);
    expect(result.current.primaryId).toBeNull();
  });

  it("single-selects (replace) and sets the primary", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    expect([...result.current.selectedIds]).toEqual(["a"]);
    expect(result.current.primaryId).toBe("a");
    // A second single-select replaces the first.
    act(() => result.current.handleSelectNode("b"));
    expect([...result.current.selectedIds]).toEqual(["b"]);
    expect(result.current.primaryId).toBe("b");
  });

  it("null clears the selection", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    act(() => result.current.handleSelectNode(null));
    expect([...result.current.selectedIds]).toEqual([]);
    expect(result.current.primaryId).toBeNull();
  });

  it("shift-select adds to the set and focuses the added id", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    act(() => result.current.handleSelectNode("b", { shiftKey: true }));
    expect([...result.current.selectedIds].sort()).toEqual(["a", "b"]);
    expect(result.current.primaryId).toBe("b");
  });

  it("shift-select on a member toggles it OUT and re-homes the primary", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    act(() => result.current.handleSelectNode("b", { addToSelection: true }));
    // Toggling "b" back off leaves {a}; primary falls back to a remaining id.
    act(() => result.current.handleSelectNode("b", { shiftKey: true }));
    expect([...result.current.selectedIds]).toEqual(["a"]);
    expect(result.current.primaryId).toBe("a");
  });

  it("shift-toggling the last member leaves an empty set + null primary", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    act(() => result.current.handleSelectNode("a", { shiftKey: true }));
    expect([...result.current.selectedIds]).toEqual([]);
    expect(result.current.primaryId).toBeNull();
  });

  it("keepSelection moves only the primary, leaving the set untouched", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("a"));
    act(() => result.current.handleSelectNode("b", { shiftKey: true }));
    act(() => result.current.handleSelectNode("a", { keepSelection: true }));
    expect([...result.current.selectedIds].sort()).toEqual(["a", "b"]);
    expect(result.current.primaryId).toBe("a");
  });

  it("clearSelection empties the set and drops the primary", () => {
    const { result } = renderHook(() => useCanvasSelection());
    act(() => result.current.handleSelectNode("x"));
    act(() => result.current.handleSelectNode("y", { addToSelection: true }));
    expect(result.current.selectedIds.size).toBe(2);
    act(() => result.current.clearSelection());
    expect([...result.current.selectedIds]).toEqual([]);
    expect(result.current.primaryId).toBeNull();
  });
});
