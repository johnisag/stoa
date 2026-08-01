// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useArchiveFleetRun,
  useFleetAnalyticsQuery,
  useFleetCleanupPreview,
  useFleetMergeStatus,
  useFleetSupervisorSnapshot,
  useMessageFleetWorker,
  useRequestFleetCleanup,
  useRequestFleetMerge,
  useRetryFleetTask,
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

describe("Fleet lifecycle client controls", () => {
  it("binds archive confirmation and retention to the selected run", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        archivedAt: "2026-08-01T00:00:00.000Z",
        retentionDays: 45,
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useArchiveFleetRun("run/a"), {
      wrapper: wrapper(),
    });

    await result.current.mutateAsync({ retentionDays: 45 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/archive",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          confirmation: "run/a",
          retentionDays: 45,
          actor: "operator",
        }),
      })
    );
  });

  it("loads a cleanup preview and sends the exact destructive confirmation", async () => {
    const preview = {
      runId: "run-1",
      archived: true,
      terminal: true,
      eligible: [],
      skipped: [],
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json(init?.method === "POST" ? { queued: 0, preview } : preview)
    );
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle = renderHook(
      () => ({
        preview: useFleetCleanupPreview("run-1", true),
        cleanup: useRequestFleetCleanup("run-1"),
      }),
      { wrapper: wrapper() }
    );

    await waitFor(() =>
      expect(lifecycle.result.current.preview.isSuccess).toBe(true)
    );
    await lifecycle.result.current.cleanup.mutateAsync();

    expect(fetchMock).toHaveBeenCalledWith("/api/fleet/runs/run-1/cleanup");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run-1/cleanup",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          confirmation: "run-1",
          actor: "operator",
        }),
      })
    );
  });

  it("loads bounded historical analytics", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        runCount: 2,
        archivedRunCount: 1,
        runOutcomes: { completed: 1 },
        taskOutcomes: {},
        providerOutcomes: {},
        durations: {
          completedRuns: 1,
          averageSeconds: 10,
          maximumSeconds: 10,
        },
        budget: { configuredUsd: 5, reservedUsd: 0, spentUsd: 1 },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const analytics = renderHook(() => useFleetAnalyticsQuery(true), {
      wrapper: wrapper(),
    });

    await waitFor(() => expect(analytics.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/analytics?limitRuns=100"
    );
    expect(analytics.result.current.data?.runCount).toBe(2);
  });

  it("polls merge readiness and requests an exact merge target", async () => {
    const status = {
      readiness: {
        runId: "run merge",
        requested: false,
        target: null,
        integrationState: "idle",
        readyTaskIds: [],
        waitingTaskIds: ["task-1"],
        mergedTaskIds: [],
        blockers: ["task-1 is waiting"],
        allTasksIntegrated: false,
        canFinalize: false,
      },
      integration: {
        state: "idle",
        target: null,
        requestedAt: null,
        requestedBy: null,
        requestKind: null,
        branch: null,
        worktree: null,
        baseSha: null,
        headSha: null,
        prNumber: null,
        prUrl: null,
        prHeadSha: null,
        mergeSha: null,
        error: null,
      },
      operations: [],
    };
    const fetchMock = vi.fn(async () => Response.json(status));
    vi.stubGlobal("fetch", fetchMock);
    const merge = renderHook(
      () => ({
        status: useFleetMergeStatus("run merge", true),
        request: useRequestFleetMerge("run merge"),
      }),
      { wrapper: wrapper() }
    );

    await waitFor(() =>
      expect(merge.result.current.status.isSuccess).toBe(true)
    );
    await merge.result.current.request.mutateAsync({
      target: "github_pr",
      expectedPlanHash: "1".repeat(64),
      expectedBaseSha: null,
      expectedIntegrationHeadSha: null,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/fleet/runs/run%20merge/merge");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%20merge/merge",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          target: "github_pr",
          expectedPlanHash: "1".repeat(64),
          expectedBaseSha: null,
          expectedIntegrationHeadSha: null,
        }),
      })
    );
  });

  it("loads the hash-bound advisory supervisor snapshot", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 1,
        rulesVersion: 1,
        snapshotHash: "a".repeat(64),
        attention: [],
        recommendations: [],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const supervisor = renderHook(
      () => useFleetSupervisorSnapshot("run/supervisor", true),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(supervisor.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fsupervisor/supervisor"
    );
    expect(supervisor.result.current.data?.snapshotHash).toBe("a".repeat(64));
  });

  it("sends exact task and worker operator preconditions", async () => {
    const response = {
      ok: true,
      action: "accepted",
      idempotent: false,
      run: {
        run: { id: "run/a" },
        tasks: [],
        workers: [],
        artifacts: [],
        verifications: [],
        events: [],
      },
    };
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);
    const controls = renderHook(
      () => ({
        retry: useRetryFleetTask("run/a", "task 1"),
        message: useMessageFleetWorker("run/a", "worker 1"),
      }),
      { wrapper: wrapper() }
    );
    const taskInput = {
      requestId: "request-task",
      expectedPlanHash: "b".repeat(64),
      expectedAttempt: 2,
      expectedHeadSha: "c".repeat(40),
    };
    const workerInput = {
      requestId: "request-worker",
      expectedAttempt: 3,
      expectedSessionId: "session-1",
      message: "Please report the blocker.",
    };

    await controls.result.current.retry.mutateAsync(taskInput);
    await controls.result.current.message.mutateAsync(workerInput);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/tasks/task%201/retry",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(taskInput),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/workers/worker%201/message",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(workerInput),
      })
    );
  });
});
