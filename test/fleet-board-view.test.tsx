// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FleetRunDto, FleetTaskDto } from "@/lib/fleet/types";
import { bucketByLane, composeFleetCards } from "@/lib/fleet-board/lanes";

const state = vi.hoisted(() => ({
  detailHook: vi.fn(),
}));

const run = {
  id: "fleet-run-1",
  name: "Ship autonomous Fleet",
  goal: "Deliver the exact reviewed result",
  status: "running",
  taskCount: 1,
  workerCount: 1,
} as FleetRunDto;

const task = {
  id: "fleet-task-1",
  title: "Wire exact task handoff",
  status: "waiting_for_operator",
} as FleetTaskDto;

vi.mock("@/components/views/VerdictInboxView/InboxCard", () => ({
  InboxCard: () => null,
}));

vi.mock("@/data/fleet-board/useFleetBoard", () => ({
  useFleetBoard: () => ({
    lanes: bucketByLane(composeFleetCards([], [], [], [run])),
    repoById: new Map(),
    total: 1,
    needsMeCount: 0,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/data/fleet/queries", () => ({
  useFleetRunQuery: (runId: string, enabled: boolean) => {
    state.detailHook(runId, enabled);
    return {
      data: enabled ? { tasks: [task] } : undefined,
      isLoading: false,
      error: null,
    };
  },
}));

import { FleetBoardView } from "@/components/views/FleetBoardView";

describe("FleetBoardView durable Fleet run handoff", () => {
  afterEach(() => {
    cleanup();
    state.detailHook.mockClear();
  });

  it("lazily reads one run's tasks and opens the exact run/task", () => {
    const onOpenFleetRun = vi.fn();
    render(<FleetBoardView onOpenFleetRun={onOpenFleetRun} />);

    expect(screen.getByText("Ship autonomous Fleet")).toBeTruthy();
    expect(screen.queryByText("Wire exact task handoff")).toBeNull();
    expect(state.detailHook).toHaveBeenLastCalledWith("fleet-run-1", false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show tasks for Fleet run Ship autonomous Fleet",
      })
    );
    expect(state.detailHook).toHaveBeenLastCalledWith("fleet-run-1", true);
    fireEvent.click(
      screen.getByRole("button", { name: /Wire exact task handoff/ })
    );
    expect(onOpenFleetRun).toHaveBeenCalledWith("fleet-run-1", "fleet-task-1");

    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
    expect(onOpenFleetRun).toHaveBeenCalledWith("fleet-run-1");
  });
});
