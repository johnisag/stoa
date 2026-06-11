/**
 * Fleet board (#5) — lane assignment + composition. Pure: maps every dispatch
 * status + ceremony step to a lane, and dedupes the pr_open row that appears in
 * BOTH the board hook and the inbox (the inbox version wins — it's richer).
 */
import { describe, it, expect } from "vitest";
import {
  laneForInboxItem,
  laneForDispatch,
  composeFleetCards,
  bucketByLane,
} from "@/lib/fleet-board/lanes";
import type { InboxItem } from "@/lib/verdict-inbox";
import type { IssueDispatch } from "@/lib/dispatch/types";

const inbox = (o: Partial<InboxItem>): InboxItem =>
  ({
    type: "dispatch",
    id: "i",
    state: "pr_open",
    reviewGate: true,
    reviewDecision: null,
    ...o,
  }) as unknown as InboxItem;
const disp = (o: Partial<IssueDispatch>): IssueDispatch =>
  ({ id: "d", status: "pending", ...o }) as unknown as IssueDispatch;

describe("laneForInboxItem", () => {
  it("maps ceremony steps to lanes", () => {
    const cer = (state: string) => inbox({ type: "ceremony", state });
    expect(laneForInboxItem(cer("queued"))).toBe("queued");
    expect(laneForInboxItem(cer("reviewing"))).toBe("in_review");
    expect(laneForInboxItem(cer("fixing"))).toBe("working");
    expect(laneForInboxItem(cer("ci_fixing"))).toBe("working");
    expect(laneForInboxItem(cer("ready"))).toBe("verified");
    expect(laneForInboxItem(cer("awaiting_merge"))).toBe("verified");
    expect(laneForInboxItem(cer("stuck"))).toBe("failed");
  });

  it("maps a dispatch pr_open by verdict/gate, failed to failed", () => {
    expect(
      laneForInboxItem(inbox({ reviewGate: true, reviewDecision: null }))
    ).toBe("in_review");
    expect(
      laneForInboxItem(inbox({ reviewGate: true, reviewDecision: "APPROVED" }))
    ).toBe("verified");
    // ungated PR gets no verdict → a human must merge → verified lane
    expect(
      laneForInboxItem(inbox({ reviewGate: false, reviewDecision: null }))
    ).toBe("verified");
    // CHANGES_REQUESTED stays In review (fix loop iterating) — NOT verified, and
    // matches the inbox's "needs me" rather than claiming approval.
    expect(
      laneForInboxItem(inbox({ reviewDecision: "CHANGES_REQUESTED" }))
    ).toBe("in_review");
    expect(laneForInboxItem(inbox({ state: "failed" }))).toBe("failed");
  });
});

describe("laneForDispatch", () => {
  it("maps dispatch statuses", () => {
    expect(laneForDispatch(disp({ status: "pending" }))).toBe("queued");
    expect(laneForDispatch(disp({ status: "dispatched" }))).toBe("working");
    expect(laneForDispatch(disp({ status: "merged" }))).toBe("merged");
    expect(laneForDispatch(disp({ status: "failed" }))).toBe("failed");
  });
});

describe("composeFleetCards", () => {
  it("dedupes a pr_open row to the inbox version (richer)", () => {
    const cards = composeFleetCards(
      [disp({ id: "x", status: "pr_open" })],
      [],
      [inbox({ id: "x", reviewGate: true, reviewDecision: "APPROVED" })]
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].source).toBe("inbox");
    expect(cards[0].lane).toBe("verified");
  });

  it("unions pending + board + ceremonies with no collisions", () => {
    const cards = composeFleetCards(
      [
        disp({ id: "w", status: "dispatched" }),
        disp({ id: "m", status: "merged" }),
      ],
      [disp({ id: "p", status: "pending" })],
      [inbox({ type: "ceremony", id: "c", state: "reviewing" })]
    );
    const byLane = bucketByLane(cards);
    expect(byLane.queued.map((c) => c.dispatch!.id)).toEqual(["p"]);
    expect(byLane.working.map((c) => c.dispatch!.id)).toEqual(["w"]);
    expect(byLane.merged.map((c) => c.dispatch!.id)).toEqual(["m"]);
    expect(byLane.in_review.map((c) => c.inbox!.id)).toEqual(["c"]);
  });
});
