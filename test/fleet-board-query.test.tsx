// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { FleetRunDto } from "@/lib/fleet/types";

const state = vi.hoisted(() => ({
  inboxRefetch: vi.fn(),
  boardRefetch: vi.fn(),
  pendingRefetch: vi.fn(),
  reposRefetch: vi.fn(),
  fleetRefetch: vi.fn(),
  elicitationRefetch: vi.fn(),
  elicitationError: false,
  elicitationFetching: false,
}));

function query(data: unknown, refetch: () => void) {
  return {
    data,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch,
  };
}

vi.mock("@/data/verdict-inbox/queries", () => ({
  useInbox: () => query([], state.inboxRefetch),
}));

vi.mock("@/data/dispatch/queries", () => ({
  useBoardQuery: () => query([], state.boardRefetch),
  usePendingQuery: () => query([], state.pendingRefetch),
  useDispatchReposQuery: () => query([], state.reposRefetch),
}));

vi.mock("@/data/fleet/queries", () => ({
  useFleetRunsQuery: () =>
    query(
      [
        {
          id: "run-query-1",
          name: "Queried run",
          goal: "Test board composition",
          status: "reviewing",
          taskCount: 3,
          workerCount: 2,
          attentionCount: 3,
          awaitingManualMerge: false,
        } as FleetRunDto,
      ],
      state.fleetRefetch
    ),
}));

vi.mock("@/data/mcp-elicitations/queries", () => ({
  useElicitations: () => ({
    ...query(
      state.elicitationError ? undefined : [{ id: "operator-question" }],
      state.elicitationRefetch
    ),
    isError: state.elicitationError,
    isFetching: state.elicitationFetching,
  }),
}));

import { useFleetBoard } from "@/data/fleet-board/useFleetBoard";

describe("useFleetBoard Fleet Management read model", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    state.elicitationError = false;
    state.elicitationFetching = false;
  });

  it("composes Fleet runs and includes them in bounded manual refresh", () => {
    const { result } = renderHook(() => useFleetBoard(true));
    expect(result.current.total).toBe(1);
    expect(result.current.lanes.in_review[0]).toMatchObject({
      source: "fleet",
      fleetRun: { id: "run-query-1" },
    });
    expect(result.current.needsMeCount).toBe(2);
    expect(result.current.elicitationCount).toBe(1);

    result.current.refetch();
    expect(state.fleetRefetch).toHaveBeenCalledOnce();
    expect(state.inboxRefetch).toHaveBeenCalledOnce();
    expect(state.boardRefetch).toHaveBeenCalledOnce();
    expect(state.pendingRefetch).toHaveBeenCalledOnce();
    expect(state.reposRefetch).toHaveBeenCalledOnce();
    expect(state.elicitationRefetch).toHaveBeenCalledOnce();
  });

  it("keeps core lanes usable when the auxiliary elicitation read fails", () => {
    state.elicitationError = true;
    const { result } = renderHook(() => useFleetBoard(true));

    expect(result.current.total).toBe(1);
    expect(result.current.isError).toBe(false);
    expect(result.current.elicitationError).toBe(true);
    expect(result.current.elicitationCount).toBe(0);

    result.current.refetchElicitations();
    expect(state.elicitationRefetch).toHaveBeenCalledOnce();
  });
});
