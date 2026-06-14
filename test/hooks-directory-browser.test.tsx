// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useDirectoryBrowser } from "@/hooks/useDirectoryBrowser";
import type { FileNode } from "@/lib/file-utils";

// Make Response-like objects explicit so TypeScript/vitest accept them.
const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as Response;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("useDirectoryBrowser", () => {
  beforeEach(() => {
    const roots = { roots: ["/"], separator: "/" };
    const listing = {
      files: [
        { name: "src", path: "/src", type: "directory" },
        { name: "readme.md", path: "/readme.md", type: "file" },
      ],
      path: "/",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/files/roots") {
          return okResponse(roots);
        }
        return okResponse(listing);
      })
    );
  });

  it("recomputes files when the filter prop changes", async () => {
    const { result, rerender } = renderHook(
      ({ filter }) => useDirectoryBrowser({ filter }),
      {
        wrapper: createWrapper(),
        initialProps: {
          filter: undefined as ((node: FileNode) => boolean) | undefined,
        },
      }
    );

    await waitFor(() => expect(result.current.files.length).toBe(2));
    expect(result.current.files.map((f) => f.name)).toEqual([
      "src",
      "readme.md",
    ]);

    rerender({ filter: (node) => node.type === "directory" });

    await waitFor(() =>
      expect(result.current.files.map((f) => f.name)).toEqual(["src"])
    );
  });
});
