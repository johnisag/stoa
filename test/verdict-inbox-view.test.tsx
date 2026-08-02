// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

const state = vi.hoisted(() => ({
  fleetError: false,
  fleetRuns: [
    { id: "fleet-a", attentionCount: 3 },
    { id: "fleet-b", attentionCount: 0 },
    { id: "fleet-c", attentionCount: 1 },
  ],
}));

vi.mock("@/data/verdict-inbox/queries", () => ({
  useInbox: () => ({
    data: [
      {
        type: "dispatch",
        id: "review-me",
        state: "pr_open",
        reviewGate: true,
        reviewDecision: "CHANGES_REQUESTED",
      },
    ],
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/data/fleet/queries", () => ({
  useFleetRunsQuery: () => ({
    data: state.fleetError ? undefined : state.fleetRuns,
    isLoading: false,
    isError: state.fleetError,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/components/views/VerdictInboxView/ElicitationRequests", () => ({
  ElicitationRequests: () => null,
}));

vi.mock("@/components/views/VerdictInboxView/InboxCard", () => ({
  InboxCard: ({ item }: { item: { id: string } }) => (
    <div>{`review-${item.id}`}</div>
  ),
}));

import { VerdictInboxView } from "@/components/views/VerdictInboxView";

describe("VerdictInboxView Fleet attention handoff", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    state.fleetError = false;
    state.fleetRuns = [
      { id: "fleet-a", attentionCount: 3 },
      { id: "fleet-b", attentionCount: 0 },
      { id: "fleet-c", attentionCount: 1 },
    ];
  });

  it("counts attentive Fleet runs as items and links to Fleet Board", () => {
    const onOpenFleetBoard = vi.fn();
    render(
      <TooltipProvider>
        <VerdictInboxView onOpenFleetBoard={onOpenFleetBoard} />
      </TooltipProvider>
    );

    expect(
      screen.getByText("2 Fleet runs need attention in Fleet Board.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Fleet Board" }));
    expect(onOpenFleetBoard).toHaveBeenCalledOnce();
  });

  it("omits the handoff when no Fleet run needs attention", () => {
    state.fleetRuns = [{ id: "fleet-b", attentionCount: 0 }];
    render(<VerdictInboxView />);

    expect(screen.queryByTestId("verdict-inbox-fleet-attention")).toBeNull();
    expect(screen.getByText("review-review-me")).toBeTruthy();
  });

  it("keeps the review queue usable when the auxiliary Fleet read fails", () => {
    state.fleetError = true;
    render(<VerdictInboxView />);

    expect(screen.getByText("review-review-me")).toBeTruthy();
    expect(screen.queryByText("Failed to load the queue")).toBeNull();
    expect(screen.queryByTestId("verdict-inbox-fleet-attention")).toBeNull();
  });
});
