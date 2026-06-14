// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFileEditor } from "@/hooks/useFileEditor";

describe("useFileEditor", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ignores a superseded openFile response", async () => {
    let aResolve: (value: { path: string; content: string }) => void = () => {};
    let bResolve: (value: { path: string; content: string }) => void = () => {};

    let callIndex = 0;
    globalThis.fetch = vi.fn(async () => {
      callIndex++;
      if (callIndex === 1) {
        return {
          json: async () =>
            new Promise((resolve) => {
              aResolve = resolve as typeof aResolve;
            }),
        } as Response;
      }
      return {
        json: async () =>
          new Promise((resolve) => {
            bResolve = resolve as typeof bResolve;
          }),
      } as Response;
    });

    const { result } = renderHook(() => useFileEditor());

    await act(async () => {
      result.current.openFile("/first.txt");
      // Give the first fetch a chance to register.
      await Promise.resolve();
      result.current.openFile("/second.txt");
    });

    // Resolve the second file first.
    await act(async () => {
      bResolve({ path: "/second.txt", content: "second content" });
    });

    await waitFor(() =>
      expect(result.current.activeFilePath).toBe("/second.txt")
    );
    expect(result.current.openFiles.map((f) => f.path)).toEqual([
      "/second.txt",
    ]);

    // Resolve the first (now stale) file — it must not clobber state.
    await act(async () => {
      aResolve({ path: "/first.txt", content: "first content" });
    });

    expect(result.current.activeFilePath).toBe("/second.txt");
    expect(result.current.openFiles.map((f) => f.path)).toEqual([
      "/second.txt",
    ]);
  });

  it("closing the active tab switches to a neighbor (not null); closing a non-active tab leaves active alone", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.searchParams.get("path")!;
      return {
        json: async () => ({ path, content: "x", isBinary: false }),
      } as Response;
    });

    const { result } = renderHook(() => useFileEditor());
    await act(async () => {
      await result.current.openFile("/a.txt");
    });
    await act(async () => {
      await result.current.openFile("/b.txt");
    });
    await act(async () => {
      await result.current.openFile("/c.txt");
    });
    expect(result.current.activeFilePath).toBe("/c.txt");

    // Close the ACTIVE tab — active must move to the neighbor, NOT clear to null.
    act(() => {
      result.current.closeFile("/c.txt");
    });
    expect(result.current.openFiles.map((f) => f.path)).toEqual([
      "/a.txt",
      "/b.txt",
    ]);
    expect(result.current.activeFilePath).toBe("/b.txt");

    // Close a NON-active tab — the active tab is unchanged.
    act(() => {
      result.current.closeFile("/a.txt");
    });
    expect(result.current.openFiles.map((f) => f.path)).toEqual(["/b.txt"]);
    expect(result.current.activeFilePath).toBe("/b.txt");
  });
});
