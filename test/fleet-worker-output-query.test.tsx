// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFleetWorkerOutput } from "@/data/fleet/queries";

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Fleet worker output client", () => {
  it("stays lazy, then binds one encoded worker attempt to a no-store read", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        runId: "run/a",
        workerId: "worker 1",
        attempt: 4,
        sessionId: "session/exact",
        lines: 1,
        output: "rendered",
        truncated: false,
        capturedAt: "2026-08-01T00:00:00.000Z",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const disabled = renderHook(
      () =>
        useFleetWorkerOutput(
          "run/a",
          "worker 1",
          4,
          "session/exact",
          false,
          60
        ),
      { wrapper: wrapper() }
    );
    expect(disabled.result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
    disabled.unmount();

    const enabled = renderHook(
      () =>
        useFleetWorkerOutput("run/a", "worker 1", 4, "session/exact", true, 60),
      { wrapper: wrapper() }
    );
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/fleet/runs/run%2Fa/workers/worker%201/output?expectedAttempt=4&expectedSessionId=session%2Fexact&lines=60",
      { cache: "no-store" }
    );
  });
});
