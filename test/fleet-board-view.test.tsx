// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FleetRunDto, FleetTaskDto } from "@/lib/fleet/types";
import { bucketByLane, composeFleetCards } from "@/lib/fleet-board/lanes";
import { TooltipProvider } from "@/components/ui/tooltip";

const state = vi.hoisted(() => ({
  detailHook: vi.fn(),
  total: 1,
  needsMeCount: 2,
  elicitationCount: 1,
  elicitationError: false,
  elicitationFetching: false,
  refetchElicitations: vi.fn(),
}));

const run = {
  id: "fleet-run-1",
  name: "Ship autonomous Fleet",
  goal: "Deliver the exact reviewed result",
  status: "running",
  taskCount: 1,
  workerCount: 1,
  attentionCount: 2,
  awaitingManualMerge: false,
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
    total: state.total,
    needsMeCount: state.needsMeCount,
    elicitationCount: state.elicitationCount,
    elicitationError: state.elicitationError,
    elicitationFetching: state.elicitationFetching,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
    refetchElicitations: state.refetchElicitations,
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
    vi.clearAllMocks();
    state.total = 1;
    state.needsMeCount = 2;
    state.elicitationCount = 1;
    state.elicitationError = false;
    state.elicitationFetching = false;
  });

  it("lazily reads one run's tasks and opens the exact run/task", () => {
    const onOpenFleetRun = vi.fn();
    render(<FleetBoardView onOpenFleetRun={onOpenFleetRun} />);

    expect(screen.getByText("Ship autonomous Fleet")).toBeTruthy();
    expect(screen.getByText("2 signals")).toBeTruthy();
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

  it("accounts for pending operator questions and links their visible handoff", () => {
    const onOpenVerdictInbox = vi.fn();
    render(
      <TooltipProvider>
        <FleetBoardView onOpenVerdictInbox={onOpenVerdictInbox} />
      </TooltipProvider>
    );

    expect(screen.getByText("2 need you")).toBeTruthy();
    expect(
      screen.getByText("1 operator question needs an answer in Verdict Inbox.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Verdict Inbox" }));
    expect(onOpenVerdictInbox).toHaveBeenCalledOnce();
  });

  it("keeps Fleet cards usable and offers an isolated elicitation retry", () => {
    state.elicitationCount = 0;
    state.elicitationError = true;
    state.needsMeCount = 1;
    render(<FleetBoardView />);

    expect(screen.getByText("Ship autonomous Fleet")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Operator questions could not be loaded. Fleet lanes remain available."
    );
    expect(screen.queryByText("Failed to load the board")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry operator questions" })
    );
    expect(state.refetchElicitations).toHaveBeenCalledOnce();
  });

  it("uses neutral delivery copy when only operator questions remain", () => {
    state.total = 0;
    state.needsMeCount = 1;
    state.elicitationCount = 1;
    render(<FleetBoardView />);

    expect(screen.getByText("No delivery work is on the board.")).toBeTruthy();
    expect(
      screen.queryByText(
        "Fleet idle — dispatch a task, or flip a session to auto mode."
      )
    ).toBeNull();
  });
});
