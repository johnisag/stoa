// @vitest-environment jsdom
/**
 * Regression: the multi-repo git stage/unstage mutations must honor res.ok.
 *
 * They previously branched only on the body field (`if (data.error) throw`),
 * so a non-2xx response whose JSON lacked an `error` key (e.g. a 500 returning
 * `{}`) was treated as SUCCESS — the mutation resolved and onSuccess fired a
 * cache invalidation, presenting a failed git op as done. These tests assert the
 * mutation now REJECTS on such a response (the pre-fix code resolved it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useMultiRepoStageFiles,
  useMultiRepoUnstageFiles,
} from "@/data/git/queries";

const res = (init: {
  ok?: boolean;
  status?: number;
  json: unknown;
}): Response =>
  ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => init.json,
  }) as Response;

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("multi-repo git mutations honor res.ok", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("stage REJECTS on a 5xx whose body has no error key (was: silent success)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ ok: false, status: 500, json: {} }))
    );
    const { result } = renderHook(() => useMultiRepoStageFiles("/repo"), {
      wrapper: createWrapper(),
    });
    await expect(result.current.mutateAsync(["a.ts"])).rejects.toThrow(
      "Failed to stage files"
    );
  });

  it("unstage REJECTS on a 5xx whose body has no error key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ ok: false, status: 500, json: {} }))
    );
    const { result } = renderHook(() => useMultiRepoUnstageFiles("/repo"), {
      wrapper: createWrapper(),
    });
    await expect(result.current.mutateAsync(["a.ts"])).rejects.toThrow(
      "Failed to unstage files"
    );
  });

  it("surfaces the server's error message when the body carries one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        res({ ok: false, status: 409, json: { error: "merge in progress" } })
      )
    );
    const { result } = renderHook(() => useMultiRepoStageFiles("/repo"), {
      wrapper: createWrapper(),
    });
    await expect(result.current.mutateAsync(["a.ts"])).rejects.toThrow(
      "merge in progress"
    );
  });

  it("resolves on a 2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res({ ok: true, status: 200, json: { staged: true } }))
    );
    const { result } = renderHook(() => useMultiRepoStageFiles("/repo"), {
      wrapper: createWrapper(),
    });
    await expect(result.current.mutateAsync(["a.ts"])).resolves.toEqual({
      staged: true,
    });
  });
});
