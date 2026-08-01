// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCreateFleetRun } from "@/data/fleet/queries";

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

describe("Fleet create intent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("persists the complete automation policy in the single create request", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          json: async () => ({ run: { id: "fleet-1" } }),
        }) as Response
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCreateFleetRun(), {
      wrapper: wrapper(),
    });
    const automationPolicy = {
      version: 1 as const,
      automaticPlanning: true,
      automaticPlanApproval: true,
      automaticStart: true,
      automaticFixes: false,
      maxAutomaticFixRounds: 0,
      automaticMerge: false,
      mergeTarget: "github_pr" as const,
      allowSensitivePaths: false,
      allowUnconfinedAgents: true,
      plannerTaskCap: 8,
      cleanupPolicy: "preserve" as const,
      retentionDays: null,
    };

    await result.current.mutateAsync({
      name: "Autonomous run",
      goal: "Plan and execute",
      repoId: "repo-1",
      automationPolicy,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "Autonomous run",
          goal: "Plan and execute",
          repoId: "repo-1",
          automationPolicy,
        }),
      })
    );
  });
});
