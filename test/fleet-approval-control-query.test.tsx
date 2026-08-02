// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useFleetApprovalControl,
  useFleetApprovalControlPreview,
} from "@/data/fleet/queries";

function wrapper() {
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

afterEach(() => vi.unstubAllGlobals());

describe("Fleet exact approval-control client", () => {
  it("loads the admin preview without caching", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        runId: "run/a",
        bindings: { currentPlanHash: "1".repeat(64) },
        tasks: [],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const preview = renderHook(
      () => useFleetApprovalControlPreview("run/a", true),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(preview.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/approvals/preview",
      { cache: "no-store" }
    );
  });

  it("sends exact run and task bindings only to whitelisted control routes", async () => {
    const response = {
      ok: true,
      action: "task_skip_approval",
      idempotent: false,
      planHash: "1".repeat(64),
      executionHash: "2".repeat(64),
      preview: { runId: "run/a", tasks: [] },
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const control = renderHook(() => useFleetApprovalControl("run/a"), {
      wrapper: wrapper(),
    });
    const binding = {
      requestId: "approval-request",
      expectedPlanHash: "1".repeat(64),
      expectedExecutionHash: "2".repeat(64),
      expectedPolicyHash: "3".repeat(64),
      expectedBaseSha: "a".repeat(40),
      expectedRunUpdatedAt: "2026-08-01T00:00:00.000Z",
      expectedTaskStatus: "ready" as const,
      expectedTaskApprovalState: "approved" as const,
      expectedAttempt: 0,
      expectedTaskBaseSha: null,
      expectedHeadSha: null,
      expectedTaskUpdatedAt: "2026-08-01T00:00:00.000Z",
      expectedSkipClosureHash: "4".repeat(64),
    };

    await control.result.current.mutateAsync({
      kind: "task_skip",
      taskId: "task 1",
      body: binding,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/tasks/task%201/controls/skip",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(binding),
      })
    );
  });
});
