// @vitest-environment jsdom
/**
 * Recursive fuzzy file search in useDirectoryBrowser (opt-in via recursiveSearch).
 * When the search box is non-empty it must search the whole subtree under the
 * current dir (bounded recursive listing, flattened + fuzzy-ranked) rather than
 * only filtering the current directory's names — and clearing search returns to
 * plain browsing. Directory-only consumers (recursiveSearch unset) are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDirectoryBrowser } from "@/hooks/useDirectoryBrowser";
import type { FileNode } from "@/lib/file-utils";

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

// /repo recursive tree: a file at the root, one at depth 2, one at depth 3.
const RECURSIVE_TREE: FileNode[] = [
  { name: "readme.md", path: "/repo/readme.md", type: "file" },
  {
    name: "src",
    path: "/repo/src",
    type: "directory",
    children: [
      { name: "util.ts", path: "/repo/src/util.ts", type: "file" },
      {
        name: "ui",
        path: "/repo/src/ui",
        type: "directory",
        children: [
          { name: "button.tsx", path: "/repo/src/ui/button.tsx", type: "file" },
        ],
      },
    ],
  },
];

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/api/files/roots")) {
        return ok({ roots: ["/"], separator: "/" });
      }
      if (url.includes("recursive=true")) {
        return ok({ files: RECURSIVE_TREE, path: "/repo" });
      }
      // Shallow listing of /repo (one dir + one file).
      return ok({
        files: [
          { name: "src", path: "/repo/src", type: "directory" },
          { name: "readme.md", path: "/repo/readme.md", type: "file" },
        ],
        path: "/repo",
      });
    })
  );
});

describe("useDirectoryBrowser — recursive fuzzy search (opt-in)", () => {
  it("matches files deep in the subtree, files-only, not just the current dir", async () => {
    const { result } = renderHook(
      () =>
        useDirectoryBrowser({ initialPath: "/repo", recursiveSearch: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.files.length).toBe(2));

    act(() => result.current.setSearch("util"));
    await waitFor(() => expect(result.current.searchingRecursively).toBe(true));
    // util.ts lives at depth 2 — proves recursion + flatten beyond the cwd.
    expect(result.current.filteredFiles.map((f) => f.path)).toEqual([
      "/repo/src/util.ts",
    ]);

    // A depth-3 file is reachable too.
    act(() => result.current.setSearch("button"));
    await waitFor(() =>
      expect(result.current.filteredFiles.map((f) => f.path)).toEqual([
        "/repo/src/ui/button.tsx",
      ])
    );
  });

  it("returns to plain directory browsing when the search is cleared", async () => {
    const { result } = renderHook(
      () =>
        useDirectoryBrowser({ initialPath: "/repo", recursiveSearch: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.files.length).toBe(2));

    act(() => result.current.setSearch("util"));
    await waitFor(() => expect(result.current.searchingRecursively).toBe(true));

    act(() => result.current.setSearch(""));
    await waitFor(() =>
      expect(result.current.searchingRecursively).toBe(false)
    );
    expect(result.current.filteredFiles.map((f) => f.name)).toEqual([
      "src",
      "readme.md",
    ]);
  });

  it("caps the result list and reports the true match total", async () => {
    // 150 matching files under /repo/src → capped to 100, total reported as 150.
    const many: FileNode[] = Array.from({ length: 150 }, (_, i) => ({
      name: `util-${i}.ts`,
      path: `/repo/src/util-${i}.ts`,
      type: "file" as const,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/files/roots"))
          return ok({ roots: ["/"], separator: "/" });
        if (url.includes("recursive=true"))
          return ok({
            files: [
              {
                name: "src",
                path: "/repo/src",
                type: "directory",
                children: many,
              },
            ],
            path: "/repo",
          });
        return ok({
          files: [{ name: "src", path: "/repo/src", type: "directory" }],
          path: "/repo",
        });
      })
    );

    const { result } = renderHook(
      () =>
        useDirectoryBrowser({ initialPath: "/repo", recursiveSearch: true }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.files.length).toBe(1));

    act(() => result.current.setSearch("util"));
    await waitFor(() => expect(result.current.searchingRecursively).toBe(true));
    expect(result.current.filteredFiles.length).toBe(
      result.current.recursiveResultCap
    );
    expect(result.current.recursiveMatchCount).toBe(150);
  });

  it("without recursiveSearch, search only filters the current directory", async () => {
    const { result } = renderHook(
      () => useDirectoryBrowser({ initialPath: "/repo" }),
      { wrapper: createWrapper() }
    );
    await waitFor(() => expect(result.current.files.length).toBe(2));

    act(() => result.current.setSearch("util"));
    // No subtree search: "util" doesn't match the current dir's names, so empty,
    // and the recursive flag stays false.
    await waitFor(() =>
      expect(result.current.searchingRecursively).toBe(false)
    );
    expect(result.current.filteredFiles).toEqual([]);
  });
});
